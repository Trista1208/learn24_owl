import { describe, expect, it } from 'vitest';
import type { Criterion, Lesson, MapNode } from '@l45/shared';
import { mountainsOf } from './mountains.ts';

const criteria: Criterion[] = [
  { id: 'sender', label: 'Sender address', ruleOfThumb: '' },
  { id: 'link', label: 'Link target', ruleOfThumb: '' },
];

const done = (n: number) => Array.from({ length: n }, (_, i): MapNode => ({ id: `n${i}`, kind: 'lesson', parentId: null, label: `L${i}`, lessonId: `l${i}`, state: 'done' }));
/** Lesson i trains the criteria targets[i]. */
const lessons = (targets: string[][]) => (id?: string) => ({ targets: targets[Number(id?.slice(1))] ?? [] }) as unknown as Lesson;

describe('mountainsOf', () => {
  it('starts with one empty mountain', () => {
    expect(mountainsOf([], lessons([]), criteria)).toEqual([{ number: 1, lessons: [], topped: false, name: null }]);
  });

  it('puts six lessons on a mountain and the seventh on the next', () => {
    const m = mountainsOf(done(7), lessons([]), criteria);
    expect(m.map((x) => [x.number, x.lessons.length, x.topped])).toEqual([[1, 6, true], [2, 1, false]]);
  });

  it('opens the next mountain right after a peak', () => {
    const m = mountainsOf(done(6), lessons([]), criteria);
    expect(m.map((x) => [x.lessons.length, x.topped])).toEqual([[6, true], [0, false]]);
  });

  it('names a topped mountain after the criterion its lessons trained most', () => {
    const m = mountainsOf(done(6), lessons([['sender'], ['link'], ['link', 'sender'], ['link'], [], ['sender', 'link']]), criteria);
    expect(m[0].name).toBe('Link target');
  });

  it('breaks a tie with the criterion listed first and leaves a mountain without targets unnamed', () => {
    expect(mountainsOf(done(6), lessons([['link'], ['sender']]), criteria)[0].name).toBe('Sender address');
    expect(mountainsOf(done(6), lessons([]), criteria)[0].name).toBeNull();
  });

  it('does not name the mountain still being climbed', () => {
    expect(mountainsOf(done(3), lessons([['link'], ['link'], ['link']]), criteria)[0].name).toBeNull();
  });
});
