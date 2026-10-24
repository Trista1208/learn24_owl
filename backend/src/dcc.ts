// The DCC profile: the only source of diagnostic levels. Loaded at login, never changed by learning.
import type { DccLevel, DccProfile } from '@l45/shared';
import { DCC_LEVELS } from '@l45/shared';
import { content } from './content.ts';

export class InputError extends Error {}

const dccTracks = () => content.skills.filter((s) => s.dccBased).flatMap((s) => s.tracks);

function level(value: unknown): DccLevel | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && (DCC_LEVELS as string[]).includes(value)) return value as DccLevel;
  throw new InputError(`Unknown level “${String(value)}”. Allowed: ${DCC_LEVELS.join(', ')} or empty.`);
}

/** Validates a DCC result file (synthetic format, see frontend/public/dcc-examples). */
export function profileFromFile(file: unknown, fileName?: string): DccProfile {
  const f = file as { type?: string; areas?: { area?: string; level?: unknown }[]; assessedOn?: string };
  if (!f || f.type !== 'dcc-result' || !Array.isArray(f.areas)) {
    throw new InputError('This is not a DCC result file. Expected JSON with "type": "dcc-result" and a list "areas".');
  }
  const levels: Record<string, DccLevel | null> = {};
  for (const t of dccTracks()) levels[t.id] = null;
  for (const a of f.areas) {
    const track = dccTracks().find((t) => t.dccArea === String(a.area));
    if (!track) throw new InputError(`Unknown competence area “${String(a.area)}”. Allowed: 1 to 5.`);
    levels[track.id] = level(a.level);
  }
  return Object.freeze({ source: 'file' as const, fileName, assessedOn: typeof f.assessedOn === 'string' ? f.assessedOn : null, levels: Object.freeze(levels) });
}

export function profileFromManual(input: unknown): DccProfile {
  const levels: Record<string, DccLevel | null> = {};
  const given = (input ?? {}) as Record<string, unknown>;
  for (const t of dccTracks()) levels[t.id] = level(given[t.id]);
  return Object.freeze({ source: 'manual' as const, assessedOn: null, levels: Object.freeze(levels) });
}
