// The planner agent with a scripted mock model: accepted plans (A1), fallbacks to the rules, evidence checks,
// DCC immutability and what reaches the model.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionView } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { setMockAgentHandler, setMockHandler, type AgentRequest, type ModelRequest } from '../src/provider.ts';
import { _idle, _reset } from '../src/sessions.ts';
import { learnersRoot } from '../src/workspace.ts';
import { finish, levels, login, mockSiteJson, node, s1MissLink, s1Right, scripted, session, use, v1MissLink, v1Right, type Turn } from './helpers.ts';

const app = createApp();

beforeEach(() => {
  _reset();
  process.env.MODEL_PROVIDER = 'mock';
  setMockHandler((req) => (req.purpose === 'generate' ? mockSiteJson() : 'Good. What else do you notice?'));
});
afterEach(async () => {
  await _idle();
  setMockHandler(null);
  setMockAgentHandler(null);
  process.env.MODEL_PROVIDER = 'none';
  delete process.env.PLANNER_TOTAL_MS;
});

/** A whole valid plan: read state, generate a lesson for "link", hang it on the done node, recommend it. */
const goodPlan = (seen?: AgentRequest[]) => scripted([
  () => [use('get_learner_state', { trackId: 't-sicherheit' })],
  () => [use('generate_lesson', { type: 'mock-site', trackId: 't-sicherheit', criterion: 'link', level: 'Grundstufe', contextHint: 'Customer email with an invoice link' })],
  (t) => {
    const done = t.state!.map.filter((n) => n.state === 'done').at(-1)!;
    return [use('add_to_map', { lessonId: (t.results[0].content as { lessonId: string }).lessonId, parentNodeId: done.nodeId })];
  },
  (t) => [use('recommend', {
    nodeId: (t.results[0].content as { nodeId: string }).nodeId,
    alternativeNodeId: t.state!.rulePlan!.nodeId,
    reason: 'You found the warning signs. Now you practise the link target on an email like the ones at work.',
    basedOn: [t.state!.activeRecords[0].id, t.state!.lastResults.at(-1)!.eventId],
  })],
], seen);

async function afterLesson(lessonId = 'sich-v1', answer: unknown = v1Right, body: Record<string, unknown> = {}): Promise<SessionView> {
  const v = await login(app, body);
  const after = await finish(app, v, node(v, lessonId), answer);
  await _idle();
  return session(app, after.session.id);
}

const learnerDir = (v: SessionView) => join(learnersRoot(), v.session.learnerId);

describe('Planner agent', () => {
  it('adds nodes and recommends with A1, based on learning records', async () => {
    setMockAgentHandler(goodPlan());
    const v = await login(app);
    const after = await finish(app, v, node(v, 'sich-v1'), v1Right);
    // Right after the lesson: the rule plan, marked provisional, while the agent plans.
    expect(after.session.planning).toBe(true);
    expect(after.recommendation?.provisional).toBe(true);
    expect(after.recommendation?.ruleId).not.toBe('A1');

    await _idle();
    const s = await session(app, v.session.id);
    expect(s.session.planning).toBe(false);
    const rec = s.recommendation!;
    expect(rec.ruleId).toBe('A1');
    expect(rec.ruleName).toBe('Agent plan');
    expect(rec.tags).toEqual(['model', 'rule']);
    expect(rec.provisional).toBeUndefined();
    expect(rec.basedOn!.some((id) => id.startsWith('LR-'))).toBe(true);
    expect(rec.alternativeNodeId).toBeTruthy();

    const added = s.session.nodes.find((n) => n.id === rec.nodeId)!;
    expect(added.addedByAgent).toBe(true);
    expect(added.state).toBe('recommended');
    expect(s.session.plannerRuns.at(-1)).toMatchObject({ outcome: 'accepted', tools: ['get_learner_state', 'generate_lesson', 'add_to_map', 'recommend'] });

    // The generated lesson: labelled, with a primary source and provenance, without solutions in the browser.
    const gen = (await request(app).get(`/api/sessions/${v.session.id}/lessons`).expect(200)).body;
    const lesson = gen.find((l: { id: string }) => l.id === added.lessonId);
    expect(lesson.source).toBe('model');
    expect(lesson.primarySource.url).toBe('https://www.bacs.admin.ch/de/phishing-de');
    expect(lesson.provenance).toMatchObject({ by: 'model', model: 'mock', sessionNo: 1 });
    expect(JSON.stringify(lesson.content)).not.toContain('"signal"');
    // ... and on disk as lessons/0001-<slug>.json
    expect(readdirSync(join(learnerDir(v), 'lessons'))).toContain('0001-check-a-customer-email-with-a-link.json');
  });

  it('falls back to the rules on an invalid plan and records the reason', async () => {
    setMockAgentHandler(scripted([
      () => [use('get_learner_state', { trackId: 't-sicherheit' })],
      (t) => [use('recommend', { nodeId: 'n-does-not-exist', alternativeNodeId: t.state!.rulePlan!.nodeId, reason: 'Because.', basedOn: [] })],
    ]));
    const s = await afterLesson();
    expect(s.recommendation!.ruleId).toMatch(/^R/);
    expect(s.recommendation!.provisional).toBeUndefined();
    const run = s.session.plannerRuns.at(-1)!;
    expect(run.outcome).toBe('fallback');
    expect(run.note).toMatch(/Plan by rules/);
    expect(run.note).toMatch(/n-does-not-exist does not exist/);
    expect(run.note).toMatch(/at least one learning record/);
  });

  it('falls back to the rules on a timeout', async () => {
    process.env.PLANNER_TOTAL_MS = '150';
    setMockAgentHandler(() => new Promise((resolve) => setTimeout(() => resolve([use('get_learner_state', { trackId: 't-sicherheit' })]), 1000)));
    const s = await afterLesson();
    expect(s.recommendation!.ruleId).toMatch(/^R/);
    const run = s.session.plannerRuns.at(-1)!;
    expect(run.outcome).toBe('fallback');
    expect(run.note).toMatch(/timeout/);
    expect(s.session.modelCalls.some((c) => c.purpose === 'plan' && c.fallback)).toBe(true);
  });

  it('discards a broken lesson, allows a second attempt and then falls back', async () => {
    setMockHandler((req) => (req.purpose === 'generate' ? mockSiteJson({ domain: 'kundenportal.ch' }) : 'ok'));
    const results: Turn['results'][] = [];
    const gen = () => [use('generate_lesson', { type: 'mock-site', trackId: 't-sicherheit', criterion: 'link', level: 'Grundstufe', contextHint: 'Customer email' })];
    setMockAgentHandler(scripted([
      gen,
      (t) => (results.push(t.results), gen()),
      (t) => (results.push(t.results), gen()),
      (t) => (results.push(t.results), [use('recommend', { nodeId: 'n-x', alternativeNodeId: 'n-y', reason: 'x', basedOn: ['ev-x'] })]),
    ]));
    const s = await afterLesson();
    expect(results[0][0]).toMatchObject({ isError: true });
    expect(String(results[0][0].content)).toMatch(/invalid and discarded.*kundenportal\.ch/);
    expect(String(results[1][0].content)).toMatch(/invalid/);
    expect(String(results[2][0].content)).toMatch(/Limit reached/);
    expect(s.session.plannerRuns.at(-1)!.outcome).toBe('fallback');
    expect(existsSync(join(learnerDir(s), 'lessons'))).toBe(false);
  });

  it('rejects a demonstrated record without matching evidence', async () => {
    let answer: Turn['results'] = [];
    setMockAgentHandler(scripted([
      () => [use('get_learner_state', { trackId: 't-sicherheit' })],
      (t) => [use('write_learning_record', {
        kind: 'demonstrated', trackId: 't-sicherheit', criterion: 'link', title: 'Link target solid', body: 'Recognises the link target.',
        evidenceEventIds: [t.state!.lastResults.at(-1)!.eventId],
      })],
      (t) => ((answer = t.results), [use('recommend', { nodeId: 'n-x', alternativeNodeId: 'n-y', reason: 'x', basedOn: [] })]),
    ]));
    const s = await afterLesson('sich-v1', v1MissLink);
    expect(answer[0].isError).toBe(true);
    expect(String(answer[0].content)).toMatch(/"demonstrated" needs evidence/);
    expect(s.workspace.records.some((r) => r.criterion === 'link' && r.kind === 'demonstrated')).toBe(false);
    // The rules did record what the evidence carries: the address question was right without help.
    expect(s.workspace.records.some((r) => r.criterion === 'adresse' && r.kind === 'demonstrated' && r.author === 'rule')).toBe(true);
    expect(s.workspace.lernstand.find((l) => l.trackId === 't-sicherheit' && l.criterion === 'link')!.state).toBe('unbekannt');
    expect(s.workspace.lernstand.find((l) => l.trackId === 't-sicherheit' && l.criterion === 'adresse')!.state).toBe('sicher');
  });

  it('never changes the DCC levels after several lessons with an active agent', async () => {
    setMockAgentHandler(goodPlan());
    let v = await login(app);
    const before = JSON.stringify(v.dcc);
    for (let i = 0; i < 3; i++) {
      const n = v.session.nodes.find((x) => x.state === 'recommended')!;
      const l = (await request(app).get('/api/content')).body.lessons.find((x: { id: string }) => x.id === n.lessonId);
      const type = l?.type ?? 'mock-site';
      const answer = type === 'video' ? { type, answers: {} } : type === 'mock-site' ? s1Right : type === 'mark-evidence' ? { type, marks: {} } : { type, turns: [{ role: 'learner', text: 'I check the link target.' }] };
      await finish(app, v, n, answer);
      await _idle();
      v = await session(app, v.session.id);
    }
    expect(v.session.events.length).toBe(3);
    expect(v.session.plannerRuns.length).toBe(3);
    expect(JSON.stringify(v.dcc)).toBe(before);
    const profile = JSON.parse(readFileSync(join(learnerDir(v), 'profile.json'), 'utf8'));
    expect(profile.dccSnapshots).toHaveLength(1);
    expect(JSON.stringify(profile.dccSnapshots[0].profile)).toBe(before);
  });

  it('sends the model neither the name nor the DCC levels of other areas', async () => {
    const seen: AgentRequest[] = [];
    const generated: ModelRequest[] = [];
    setMockHandler((req) => {
      generated.push(req);
      return req.purpose === 'generate' ? mockSiteJson() : 'ok';
    });
    setMockAgentHandler(goodPlan(seen));
    const s = await afterLesson('sich-v1', v1Right, { name: 'Zoe Samplename' });
    expect(s.recommendation!.ruleId).toBe('A1');
    expect(seen.length).toBeGreaterThan(2);
    expect(generated.some((r) => r.purpose === 'generate')).toBe(true);

    // What the model reads: system prompt, messages and tool results (tool schemas list the level names as an enum).
    const sent = [...seen.map((r) => JSON.stringify({ system: r.system, messages: r.messages })), ...generated.map((r) => JSON.stringify(r))].join('\n');
    expect(sent).not.toContain('Zoe');
    expect(sent).not.toContain('Samplename');
    expect(sent).not.toContain(s.session.learnerId);
    expect(sent).not.toContain(s.session.id);
    // Only this track's level (Grundstufe) is there. All other tracks are 'Fortgeschritten' and must not show up.
    expect(Object.values(levels).filter((l) => l === 'Fortgeschritten')).toHaveLength(4);
    expect(sent).not.toContain('Fortgeschritten');
    for (const t of ['t-info', 't-komm', 't-inhalte', 't-problem', 't-analysis', 't-physik']) expect(sent).not.toContain(`"${t}"`);
    expect(sent).not.toMatch(/Information and data literacy|Communication and collaboration/);
    expect(sent).toMatch(/dccLevel\W+Grundstufe/);
  });

  it('plans by rules without the agent when the model is missing', async () => {
    process.env.MODEL_PROVIDER = 'none';
    const s = await afterLesson('sich-s1', s1Right);
    expect(s.agentAvailable).toBe(false);
    expect(s.session.planning).toBe(false);
    expect(s.session.plannerRuns).toHaveLength(0);
    expect(s.recommendation!.provisional).toBeUndefined();
    // The node the rules recommended before (and the learner skipped) is open again for the next decision.
    expect(s.recommendation).toMatchObject({ ruleId: 'R0', nodeId: 'n-sich-v1' });
  });
});

describe('AI first, prepared lessons as a fallback', () => {
  const lessonsOn = (v: SessionView, trackId: string) => v.session.nodes.filter((n) => n.kind === 'lesson' && n.trackId === trackId);
  const tracks = ['t-info', 't-komm', 't-inhalte', 't-sicherheit', 't-problem', 't-analysis', 't-physik'];

  it('starts with one lesson per area with AI, with the whole plan without AI', async () => {
    const ai = await login(app);
    for (const t of tracks) expect(lessonsOn(ai, t), t).toHaveLength(1);
    process.env.MODEL_PROVIDER = 'none';
    const offline = await login(app, { name: 'Offline' });
    expect(tracks.reduce((sum, t) => sum + lessonsOn(offline, t).length, 0)).toBeGreaterThan(tracks.length);
  });

  it('attaches a prepared lesson only once generation has failed', async () => {
    const answers: Turn['results'][] = [];
    setMockHandler((req) => (req.purpose === 'generate' ? mockSiteJson({ domain: 'kundenportal.ch' }) : 'ok'));
    const add = () => [use('add_to_map', { lessonId: 'sich-s1', parentNodeId: 'n-sich-v1' })];
    setMockAgentHandler(scripted([
      add,
      (t) => (answers.push(t.results), [use('generate_lesson', { type: 'mock-site', trackId: 't-sicherheit', criterion: 'link', level: 'Grundstufe', contextHint: 'Email' })]),
      (t) => (answers.push(t.results), add()),
      (t) => (answers.push(t.results), [use('recommend', { nodeId: 'n-x', alternativeNodeId: 'n-y', reason: 'x', basedOn: [] })]),
    ]));
    await afterLesson();
    expect(String(answers[0][0].content)).toMatch(/First create a fitting lesson with generate_lesson/);
    expect(answers[1][0].isError).toBe(true);
    expect(answers[2][0]).toMatchObject({ isError: false });
  });

  it('removes nodes of the provisional rule plan when the agent plan applies', async () => {
    setMockAgentHandler(scripted([
      () => [use('get_learner_state', { trackId: 't-sicherheit' })],
      () => [use('generate_lesson', { type: 'mock-site', trackId: 't-sicherheit', criterion: 'link', level: 'Grundstufe', contextHint: 'Invoice email' })],
      (t) => [use('add_to_map', { lessonId: (t.results[0].content as { lessonId: string }).lessonId, parentNodeId: 'n-sich-v1' })],
      (t) => [use('recommend', {
        nodeId: (t.results[0].content as { nodeId: string }).nodeId,
        alternativeNodeId: t.state!.rulePlan!.alternativeNodeId,
        reason: 'Practise the link target on an invoice email.',
        basedOn: [t.state!.lastResults.at(-1)!.eventId],
      })],
    ]));
    const v = await login(app);
    const after = await finish(app, v, node(v, 'sich-v1'), v1MissLink);
    // The rules took sich-s1 from the pool for the missed link, only for the provisional plan.
    const ruleNode = after.session.nodes.find((n) => n.lessonId === 'sich-s1')!;
    expect(ruleNode.provisionalOf).toBe(after.recommendation!.id);
    await _idle();
    const s = await session(app, v.session.id);
    expect(s.recommendation!.ruleId).toBe('A1');
    expect(s.session.nodes.some((n) => n.lessonId === 'sich-s1')).toBe(false);
    expect(s.session.nodes.some((n) => n.provisionalOf)).toBe(false);
    expect(s.session.nodes.find((n) => n.id === s.recommendation!.nodeId)!.addedByAgent).toBe(true);
  });

  it('takes the area\'s prepared lessons when the agent fails', async () => {
    setMockAgentHandler(() => [{ type: 'text', text: 'I am stuck.' }]);
    const s = await afterLesson();
    const run = s.session.plannerRuns.at(-1)!;
    expect(run.outcome).toBe('fallback');
    expect(run.note).toMatch(/with 1 prepared lessons/);
    const rec = s.recommendation!;
    expect(rec.provisional).toBeUndefined();
    expect(s.session.nodes.find((n) => n.id === rec.nodeId)!.lessonId).toBe('sich-s1');
  });
});

describe('Learning records and reviews', () => {
  it('writes "demonstrated" only with evidence and puts the criterion into the review queue', async () => {
    process.env.MODEL_PROVIDER = 'none';
    const s = await afterLesson('sich-s1', s1Right);
    const demo = s.workspace.records.filter((r) => r.kind === 'demonstrated');
    expect(demo.map((r) => r.criterion).sort()).toEqual(['absender', 'adresse', 'anrede', 'daten', 'druck', 'link']);
    expect(demo.every((r) => r.evidence.length === 1 && r.evidence[0] === s.session.events[0].id)).toBe(true);
    expect(s.session.reviewQueue.filter((q) => q.status === 'waiting')).toHaveLength(6);
    // The cheat sheet grows with the rules of thumb of what was demonstrated.
    expect(s.workspace.reference['t-sicherheit'].map((e) => e.title)).toContain('Link target');
    const md = readFileSync(join(learnerDir(s), 'reference', 't-sicherheit.md'), 'utf8');
    expect(md).toMatch(/## Rules of thumb[\s\S]*\*\*Link target\*\*: Before you click, check/);
    const files = readdirSync(join(learnerDir(s), 'learning-records'));
    expect(files[0]).toMatch(/^0001-.+\.md$/);
    expect(readFileSync(join(learnerDir(s), 'learning-records', files[0]), 'utf8')).toMatch(/kind: demonstrated\nstatus: active\nevidence: \["ev-/);
  });

  it('recognises a corrected misconception and replaces outdated records', async () => {
    process.env.MODEL_PROVIDER = 'none';
    let v = await login(app);
    v = await finish(app, v, node(v, 'sich-s1'), s1MissLink);
    // Same lesson again, now all right: link was missed before and is now found without help.
    v = await finish(app, v, node(v, 'sich-s1'), s1Right);
    const misc = v.workspace.records.find((r) => r.kind === 'misconception' && r.criterion === 'link')!;
    expect(misc.evidence).toEqual([v.session.events[0].id, v.session.events[1].id]);
    expect(v.workspace.lernstand.find((l) => l.trackId === 't-sicherheit' && l.criterion === 'link')!.state).toBe('am-ueben');
    // Absender was right twice: one demonstrated record, still active.
    expect(v.workspace.records.filter((r) => r.criterion === 'absender')).toHaveLength(1);
    // Absender missed later: progress drops to 'practising', a new success supersedes the old record.
    v = await finish(app, v, node(v, 'sich-s1'), { ...s1Right, marked: s1Right.marked.filter((m) => m !== 'm-from') });
    expect(v.workspace.lernstand.find((l) => l.trackId === 't-sicherheit' && l.criterion === 'absender')!.state).toBe('am-ueben');
    v = await finish(app, v, node(v, 'sich-s1'), s1Right);
    const absender = v.workspace.records.filter((r) => r.criterion === 'absender' && r.kind === 'demonstrated');
    expect(absender).toHaveLength(2);
    expect(absender[0].status).toBe(`superseded by ${absender[1].id}`);
    expect(v.workspace.lernstand.find((l) => l.trackId === 't-sicherheit' && l.criterion === 'absender')!.state).toBe('sicher');
  });
});
