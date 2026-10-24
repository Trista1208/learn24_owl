// The tracks of one learner. The map starts empty: a learner adds prepared tracks from the catalog
// (data/skills.json) or creates own ones from a topic (designer.ts, stored in tracks/<id>.json).
// Everything that depends on a learner's tracks looks them up here, never in the whole catalog.
import type { Mission, Skill, Track } from '@l45/shared';
import { CUSTOM_SKILL } from '@l45/shared';
import { content, getTrack as catalogTrack } from './content.ts';
import type { Stored } from './workspace.ts';

export { catalogTrack };

/** Tracks on the learner's map, in the order they were added. */
export function learnerTracks(st: Stored): Track[] {
  return st.session.nodes
    .filter((n) => n.kind === 'track' && n.trackId)
    .map((n) => st.tracks.find((t) => t.id === n.trackId) ?? catalogTrack(n.trackId!))
    .filter((t): t is Track => Boolean(t));
}

export const trackIn = (st: Stored, id: string) => learnerTracks(st).find((t) => t.id === id);

/** The learner's tracks grouped by skill, in catalog order; own tracks last. */
export function learnerSkills(st: Stored): Skill[] {
  const mine = learnerTracks(st);
  const ids = new Set(mine.map((t) => t.id));
  const own: Skill = { ...CUSTOM_SKILL, tracks: mine.filter((t) => t.custom) };
  return [...content.skills.map((s) => ({ ...s, tracks: s.tracks.filter((t) => ids.has(t.id)) })), own].filter((s) => s.tracks.length);
}

export const skillIn = (st: Stored, trackId: string) => learnerSkills(st).find((s) => s.tracks.some((t) => t.id === trackId));
export const criterionLabel = (st: Stored, trackId: string, id: string) => trackIn(st, trackId)?.criteria.find((c) => c.id === id)?.label ?? id;
export const ruleOfThumb = (st: Stored, trackId: string, id: string) => trackIn(st, trackId)?.criteria.find((c) => c.id === id)?.ruleOfThumb;

export const defaultMission = (st: Stored, trackId: string) => {
  const t = trackIn(st, trackId);
  return t?.mission?.default ?? `I want to get more confident in “${t?.name ?? trackId}”.`;
};
export const missionOf = (st: Stored, trackId: string): Mission | undefined => st.missions.find((m) => m.trackId === trackId);
