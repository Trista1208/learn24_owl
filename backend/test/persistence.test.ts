// The workspace on disk: a restart (new createApp) keeps progress, records and generated lessons.
// Login with an existing name offers "Continue" or "Start over"; missions change only when confirmed.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { setMockAgentHandler, setMockHandler } from '../src/provider.ts';
import { _idle, _reset } from '../src/sessions.ts';
import { learnersRoot } from '../src/workspace.ts';
import { finish, levels, login, mockSiteJson, node, scripted, session, use, v1Right } from './helpers.ts';

beforeEach(() => {
  _reset();
  process.env.MODEL_PROVIDER = 'mock';
  setMockHandler((req) => (req.purpose === 'generate' ? mockSiteJson() : 'ok'));
  setMockAgentHandler(scripted([
    () => [use('get_learner_state', { trackId: 't-sicherheit' })],
    () => [use('generate_lesson', { type: 'mock-site', trackId: 't-sicherheit', criterion: 'link', level: 'Grundstufe', contextHint: 'Invoice email' })],
    (t) => [use('add_to_map', { lessonId: (t.results[0].content as { lessonId: string }).lessonId, parentNodeId: 'n-sich-v1' })],
    (t) => [use('recommend', { nodeId: (t.results[0].content as { nodeId: string }).nodeId, alternativeNodeId: t.state!.rulePlan!.nodeId, reason: 'Practise the link target on an invoice email.', basedOn: [t.state!.activeRecords[0].id] })],
  ]));
});
afterEach(async () => {
  await _idle();
  setMockHandler(null);
  setMockAgentHandler(null);
  process.env.MODEL_PROVIDER = 'none';
});

describe('Progress on disk', () => {
  it('survives a restart: history, learning records and generated lessons', async () => {
    const app1 = createApp();
    const v = await login(app1, { name: 'Mara' });
    await finish(app1, v, node(v, 'sich-v1'), v1Right);
    await _idle();
    const before = await session(app1, v.session.id);
    expect(before.recommendation!.ruleId).toBe('A1');

    const dir = join(learnersRoot(), v.session.learnerId);
    for (const f of ['profile.json', 'state.json']) expect(existsSync(join(dir, f))).toBe(true);
    expect(readdirSync(join(dir, 'learning-records')).length).toBe(2);
    expect(readdirSync(join(dir, 'lessons')).length).toBe(1);
    expect(existsSync(join(dir, 'reference', 't-sicherheit.md'))).toBe(true);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);

    // Restart: a new app has nothing in memory.
    const app2 = createApp();
    await request(app2).get(`/api/sessions/${v.session.id}`).expect(200);
    // Same name, other case: the learner is asked to choose.
    const conflict = await request(app2).post('/api/login').send({ name: 'mara', levels }).expect(409);
    expect(conflict.body).toMatchObject({ code: 'learner-exists', name: 'Mara', lessonsDone: 1 });

    const again = await login(app2, { name: 'mara', resume: 'continue' });
    expect(again.session.learnerId).toBe(v.session.learnerId);
    expect(again.session.id).not.toBe(v.session.id);
    expect(again.session.sessionNo).toBe(2);
    expect(again.session.events).toHaveLength(1);
    expect(again.session.nodes.find((n) => n.lessonId === 'sich-v1')!.state).toBe('done');
    expect(again.workspace.records).toEqual(before.workspace.records);
    expect(again.workspace.reference).toEqual(before.workspace.reference);
    // The agent plan is still valid, so it stays the open recommendation.
    expect(again.recommendation!.ruleId).toBe('A1');
    const generated = (await request(app2).get(`/api/sessions/${again.session.id}/lessons`).expect(200)).body;
    expect(generated).toHaveLength(1);
    expect(again.session.nodes.some((n) => n.lessonId === generated[0].id && n.addedByAgent)).toBe(true);
    // The old session is closed.
    await request(app2).get(`/api/sessions/${v.session.id}`).expect(404);
    // The review queue from session 1 is kept.
    expect(again.session.reviewQueue.filter((q) => q.status === 'waiting' && q.addedInSession === 1)).toHaveLength(2);
  });

  it('"Start over" creates a new learner and deletes nothing', async () => {
    const app = createApp();
    const a = await login(app, { name: 'Mara' });
    await finish(app, a, node(a, 'sich-v1'), v1Right);
    await _idle();
    await login(app, { name: 'Mara' }, 409);
    const b = await login(app, { name: 'Mara', resume: 'new' });
    expect(b.session.learnerId).not.toBe(a.session.learnerId);
    expect(b.session.events).toHaveLength(0);
    expect(existsSync(join(learnersRoot(), a.session.learnerId, 'state.json'))).toBe(true);
    // "Continue" now continues the newest learner with this name.
    const c = await login(app, { name: 'Mara', resume: 'continue' });
    expect(c.session.learnerId).toBe(b.session.learnerId);
  });

  it('saves a new DCC result as a new record and keeps the learning records', async () => {
    const app = createApp();
    const a = await login(app, { name: 'Mara' });
    await finish(app, a, node(a, 'sich-v1'), v1Right);
    await _idle();
    const records = (await session(app, a.session.id)).workspace.records;
    const b = await login(app, { name: 'Mara', resume: 'continue', levels: { ...levels, 't-komm': 'Grundstufe' } });
    expect(b.dcc.levels['t-komm']).toBe('Grundstufe');
    expect(b.workspace.dccSnapshots).toHaveLength(2);
    expect(b.workspace.records).toEqual(records);
    // Same DCC again: no new snapshot.
    const c = await login(app, { name: 'Mara', resume: 'continue', levels: { ...levels, 't-komm': 'Grundstufe' } });
    expect(c.workspace.dccSnapshots).toHaveLength(2);
    const profile = JSON.parse(readFileSync(join(learnersRoot(), a.session.learnerId, 'profile.json'), 'utf8'));
    expect(profile.dccSnapshots.map((x: { profile: { levels: Record<string, string> } }) => x.profile.levels['t-komm'])).toEqual(['Fortgeschritten', 'Grundstufe']);
  });
});

describe('Mission', () => {
  it('is set the first time and only changes after confirmation', async () => {
    const app = createApp();
    const v = await login(app);
    const url = `/api/sessions/${v.session.id}/missions/t-sicherheit`;
    let res = await request(app).put(url).send({ text: 'I answer customer emails and want to recognise phishing reliably' }).expect(200);
    expect(res.body.workspace.missions[0]).toMatchObject({ trackId: 't-sicherheit', status: 'set' });
    const file = join(learnersRoot(), v.session.learnerId, 'missions', 't-sicherheit.md');
    expect(readFileSync(file, 'utf8')).toMatch(/# Mission: Safety\n\n## Why\nI answer customer emails/);

    await request(app).put(url).send({ text: 'I want to protect my family from fraud' }).expect(409);
    res = await request(app).put(url).send({ text: 'I want to protect my family from fraud', confirm: true }).expect(200);
    expect(res.body.workspace.missions[0].text).toBe('I want to protect my family from fraud');
    const shift = res.body.workspace.records.find((r: { kind: string }) => r.kind === 'mission-shift');
    expect(shift.evidence[0]).toMatch(/^mi-/);
    expect(res.body.session.missionChanges).toHaveLength(1);
  });

  it('takes the default mission when skipped', async () => {
    const app = createApp();
    const v = await login(app);
    const res = await request(app).put(`/api/sessions/${v.session.id}/missions/t-info`).send({ skip: true }).expect(200);
    expect(res.body.workspace.missions[0]).toMatchObject({ trackId: 't-info', status: 'default', text: 'I want to check AI summaries against the source with confidence.' });
  });
});
