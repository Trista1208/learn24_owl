// The map starts empty. Learners add prepared tracks from the catalog or create their own from a topic:
// the model designs the track, only sources that answer are kept, and the generator writes every lesson.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionView } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { setSourceCheck } from '../src/designer.ts';
import { setMockAgentHandler, setMockHandler, type AgentBlock, type ModelRequest } from '../src/provider.ts';
import { _idle, _reset } from '../src/sessions.ts';
import { learnersRoot } from '../src/workspace.ts';
import { addTracks, scripted, session, use, type Turn } from './helpers.ts';

const app = createApp();

const COMPTIA = 'https://www.comptia.org/certifications/security';
const NIST = 'https://csrc.nist.gov/glossary';

/** What the model answers when asked to design a track for "Security+". */
function designJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'Security+ exam',
    criteria: [
      { id: 'ports', label: 'Ports and protocols', ruleOfThumb: 'Every service has a standard port, for example HTTPS on 443.' },
      { id: 'krypto', label: 'Encryption', ruleOfThumb: 'Symmetric is fast, asymmetric solves the key exchange.' },
      { id: 'zugriff', label: 'Access control', ruleOfThumb: 'Everyone only gets the rights they need for their work.' },
    ],
    mission: {
      suggestions: ['I want to pass the exam at the first attempt', 'I want to get started in IT security', 'I want to use the terms confidently at work'],
      default: 'I want to pass the Security+ exam.',
    },
    sources: [
      { title: 'CompTIA Security+', url: COMPTIA, note: 'Exam objectives and topics' },
      { title: 'NIST Glossary', url: NIST, note: 'Look up terms' },
    ],
    lessonTypes: ['video', 'ai-chat'],
    ...overrides,
  });
}

/** A valid video lesson for the criterion "ports", as the generator would get it from the model. */
function videoJson() {
  return JSON.stringify({
    title: 'Ports at a glance',
    intro: 'You match services to their standard ports.',
    durationMin: 3,
    transfer: 'For every firewall rule, check which service is behind the port.',
    primarySourceUrl: COMPTIA,
    content: {
      scenes: [
        { caption: 'Services listen on fixed ports.', visual: 'steps', items: ['HTTPS', 'Port 443'], seconds: 6 },
        { caption: 'SSH has its port too.', visual: 'steps', items: ['SSH', 'Port 22'], seconds: 6 },
      ],
      questions: [
        { afterScene: 0, prompt: 'Which port belongs to HTTPS?', options: ['Port 443', 'Port 80', 'Port 21'], correct: 0, explanation: 'HTTPS uses 443.', criterion: 'ports' },
        { afterScene: 1, prompt: 'Which port belongs to SSH?', options: ['Port 22', 'Port 25', 'Port 53'], correct: 0, explanation: 'SSH uses 22.', criterion: 'ports' },
      ],
    },
  });
}

let modelRequests: ModelRequest[] = [];

beforeEach(() => {
  _reset();
  process.env.MODEL_PROVIDER = 'mock';
  modelRequests = [];
  setMockHandler((req) => {
    modelRequests.push(req);
    return req.purpose === 'design' ? designJson() : req.purpose === 'generate' ? videoJson() : 'ok';
  });
  setSourceCheck(async () => true);
});
afterEach(async () => {
  await _idle();
  setMockHandler(null);
  setMockAgentHandler(null);
  setSourceCheck(null);
  process.env.MODEL_PROVIDER = 'none';
});

async function emptyLogin(name = 'Test'): Promise<SessionView> {
  return (await request(app).post('/api/login').send({ name }).expect(201)).body;
}

async function createOwn(v: SessionView, body: Record<string, unknown> = { topic: 'Pass the Security+ exam', goal: 'I want to pass the Security+ exam in December' }, status = 201) {
  const res = await request(app).post(`/api/sessions/${v.session.id}/own-tracks`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as { trackId: string; view: SessionView; error?: string };
}

const learnerDir = (v: SessionView) => join(learnersRoot(), v.session.learnerId);

describe('Empty map', () => {
  it('starts without areas and without a DCC profile', async () => {
    process.env.MODEL_PROVIDER = 'none';
    const v = await emptyLogin();
    expect(v.session.nodes.map((n) => n.kind)).toEqual(['start']);
    expect(v.skills).toEqual([]);
    expect(v.workspace.lernstand).toEqual([]);
    expect(v.recommendation).toMatchObject({ ruleId: 'R7', nodeId: '', observation: 'No area on the map yet.' });
    expect(v.canCreateTracks).toBe(false);
  });

  it('adds a prepared area and starts there (R8)', async () => {
    process.env.MODEL_PROVIDER = 'none';
    let v = await emptyLogin();
    v = await addTracks(app, v, ['t-sicherheit']);
    expect(v.skills.map((s) => [s.id, s.tracks.map((t) => t.id)])).toEqual([['digital', ['t-sicherheit']]]);
    expect(v.session.nodes.filter((n) => n.kind === 'track').map((n) => n.trackId)).toEqual(['t-sicherheit']);
    // Without the agent, the whole prepared plan of the track.
    expect(v.session.nodes.filter((n) => n.kind === 'lesson').length).toBeGreaterThan(1);
    const rec = v.recommendation!;
    expect(rec.ruleId).toBe('R8');
    expect(v.session.nodes.find((n) => n.id === rec.nodeId)!.trackId).toBe('t-sicherheit');

    await request(app).post(`/api/sessions/${v.session.id}/tracks`).send({ trackIds: ['t-sicherheit'] }).expect(409);
    await request(app).post(`/api/sessions/${v.session.id}/tracks`).send({ trackIds: ['t-does-not-exist'] }).expect(404);
    // A mission only for tracks on the map.
    await request(app).put(`/api/sessions/${v.session.id}/missions/t-info`).send({ skip: true }).expect(404);
  });

  it('starts a prepared area with AI with a starter', async () => {
    let v = await emptyLogin();
    v = await addTracks(app, v, ['t-analysis']);
    expect(v.session.nodes.filter((n) => n.kind === 'lesson')).toHaveLength(1);
    expect(v.skills[0].id).toBe('math');
  });
});

describe('Own area', () => {
  it('plans the area with the AI, creates a starter and takes the What for as the mission', async () => {
    const v = await emptyLogin('Zoe Beispielname');
    expect(v.canCreateTracks).toBe(true);
    const r = await createOwn(v);
    const after = r.view;

    const own = after.skills.find((s) => s.id === 'custom')!;
    expect(own.name).toBe('Own topics');
    const track = own.tracks[0];
    expect(track).toMatchObject({ id: r.trackId, name: 'Security+ exam', skillId: 'custom' });
    expect(track.criteria.map((c) => c.id)).toEqual(['ports', 'krypto', 'zugriff']);
    expect(track.custom).toMatchObject({ topic: 'Pass the Security+ exam', selfLevel: 'Grundstufe', lessonTypes: ['video', 'ai-chat'] });
    expect(track.custom!.sources.map((s) => s.url)).toEqual([COMPTIA, NIST]);

    // On the map: skill, track and the first lesson, recommended as the next step.
    const lesson = after.session.nodes.find((n) => n.kind === 'lesson' && n.trackId === track.id)!;
    expect(lesson.parentId).toBe(`t-${track.id}`);
    expect(after.recommendation).toMatchObject({ ruleId: 'R8', nodeId: lesson.id });
    expect(after.workspace.missions).toEqual([expect.objectContaining({ trackId: track.id, status: 'set', text: 'I want to pass the Security+ exam in December' })]);
    expect(after.workspace.lernstand.map((l) => l.criterion)).toEqual(['ports', 'krypto', 'zugriff']);

    const gen = (await request(app).get(`/api/sessions/${v.session.id}/lessons`).expect(200)).body;
    expect(gen).toHaveLength(1);
    expect(gen[0]).toMatchObject({ id: lesson.lessonId, trackId: track.id, source: 'model', type: 'video', primarySource: { url: COMPTIA } });

    // Stored in the workspace.
    expect(JSON.parse(readFileSync(join(learnerDir(v), 'tracks', `${track.id}.json`), 'utf8')).name).toBe('Security+ exam');
    expect(readdirSync(join(learnerDir(v), 'lessons'))).toHaveLength(1);

    // Neither the name nor the learner id goes to the model.
    const sent = JSON.stringify(modelRequests);
    expect(modelRequests.map((m) => m.purpose)).toEqual(['design', 'generate']);
    expect(sent).not.toContain('Zoe');
    expect(sent).not.toContain(v.session.learnerId);
  });

  it('judges with the own area\'s criteria and survives a restart', async () => {
    const v = await emptyLogin();
    const { view: after, trackId } = await createOwn(v);
    const node = after.session.nodes.find((n) => n.kind === 'lesson' && n.trackId === trackId)!;
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${node.id}/start`).expect(200);
    process.env.MODEL_PROVIDER = 'none';
    const res = await request(app).post(`/api/sessions/${v.session.id}/nodes/${node.id}/complete`).send({ answer: { type: 'video', answers: {} } }).expect(200);
    expect(res.body.result.criteria[0]).toMatchObject({ key: 'ports', label: 'Ports and protocols', status: 'missed' });

    const app2 = createApp();
    const s: SessionView = (await request(app2).get(`/api/sessions/${v.session.id}`).expect(200)).body;
    expect(s.skills.find((x) => x.id === 'custom')!.tracks[0].id).toBe(trackId);
    expect(s.session.nodes.find((n) => n.id === node.id)!.state).toBe('done');
  });

  it('needs the AI', async () => {
    process.env.MODEL_PROVIDER = 'none';
    const v = await emptyLogin();
    const r = await createOwn(v, { topic: 'Security+' }, 409);
    expect(r.error).toMatch(/with AI/);
  });

  it('keeps only reachable sources', async () => {
    setSourceCheck(async (url) => url === NIST);
    const v = await emptyLogin();
    // The first lesson cites the source that did not answer: rejected, and the track is not made.
    const r = await createOwn(v, undefined, 502);
    expect(r.error).toMatch(/first lesson was invalid: primary source .*comptia.* is not among the area's sources/);
    expect((await session(app, v.session.id)).skills).toEqual([]);

    setMockHandler((req) => (req.purpose === 'design' ? designJson() : videoJson().replace(COMPTIA, NIST)));
    const { view: after } = await createOwn(v);
    expect(after.skills.find((s) => s.id === 'custom')!.tracks[0].custom!.sources.map((s) => s.url)).toEqual([NIST]);
  });

  it('discards an invalid design and keeps the map empty', async () => {
    setSourceCheck(async () => false);
    const v = await emptyLogin();
    let r = await createOwn(v, { topic: 'Security+' }, 502);
    expect(r.error).toMatch(/None of the suggested sources could be reached/);

    setSourceCheck(async () => true);
    setMockHandler((req) => (req.purpose === 'design' ? designJson({ criteria: [{ id: 'Ports and protocols', label: 'x', ruleOfThumb: 'y' }] }) : videoJson()));
    r = await createOwn(v, { topic: 'Security+' }, 502);
    expect(r.error).toMatch(/3 to 6 criteria/);

    setMockHandler((req) => (req.purpose === 'design' ? JSON.stringify({ error: 'The topic is too vague.' }) : videoJson()));
    r = await createOwn(v, { topic: 'Things' }, 502);
    expect(r.error).toMatch(/too vague/);

    const s = await session(app, v.session.id);
    expect(s.session.nodes.map((n) => n.kind)).toEqual(['start']);
    expect(existsSync(join(learnerDir(v), 'tracks'))).toBe(false);
  });

  it('lets the rules create the next lesson when the agent fails', async () => {
    setMockAgentHandler(() => [{ type: 'text', text: 'I am stuck.' }]);
    const v = await emptyLogin();
    const { view: after, trackId } = await createOwn(v);
    const first = after.session.nodes.find((n) => n.kind === 'lesson' && n.trackId === trackId)!;
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${first.id}/start`).expect(200);
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${first.id}/complete`).send({ answer: { type: 'video', answers: {} } }).expect(200);
    await _idle();

    const s = await session(app, v.session.id);
    const run = s.session.plannerRuns.at(-1)!;
    expect(run.outcome).toBe('fallback');
    expect(run.note).toMatch(/lesson whose goal the rules chose/);
    const next = s.session.nodes.find((n) => n.id === s.recommendation!.nodeId)!;
    expect(next).toMatchObject({ trackId, parentId: first.id, state: 'recommended', addedByAgent: true });
    // The missed criterion is the target.
    const gen = (await request(app).get(`/api/sessions/${v.session.id}/lessons`).expect(200)).body;
    expect(gen.find((l: { id: string }) => l.id === next.lessonId).targets).toEqual(['ports']);
  });

  /** Finishes the first lesson of a new own track while the given agent plans; returns the session after the agent. */
  async function afterFirst(agent: (trackId: string) => ((t: Turn) => AgentBlock[])[]) {
    const v = await emptyLogin();
    const { view: after, trackId } = await createOwn(v);
    setMockAgentHandler(scripted(agent(trackId)));
    const first = after.session.nodes.find((n) => n.kind === 'lesson' && n.trackId === trackId)!;
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${first.id}/start`).expect(200);
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${first.id}/complete`).send({ answer: { type: 'video', answers: {} } }).expect(200);
    await _idle();
    return { s: await session(app, v.session.id), first };
  }
  const generateAndHang = (trackId: string) => [
    () => [use('generate_lesson', { type: 'video', trackId, criterion: 'ports', level: 'Grundstufe', contextHint: 'Firewall rules' })],
    (t: Turn) => [use('add_to_map', { lessonId: (t.results[0].content as { lessonId: string }).lessonId, parentNodeId: `t-${trackId}` })],
  ];

  it('accepts the agent plan without an alternative when nothing else is reachable', async () => {
    const { s } = await afterFirst((trackId) => [
      () => [use('get_learner_state', { trackId })],
      ...generateAndHang(trackId),
      // The only other node is the one just done: not reachable, so the plan goes without an alternative.
      (t) => [use('recommend', {
        nodeId: (t.results[0].content as { nodeId: string }).nodeId,
        alternativeNodeId: t.state!.map[0].nodeId,
        reason: 'Practise ports once more on a new example.',
        basedOn: [t.state!.lastResults.at(-1)!.eventId],
      })],
    ]);
    expect(s.session.plannerRuns.at(-1)!.outcome).toBe('accepted');
    expect(s.recommendation).toMatchObject({ ruleId: 'A1' });
    expect(s.recommendation!.alternativeNodeId).toBeUndefined();
  });

  it('takes the lesson the agent already created after a rejected plan', async () => {
    const { s } = await afterFirst((trackId) => [
      ...generateAndHang(trackId),
      (t) => [use('recommend', { nodeId: (t.results[0].content as { nodeId: string }).nodeId, reason: 'Without evidence.', basedOn: [] })],
    ]);
    const run = s.session.plannerRuns.at(-1)!;
    expect(run.outcome).toBe('fallback');
    expect(run.note).toMatch(/with the lesson the agent generated/);
    // Starter and the agent's lesson; no third lesson from the rules.
    expect(modelRequests.filter((m) => m.purpose === 'generate')).toHaveLength(2);
    expect(s.session.nodes.find((n) => n.id === s.recommendation!.nodeId)!.lessonId).toMatch(/^ki-u-/);
  });

  it('creates a new lesson on request when nothing is left open in the area', async () => {
    const v = await emptyLogin();
    const { trackId } = await createOwn(v);
    // Still open: the first lesson.
    await request(app).post(`/api/sessions/${v.session.id}/tracks/${trackId}/next`).expect(409);
    await request(app).post(`/api/sessions/${v.session.id}/tracks/t-sicherheit/next`).expect(404);
  });

  it('belongs only to the learner who created it', async () => {
    const a = await emptyLogin('Ada');
    const { trackId } = await createOwn(a);
    const b = await emptyLogin('Ben');
    await request(app).put(`/api/sessions/${b.session.id}/missions/${trackId}`).send({ skip: true }).expect(404);
    await request(app).post(`/api/sessions/${b.session.id}/tracks/${trackId}/next`).expect(404);
    expect((await session(app, b.session.id)).skills).toEqual([]);
  });
});
