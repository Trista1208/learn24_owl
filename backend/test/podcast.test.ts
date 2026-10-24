// Podcast lessons: the learner chooses the format, the model writes a two-host script with questions,
// the server narrates it on first open and judges the questions like a video's.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, PodcastLesson, PodcastLine, PodcastManifest, PodcastSpeaker, SessionView, TopicChoices } from '@l45/shared';
import { content } from '../src/content.ts';
import { createApp } from '../src/app.ts';
import { PodcastService } from '../src/podcast/service.ts';
import { setMockHandler, type ModelRequest } from '../src/provider.ts';
import { _idle, _reset } from '../src/sessions.ts';
import { validateLesson } from '../src/validate.ts';
import type { Speaker } from '../src/video/build.ts';
import { addTracks } from './helpers.ts';

const sicherheit = content.skills.flatMap(s => s.tracks).find(t => t.id === 't-sicherheit')!;
const second = Buffer.alloc(24000 * 2, 1);
const temp = () => mkdtemp(join(tmpdir(), 'l45-podcast-test-'));
const dialogue = (n: number): PodcastLine[] => Array.from({ length: n }, (_, i) => ({ speaker: i % 2 ? 'b' : 'a', text: `Turn ${i + 1}.` }));
const speakers = (pcm = async (_text: string) => second): Record<PodcastSpeaker, Speaker> => ({
  a: { config: { provider: 'elevenlabs', voice: 'voice-a', model: 'test' }, pcm: vi.fn(pcm) },
  b: { config: { provider: 'elevenlabs', voice: 'voice-b', model: 'test' }, pcm: vi.fn(pcm) },
});
const questions = [
  { prompt: 'What do you check before you click?', options: ['The link target', 'The colour', 'The font'], correct: 0, explanation: 'The target shows where you end up.', criterion: 'link' },
  { prompt: 'Which part of the address counts?', options: ['The path', 'The domain', 'The scheme'], correct: 1, explanation: 'The domain decides who owns it.', criterion: 'adresse' },
];
const podcastJson = (lines = dialogue(8)) => JSON.stringify({
  title: 'Talking about link targets', intro: 'Mira and Jonas talk about link targets.', durationMin: 3,
  transfer: 'Check the target of the next link.', primarySourceUrl: 'https://www.bacs.admin.ch/de/phishing-de',
  content: { lines, questions },
});
const lesson = (over: Partial<PodcastLesson['content']> = {}): PodcastLesson => ({
  id: 'ki-podcast-test', trackId: 't-sicherheit', type: 'podcast', level: 'Grundstufe', title: 'Talking about link targets',
  intro: 'Two voices talk about link targets.', durationMin: 3, mode: 'alone', targets: ['link'], source: 'prepared',
  content: { lines: dialogue(8), questions, ...over },
});

let calls: ModelRequest[] = [];
let learners = 0;
beforeEach(() => {
  _reset();
  process.env.MODEL_PROVIDER = 'mock';
  calls = [];
  setMockHandler(req => {
    calls.push(req);
    return req.purpose === 'plan'
      ? JSON.stringify({ topics: [
        { title: 'Recognise link targets', reason: 'Go deeper into checking links.', criterion: 'link', formats: ['video'] },
        { title: 'Compare domains', reason: 'A related focus.', criterion: 'adresse', formats: ['ai-chat'] },
        { title: 'Check links in everyday life', reason: 'Apply it.', criterion: 'link', formats: ['video'] },
      ] })
      : podcastJson();
  });
});
afterEach(async () => {
  await _idle();
  setMockHandler(null);
  process.env.MODEL_PROVIDER = 'none';
});

/** A learner who chose a podcast lesson in “Safety”. */
async function setup(speak = speakers()) {
  const folder = await temp();
  const app = createApp({ podcastService: new PodcastService({ output: folder, speechCache: folder, speakers: speak }) });
  const login = await request(app).post('/api/login').send({ name: `Podcast ${++learners}`, levels: {} }).expect(201);
  const v: SessionView = await addTracks(app, login.body, ['t-sicherheit']);
  const choices: TopicChoices = (await request(app).post(`/api/sessions/${v.session.id}/tracks/t-sicherheit/topics`).send({}).expect(200)).body.choices;
  expect(choices.topics.every(t => t.formats.includes('podcast'))).toBe(true);
  const chosen = await request(app).post(`/api/sessions/${v.session.id}/topics/choose`).send({ choiceSetId: choices.id, topicId: choices.topics[0].id, format: 'podcast' }).expect(201);
  const nodeId: string = chosen.body.nodeId;
  return { app, folder, speak, sessionId: v.session.id, nodeId, url: `/api/sessions/${v.session.id}/nodes/${nodeId}/podcast` };
}
async function settled(app: Parameters<typeof request>[0], url: string) {
  let body: { state: string; manifestUrl?: string; message?: string } = { state: 'idle' };
  await vi.waitFor(async () => {
    body = (await request(app).get(url).expect(200)).body;
    expect(body.state).toMatch(/ready|error/);
  }, { timeout: 5000, interval: 20 });
  return body;
}

describe('podcast lesson schema', () => {
  it('accepts two hosts within the speech budget and a fair quiz', () => {
    expect(validateLesson(lesson(), { track: sicherheit })).toEqual([]);
  });

  it('rejects one voice, too much speech and quizzes with the right answer always first', () => {
    expect(validateLesson(lesson({ lines: dialogue(8).map(l => ({ ...l, speaker: 'a' as const })) }))).toContain('both hosts speak in the podcast');
    expect(validateLesson(lesson({ lines: dialogue(4) }))).toContain('podcast needs 6 to 16 turns');
    expect(validateLesson(lesson({ lines: dialogue(10).map(l => ({ ...l, text: 'x'.repeat(390) })) }))).toContain('podcast is longer than 3000 characters');
    expect(validateLesson(lesson({ questions: [] }))).toContain('podcast needs 1 to 4 questions');
    expect(validateLesson(lesson({ questions: questions.map(q => ({ ...q, options: [q.options[q.correct], ...q.options.filter((_, i) => i !== q.correct)], correct: 0 })) }))).toContain('The right answer is in the same place in every question');
  });
});

describe('podcast lessons', () => {
  it('is generated when the learner chooses it, narrated once, served without solutions and judged', async () => {
    const { app, folder, speak, sessionId, nodeId, url } = await setup();
    const generated = calls.filter(c => c.purpose === 'generate');
    expect(generated).toHaveLength(1);
    expect(generated[0].messages[0].content).toContain('Lesson type: podcast');

    const started = await request(app).post(`/api/sessions/${sessionId}/nodes/${nodeId}/start`).send({}).expect(200);
    const served = started.body.lesson as PodcastLesson;
    expect(served.type).toBe('podcast');
    expect(served.content.lines).toHaveLength(8);
    expect(served.content.questions.every(q => q.correct === -1 && q.explanation === '')).toBe(true);

    const first = await Promise.all([request(app).post(url), request(app).post(url)]);
    expect(first.map(r => r.status)).toEqual([202, 202]);
    const done = await settled(app, url);
    expect(done.state).toBe('ready');
    expect(speak.a.pcm).toHaveBeenCalledTimes(4);
    expect(speak.b.pcm).toHaveBeenCalledTimes(4);
    const manifest = (await request(app).get(done.manifestUrl!).expect(200)).body as PodcastManifest;
    expect(manifest).toMatchObject({ schemaVersion: 2, lessonId: served.id, hosts: { a: 'Mira', b: 'Jonas' }, narration: { voices: { a: 'voice-a', b: 'voice-b' } } });
    expect(manifest.lines[1].start).toBeCloseTo(1.4, 5);
    expect(manifest.duration).toBeCloseTo(8 + 7 * 0.4, 5);
    const audio = await request(app).get(manifest.audioUrl).expect(200).expect('content-type', /audio/);
    expect(audio.body.toString('ascii', 0, 4)).toBe('RIFF');

    // A restarted server finds the audio on disk: no new speech.
    const restarted = new PodcastService({ output: folder, speechCache: folder, speakers: speak });
    expect((await request(createApp({ podcastService: restarted })).post(url)).status).toBe(200);
    expect(speak.a.pcm).toHaveBeenCalledTimes(4);

    // The server shuffled the options; answer with what it stored.
    const stored = (await request(app).get(`/api/sessions/${sessionId}/lessons`).expect(200)).body as Lesson[];
    expect(stored.find(l => l.id === served.id)?.type).toBe('podcast');
    const answers = Object.fromEntries(served.content.questions.map((q, i) => [i, q.options.indexOf(questions[i].options[questions[i].correct])]));
    const result = await request(app).post(`/api/sessions/${sessionId}/nodes/${nodeId}/complete`).send({ answer: { type: 'podcast', answers } }).expect(200);
    expect(result.body.result).toMatchObject({ allMet: true, summary: '2 of 2 questions correct.' });
  });

  it('keeps the lesson usable when narration fails', async () => {
    const { app, url } = await setup(speakers(async () => { throw new Error('ElevenLabs key or voice missing.'); }));
    await request(app).post(url).expect(202);
    const done = await settled(app, url);
    expect(done.state).toBe('error');
    expect(done.message).toMatch(/read the conversation/);
    expect((await request(app).post(url)).status).toBe(503);
  });

  it('serves audio only for podcast lessons', async () => {
    const { app, sessionId } = await setup();
    const login = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const track = (login.body as SessionView).session.nodes.find(n => n.kind === 'track')!;
    await request(app).post(`/api/sessions/${sessionId}/nodes/${track.id}/podcast`).expect(404);
    await request(app).get('/podcasts/missing/manifest.json').expect(404);
  });
});
