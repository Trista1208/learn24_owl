// The planner agent. Runs in the background after a lesson: reads the teaching workspace of one track,
// picks one target in the zone of proximal development, may generate a lesson for it and plans the next step.
// The rule engine checks the plan (guard.ts); if anything fails, the rule plan stays and the reason is logged.
// The model never sees the name, the learner id or the DCC levels of other tracks.
import type { DccLevel, LearningEvent, Lesson, LessonType, MapNode, PlannerRun, Recommendation } from '@l45/shared';
import { DCC_LEVELS } from '@l45/shared';
import { RULE_NAME } from './agent.ts';
import { GENERATED_PER_SESSION, LESSON_TYPES, generateLesson } from './generator.ts';
import { allLessons, checkPlan, reachableIds, type Plan } from './guard.ts';
import { ruleLesson } from './ownlessons.ts';
import { callAgent, type AgentBlock, type AgentMessage, type AgentTool } from './provider.ts';
import { RECORD_KINDS, RecordError, addRecord, addReference, dueReviews, lernstand, type RecordInput } from './records.ts';
import { applyRecommendation, fillFromPool, openRecommendation, recommend, save, storeLesson } from './sessions.ts';
import { defaultMission, missionOf, skillIn, trackIn } from './tracks.ts';
import { newId, nowIso } from './util.ts';
import { deleteLesson, writeNotes, type Stored } from './workspace.ts';

export const LIMITS = {
  steps: 6,
  totalMs: () => Number(process.env.PLANNER_TOTAL_MS ?? 45_000),
  callMs: () => Number(process.env.PLANNER_CALL_MS ?? 20_000),
  mapAdds: 2,
  generateCalls: 2,
  generatedPerSession: GENERATED_PER_SESSION,
  records: 3,
  references: 2,
  notes: 1,
};

const SYSTEM = `You are the planning agent of a learning app and work like a teacher. You plan the next step of a learner in exactly one area. You know neither their name nor their other areas.

How you teach:
- Stay in the zone of proximal development: choose exactly one narrow goal (one criterion). Base it on the mission, the active learning records, the DCC level of this area and the latest results.
- One thing per lesson: at most 5 minutes, one concrete success.
- Knowledge before practice: knowledge must be easy, practice may be hard.
- Every lesson is tied to the mission. The example fits the learner's everyday life.
- Retrieval, spacing and interleaving: due reviews come first. A review is short and mixes criteria of this area (reviewOf).
- Covered is not learned. Learning records only with evidence (event ids).
- Missing evidence means "unbekannt" (unknown), not "weak".
- Never rely on your own knowledge. Content comes only from the area's sources, its criteria and rules of thumb. The only lesson types are video, mark-evidence, mock-site and ai-chat. If the area names lessonTypes, only those.
- You never change the DCC level. It only comes from the DCC.

Steps:
1. Read get_learner_state.
2. Create a lesson that fits the mission with generate_lesson. On errors, at most one second attempt. You may attach prepared lessons (list_pool_lessons) only if generation fails or the limit is reached.
3. Attach new nodes with add_to_map (at most 2), to the last finished node or to the area node.
4. If the evidence supports it: write_learning_record, update_reference, note_preference.
5. Finally call recommend exactly once: node, alternative (leave empty if no node other than this one is reachable), a short reason (1 to 2 sentences, in English, addressing the learner as "you") and basedOn with ids of learning records (LR-…) or events (ev-…).

Rules check your recommendation: the node must be reachable, there must be an alternative as soon as another node is reachable, and the reason must cite evidence. Otherwise the rules' plan applies. You have at most ${LIMITS.steps} steps.`;

const str = { type: 'string' } as const;
const TOOLS: AgentTool[] = [
  {
    name: 'get_learner_state',
    description: 'Progress in this area: mission, DCC level of this area only, active learning records, the last 5 results, due reviews, map and the rules\' plan.',
    input_schema: { type: 'object', properties: { trackId: str }, required: ['trackId'] },
  },
  {
    name: 'list_pool_lessons',
    description: 'Prepared and already generated lessons of this area, optionally only for one criterion. Prepared ones are the fallback when generate_lesson fails.',
    input_schema: { type: 'object', properties: { trackId: str, criterion: str }, required: ['trackId'] },
  },
  {
    name: 'generate_lesson',
    description: 'Creates a new lesson (at most 5 min.) from the area\'s sources and checks it. Returns lessonId or the errors.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: LESSON_TYPES },
        trackId: str,
        criterion: str,
        level: { type: 'string', enum: DCC_LEVELS },
        contextHint: { type: 'string', description: 'What the example should be about, matching the mission' },
        reviewOf: { type: 'array', items: str, description: 'More criteria for a mixed review' },
      },
      required: ['type', 'trackId', 'criterion', 'level', 'contextHint'],
    },
  },
  {
    name: 'add_to_map',
    description: 'Attaches a lesson as a new node to the map. At most 2 per run.',
    input_schema: { type: 'object', properties: { lessonId: str, parentNodeId: str }, required: ['lessonId', 'parentNodeId'] },
  },
  {
    name: 'write_learning_record',
    description: 'Writes a learning record. The server checks the evidence: "demonstrated" only if the criterion was met in the given events alone, without a hint and at the first check.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: RECORD_KINDS },
        trackId: str,
        criterion: str,
        title: str,
        body: str,
        evidenceEventIds: { type: 'array', items: str },
        supersedes: { type: 'string', description: 'LR-… of a record that this one replaces' },
      },
      required: ['kind', 'trackId', 'title', 'body', 'evidenceEventIds'],
    },
  },
  {
    name: 'update_reference',
    description: 'Adds a rule of thumb or a term to the cheat sheet for a criterion the learner showed without help.',
    input_schema: {
      type: 'object',
      properties: {
        trackId: str,
        entry: {
          type: 'object',
          properties: { section: { type: 'string', enum: ['rule', 'term'] }, criterion: str, title: str, text: str },
          required: ['section', 'criterion', 'title', 'text'],
        },
      },
      required: ['trackId', 'entry'],
    },
  },
  {
    name: 'note_preference',
    description: 'Notes a learning preference that follows from the history, e.g. "likes short lessons".',
    input_schema: { type: 'object', properties: { text: str }, required: ['text'] },
  },
  {
    name: 'recommend',
    description: 'Ends the planning with the next step and an alternative.',
    input_schema: {
      type: 'object',
      properties: {
        nodeId: str,
        alternativeNodeId: { type: 'string', description: 'Another reachable node. Empty if there is none.' },
        reason: str,
        basedOn: { type: 'array', items: str, description: 'Ids of learning records (LR-…) or events (ev-…)' },
      },
      required: ['nodeId', 'reason', 'basedOn'],
    },
  },
];

interface Ctx {
  st: Stored;
  ev: LearningEvent;
  run: PlannerRun;
  trackId: string;
  deadline: number;
  staged: MapNode[];
  count: Record<'mapAdds' | 'generateCalls' | 'records' | 'references' | 'notes', number>;
  /** A generate_lesson call failed in this run: only then may the agent fall back to pool lessons */
  generationFailed: boolean;
  /** Valid lessons the agent generated in this run */
  generated: Lesson[];
}

class ToolError extends Error {}

const left = (ctx: Ctx) => ctx.deadline - Date.now();
const lessonsOfTrack = (ctx: Ctx) => allLessons(ctx.st.session).filter((l) => l.trackId === ctx.trackId);
const nodes = (ctx: Ctx) => [...ctx.st.session.nodes, ...ctx.staged];

function sameTrack(ctx: Ctx, trackId: unknown) {
  if (trackId !== ctx.trackId) throw new ToolError(`Only this run\'s area is allowed: ${ctx.trackId}`);
}

function learnerState(ctx: Ctx) {
  const { st, trackId } = ctx;
  const s = st.session;
  const track = trackIn(st, trackId)!;
  const lessons = allLessons(s);
  const lessonOf = (id?: string) => lessons.find((l) => l.id === id);
  const level = st.dcc.levels[trackId];
  const mission = missionOf(st, trackId);
  const rec = openRecommendation(s);
  // Nodes of other tracks only by id: their labels and the rule's reason can reveal other DCC levels.
  const label = (id?: string) => {
    const n = s.nodes.find((x) => x.id === id);
    return !n ? undefined : n.trackId === trackId ? n.label : 'Step in another area';
  };
  const generated = s.generatedLessons.filter((l) => l.provenance?.by === 'model' && l.provenance.sessionNo === s.sessionNo).length;
  return {
    track: { id: track.id, name: track.name, criteria: track.criteria, ...(track.custom ? { lessonTypes: track.custom.lessonTypes } : {}) },
    mission: mission ? { text: mission.text, status: mission.status } : { text: defaultMission(st, trackId), status: 'default' },
    // Only this track's level, from the DCC. Read-only.
    dccLevel: skillIn(st, trackId)?.dccBased ? level ?? 'not assessed' : 'not a DCC area',
    // Own tracks: what the learner said about their prior knowledge when they made the track. Not a DCC level.
    ...(track.custom ? { selfAssessment: track.custom.selfLevel } : {}),
    lernstand: track.criteria.map((c) => ({ criterion: c.id, state: lernstand(st, trackId, c.id).state })),
    activeRecords: st.records.filter((r) => r.trackId === trackId && r.status === 'active').map((r) => ({ id: r.id, kind: r.kind, criterion: r.criterion, title: r.title })),
    lastResults: s.events.filter((e) => e.trackId === trackId).slice(-5).map((e) => ({
      eventId: e.id,
      lesson: lessonOf(e.lessonId)?.title ?? e.lessonId,
      type: lessonOf(e.lessonId)?.type,
      mode: e.mode,
      helpUsed: e.helpUsed,
      attempts: e.attempts,
      met: [...new Set(e.result.criteria.filter((c) => c.status === 'met').map((c) => c.key))],
      missed: [...new Set(e.result.criteria.filter((c) => c.status === 'missed').map((c) => c.key))],
    })),
    dueReviews: dueReviews(st, trackId).map((q) => ({ criterion: q.criterion, recordId: q.recordId })),
    preferences: st.notes,
    merkblatt: (st.reference[trackId] ?? []).map((e) => e.title),
    trackNodeId: `t-${trackId}`,
    map: s.nodes.filter((n) => n.kind === 'lesson' && n.trackId === trackId).map((n) => {
      const l = lessonOf(n.lessonId);
      return { nodeId: n.id, parentNodeId: n.parentId, label: n.label, state: n.state, lessonId: n.lessonId, type: l?.type, minutes: l?.durationMin, level: l?.level, targets: l?.targets, generated: l?.source === 'model' };
    }),
    rulePlan: rec ? { ruleId: rec.ruleId, nodeId: rec.nodeId, label: label(rec.nodeId), alternativeNodeId: rec.alternativeNodeId, alternativeLabel: label(rec.alternativeNodeId) } : null,
    limits: {
      mapAddsLeft: LIMITS.mapAdds - ctx.count.mapAdds,
      generateCallsLeft: LIMITS.generateCalls - ctx.count.generateCalls,
      generatedThisSessionLeft: LIMITS.generatedPerSession - generated,
    },
  };
}

async function runTool(ctx: Ctx, name: string, input: Record<string, unknown>): Promise<unknown> {
  const { st, trackId } = ctx;
  const s = st.session;
  const bump = (key: keyof Ctx['count']) => {
    if (ctx.count[key] >= LIMITS[key]) throw new ToolError(`Limit reached: at most ${LIMITS[key]} per run`);
    ctx.count[key]++;
  };
  switch (name) {
    case 'get_learner_state':
      sameTrack(ctx, input.trackId);
      return learnerState(ctx);

    case 'list_pool_lessons': {
      sameTrack(ctx, input.trackId);
      const onMap = new Set(nodes(ctx).map((n) => n.lessonId));
      return lessonsOfTrack(ctx)
        .filter((l) => !input.criterion || l.targets.includes(String(input.criterion)))
        .map((l) => ({ lessonId: l.id, title: l.title, type: l.type, level: l.level, minutes: l.durationMin, mode: l.mode, targets: l.targets, onMap: onMap.has(l.id), source: l.source }));
    }

    case 'generate_lesson': {
      sameTrack(ctx, input.trackId);
      const generated = s.generatedLessons.filter((l) => l.provenance?.by === 'model' && l.provenance.sessionNo === s.sessionNo).length;
      if (generated >= LIMITS.generatedPerSession) throw new ToolError(`${LIMITS.generatedPerSession} lessons have already been generated in this session. Use an existing one.`);
      bump('generateCalls');
      const criterion = String(input.criterion ?? '');
      const reviewOf = Array.isArray(input.reviewOf) ? input.reviewOf.map(String) : undefined;
      const basedOn = [
        ...st.records.filter((r) => r.trackId === trackId && r.status === 'active' && [criterion, ...(reviewOf ?? [])].includes(r.criterion ?? '')).map((r) => r.id),
        ctx.ev.id,
      ];
      const r = await generateLesson({
        type: String(input.type) as LessonType,
        track: trackIn(st, trackId)!,
        criterion,
        level: String(input.level) as DccLevel,
        contextHint: input.contextHint ? String(input.contextHint).slice(0, 300) : undefined,
        reviewOf,
        mission: missionOf(st, trackId)?.text ?? defaultMission(st, trackId),
        preferences: st.notes,
        basedOn,
        sessionNo: s.sessionNo,
        timeoutMs: Math.max(1, Math.min(LIMITS.callMs(), left(ctx))),
      }, (c) => s.modelCalls.push(c));
      if (!r.ok) ctx.generationFailed = true;
      if (!r.ok) throw new ToolError(`Lesson invalid and discarded: ${r.errors.join('; ')}`);
      storeLesson(st, r.lesson);
      ctx.generated.push(r.lesson);
      return { lessonId: r.lesson.id, title: r.lesson.title, type: r.lesson.type, minutes: r.lesson.durationMin, primarySource: r.lesson.primarySource?.title };
    }

    case 'add_to_map': {
      const lesson = lessonsOfTrack(ctx).find((l) => l.id === input.lessonId);
      if (!lesson) throw new ToolError(`Lesson ${String(input.lessonId)} does not exist in this area`);
      if (nodes(ctx).some((n) => n.lessonId === lesson.id && n.state !== 'done')) throw new ToolError('This lesson is already open on the map');
      const parent = nodes(ctx).find((n) => n.id === input.parentNodeId);
      if (!parent || parent.trackId !== trackId || (parent.kind !== 'lesson' && parent.kind !== 'track')) throw new ToolError(`Parent node ${String(input.parentNodeId)} does not exist in this area`);
      const generatedSoFar = s.generatedLessons.filter((l) => l.provenance?.by === 'model' && l.provenance.sessionNo === s.sessionNo).length;
      if (lesson.source !== 'model' && !ctx.generationFailed && generatedSoFar < LIMITS.generatedPerSession) {
        throw new ToolError('First create a fitting lesson with generate_lesson. Prepared lessons only if generation fails or the limit is reached.');
      }
      bump('mapAdds');
      const node: MapNode = {
        id: `n-${lesson.id}-${s.nodes.length + ctx.staged.length}`,
        kind: 'lesson',
        parentId: parent.id,
        label: lesson.title,
        skillId: skillIn(st, trackId)?.id,
        trackId,
        lessonId: lesson.id,
        state: 'planned',
        addedByAgent: true,
      };
      ctx.staged.push(node);
      return { nodeId: node.id, note: 'The node appears when the recommendation is accepted.' };
    }

    case 'write_learning_record': {
      sameTrack(ctx, input.trackId);
      bump('records');
      const rec: RecordInput = {
        kind: String(input.kind) as RecordInput['kind'],
        trackId,
        criterion: input.criterion ? String(input.criterion) : undefined,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        evidence: Array.isArray(input.evidenceEventIds) ? input.evidenceEventIds.map(String) : [],
        supersedes: input.supersedes ? String(input.supersedes) : undefined,
        author: 'agent',
      };
      try {
        const r = addRecord(st, rec);
        return { recordId: r.id };
      } catch (err) {
        if (err instanceof RecordError) throw new ToolError(`Rejected: ${err.errors.join('; ')}`);
        throw err;
      }
    }

    case 'update_reference': {
      sameTrack(ctx, input.trackId);
      const e = (input.entry ?? {}) as Record<string, unknown>;
      const criterion = String(e.criterion ?? '');
      const demo = st.records.find((r) => r.trackId === trackId && r.criterion === criterion && r.kind === 'demonstrated' && r.status === 'active');
      if (!demo) throw new ToolError(`Only what was shown without help goes into the cheat sheet. No active demonstrated record for ${criterion}.`);
      const title = String(e.title ?? '').trim();
      const text = String(e.text ?? '').trim();
      if (!title || title.length > 60 || !text || text.length > 200) throw new ToolError('title (60) and text (200 characters) needed');
      bump('references');
      const added = addReference(st, trackId, { section: e.section === 'term' ? 'term' : 'rule', title, text, basedOn: [demo.id] });
      return { ok: true, added };
    }

    case 'note_preference': {
      const text = String(input.text ?? '').replace(/ß/g, 'ss').trim();
      if (!text || text.length > 160) throw new ToolError('text with 1 to 160 characters needed');
      bump('notes');
      if (!st.notes.some((n) => n.toLowerCase().startsWith(text.toLowerCase()))) {
        st.notes.push(`${text} (${nowIso().slice(0, 10)})`);
        writeNotes(st.profile.id, st.notes);
      }
      return { ok: true };
    }

    default:
      throw new ToolError(`Unknown tool ${name}`);
  }
}

type Outcome = { ok: true; plan: Plan } | { ok: false; reason: string };

async function loop(ctx: Ctx): Promise<Outcome> {
  const track = trackIn(ctx.st, ctx.trackId)!;
  const messages: AgentMessage[] = [{
    role: 'user',
    content: `The learner has just finished a lesson in the area “${track.name}” (event ${ctx.ev.id}). Plan the next step. trackId: ${ctx.trackId}`,
  }];
  for (let step = 1; step <= LIMITS.steps; step++) {
    if (left(ctx) <= 0) return { ok: false, reason: `Time limit of ${LIMITS.totalMs() / 1000} s reached` };
    const reply = await callAgent({ system: SYSTEM, messages, tools: TOOLS, timeoutMs: Math.min(LIMITS.callMs(), left(ctx)) });
    ctx.st.session.modelCalls.push(reply.call);
    ctx.run.steps = step;
    if (!reply.ok) return { ok: false, reason: `Model not available: ${reply.error}` };
    messages.push({ role: 'assistant', content: reply.content });
    const uses = reply.content.filter((b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return { ok: false, reason: 'The agent stopped without a recommendation' };

    const final = uses.find((u) => u.name === 'recommend');
    if (final) {
      ctx.run.tools.push('recommend');
      const i = final.input ?? {};
      const plan: Plan = {
        nodeId: String(i.nodeId ?? ''),
        alternativeNodeId: String(i.alternativeNodeId ?? ''),
        reason: String(i.reason ?? '').replace(/ß/g, 'ss').trim(),
        basedOn: Array.isArray(i.basedOn) ? i.basedOn.map(String) : [],
      };
      // Nothing else reachable (one track, one new node): there is no alternative to offer.
      if (![...reachableIds(ctx.st, ctx.staged)].some((id) => id !== plan.nodeId)) plan.alternativeNodeId = '';
      const problems = checkPlan(ctx.st, plan, { nodes: ctx.staged, lessons: [] });
      return problems.length ? { ok: false, reason: `Plan rejected: ${problems.join('; ')}` } : { ok: true, plan };
    }

    // All results of one turn go back in one user message.
    const results: AgentBlock[] = [];
    for (const u of uses) {
      ctx.run.tools.push(u.name);
      try {
        const out = await runTool(ctx, u.name, u.input ?? {});
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { ok: false, reason: `No recommendation after ${LIMITS.steps} steps` };
}

/**
 * The agent's plan replaces the provisional rule plan: nodes the rules added only for it go again,
 * unless the agent chose them. Rule template lessons nobody uses any more go too.
 */
function dropProvisional(st: Stored, ruleRecId: string | undefined, keep: string[]) {
  const s = st.session;
  const drop = s.nodes.filter((n) => n.provisionalOf && n.provisionalOf === ruleRecId && !keep.includes(n.id) && n.state !== 'done');
  s.nodes = s.nodes.filter((n) => !drop.includes(n));
  for (const n of s.nodes) if (n.provisionalOf) delete n.provisionalOf;
  for (const lessonId of new Set(drop.map((n) => n.lessonId))) {
    const l = s.generatedLessons.find((x) => x.id === lessonId);
    if (!l || l.provenance?.by !== 'rule' || s.nodes.some((n) => n.lessonId === lessonId)) continue;
    s.generatedLessons = s.generatedLessons.filter((x) => x !== l);
    deleteLesson(st.profile.id, l.id);
  }
}

/** What the agent cited, in words, for "What the agent saw". */
function observation(ctx: Ctx, basedOn: string[]): string {
  const s = ctx.st.session;
  const lessons = allLessons(s);
  return basedOn.map((id) => {
    const r = ctx.st.records.find((x) => x.id === id);
    if (r) return `${r.id}: ${r.title}`;
    const e = s.events.find((x) => x.id === id);
    if (e) return `“${lessons.find((l) => l.id === e.lessonId)?.title ?? e.lessonId}”: ${e.result.summary}`;
    return '';
  }).filter(Boolean).join(' · ');
}

export async function runPlanner(st: Stored, ev: LearningEvent): Promise<void> {
  const s = st.session;
  const run: PlannerRun = { id: newId('pr'), eventId: ev.id, trackId: ev.trackId, startedAt: nowIso(), steps: 0, outcome: 'running', note: '', tools: [] };
  s.plannerRuns.push(run);
  const ruleRec = openRecommendation(s);
  const ctx: Ctx = {
    st, ev, run, trackId: ev.trackId, deadline: Date.now() + LIMITS.totalMs(), staged: [],
    count: { mapAdds: 0, generateCalls: 0, records: 0, references: 0, notes: 0 },
    generationFailed: false,
    generated: [],
  };

  let outcome: Outcome;
  try {
    outcome = await loop(ctx);
  } catch (err) {
    outcome = { ok: false, reason: `Error in the agent: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The learner may have moved on meanwhile: then the agent's plan is out of date.
  const current = openRecommendation(s);
  if (outcome.ok && (s.events.at(-1)?.id !== ev.id || !current || current.id !== ruleRec?.id)) {
    outcome = { ok: false, reason: 'Discarded: the learner has already chosen meanwhile' };
  }

  if (outcome.ok) {
    const { plan } = outcome;
    s.nodes.push(...ctx.staged);
    const label = (id: string) => s.nodes.find((n) => n.id === id)?.label ?? id;
    const rec: Recommendation = {
      id: newId('r'),
      createdAt: nowIso(),
      ruleId: 'A1',
      ruleName: RULE_NAME.A1,
      nodeId: plan.nodeId,
      alternativeNodeId: plan.alternativeNodeId || undefined,
      observation: observation(ctx, plan.basedOn),
      reason: plan.reason,
      why: 'The learning agent chose this lesson based on your goal and your results so far.',
      tags: ['model', 'rule'],
      status: 'open',
      basedOn: plan.basedOn,
    };
    applyRecommendation(s, rec);
    dropProvisional(st, ruleRec?.id, [plan.nodeId, plan.alternativeNodeId]);
    const added = ctx.staged.map((n) => n.label);
    Object.assign(run, { outcome: 'accepted', note: `A1: ${label(plan.nodeId)}${added.length ? `. New on the map: ${added.join(', ')}` : ''}. Replaces ${ruleRec?.ruleId ?? 'the rules\' plan'}.` });
  } else {
    for (const n of s.nodes) if (n.provisionalOf) delete n.provisionalOf;
    if (current?.provisional) delete current.provisional;
    // Generation failed: the rules take over and may use the whole pool of this track.
    // Own tracks have no pool: there a valid lesson the agent made goes on the map, else the rules let the generator write one.
    const stillOpen = () => current && current.id === ruleRec?.id && openRecommendation(s)?.id === current.id;
    const filled = stillOpen() ? fillFromPool(st, ev.trackId) : 0;
    const written = !filled && stillOpen() ? await ruleLesson(st, ev.trackId, ctx.generated) : null;
    if (filled || (written && stillOpen())) recommend(st);
    const reused = written && ctx.generated.some((l) => l.id === written.lessonId);
    const how = filled ? ` with ${filled} prepared lessons` : reused ? ' with the lesson the agent generated' : written ? ' with a lesson whose goal the rules chose' : '';
    Object.assign(run, { outcome: 'fallback', note: `Plan by rules${how}. Reason: ${outcome.reason}` });
    console.warn(`Planner ${run.id} (${ev.trackId}): falling back to rules. ${outcome.reason}`);
  }
  run.finishedAt = nowIso();
  save(st);
}

/** For tests: the tool definitions the model sees. */
export const _tools = TOOLS;
export const _system = SYSTEM;
