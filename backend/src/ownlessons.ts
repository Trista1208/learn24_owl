// Lessons for the learner's own tracks. These have no prepared lessons, so the generator writes every one:
// the first lesson when the track is made, and later ones the rules ask for when the planner agent is not there
// or fails. The rules pick the target (last missed criterion, else one without evidence); the model only writes.
import type { DccLevel, LearningEvent, Lesson, LessonType, MapNode, Session, Track } from '@l45/shared';
import { DCC_LEVELS } from '@l45/shared';
import { GENERATED_PER_SESSION, generateLesson, type GenerateResult } from './generator.ts';
import { allLessons } from './guard.ts';
import { dueReviews, lernstand } from './records.ts';
import { defaultMission, missionOf, trackIn } from './tracks.ts';
import { storeLesson, type Stored } from './workspace.ts';

const CALL_MS = () => Number(process.env.GENERATE_TIMEOUT_MS ?? 30_000);

export const generatedThisSession = (s: Session) =>
  s.generatedLessons.filter((l) => l.provenance?.by === 'model' && l.provenance.sessionNo === s.sessionNo).length;

interface Want {
  criterion: string;
  reviewOf?: string[];
  level: DccLevel;
  contextHint: string;
  mission: string;
  basedOn: string[];
}

/** Tries the preferred lesson type, then one other type of the track. */
async function generate(st: Stored, track: Track, types: LessonType[], want: Want): Promise<GenerateResult> {
  const s = st.session;
  let last: GenerateResult = { ok: false, errors: ['no suitable lesson type'] };
  for (const type of types.slice(0, 2)) {
    last = await generateLesson({ ...want, type, track, preferences: st.notes, sessionNo: s.sessionNo, timeoutMs: CALL_MS() }, (c) => s.modelCalls.push(c));
    if (last.ok) return last;
  }
  return last;
}

/** The first lesson of a new own track: a short starter on the first criterion, at the level the learner stated. */
export function firstLesson(st: Stored, track: Track, goal?: string, requestedType?: 'video'): Promise<GenerateResult> {
  const types = track.custom!.lessonTypes;
  return generate(st, track, requestedType ? [requestedType] : [...types.filter((t) => t === 'video'), ...types.filter((t) => t !== 'video')], {
    criterion: track.criteria[0].id,
    level: track.custom!.selfLevel,
    contextHint: `Starter for “${track.name}”. ${requestedType === 'video' ? 'The learner explicitly wants an explainer video with questions on their topic.' : 'Shows what the learner already knows.'}`,
    mission: goal ?? track.mission?.default ?? track.custom!.topic,
    basedOn: [],
  });
}

/** Hangs a lesson on the node of the track's last result, or on the track node. */
function place(st: Stored, track: Track, lesson: Lesson, last?: LearningEvent): MapNode {
  const s = st.session;
  const parent = s.nodes.find((n) => n.id === last?.nodeId) ?? s.nodes.find((n) => n.kind === 'track' && n.trackId === track.id)!;
  const node: MapNode = {
    id: `n-${lesson.id}`, kind: 'lesson', parentId: parent.id, label: lesson.title,
    skillId: track.skillId, trackId: track.id, lessonId: lesson.id, state: 'planned', addedByAgent: true,
  };
  s.nodes.push(node);
  return node;
}

/**
 * After a lesson in an own track with nothing left to do there: a valid lesson the agent already made (ready)
 * goes on the map; otherwise the rules choose the next target and the generator writes it.
 * Returns the new node, or null if this is not an own track, nothing is needed or it failed.
 */
export async function ruleLesson(st: Stored, trackId: string, ready: Lesson[] = []): Promise<MapNode | null> {
  const s = st.session;
  const track = trackIn(st, trackId);
  if (!track?.custom) return null;
  if (s.nodes.some((n) => n.kind === 'lesson' && n.trackId === trackId && n.state !== 'done' && n.state !== 'skipped')) return null;

  const events = s.events.filter((e) => e.trackId === trackId);
  const last = events.at(-1);
  const unused = ready.find((l) => l.trackId === trackId && !s.nodes.some((n) => n.lessonId === l.id));
  if (unused) return place(st, track, unused, last);
  if (generatedThisSession(s) >= GENERATED_PER_SESSION) return null;
  const known = (id: string) => track.criteria.some((c) => c.id === id);
  const missed = last?.result.criteria.find((c) => c.status === 'missed' && known(c.key))?.key;
  const withState = (state: string) => track.criteria.find((c) => lernstand(st, trackId, c.id).state === state)?.id;
  const due = dueReviews(st, trackId).map((q) => q.criterion);
  const criterion = missed ?? withState('unbekannt') ?? withState('am-ueben') ?? due[0] ?? track.criteria[events.length % track.criteria.length].id;
  // Spacing: due reviews are mixed into the next lesson, unless it has to repair a miss.
  const reviewOf = missed ? [] : due.filter((c) => c !== criterion).slice(0, 2);

  // One level up after two smooth lessons, as R2 does for prepared tracks.
  const lastLevel = allLessons(s).find((l) => l.id === last?.lessonId)?.level ?? track.custom.selfLevel;
  const fluent = events.length >= 2 && events.slice(-2).every((e) => e.result.allMet && !e.helpUsed && e.attempts <= 1);
  const level = fluent ? DCC_LEVELS[Math.min(DCC_LEVELS.length - 1, DCC_LEVELS.indexOf(lastLevel) + 1)] : lastLevel;

  const types = track.custom.lessonTypes;
  const start = events.length % types.length;
  const targets = [criterion, ...reviewOf];
  const r = await generate(st, track, [...types.slice(start), ...types.slice(0, start)], {
    criterion,
    reviewOf: reviewOf.length ? reviewOf : undefined,
    level,
    contextHint: missed ? 'A new example for what was missing last time.' : 'The next step in the area.',
    mission: missionOf(st, trackId)?.text ?? defaultMission(st, trackId),
    basedOn: [
      ...st.records.filter((x) => x.trackId === trackId && x.status === 'active' && targets.includes(x.criterion ?? '')).map((x) => x.id),
      ...(last ? [last.id] : []),
    ],
  });
  if (!r.ok) {
    console.warn(`Rule lesson for ${trackId} not created: ${r.errors.join('; ')}`);
    return null;
  }
  storeLesson(st, r.lesson);
  return place(st, track, r.lesson, last);
}
