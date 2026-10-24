import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { completionReward, learningProgress, levelProgress, lessonXp } from '@l45/shared';
import type { LearningEvent, LessonResult, LessonType } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { _reset } from '../src/sessions.ts';
import { finish, levels, login, node, s1Right, v1MissLink, v1Right } from './helpers.ts';

const now = new Date('2026-10-24T12:00:00Z');
function result(statuses: ('met' | 'missed')[] = ['met', 'met']): LessonResult {
  return { allMet: statuses.every((s) => s === 'met'), criteria: statuses.map((status, i) => ({ key: `c${i}`, label: `Goal ${i}`, status })), items: [], summary: 'Result', judgedBy: 'rule' };
}
function event(lessonId: string, overrides: Partial<LearningEvent> = {}): LearningEvent {
  return { id: `event-${lessonId}`, at: now.toISOString(), nodeId: `node-${lessonId}`, lessonId, trackId: 'topic', mode: 'alone', helpUsed: false, attempts: 1, durationMin: 3, result: result(), source: 'prepared', ...overrides };
}

describe('XP and milestones from the learning history', () => {
  it('starts at level one and crosses exact level boundaries', () => {
    expect(levelProgress(0)).toMatchObject({ xp: 0, level: 1, intoLevel: 0, toNextLevel: 200 });
    expect(levelProgress(199)).toMatchObject({ level: 1, intoLevel: 199, toNextLevel: 1 });
    expect(levelProgress(200)).toMatchObject({ level: 2, intoLevel: 0, toNextLevel: 200 });
    expect(learningProgress([], [], now)).toMatchObject({ xp: 0, completedLessons: 0, todayComplete: false, weekActiveDays: 0 });
  });

  it('rewards completion and learning goals equally across all five formats, with no hint or speed penalty', () => {
    const types: LessonType[] = ['video', 'podcast', 'ai-chat', 'mark-evidence', 'mock-site'];
    for (const type of types) {
      const lesson = { id: type, type };
      const ordinary = learningProgress([event(type)], [lesson], now);
      const supported = learningProgress([event(type, { helpUsed: true, attempts: 4, durationMin: 60 })], [lesson], now);
      expect(ordinary.xp).toBe(100);
      expect(supported.xp).toBe(ordinary.xp);
    }
    expect(lessonXp(result(['missed', 'missed']))).toBe(40);
    expect(lessonXp(result(['met', 'missed']))).toBe(70);
    expect(lessonXp({ ...result([]), allMet: false })).toBe(40);
  });

  it('counts the best result per lesson, including replays under different map nodes', () => {
    const events = [event('one', { result: result(['met', 'missed']) })];
    const first = learningProgress(events, [], now);
    const better = learningProgress([...events, event('one', { nodeId: 'new-node' })], [], now);
    expect(first.xp).toBe(70);
    expect(better.xp).toBe(100);
    expect(completionReward(first, better, 'topic')).toMatchObject({ xp: 30, firstCompletion: false });
    for (const replay of [event('one'), event('one', { result: result(['missed', 'missed']) })]) {
      expect(learningProgress([...events, event('one'), replay], [], now)).toMatchObject({ xp: 100, completedLessons: 1 });
    }
  });

  it('keeps topic levels independent while the overall level includes every topic', () => {
    const progress = learningProgress([event('one'), event('two'), event('three', { trackId: 'another-topic' })], [], now);
    expect(progress).toMatchObject({ xp: 300, level: 2, completedLessons: 3 });
    expect(progress.tracks.topic).toMatchObject({ xp: 200, level: 2, completedLessons: 2 });
    expect(progress.tracks['another-topic']).toMatchObject({ xp: 100, level: 1, completedLessons: 1 });
    const before = learningProgress([event('one')], [], now);
    const after = learningProgress([event('one'), event('two')], [], now);
    expect(completionReward(before, after, 'topic')).toMatchObject({ xp: 100, levelBefore: 1, levelAfter: 2, topicLevelBefore: 1, topicLevelAfter: 2 });
  });

  it('unlocks each badge once and requires distinct lessons, topics and formats', () => {
    const types: LessonType[] = ['video', 'podcast', 'ai-chat', 'mark-evidence', 'mock-site'];
    const lessons = types.map((type, i) => ({ id: `lesson-${i}`, type }));
    const events = lessons.map((l, i) => event(l.id, { trackId: `topic-${i % 3}` }));
    const empty = learningProgress([], lessons, now);
    const full = learningProgress(events, lessons, now);
    expect(full.achievements.every((a) => a.unlocked)).toBe(true);
    expect(completionReward(empty, full, 'topic-0').achievements).toHaveLength(4);
    expect(completionReward(full, learningProgress([...events, events[0]], lessons, now), 'topic-0').achievements).toEqual([]);
    const repeats = learningProgress(Array.from({ length: 5 }, () => events[0]), lessons, now);
    expect(repeats.achievements.filter((a) => a.unlocked).map((a) => a.id)).toEqual(['first-step']);
  });

  it('uses Swiss calendar dates for midnight, Mondays and the autumn clock change', () => {
    const sunday = event('one', { at: '2026-10-25T00:30:00Z' });
    const repeatedHour = event('one', { at: '2026-10-25T01:30:00Z' });
    const sundayNow = new Date('2026-10-25T12:00:00Z');
    const progress = learningProgress([sunday, repeatedHour], [], sundayNow);
    expect(progress.weekDays).toEqual([false, false, false, false, false, false, true]);
    expect(progress.weekActiveDays).toBe(1);
    // Sunday at 23:30 UTC is already Monday in Zurich (after the clock change).
    const monday = event('two', { at: '2026-10-25T23:30:00Z' });
    const nextWeek = learningProgress([sunday, repeatedHour, monday], [], new Date('2026-10-26T00:00:00Z'));
    expect(nextWeek.weekDays).toEqual([true, false, false, false, false, false, false]);
    expect(nextWeek.todayComplete).toBe(true);
    const previousDay = learningProgress([sunday, repeatedHour], [], new Date('2026-10-26T00:00:00Z'));
    expect(previousDay.todayComplete).toBe(false);
    expect(previousDay.xp).toBe(100);
  });

  it('celebrates daily and weekly goals once while a replay can count as a learning day', () => {
    const events = [event('one', { at: '2026-10-19T10:00:00Z' }), event('one', { at: '2026-10-21T10:00:00Z' })];
    const before = learningProgress(events, [], now);
    const after = learningProgress([...events, event('one')], [], now);
    expect(completionReward(before, after, 'topic')).toMatchObject({ xp: 0, dailyGoalReached: true, weeklyGoalReached: true });
    expect(completionReward(after, after, 'topic')).toMatchObject({ dailyGoalReached: false, weeklyGoalReached: false });
    expect(learningProgress([event('future', { at: '2026-10-25T10:00:00Z' })], [], now).weekActiveDays).toBe(0);
  });
});

describe('Rewards through the API', () => {
  beforeEach(() => {
    process.env.MODEL_PROVIDER = 'none';
    _reset();
  });

  it('returns earned rewards, improves a partial result, avoids duplicate XP and keeps DCC separate', async () => {
    const app = createApp();
    const initial = await login(app);
    const lessonNode = node(initial, 'sich-v1');
    const complete = (answer: unknown) => request(app).post(`/api/sessions/${initial.session.id}/nodes/${lessonNode.id}/complete`).send({ answer });
    const first = await complete(v1MissLink).expect(200);
    expect(first.body.reward).toMatchObject({ xp: 70, firstCompletion: true, dailyGoalReached: true });
    expect(first.body.reward.achievements.map((a: { id: string }) => a.id)).toEqual(['first-step']);
    const improved = await complete(v1Right).expect(200);
    expect(improved.body.reward).toMatchObject({ xp: 30, firstCompletion: false, dailyGoalReached: false, achievements: [] });
    const replay = await complete(v1Right).expect(200);
    expect(replay.body.reward.xp).toBe(0);
    expect(replay.body.view.rewards).toMatchObject({ xp: 100, completedLessons: 1 });
    expect(replay.body.view.dcc).toEqual(initial.dcc);
  });

  it('retains levels and badges after restart and continuing the learner, without a new rewards file', async () => {
    const app = createApp();
    let progress = await login(app, { name: 'Rewards persistence' });
    progress = await finish(app, progress, node(progress, 'sich-v1'), v1Right);
    progress = await finish(app, progress, node(progress, 'sich-s1'), s1Right);
    expect(progress.rewards).toMatchObject({ xp: 200, level: 2 });
    expect(progress.rewards.tracks['t-sicherheit'].level).toBe(2);
    const restarted = createApp();
    const restored = await request(restarted).get(`/api/sessions/${progress.session.id}`).expect(200);
    expect(restored.body.rewards).toEqual(progress.rewards);
    const continued = await request(restarted).post('/api/login').send({ name: 'Rewards persistence', levels, resume: 'continue' }).expect(201);
    expect(continued.body.rewards).toEqual(progress.rewards);
    expect(continued.body.dcc).toEqual(progress.dcc);
  });
});
