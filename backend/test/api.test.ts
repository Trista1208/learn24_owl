// End-to-end tests of the API: login, planning from DCC, agent rules, DCC immutability, fallbacks.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MapNode, SessionView } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { _reset } from '../src/sessions.ts';
import { addTracks, catalog } from './helpers.ts';

process.env.MODEL_PROVIDER = 'none';
const root = join(import.meta.dirname, '..', '..');
const sample = (name: string) => JSON.parse(readFileSync(join(root, 'frontend', 'public', 'dcc-examples', name), 'utf8'));
const app = createApp();

async function login(body: Record<string, unknown> = {}): Promise<SessionView> {
  const res = await request(app)
    .post('/api/login')
    .send({ name: 'Test', dccFile: sample('dcc-mixed.json'), fileName: 'dcc-mixed.json', ...body });
  expect(res.status).toBe(201);
  return addTracks(app, res.body, catalog);
}

const lessonsOn = (v: SessionView, trackId: string) => v.session.nodes.filter((n) => n.kind === 'lesson' && n.trackId === trackId);
const recNode = (v: SessionView) => v.session.nodes.find((n) => n.state === 'recommended')!;
const altNode = (v: SessionView) => v.session.nodes.find((n) => n.state === 'alternative');
const node = (v: SessionView, id: string) => v.session.nodes.find((n) => n.id === id)!;

async function complete(v: SessionView, n: MapNode, answer: unknown): Promise<SessionView> {
  const id = v.session.id;
  await request(app).post(`/api/sessions/${id}/nodes/${n.id}/start`).expect(200);
  const res = await request(app).post(`/api/sessions/${id}/nodes/${n.id}/complete`).send({ answer });
  expect(res.status).toBe(200);
  return res.body.view;
}

/** Marks every sentence as "belegt": misses each invented detail. */
const allBelegt = { type: 'mark-evidence', marks: { s1: 'belegt', s2: 'belegt', s3: 'belegt', s4: 'belegt' } };

beforeEach(() => _reset());

describe('Login and DCC', () => {
  it('reads a DCC result file', async () => {
    const v = await login();
    expect(v.dcc.source).toBe('file');
    expect(v.dcc.levels['t-info']).toBe('Grundstufe');
    expect(v.dcc.levels['t-komm']).toBe('Mittelstufe');
    expect(v.dcc.levels['t-problem']).toBeNull();
  });

  it('accepts levels entered by hand', async () => {
    const v = await login({ dccFile: undefined, levels: { 't-info': 'Fortgeschritten', 't-sicherheit': 'Grundstufe' } });
    expect(v.dcc.source).toBe('manual');
    expect(v.dcc.levels['t-info']).toBe('Fortgeschritten');
    expect(v.dcc.levels['t-komm']).toBeNull();
  });

  it('rejects wrong files and levels', async () => {
    await request(app).post('/api/login').send({ name: 'x', dccFile: { foo: 1 } }).expect(400);
    await request(app).post('/api/login').send({ name: 'x', dccFile: { type: 'dcc-result', areas: [{ area: '9', level: 'Grundstufe' }] } }).expect(400);
    await request(app).post('/api/login').send({ name: 'x', levels: { 't-info': 'Expert' } }).expect(400);
  });

  it('plans each area to match its DCC level', async () => {
    const v = await login();
    const info = lessonsOn(v, 't-info');
    expect(info.length).toBeGreaterThan(0);
    expect(info.every((n) => n.state === 'planned' || n.state === 'recommended' || n.state === 'alternative')).toBe(true);
    // Not assessed (Problem solving): a short starter plus one step, not a full basic course.
    expect(lessonsOn(v, 't-problem').length).toBeLessThanOrEqual(2);
    // Skills without DCC (Mathematics, Science) are on the map too.
    expect(lessonsOn(v, 't-analysis').length).toBeGreaterThan(0);
    expect(lessonsOn(v, 't-physik').length).toBeGreaterThan(0);
  });

  it('starts with an area at Foundation level and offers an alternative', async () => {
    const v = await login();
    expect(v.recommendation?.ruleId).toBe('R3');
    expect(v.dcc.levels[recNode(v).trackId!]).toBe('Grundstufe');
    expect(altNode(v)).toBeDefined();
  });

  it('treats missing DCC values as not low competence', async () => {
    // Only Problem solving is missing. The agent offers a short starter to collect evidence,
    // not a full basic course, and does not call it the largest need.
    const levels = { 't-info': 'Mittelstufe', 't-komm': 'Fortgeschritten', 't-inhalte': 'Fortgeschritten', 't-sicherheit': 'Fortgeschritten', 't-problem': null };
    const v = await login({ dccFile: undefined, levels });
    const rec = v.recommendation!;
    expect(recNode(v).trackId).toBe('t-problem');
    expect(rec.observation).toMatch(/no DCC result/);
    expect(rec.why).toMatch(/does not mean low competence/);
    expect(rec.reason).not.toMatch(/most to gain/);
    expect(lessonsOn(v, 't-problem').length).toBeLessThanOrEqual(2);
  });
});

describe('Agent', () => {
  it('adds an AI node with an alternative after the same mistake twice (R1)', async () => {
    let v = await login();
    // Two text checks in the info track, each time the invented date is missed (criterion "zeit").
    v = await complete(v, node(v, 'n-info-m1'), allBelegt);
    expect(v.recommendation?.ruleId).not.toBe('R1');
    v = await complete(v, node(v, 'n-info-m2'), allBelegt);
    expect(v.recommendation?.ruleId).toBe('R1');
    const added = recNode(v);
    expect(added.addedByAgent).toBe(true);
    expect(added.lessonId).toMatch(/^klaeren-t-info-zeit-/);
    expect(altNode(v)).toBeDefined();
    // The new node hangs on the last done node in this track.
    expect(node(v, added.parentId!).state).toBe('done');
    // Its lesson is delivered to the browser without solution patterns.
    const gen = await request(app).get(`/api/sessions/${v.session.id}/lessons`).expect(200);
    const lesson = gen.body.find((l: { id: string }) => l.id === added.lessonId);
    expect(lesson.type).toBe('ai-chat');
    expect(lesson.content.criteria.every((c: { patterns: string[] }) => c.patterns.length === 0)).toBe(true);
  });

  it('counts the alternative as declining and plans again', async () => {
    const v = await login();
    const alt = altNode(v)!;
    const res = await request(app).post(`/api/sessions/${v.session.id}/nodes/${alt.id}/start`).expect(200);
    expect(res.body.switched).toMatch(/alternative/);
    const recs = res.body.view.session.recommendations;
    expect(recs.at(-1).status).toBe('declined');
    expect(res.body.view.recommendation).toBeNull();
  });

  it('never changes the DCC profile through learning', async () => {
    let v = await login();
    const before = JSON.stringify(v.dcc);
    for (let i = 0; i < 3; i++) {
      const n = recNode(v);
      if (!n) break;
      const lessons = (await request(app).get('/api/content')).body.lessons as { id: string; type: string }[];
      const type = lessons.find((l) => l.id === n.lessonId)?.type ?? 'ai-chat';
      const answer =
        type === 'video' ? { type, answers: {} }
        : type === 'mark-evidence' ? allBelegt
        : type === 'mock-site' ? { type, marked: [], verdict: 'phishing' }
        : { type, turns: [{ role: 'learner', text: 'I check every detail against the source.' }] };
      v = await complete(v, n, answer);
    }
    expect(v.session.events.length).toBe(3);
    expect(JSON.stringify(v.dcc)).toBe(before);
  });
});

describe('Lessons', () => {
  it('sends no solutions to the browser', async () => {
    const res = await request(app).get('/api/content').expect(200);
    for (const l of res.body.lessons) {
      if (l.type === 'mark-evidence') expect(l.content.summary.every((x: { explanation: string }) => x.explanation === '')).toBe(true);
      if (l.type === 'mock-site') expect(JSON.stringify(l.content)).not.toContain('"signal"');
      if (l.type === 'video') expect(l.content.questions.every((q: { correct: number }) => q.correct === -1)).toBe(true);
      if (l.type === 'ai-chat') expect(l.content.fallbackReplies).toEqual([]);
    }
  });

  it('recognises a phishing page with the right clues', async () => {
    const v = await login();
    const n = v.session.nodes.find((x) => x.lessonId === 'sich-s1') ?? v.session.nodes.find((x) => x.lessonId?.startsWith('sich-s'));
    expect(n).toBeDefined();
    const after = await complete(v, n!, { type: 'mock-site', marked: ['m-from', 'w-url'], verdict: 'echt' });
    const done = node(after, n!.id);
    expect(done.state).toBe('done');
    expect(done.result?.allMet).toBe(false);
    expect(done.result?.criteria.find((c) => c.key === 'entscheid')?.status).toBe('missed');
  });

  it('answers without a model with labelled prepared content', async () => {
    const v = await login();
    const n = v.session.nodes.find((x) => x.lessonId === 'info-c1') ?? v.session.nodes.find((x) => x.lessonId?.includes('-c'));
    expect(n).toBeDefined();
    const res = await request(app)
      .post(`/api/sessions/${v.session.id}/nodes/${n!.id}/chat`)
      .send({ turns: [{ role: 'learner', text: 'Hello' }] })
      .expect(200);
    expect(res.body.source).toBe('prepared');
    expect(res.body.text.length).toBeGreaterThan(0);
    const s = await request(app).get(`/api/sessions/${v.session.id}`).expect(200);
    expect(s.body.modelStatus).toBe('offline');
  });
});

describe('Security', () => {
  it('contains no API keys in the frontend', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(join(root, 'frontend', 'src'));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/sk-ant-|sk-proj-|ANTHROPIC_API_KEY|OPENAI_API_KEY/);
    }
  });
});
