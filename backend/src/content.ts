// Loads the synthetic content from /data. Read-only at runtime.
// Every lesson goes through the same validator as generated lessons; invalid ones are dropped and logged.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Lesson, Skill } from '@l45/shared';
import { validateLesson } from './validate.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR ?? join(here, '..', '..', 'data');

const readJson = <T,>(file: string): T => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8')) as T;

/** Lessons the validator rejected at startup, with the reasons. */
export const rejectedLessons: { id: string; file: string; errors: string[] }[] = [];

function load() {
  const skills = readJson<Skill[]>('skills.json');
  const files = readdirSync(join(DATA_DIR, 'lessons')).filter((f) => f.endsWith('.json')).sort();
  const tracks = new Map(skills.flatMap((s) => s.tracks).map((t) => [t.id, t]));
  const ids = new Set<string>();
  const lessons: Lesson[] = [];
  for (const f of files) {
    for (const l of readJson<Lesson[]>(join('lessons', f))) {
      const track = tracks.get(l.trackId);
      const errors = track ? validateLesson(l, { track }) : [`unknown track ${l.trackId}`];
      if (ids.has(l.id)) errors.push('duplicate lesson ID');
      if (errors.length) {
        rejectedLessons.push({ id: l.id, file: f, errors });
        console.warn(`Lesson ${l.id} (${f}) discarded: ${errors.join('; ')}`);
        continue;
      }
      ids.add(l.id);
      lessons.push(l);
    }
  }
  return { skills, lessons };
}

export const content = load();

/** A prepared track of the catalog. A learner's tracks (with their own) are in tracks.ts. */
export const getTrack = (id: string) => content.skills.flatMap((s) => s.tracks).find((t) => t.id === id);
