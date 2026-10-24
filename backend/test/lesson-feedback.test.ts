import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PodcastLesson } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { content } from '../src/content.ts';
import { _reset, get } from '../src/sessions.ts';
import { login, node } from './helpers.ts';

beforeEach(() => { process.env.MODEL_PROVIDER = 'none'; _reset(); });

describe('Individual answer feedback', () => {
  it('opens the first lesson directly with no personal goal required', async () => {
    const app = createApp();
    const learner = await login(app);
    expect(learner.workspace.missions).toEqual([]);
    const opened = await request(app).post(`/api/sessions/${learner.session.id}/nodes/${node(learner, 'sich-v1').id}/start`).send({}).expect(200);
    expect(opened.body.lesson).toMatchObject({ id: 'sich-v1', type: 'video' });
    expect(opened.body.view.workspace.missions).toEqual([]);
    expect(opened.body.lesson.content.questions.every((q: { correct: number; explanation: string }) => q.correct === -1 && q.explanation === '')).toBe(true);
  });

  it('checks just the submitted video question without awarding XP or leaking other answers', async () => {
    const app = createApp();
    const learner = await login(app);
    const url = `/api/sessions/${learner.session.id}/nodes/${node(learner, 'sich-v1').id}`;
    const correct = await request(app).post(`${url}/answer-feedback`).send({ type: 'quiz', questionIndex: 0, option: 1 }).expect(200);
    expect(correct.body).toMatchObject({ correct: true, correctOption: 1 });
    expect(correct.body.explanation.length).toBeGreaterThan(0);
    expect(Object.keys(correct.body).sort()).toEqual(['correct', 'correctOption', 'explanation']);
    const incorrect = await request(app).post(`${url}/answer-feedback`).send({ type: 'quiz', questionIndex: 0, option: 0 }).expect(200);
    expect(incorrect.body).toMatchObject({ correct: false, correctOption: 1 });
    const unchanged = await request(app).get(`/api/sessions/${learner.session.id}`).expect(200);
    expect(unchanged.body.session.events).toEqual([]);
    expect(unchanged.body.rewards.xp).toBe(0);
    const reopened = await request(app).post(`${url}/start`).send({}).expect(200);
    expect(reopened.body.lesson.content.questions.every((q: { correct: number }) => q.correct === -1)).toBe(true);
  });

  it.each([
    {}, { type: 'quiz', questionIndex: -1, option: 0 }, { type: 'quiz', questionIndex: 99, option: 0 },
    { type: 'quiz', questionIndex: .5, option: 0 }, { type: 'quiz', questionIndex: '0', option: 0 },
    { type: 'quiz', questionIndex: 0, option: -1 }, { type: 'quiz', questionIndex: 0, option: 99 },
    { type: 'quiz', questionIndex: 0, option: .5 }, { type: 'quiz', questionIndex: 0, option: null },
    { type: 'mark-evidence', itemId: 's1', mark: 'belegt' },
  ])('rejects malformed or mismatched answers: %j', async (body) => {
    const app = createApp();
    const learner = await login(app);
    await request(app).post(`/api/sessions/${learner.session.id}/nodes/${node(learner, 'sich-v1').id}/answer-feedback`).send(body).expect(400);
  });

  it('keeps the original text judgement even after showing a corrective explanation', async () => {
    const app = createApp();
    const learner = await login(app, { levels: { 't-info': 'Grundstufe' } });
    const lesson = content.lessons.find((l) => l.id === 'info-m1')!;
    if (lesson.type !== 'mark-evidence') throw new Error('Expected prepared text lesson');
    const invented = lesson.content.summary.find((item) => item.verdict === 'erfunden')!;
    const url = `/api/sessions/${learner.session.id}/nodes/${node(learner, lesson.id).id}`;
    const feedback = await request(app).post(`${url}/answer-feedback`).send({ type: 'mark-evidence', itemId: invented.id, mark: 'belegt' }).expect(200);
    expect(feedback.body).toMatchObject({ correct: false, correctOption: 1 });
    expect(feedback.body.explanation).toContain(invented.explanation);
    const finished = await request(app).post(`${url}/complete`).send({ answer: { type: 'mark-evidence', marks: Object.fromEntries(lesson.content.summary.map((item) => [item.id, 'belegt'])) } }).expect(200);
    expect(finished.body.result.allMet).toBe(false);
    expect(finished.body.result.items.find((item: { label: string }) => item.label === invented.text).correct).toBe(false);
    await request(app).post(`${url}/answer-feedback`).send({ type: 'mark-evidence', itemId: 'not-an-item', mark: 'belegt' }).expect(400);
    await request(app).post(`${url}/answer-feedback`).send({ type: 'mark-evidence', itemId: invented.id, mark: 'unknown' }).expect(400);
  });

  it('uses the same checked-answer feedback for generated podcast questions', async () => {
    const app = createApp();
    const learner = await login(app);
    const video = content.lessons.find((l) => l.id === 'sich-v1')!;
    if (video.type !== 'video') throw new Error('Expected video');
    const podcast: PodcastLesson = { ...video, id: 'feedback-podcast', type: 'podcast', content: { lines: [{ speaker: 'a', text: 'Check the domain.' }, { speaker: 'b', text: 'The name before the ending?' }], questions: video.content.questions } };
    const stored = get(learner.session.id);
    stored.session.generatedLessons.push(podcast);
    stored.session.nodes.push({ ...node(learner, video.id), id: 'feedback-podcast-node', lessonId: podcast.id });
    const response = await request(app).post(`/api/sessions/${learner.session.id}/nodes/feedback-podcast-node/answer-feedback`).send({ type: 'quiz', questionIndex: 1, option: 2 }).expect(200);
    expect(response.body).toMatchObject({ correct: true, correctOption: 2, explanation: video.content.questions[1].explanation });
    expect(stored.session.events).toEqual([]);
  });

  it('rejects nodes outside the learner and unknown sessions', async () => {
    const app = createApp();
    const learner = await login(app);
    const body = { type: 'quiz', questionIndex: 0, option: 1 };
    await request(app).post(`/api/sessions/${learner.session.id}/nodes/missing-node/answer-feedback`).send(body).expect(404);
    await request(app).post('/api/sessions/missing-session/nodes/n-sich-v1/answer-feedback').send(body).expect(404);
  });
});
