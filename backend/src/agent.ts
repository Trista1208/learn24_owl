// The learning agent. Rules decide, the model only writes (chat replies, hints, judging free text).
// 1. For each track the learner adds it plans lessons from the DCC profile (the faded nodes on the mind map).
// 2. After every lesson it picks the next step, explains why and offers an alternative.
// 3. It grows the map: new nodes when something was hard twice or too easy.
// It never changes the DCC profile, and missing DCC values are treated as unknown, not low.
import type {
  AiChatLesson, DccLevel, DccProfile, LearningEvent, Lesson, MapNode, Observation, RuleId, Skill, Source, Track,
} from '@l45/shared';
import { DCC_LEVEL_LABEL, DCC_LEVELS } from '@l45/shared';

export interface Decision {
  ruleId: RuleId;
  ruleName: string;
  /** Node to recommend. Missing = nothing fits (time is up, or all done) */
  nodeId?: string;
  alternativeNodeId?: string;
  observation: string;
  reason: string;
  why: string;
  tags: Source[];
  /** Nodes the agent adds to the map for this decision */
  newNodes: MapNode[];
  /** Lessons the agent created for these nodes */
  newLessons: Lesson[];
}

export const RULE_NAME: Record<RuleId, string> = {
  R0: 'Next on the learning path',
  R1: 'Repeated difficulty',
  R2: 'Not challenged enough',
  R3: 'Start from the DCC profile',
  R5: 'Alternative chosen',
  R6: 'Help in the exercise',
  R7: 'Area completed',
  R8: 'Area chosen',
  A1: 'Agent plan',
};

// --- Initial plan --------------------------------------------------------------------------

const byLevel = (lessons: Lesson[], trackId: string, level: DccLevel) => lessons.filter((l) => l.trackId === trackId && l.level === level);

/** Which lessons to place on a track's branch, given the DCC level. undefined = skill without DCC. */
export function planTrack(track: Track, level: DccLevel | null | undefined, lessons: Lesson[]): Lesson[] {
  const G = byLevel(lessons, track.id, 'Grundstufe');
  const M = byLevel(lessons, track.id, 'Mittelstufe');
  const F = byLevel(lessons, track.id, 'Fortgeschritten');
  if (level === undefined) return [...G, ...M].slice(0, 3);
  // Not assessed: a short starter, then one step up. No assumption that the level is low.
  if (level === null) return [[...G].sort((a, b) => a.durationMin - b.durationMin)[0], M[0]].filter(Boolean) as Lesson[];
  if (level === 'Grundstufe') return G.slice(0, 3);
  if (level === 'Mittelstufe') return [...M, ...F].slice(0, 3);
  return [...F, ...M].slice(0, 2);
}

// --- Decisions ---------------------------------------------------------------------------------

export interface AgentInput {
  /** The learner's skills with the tracks on their map */
  skills: Skill[];
  dcc: DccProfile;
  nodes: MapNode[];
  events: LearningEvent[];
  observations: Observation[];
  lessons: Lesson[];
  /** For unique ids of agent-created lessons */
  counter: number;
  /** A track the learner just added or asked a new lesson for: go there (R8) */
  focusTrackId?: string;
}

const levelRank = (l: DccLevel) => DCC_LEVELS.indexOf(l);

function trackPriority(input: AgentInput, trackId: string): number {
  const skill = input.skills.find((s) => s.tracks.some((t) => t.id === trackId));
  if (!skill?.dccBased) return 10;
  const level = input.dcc.levels[trackId];
  // Foundation level first (largest need according to the DCC), then not assessed (short starter), then higher levels.
  if (level === 'Grundstufe') return 0;
  if (level === null || level === undefined) return 1;
  return 2 + levelRank(level);
}

const lessonOf = (input: AgentInput, n?: MapNode) => (n?.lessonId ? input.lessons.find((l) => l.id === n.lessonId) : undefined);
const trackOf = (input: AgentInput, id: string) => input.skills.flatMap((s) => s.tracks).find((t) => t.id === id)!;
const label = (input: AgentInput, trackId: string, crit: string) => trackOf(input, trackId).criteria.find((c) => c.id === crit)?.label ?? crit;

/** Planned nodes that can be done next: their parent is not itself still planned. */
export function frontier(input: Pick<AgentInput, 'nodes'>, trackId?: string): MapNode[] {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  return input.nodes.filter((n) => {
    if (n.kind !== 'lesson' || n.state !== 'planned') return false;
    if (trackId && n.trackId !== trackId) return false;
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    return !parent || parent.kind !== 'lesson' || parent.state === 'done' || parent.state === 'skipped';
  });
}

function tracksByPriority(input: AgentInput, exclude?: string): string[] {
  return input.skills.flatMap((s) => s.tracks.map((t) => t.id))
    .filter((id) => id !== exclude && frontier(input, id).length > 0)
    .sort((a, b) => trackPriority(input, a) - trackPriority(input, b));
}

function lastDoneNode(input: AgentInput, trackId: string): MapNode {
  const done = input.nodes.filter((n) => n.trackId === trackId && n.kind === 'lesson' && n.state === 'done');
  return done.at(-1) ?? input.nodes.find((n) => n.kind === 'track' && n.trackId === trackId)!;
}

function inMap(input: AgentInput, lessonId: string) {
  return input.nodes.some((n) => n.lessonId === lessonId);
}

function newNode(input: AgentInput, lesson: Lesson, parentId: string): MapNode {
  return {
    id: `n-${lesson.id}-${input.counter}`,
    kind: 'lesson',
    parentId,
    label: lesson.title,
    skillId: input.skills.find((s) => s.tracks.some((t) => t.id === lesson.trackId))?.id,
    trackId: lesson.trackId,
    lessonId: lesson.id,
    state: 'planned',
    addedByAgent: true,
  };
}

export function keywordPatterns(text: string): string[] {
  const words = text.toLowerCase().replace(/[«»“”".,:;!?()]/g, ' ').split(/\s+/).filter((w) => w.length >= 5);
  return [...new Set(words)].slice(0, 8).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** A short AI conversation about exactly the criterion that was missed twice. Created by the agent. */
export function clarifyLesson(track: Track, criterionId: string, n: number): AiChatLesson {
  const c = track.criteria.find((x) => x.id === criterionId) ?? { id: criterionId, label: criterionId, ruleOfThumb: '' };
  return {
    id: `klaeren-${track.id}-${criterionId}-${n}`,
    trackId: track.id,
    type: 'ai-chat',
    level: 'Grundstufe',
    title: `Clear it up with the AI: ${c.label}`,
    intro: `You missed “${c.label}” twice. Work out with the AI how to recognise it.`,
    durationMin: 3,
    mode: 'ai',
    targets: [criterionId],
    transfer: c.ruleOfThumb,
    source: 'prepared',
    content: {
      kind: 'tutor',
      goal: `At the end you say in one sentence how you recognise “${c.label}” and how you check it.`,
      aiRole: `You are a learning coach. In exercises in the area “${track.name}” the learner missed “${c.label}” twice. Ask follow-up questions that help them understand how to recognise it and how to check it. The goal is this rule of thumb: “${c.ruleOfThumb}”. Do not give it away straight away; let the learner put it into words themselves.`,
      opening: `In your last exercises you missed “${c.label}” twice. Why do you think it is easy to overlook?`,
      criteria: [{ id: criterionId, label: c.label, hint: c.ruleOfThumb, patterns: keywordPatterns(`${c.label} ${c.ruleOfThumb}`) }],
      fallbackReplies: [
        'Thanks. Next time, what could tell you sooner that you need to look closely here?',
        'Good. How exactly would you check it, step by step?',
        `Now sum it up in a sentence of your own. For comparison, the rule of thumb: “${c.ruleOfThumb}”`,
        'Thanks. You can finish the lesson now.',
      ],
      minTurns: 3,
    },
  };
}

export function decide(input: AgentInput): Decision {
  const base = { newNodes: [] as MapNode[], newLessons: [] as Lesson[] };
  const last = input.events.at(-1);

  // R8: the learner just chose a track (added it, or asked for a new lesson there) -> go there.
  const chosen = input.focusTrackId ? frontier(input, input.focusTrackId)[0] : undefined;
  if (chosen) {
    const t = trackOf(input, input.focusTrackId!);
    const other = tracksByPriority(input, t.id)[0];
    const fresh = !input.events.some((e) => e.trackId === t.id);
    return {
      ...base,
      ruleId: 'R8',
      ruleName: RULE_NAME.R8,
      nodeId: chosen.id,
      alternativeNodeId: other ? frontier(input, other)[0]?.id : undefined,
      observation: fresh ? `“${t.name}” is new on your map.` : `New lesson requested in “${t.name}”.`,
      reason: fresh ? `You just added “${t.name}”. The starter shows where you begin.` : `On in “${t.name}” with what comes next.`,
      why: fresh
        ? 'A short starter shows what you can already do. After that the next lessons adapt to you.'
        : 'This lesson practises what was still missing last time, or something new.',
      tags: ['rule'],
    };
  }

  // R3: nothing done yet -> start where the DCC profile shows the largest need.
  if (!last) {
    const order = tracksByPriority(input);
    const first = order[0];
    if (!first) {
      return {
        ...base, ruleId: 'R7', ruleName: RULE_NAME.R7, tags: ['rule'],
        observation: 'No area on the map yet.',
        reason: 'Add an area: your own topic or a prepared area.',
        why: 'You decide which topics you learn.',
      };
    }
    const node = frontier(input, first)[0];
    const alt = order[1] ? frontier(input, order[1])[0] : undefined;
    const t = trackOf(input, first);
    if (!input.skills.find((s) => s.tracks.includes(t))?.dccBased) {
      return {
        ...base,
        ruleId: 'R3',
        ruleName: RULE_NAME.R3,
        nodeId: node.id,
        alternativeNodeId: alt?.id,
        observation: `“${t.name}” has no DCC position.`,
        reason: `Start with the starter in “${t.name}”.`,
        why: 'A short starter shows what you can already do. After that the next lessons adapt to you.',
        tags: ['rule'],
      };
    }
    const level = input.dcc.levels[first];
    const notAssessed = level === null || level === undefined;
    return {
      ...base,
      ruleId: 'R3',
      ruleName: RULE_NAME.R3,
      nodeId: node.id,
      alternativeNodeId: alt?.id,
      observation: notAssessed ? `There is no DCC result for “${t.name}”.` : `DCC profile: ${DCC_LEVEL_LABEL[level]} in “${t.name}”.`,
      reason: notAssessed ? `A DCC result is missing for “${t.name}”. A short starter shows where you begin.` : `According to your DCC profile, “${t.name}” is where you have the most to gain.`,
      why: notAssessed
        ? 'A missing test value does not mean low competence. So first a short starter instead of a whole course.'
        : 'The lesson fits your level.',
      tags: ['rule'],
    };
  }

  const T = last.trackId;
  const track = trackOf(input, T);
  const trackEvents = input.events.filter((e) => e.trackId === T);

  // R1: the same criterion missed twice -> the agent creates a short AI conversation about exactly that.
  const repeated = input.observations
    .filter((o) => o.trackId === T && o.status === 'active' && o.count >= 2)
    .find((o) => !input.nodes.some((n) => n.lessonId?.startsWith(`klaeren-${T}-${o.criterion}-`)));
  if (repeated && track.criteria.some((c) => c.id === repeated.criterion)) {
    const lesson = clarifyLesson(track, repeated.criterion, input.counter);
    const parent = lastDoneNode(input, T);
    const node = newNode(input, lesson, parent.id);
    // Alternative on the same fork: another example alone, targeting the same criterion.
    const altLesson = input.lessons.find((l) => l.trackId === T && l.mode === 'alone' && l.targets.includes(repeated.criterion) && !inMap(input, l.id));
    const altNode = altLesson ? newNode({ ...input, counter: input.counter + 1 }, altLesson, parent.id) : frontier(input, T)[0];
    return {
      newLessons: [lesson],
      newNodes: altLesson && altNode ? [node, altNode] : [node],
      ruleId: 'R1',
      ruleName: RULE_NAME.R1,
      nodeId: node.id,
      alternativeNodeId: altNode?.id,
      observation: repeated.text,
      reason: `You missed “${label(input, T, repeated.criterion)}” ${repeated.count}×.`,
      why: 'When the same mistake happens several times, a short conversation helps you understand it. After that you practise on your own again.',
      tags: ['rule', 'model'],
    };
  }

  // R2: the last two lessons in this track went smoothly -> add a harder one.
  const lastTwo = trackEvents.slice(-2);
  const fluent = lastTwo.length === 2 && lastTwo.every((e) => e.result.allMet && !e.helpUsed && e.attempts <= 1);
  if (fluent) {
    const levels = lastTwo.map((e) => input.lessons.find((l) => l.id === e.lessonId)?.level ?? 'Grundstufe');
    const top = Math.max(...levels.map(levelRank));
    const harder = input.lessons.find((l) => l.trackId === T && levelRank(l.level) > top && !inMap(input, l.id));
    if (harder) {
      const parent = lastDoneNode(input, T);
      const node = newNode(input, harder, parent.id);
      const other = tracksByPriority(input, T)[0];
      const alt = other ? frontier(input, other)[0] : undefined;
      return {
        newLessons: [],
        newNodes: [node],
        ruleId: 'R2',
        ruleName: RULE_NAME.R2,
        nodeId: node.id,
        alternativeNodeId: alt?.id,
        observation: `Solved the last two lessons in “${track.name}” without help.`,
        reason: `That already works well. The agent adds a more demanding lesson (${DCC_LEVEL_LABEL[harder.level]}).`,
        why: 'That was easy for you. Something harder will teach you more.',
        tags: ['rule'],
      };
    }
  }

  // R0: continue. Aim at what was missed last time, otherwise keep going in this track.
  const missed = last.result.criteria.filter((c) => c.status === 'missed' && c.key !== 'entscheid').map((c) => c.key);
  const helped = last.helpUsed || last.attempts > 1 ? last.result.criteria.filter((c) => c.key !== 'entscheid').map((c) => c.key) : [];
  const focus = [...new Set([...missed, ...helped])];
  const otherTrack = tracksByPriority(input, T)[0];
  const altOther = otherTrack ? frontier(input, otherTrack)[0] : undefined;

  if (focus.length) {
    const planned = frontier(input, T).find((n) => lessonOf(input, n)?.targets.some((t) => focus.includes(t)));
    const fromPool = planned ? undefined : input.lessons.find((l) => l.trackId === T && l.mode === 'alone' && l.targets.some((t) => focus.includes(t)) && !inMap(input, l.id));
    const node = planned ?? (fromPool ? newNode(input, fromPool, lastDoneNode(input, T).id) : undefined);
    if (node) {
      const crit = (lessonOf(input, node) ?? fromPool)!.targets.find((t) => focus.includes(t))!;
      const wasHelped = !missed.includes(crit);
      return {
        newLessons: [],
        newNodes: planned ? [] : [node],
        ruleId: 'R0',
        ruleName: RULE_NAME.R0,
        nodeId: node.id,
        alternativeNodeId: altOther?.id,
        observation: wasHelped ? `Found “${label(input, T, crit)}” with a hint.` : `Missed “${label(input, T, crit)}” last time.`,
        reason: wasHelped ? `You needed a hint for “${label(input, T, crit)}”.` : `You missed “${label(input, T, crit)}” last time.`,
        why: 'Another example of the same thing shows whether it now works on your own.',
        tags: ['rule'],
      };
    }
  }

  const next = frontier(input, T)[0];
  if (next) {
    return {
      ...base,
      ruleId: 'R0',
      ruleName: RULE_NAME.R0,
      nodeId: next.id,
      alternativeNodeId: altOther?.id,
      observation: last.result.allMet ? 'Last lesson fully solved.' : 'Last lesson finished.',
      reason: `On in “${track.name}”.`,
      why: 'Carrying on in the same area helps to consolidate what you learned.',
      tags: ['rule'],
    };
  }

  if (otherTrack && altOther) {
    const t2 = trackOf(input, otherTrack);
    const second = tracksByPriority(input, T)[1];
    return {
      ...base,
      ruleId: 'R7',
      ruleName: RULE_NAME.R7,
      nodeId: altOther.id,
      alternativeNodeId: second ? frontier(input, second)[0]?.id : undefined,
      observation: `All planned lessons in “${track.name}” done.`,
      reason: `On with “${t2.name}”, the next area according to your DCC profile.`,
      why: 'The topic where you can learn the most comes first.',
      tags: ['rule'],
    };
  }
  return { ...base, ruleId: 'R7', ruleName: RULE_NAME.R7, observation: 'All planned lessons done.', reason: 'You have done everything on your map.', why: 'Choose a new topic or have another lesson created.', tags: ['rule'] };
}

// --- Observations ---------------------------------------------------------------------------

export function updateObservations(obs: Observation[], ev: LearningEvent, criterionText: (trackId: string, key: string) => string, makeId: () => string): Observation[] {
  const next = obs.map((o) => ({ ...o }));
  const seen = new Set<string>();
  for (const c of ev.result.criteria) {
    if (seen.has(`${c.key}:${c.status}`)) continue;
    seen.add(`${c.key}:${c.status}`);
    const active = next.find((o) => o.trackId === ev.trackId && o.criterion === c.key && o.status === 'active');
    const name = c.key === 'entscheid' ? c.label : criterionText(ev.trackId, c.key);
    if (c.status === 'missed') {
      if (active) {
        active.count += 1;
        active.text = `Missed “${name}” ${active.count}×`;
      } else {
        next.push({ id: makeId(), trackId: ev.trackId, criterion: c.key, text: `Missed “${name}” 1×`, count: 1, status: 'active', createdAt: ev.at });
      }
    } else if (active && !ev.helpUsed && !ev.result.criteria.some((x) => x.key === c.key && x.status === 'missed')) {
      active.status = 'outdated';
    }
  }
  return next;
}
