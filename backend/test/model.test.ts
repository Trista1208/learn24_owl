// Model path with a mock provider: model answers are marked, broken answers fall back to prepared content.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionView } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { setMockHandler } from '../src/provider.ts';
import { _reset } from '../src/sessions.ts';
import { addTracks, catalog } from './helpers.ts';

const app = createApp();
const levels = { 't-info': 'Mittelstufe', 't-komm': 'Grundstufe', 't-inhalte': 'Grundstufe', 't-sicherheit': 'Mittelstufe', 't-problem': 'Grundstufe' };

async function chatNode() {
  const res = await request(app).post('/api/login').send({ name: 'Quirina', levels }).expect(201);
  const v: SessionView = await addTracks(app, res.body, catalog);
  // With the agent each track starts with one lesson; for Communication (Grundstufe) that is a chat.
  const n = v.session.nodes.find((x) => x.lessonId === 'komm-c1')!;
  expect(n).toBeDefined();
  return { id: v.session.id, node: n.id };
}

beforeEach(() => {
  _reset();
  process.env.MODEL_PROVIDER = 'mock';
});
afterEach(() => {
  setMockHandler(null);
  process.env.MODEL_PROVIDER = 'none';
});

describe('Model', () => {
  it('labels the model\'s replies', async () => {
    const seen: string[] = [];
    setMockHandler((req) => {
      seen.push(JSON.stringify(req));
      return 'How can you tell where the number comes from?';
    });
    const { id, node } = await chatNode();
    const res = await request(app).post(`/api/sessions/${id}/nodes/${node}/chat`).send({ turns: [{ role: 'learner', text: 'I ask about the source.' }] }).expect(200);
    expect(res.body).toEqual({ text: 'How can you tell where the number comes from?', source: 'model' });
    // Neither the name nor the DCC profile goes to the model.
    expect(seen.join(' ')).not.toContain('Quirina');
    expect(seen.join(' ')).not.toMatch(/Mittelstufe|Grundstufe/);
  });

  it('falls back to prepared content on errors', async () => {
    setMockHandler(() => {
      throw new Error('timeout');
    });
    const { id, node } = await chatNode();
    const res = await request(app).post(`/api/sessions/${id}/nodes/${node}/chat`).send({ turns: [{ role: 'learner', text: 'Hello' }] }).expect(200);
    expect(res.body.source).toBe('prepared');
  });

  it('judges with the model and uses keywords for unreadable JSON', async () => {
    const { id, node } = await chatNode();
    const lesson = (await request(app).get('/api/content')).body.lessons.find((l: { id: string }) => l.id === 'komm-c1');
    const ids: string[] = lesson.content.criteria.map((c: { id: string }) => c.id);
    const turns = [{ role: 'learner', text: 'I check whether the number is in the source.' }];

    setMockHandler(() => JSON.stringify({ criteria: ids.map((c) => ({ id: c, met: true, reason: 'It says so.' })) }));
    await request(app).post(`/api/sessions/${id}/nodes/${node}/start`).expect(200);
    let res = await request(app).post(`/api/sessions/${id}/nodes/${node}/complete`).send({ answer: { type: 'ai-chat', turns } }).expect(200);
    expect(res.body.result.judgedBy).toBe('model');
    expect(res.body.result.allMet).toBe(true);

    setMockHandler(() => 'not JSON');
    await request(app).post(`/api/sessions/${id}/nodes/${node}/start`).expect(200);
    res = await request(app).post(`/api/sessions/${id}/nodes/${node}/complete`).send({ answer: { type: 'ai-chat', turns } }).expect(200);
    expect(res.body.result.judgedBy).toBe('keywords');
  });
});
