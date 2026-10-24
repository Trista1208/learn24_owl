import type { LearningEvent, Lesson, LessonResult } from './types.ts';

export const XP_PER_LEVEL = 200;
export const COMPLETION_XP = 40;
export const LEARNING_XP = 60;
export const LEARNING_TIME_ZONE = 'Europe/Zurich';

export interface LevelProgress {
  xp: number;
  level: number;
  intoLevel: number;
  toNextLevel: number;
  percent: number;
}

export interface TopicProgress extends LevelProgress {
  completedLessons: number;
}

export interface Achievement {
  id: 'first-step' | 'five-lessons' | 'explorer' | 'formats';
  name: string;
  description: string;
  progress: number;
  target: number;
  unlocked: boolean;
}

export interface LearningProgress extends LevelProgress {
  completedLessons: number;
  tracks: Record<string, TopicProgress>;
  achievements: Achievement[];
  todayComplete: boolean;
  weekDays: boolean[];
  weekActiveDays: number;
}

export interface CompletionReward {
  xp: number;
  firstCompletion: boolean;
  levelBefore: number;
  levelAfter: number;
  topicLevelBefore: number;
  topicLevelAfter: number;
  achievements: Achievement[];
  dailyGoalReached: boolean;
  weeklyGoalReached: boolean;
}

export function levelProgress(xp: number): LevelProgress {
  const total = Math.max(0, Math.floor(xp));
  const intoLevel = total % XP_PER_LEVEL;
  return {
    xp: total, level: Math.floor(total / XP_PER_LEVEL) + 1,
    intoLevel, toNextLevel: XP_PER_LEVEL - intoLevel, percent: intoLevel / XP_PER_LEVEL * 100,
  };
}

/** The same maximum for every format. Hints, speed and number of attempts never reduce XP. */
export function lessonXp(result: LessonResult): number {
  const met = result.criteria.filter((c) => c.status === 'met').length;
  const fraction = result.criteria.length ? met / result.criteria.length : result.allMet ? 1 : 0;
  return COMPLETION_XP + Math.round(LEARNING_XP * fraction);
}

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: LEARNING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Calendar days rather than elapsed hours, including daylight-saving transitions. */
function dayNumber(date: Date): number {
  const parts = dayFormat.formatToParts(date);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000;
}

/** Derived from persisted events: old learners get their earned progress without a migration. */
export function learningProgress(events: LearningEvent[], lessons: Pick<Lesson, 'id' | 'type'>[] = [], now = new Date()): LearningProgress {
  const best = new Map<string, { xp: number; trackId: string; lessonId: string }>();
  for (const event of events) {
    const key = JSON.stringify([event.trackId, event.lessonId]);
    const xp = lessonXp(event.result);
    if (!best.has(key) || xp > best.get(key)!.xp) best.set(key, { xp, trackId: event.trackId, lessonId: event.lessonId });
  }
  const topics = new Map<string, { xp: number; completedLessons: number }>();
  for (const entry of best.values()) {
    const topic = topics.get(entry.trackId) ?? { xp: 0, completedLessons: 0 };
    topic.xp += entry.xp;
    topic.completedLessons++;
    topics.set(entry.trackId, topic);
  }
  const completedIds = new Set([...best.values()].map((entry) => entry.lessonId));
  const formats = new Set(lessons.filter((lesson) => completedIds.has(lesson.id)).map((lesson) => lesson.type));
  const achievement = (id: Achievement['id'], name: string, description: string, progress: number, target: number): Achievement => ({
    id, name, description, progress: Math.min(progress, target), target, unlocked: progress >= target,
  });
  const today = dayNumber(now);
  const monday = today - ((new Date(today * 86_400_000).getUTCDay() + 6) % 7);
  const activeDays = new Set(events.flatMap((event) => {
    const date = new Date(event.at);
    return Number.isNaN(date.getTime()) || date > now ? [] : [dayNumber(date)];
  }));
  const weekDays = Array.from({ length: 7 }, (_, i) => activeDays.has(monday + i));
  return {
    ...levelProgress([...topics.values()].reduce((sum, topic) => sum + topic.xp, 0)),
    completedLessons: best.size,
    tracks: Object.fromEntries([...topics].map(([id, topic]) => [id, { ...levelProgress(topic.xp), completedLessons: topic.completedLessons }])),
    achievements: [
      achievement('first-step', 'First step', 'Finish your first lesson.', best.size, 1),
      achievement('five-lessons', 'Well on your way', 'Finish 5 different lessons.', best.size, 5),
      achievement('explorer', 'Explorer', 'Learn in 3 different topics.', topics.size, 3),
      achievement('formats', 'Versatile', 'Try 3 different learning formats.', formats.size, 3),
    ],
    todayComplete: activeDays.has(today), weekDays, weekActiveDays: weekDays.filter(Boolean).length,
  };
}

export function completionReward(before: LearningProgress, after: LearningProgress, trackId: string): CompletionReward {
  return {
    xp: after.xp - before.xp,
    firstCompletion: after.completedLessons > before.completedLessons,
    levelBefore: before.level, levelAfter: after.level,
    topicLevelBefore: before.tracks[trackId]?.level ?? 1,
    topicLevelAfter: after.tracks[trackId]?.level ?? 1,
    achievements: after.achievements.filter((a) => a.unlocked && !before.achievements.some((b) => b.id === a.id && b.unlocked)),
    dailyGoalReached: !before.todayComplete && after.todayComplete,
    weeklyGoalReached: before.weekActiveDays < 3 && after.weekActiveDays >= 3,
  };
}
