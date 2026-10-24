import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lesson, MockSiteLesson, PodcastLesson, ReviewQuestion, VideoLesson } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { _reset, get, save, storeLesson } from '../src/sessions.ts';
import { content } from '../src/content.ts';
import { scheduleReview } from '../src/reviewSchedule.ts';
import { finish, levels, login, node, s1Right, v1Right } from './helpers.ts';

beforeEach(() => {
  _reset();
  process.env.MODEL_PROVIDER = 'none';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const advance = (at: string) => vi.setSystemTime(new Date(at));

async function learned() {
  const app = createApp();
  let v = await login(app);
  v = await finish(app, v, node(v, 'sich-v1'), v1Right);
  return { app, v, base: `/api/sessions/${v.session.id}` };
}

async function grade(app: ReturnType<typeof createApp>, base: string, reviewId: string, correct: boolean) {
  const opened = await request(app).post(`${base}/reviews/${reviewId}/start`).send({}).expect(200);
  const question: ReviewQuestion = opened.body.question;
  const sessionId = base.split('/').at(-1)!;
  const answer = get(sessionId).session.reviewChallenges![reviewId].correctOption;
  const option = correct ? answer : (answer + 1) % question.options.length;
  const body = { challengeId: question.id, option };
  const response = await request(app).post(`${base}/reviews/${reviewId}/answer`).send(body).expect(200);
  return { response, question, body };
}

describe('spaced recall', () => {
  it('starts after one day, stays due until answered and never exposes solutions before grading', async () => {
    const { app, v, base } = await learned();
    expect(v.reviews.due).toHaveLength(0);
    expect(v.reviews.upcoming).toHaveLength(2);
    const id = v.reviews.upcoming[0].id;
    await request(app).post(`${base}/reviews/${id}/start`).send({}).expect(409);
    advance('2026-10-25T10:00:00Z');
    const opened = await request(app).post(`${base}/reviews/${id}/start`).send({}).expect(200);
    expect(opened.body.question).not.toHaveProperty('correctOption');
    expect(opened.body.question).not.toHaveProperty('explanation');
    expect(opened.body.question).not.toHaveProperty('sourceQuestionId');
    expect(opened.body.view.session).not.toHaveProperty('reviewChallenges');
    expect(opened.body.view.reviews.due).toHaveLength(2);
    expect(opened.body.question).not.toHaveProperty('scenes');
    const same = await request(app).post(`${base}/reviews/${id}/start`).send({}).expect(200);
    expect(same.body.question).toEqual(opened.body.question);
  });

  it('increases successful intervals through 3, 7, 14, 30 and 60 days without adding XP or completed lessons', async () => {
    const { app, v, base } = await learned();
    const id = v.reviews.upcoming[0].id;
    let dueAt = v.reviews.upcoming[0].dueAt;
    for (const days of [3, 7, 14, 30, 60, 60]) {
      advance(dueAt);
      const { response } = await grade(app, base, id, true);
      expect(response.body.feedback.intervalDays).toBe(days);
      expect(Date.parse(response.body.feedback.dueAt) - Date.now()).toBe(days * 86_400_000);
      expect(response.body.view.rewards.xp).toBe(v.rewards.xp);
      expect(response.body.view.rewards.completedLessons).toBe(1);
      dueAt = response.body.feedback.dueAt;
    }
  });

  it('prioritises failed concepts, requires a ten-minute retry, and rebuilds intervals from one day', async () => {
    const { app, v, base } = await learned();
    const id = v.reviews.upcoming[1].id;
    advance(v.reviews.upcoming[1].dueAt);
    const missed = await grade(app, base, id, false);
    expect(Date.parse(missed.response.body.feedback.dueAt) - Date.now()).toBe(600_000);
    const q = get(v.session.id).session.reviewQueue.find((q) => q.id === id)!;
    expect(q.lapses).toBe(1);
    expect(missed.response.body.view.workspace.lernstand.find((c: { criterion: string }) => c.criterion === q.criterion).state).toBe('am-ueben');
    await request(app).post(`${base}/reviews/${id}/start`).send({}).expect(409);
    advance(q.dueAt!);
    const due = await request(app).get(base).expect(200);
    expect(due.body.reviews.due[0].id).toBe(id);
    const recovered = await grade(app, base, id, true);
    expect(recovered.response.body.feedback.intervalDays).toBe(1);
    expect(recovered.response.body.view.workspace.lernstand.find((c: { criterion: string }) => c.criterion === q.criterion).state).toBe('sicher');
    advance(q.dueAt!);
    expect((await grade(app, base, id, true)).response.body.feedback.intervalDays).toBe(3);
  });

  it('persists deadlines and challenge receipts, handles retries once and rejects changing a graded answer', async () => {
    const { app, v, base } = await learned();
    const id = v.reviews.upcoming[0].id;
    advance(v.reviews.upcoming[0].dueAt);
    const { response, body, question } = await grade(app, base, id, false);
    const restarted = createApp();
    const replay = await request(restarted).post(`${base}/reviews/${id}/answer`).send(body).expect(200);
    expect(replay.body.feedback).toEqual(response.body.feedback);
    expect(replay.body.view.session.reviewQueue.find((q: { id: string }) => q.id === id).lapses).toBe(1);
    await request(restarted).post(`${base}/reviews/${id}/answer`).send({ ...body, option: (body.option + 1) % question.options.length }).expect(409);
    const resumed = await login(restarted, { resume: 'continue' });
    expect(resumed.reviews.upcoming.find((q) => q.id === id)?.dueAt).toBe(response.body.feedback.dueAt);
    expect(resumed.dcc).toEqual(v.dcc);
  });

  it('rejects malformed answers, unstarted challenges and another learner’s reviews', async () => {
    const { app, v, base } = await learned();
    const id = v.reviews.upcoming[0].id;
    advance(v.reviews.upcoming[0].dueAt);
    await request(app).post(`${base}/reviews/${id}/answer`).send({ option: 0 }).expect(409);
    const opened = await request(app).post(`${base}/reviews/${id}/start`).send({}).expect(200);
    for (const option of [-1, 1000, 0.5, '0', null]) await request(app).post(`${base}/reviews/${id}/answer`).send({ challengeId: opened.body.question.id, option }).expect(400);
    const other = await login(app, { name: 'Other' });
    await request(app).post(`/api/sessions/${other.session.id}/reviews/${id}/start`).send({}).expect(404);
  });

  it('covers concepts learned through website tasks and migrates old completed reviews into recurring ones', async () => {
    const { app, v, base } = await learned();
    await finish(app, v, node(v, 'sich-s1'), s1Right);
    const st = get(v.session.id);
    expect(st.session.reviewQueue).toHaveLength(6);
    const legacy = st.session.reviewQueue.find((q) => q.criterion === 'druck')!;
    delete legacy.dueAt;
    legacy.status = 'done';
    save(st);
    advance('2026-10-26T10:00:00Z');
    const restarted = createApp();
    const migrated = await request(restarted).get(base).expect(200);
    expect(migrated.body.reviews.due.some((q: { id: string }) => q.id === legacy.id)).toBe(true);
    const { question } = await grade(restarted, base, legacy.id, true);
    expect(question.context?.join(' ')).toContain('24 hours');
    expect(question.options.length).toBeGreaterThan(1);
  });

  it('a later lesson cannot erase a recent failure or push its retry further away', async () => {
    const { app, v } = await learned();
    const st = get(v.session.id);
    const q = st.session.reviewQueue[0];
    scheduleReview(q, false);
    const dueAt = q.dueAt;
    await finish(app, v, node(v, 'sich-v1'), v1Right);
    expect(q.dueAt).toBe(dueAt);
    expect(q.lapses).toBe(1);
  });
});

async function learnedInfo() {
  const app = createApp();
  let v = await login(app, { levels: { ...levels, 't-info': 'Grundstufe' } });
  const lesson = content.lessons.find((l): l is VideoLesson => l.id === 'info-v1' && l.type === 'video')!;
  const answers = Object.fromEntries(lesson.content.questions.map((q, i) => [i, q.correct]));
  v = await finish(app, v, node(v, lesson.id), { type: 'video', answers });
  const id = v.session.reviewQueue.find((q) => q.trackId === lesson.trackId && q.criterion === 'quelle')!.id;
  return { app, v, lesson, id, base: `/api/sessions/${v.session.id}` };
}

function podcastFrom(lesson: VideoLesson, id: string): PodcastLesson {
  return { ...lesson, id, type: 'podcast', source: 'model', content: {
    lines: [{ speaker: 'a', text: 'We check details against the source.' }, { speaker: 'b', text: 'That goes for studies too.' }],
    questions: lesson.content.questions.map(({ afterScene: _a, ...question }, i) => ({ ...question, prompt: `${id}: Quellenfrage ${i + 1}` })),
  } };
}

function addLesson(sessionId: string, lesson: Lesson) {
  const st = get(sessionId);
  storeLesson(st, lesson);
  const n = { id: `n-${lesson.id}`, kind: 'lesson' as const, parentId: `t-${lesson.trackId}`, trackId: lesson.trackId, lessonId: lesson.id, label: lesson.title, state: 'planned' as const };
  st.session.nodes.push(n);
  save(st);
  return n;
}

describe('question rotation', () => {
  it('repeats every correctly answered question, including after the success interval reaches its cap', async () => {
    const { app, v, base, id, lesson } = await learnedInfo();
    const expected = lesson.content.questions.map((q) => q.prompt);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      advance(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.dueAt!);
      const { question } = await grade(app, base, id, true);
      seen.push(question.prompt);
    }
    expect(seen).toEqual(Array.from({ length: 6 }, () => expected).flat());
    expect(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.questionHistory).toHaveLength(2);
  });

  it('rotates independently of errors and streak resets so a difficult question cannot starve the others', async () => {
    const { app, v, base, id, lesson } = await learnedInfo();
    for (let i = 0; i < 8; i++) {
      advance(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.dueAt!);
      const { question, response } = await grade(app, base, id, i % 3 === 0);
      expect(question.prompt).toBe(lesson.content.questions[i % 2].prompt);
      if (i % 3 !== 0) expect(Date.parse(response.body.feedback.dueAt) - Date.now()).toBe(600_000);
    }
  });

  it('includes all questions from older and newer completed lessons while excluding uncompleted lessons', async () => {
    const { app, v, base, id, lesson } = await learnedInfo();
    const podcast = podcastFrom(lesson, 'review-podcast');
    const n = addLesson(v.session.id, podcast);
    addLesson(v.session.id, podcastFrom(lesson, 'not-completed'));
    // One originally missed question and one originally correct question must both be included.
    const answers = { 0: (podcast.content.questions[0].correct + 1) % 3, 1: podcast.content.questions[1].correct };
    await finish(app, v, n, { type: 'podcast', answers });
    // Repeating a normal lesson does not duplicate its questions in the bank.
    await finish(app, v, n, { type: 'podcast', answers });
    const expected = [...lesson.content.questions, ...podcast.content.questions].map((q) => q.prompt);
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      advance(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.dueAt!);
      seen.push((await grade(app, base, id, true)).question.prompt);
    }
    expect(seen).toEqual([...expected, ...expected]);
  });

  it('adds newly learned questions to the rotation before repeating previously reviewed questions', async () => {
    const { app, v, base, id, lesson } = await learnedInfo();
    for (let i = 0; i < 2; i++) {
      advance(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.dueAt!);
      await grade(app, base, id, true);
    }
    const podcast = podcastFrom(lesson, 'new-review-podcast');
    const n = addLesson(v.session.id, podcast);
    await finish(app, v, n, { type: 'podcast', answers: Object.fromEntries(podcast.content.questions.map((q, i) => [i, q.correct])) });
    const expected = [...podcast.content.questions, ...lesson.content.questions].map((q) => q.prompt);
    for (const prompt of expected) {
      advance(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.dueAt!);
      expect((await grade(app, base, id, true)).question.prompt).toBe(prompt);
    }
  });

  it('keeps pending cards and rotation across restarts and logins, and advances only once per valid submission', async () => {
    const { app, v, base, id, lesson } = await learnedInfo();
    advance(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.dueAt!);
    const opened = await request(app).post(`${base}/reviews/${id}/start`).send({}).expect(200);
    await request(app).post(`${base}/reviews/${id}/answer`).send({ challengeId: opened.body.question.id, option: 1000 }).expect(400);
    expect(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.questionHistory).toBeUndefined();
    const restarted = createApp();
    const reopened = await request(restarted).post(`${base}/reviews/${id}/start`).send({}).expect(200);
    expect(reopened.body.question).toEqual(opened.body.question);
    const { body } = await grade(restarted, base, id, true);
    const history = [...get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.questionHistory!];
    await request(restarted).post(`${base}/reviews/${id}/answer`).send(body).expect(200);
    expect(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.questionHistory).toEqual(history);
    const again = createApp();
    const resumed = await login(again, { resume: 'continue' });
    expect(resumed.session.reviewQueue.find((q) => q.id === id)!.questionHistory).toEqual(history);
    advance(resumed.session.reviewQueue.find((q) => q.id === id)!.dueAt!);
    expect((await grade(again, `/api/sessions/${resumed.session.id}`, id, true)).question.prompt).toBe(lesson.content.questions[1].prompt);
  });

  it('includes supported and invented statements in text checks, including originally correct answers', async () => {
    const app = createApp();
    let v = await login(app, { levels: { ...levels, 't-info': 'Grundstufe' } });
    v = await finish(app, v, node(v, 'info-m1'), { type: 'mark-evidence', marks: { s1: 'erfunden', s2: 'belegt' } });
    const q = get(v.session.id).session.reviewQueue.find((q) => q.trackId === 't-info' && q.criterion === 'zeit')!;
    const prompts: string[] = [];
    for (let i = 0; i < 4; i++) {
      advance(q.dueAt!);
      const { question } = await grade(app, `/api/sessions/${v.session.id}`, q.id, true);
      prompts.push(question.prompt);
      expect(question.context?.length).toBe(3);
    }
    expect(prompts[0]).toContain('Monday');
    expect(prompts[1]).toContain('Lukas');
    expect(prompts.slice(2)).toEqual(prompts.slice(0, 2));
  });

  it('accepts an outstanding card created before rotation and records its source on submission', async () => {
    const { app, v, base, id, lesson } = await learnedInfo();
    advance(get(v.session.id).session.reviewQueue.find((q) => q.id === id)!.dueAt!);
    await request(app).post(`${base}/reviews/${id}/start`).send({}).expect(200);
    delete get(v.session.id).session.reviewChallenges![id].sourceQuestionId;
    save(get(v.session.id));
    const restarted = createApp();
    await grade(restarted, base, id, true);
    const q = get(v.session.id).session.reviewQueue.find((q) => q.id === id)!;
    expect(q.questionHistory).toHaveLength(1);
    advance(q.dueAt!);
    expect((await grade(restarted, base, id, true)).question.prompt).toBe(lesson.content.questions[1].prompt);
  });

  it('rotates warning signs from different completed website exercises for the same concept', async () => {
    const { app, v, base } = await learned();
    await finish(app, v, node(v, 'sich-s1'), s1Right);
    const site = content.lessons.find((l): l is MockSiteLesson => l.id === 'sich-s2' && l.type === 'mock-site')!;
    const n = addLesson(v.session.id, { ...site, id: 'review-website', source: 'model' });
    const parts = [...(site.content.mail ?? []), ...site.content.site];
    await finish(app, v, n, { type: 'mock-site', marked: parts.filter((p) => p.signal).map((p) => p.id), verdict: site.content.correctVerdict });
    const q = get(v.session.id).session.reviewQueue.find((q) => q.criterion === 'absender')!;
    const contexts: string[] = [];
    for (let i = 0; i < 4; i++) {
      advance(q.dueAt!);
      const { question } = await grade(app, base, q.id, true);
      contexts.push(question.context!.join(' '));
    }
    expect(contexts[0]).toContain('samplebank-support.example');
    expect(contexts[1]).toContain('sample-parcelpost-delivery.example');
    expect(contexts.slice(2)).toEqual(contexts.slice(0, 2));
  });
});
