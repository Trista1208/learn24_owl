// Learning records: decision-grade insights with evidence, not a log. Coverage is not learning.
// The server checks every record against the events it cites, for records from the rules and from the agent.
// From the records follow the progress per criterion, the review queue and the cheat sheet.
// None of this touches the DCC profile.
import type {
  LearningEvent, LearningRecord, LernstandEntry, LernstandState, RecordKind, ReferenceEntry, ReviewItem, Track,
} from '@l45/shared';
import { criterionLabel, ruleOfThumb, trackIn } from './tracks.ts';
import { newId, nowIso } from './util.ts';
import { nextRecordId, writeRecord, writeReference, type Stored } from './workspace.ts';
import { firstReviewAt, scheduleReview } from './reviewSchedule.ts';

export interface RecordInput {
  kind: RecordKind;
  trackId: string;
  criterion?: string;
  title: string;
  body: string;
  evidence: string[];
  supersedes?: string;
  author: LearningRecord['author'];
}

export const RECORD_KINDS: RecordKind[] = ['demonstrated', 'prior-knowledge', 'misconception', 'mission-shift'];
const swiss = (s: string) => s.replace(/ß/g, 'ss').trim();
const isActive = (r: LearningRecord) => r.status === 'active';

/** Results for one criterion in one event. Mark-evidence and mock-site can list a criterion more than once. */
function outcome(ev: LearningEvent, criterion: string): 'met' | 'missed' | null {
  const hits = ev.result.criteria.filter((c) => c.key === criterion);
  if (!hits.length) return null;
  return hits.every((c) => c.status === 'met') ? 'met' : 'missed';
}

/** Met without help: alone, no hint, right at the first check. */
export function metWithoutHelp(ev: LearningEvent, criterion: string) {
  return outcome(ev, criterion) === 'met' && ev.mode === 'alone' && !ev.helpUsed && ev.attempts <= 1;
}

/** Problems with a record; empty = the evidence carries it. */
export function checkRecord(st: Stored, r: RecordInput): string[] {
  const e: string[] = [];
  const s = st.session;
  const track = trackIn(st, r.trackId);
  if (!track) return [`unknown area ${r.trackId}`];
  if (!RECORD_KINDS.includes(r.kind)) e.push(`unknown kind ${String(r.kind)}`);
  if (!r.title?.trim() || r.title.length > 100) e.push('title is missing or too long (100 characters)');
  if (!r.body?.trim() || r.body.length > 600) e.push('text is missing or too long (600 characters)');
  if (!Array.isArray(r.evidence) || r.evidence.length === 0) return [...e, 'evidence is missing: give event ids'];

  const needsCriterion = r.kind === 'demonstrated' || r.kind === 'misconception';
  if (needsCriterion && !r.criterion) e.push('criterion is missing');
  if (r.criterion && !track.criteria.some((c) => c.id === r.criterion)) e.push(`unknown criterion ${r.criterion}`);

  const index = new Map(s.events.map((ev, i) => [ev.id, i]));
  const cited = r.evidence.map((id) => s.events.find((ev) => ev.id === id));
  const missions = r.evidence.map((id) => s.missionChanges.find((m) => m.id === id));

  if (r.kind === 'mission-shift') {
    if (!missions.some((m) => m && m.trackId === r.trackId)) e.push('A mission only changes when the learner confirms it. Evidence: id of a mission change (mi-…)');
  } else {
    r.evidence.forEach((id, i) => {
      const ev = cited[i];
      if (!ev) e.push(`evidence ${id} does not exist`);
      else if (ev.trackId !== r.trackId) e.push(`evidence ${id} belongs to another area`);
    });
    const evs = cited.filter((ev): ev is LearningEvent => Boolean(ev && ev.trackId === r.trackId));
    if (r.kind === 'demonstrated' && r.criterion) {
      const bad = evs.filter((ev) => !metWithoutHelp(ev, r.criterion!));
      if (!evs.length || bad.length) {
        e.push(`"demonstrated" needs evidence in which “${r.criterion}” is met alone, without a hint and at the first check${bad.length ? `; not met in ${bad.map((x) => x.id).join(', ')}` : ''}`);
      }
    }
    if (r.kind === 'misconception' && r.criterion) {
      const misses = evs.filter((ev) => outcome(ev, r.criterion!) === 'missed');
      const fix = evs.find((ev) => outcome(ev, r.criterion!) === 'met' && !ev.helpUsed && misses.some((m) => index.get(m.id)! < index.get(ev.id)!));
      if (!misses.length || !fix) e.push(`"misconception" needs evidence in which “${r.criterion}” was missed, and a later one met without a hint`);
    }
  }

  if (r.supersedes) {
    const old = st.records.find((x) => x.id === r.supersedes);
    if (!old) e.push(`${r.supersedes} does not exist`);
    else if (!isActive(old)) e.push(`${r.supersedes} is already replaced`);
    else if (old.trackId !== r.trackId) e.push(`${r.supersedes} belongs to another area`);
  } else if (r.kind !== 'mission-shift') {
    const dup = st.records.find((x) => isActive(x) && x.trackId === r.trackId && x.kind === r.kind && x.criterion === r.criterion);
    if (dup) e.push(`${dup.id} already covers this. Give supersedes to replace it.`);
  }
  return e;
}

/** Checks and writes a record. Throws the problems so callers can report them. */
export function addRecord(st: Stored, input: RecordInput): LearningRecord {
  const errors = checkRecord(st, input);
  if (errors.length) throw new RecordError(errors);
  const rec: LearningRecord = {
    id: nextRecordId(st.profile.id),
    trackId: input.trackId,
    criterion: input.criterion,
    kind: input.kind,
    status: 'active',
    evidence: [...new Set(input.evidence)],
    title: swiss(input.title),
    body: swiss(input.body),
    createdAt: nowIso(),
    author: input.author,
  };
  if (input.supersedes) {
    const old = st.records.find((x) => x.id === input.supersedes)!;
    old.status = `superseded by ${rec.id}`;
    writeRecord(st.profile.id, old);
  }
  st.records.push(rec);
  writeRecord(st.profile.id, rec);
  if (rec.kind === 'demonstrated' && rec.criterion) {
    queueReview(st, rec);
    addReference(st, rec.trackId, { section: 'rule', title: criterionLabel(st, rec.trackId, rec.criterion), text: ruleOfThumb(st, rec.trackId, rec.criterion) ?? rec.body, basedOn: [rec.id] });
  }
  return rec;
}

export class RecordError extends Error {
  constructor(public errors: string[]) {
    super(errors.join('; '));
  }
}

// --- Rules that write records after each lesson -------------------------------------------------------

/** Index of the last event a record cites. */
const lastEvidence = (st: Stored, r: LearningRecord) => Math.max(-1, ...r.evidence.map((id) => st.session.events.findIndex((ev) => ev.id === id)));

/** A demonstrated record is stale once the criterion was missed after it. */
function missedSince(st: Stored, r: LearningRecord) {
  const from = lastEvidence(st, r);
  return st.session.events.some((ev, i) => i > from && ev.trackId === r.trackId && outcome(ev, r.criterion!) === 'missed');
}

/**
 * After a lesson: a criterion first missed and now solved without a hint is a corrected misconception;
 * a criterion solved alone, without a hint, at the first check is demonstrated. Nothing else is recorded.
 */
export function recordFromEvent(st: Stored, ev: LearningEvent): LearningRecord[] {
  const out: LearningRecord[] = [];
  const keys = [...new Set(ev.result.criteria.map((c) => c.key))].filter((k) => k !== 'entscheid' && trackIn(st, ev.trackId)?.criteria.some((c) => c.id === k));
  const before = st.session.events.slice(0, st.session.events.findIndex((x) => x.id === ev.id));
  for (const key of keys) {
    if (outcome(ev, key) !== 'met' || ev.helpUsed || ev.attempts > 1) continue;
    const active = (kind: RecordKind) => st.records.find((r) => isActive(r) && r.trackId === ev.trackId && r.kind === kind && r.criterion === key);
    const demo = active('demonstrated');
    const misc = active('misconception');
    const misses = before.filter((x) => x.trackId === ev.trackId && outcome(x, key) === 'missed');
    const label = criterionLabel(st, ev.trackId, key);
    try {
      if (misses.length && !misc && !demo) {
        out.push(addRecord(st, {
          kind: 'misconception', trackId: ev.trackId, criterion: key, author: 'rule',
          title: `“${label}” now recognised`,
          body: `Missed ${misses.length}× at first, now solved without a hint. Practise once more so it sticks. Rule of thumb: ${ruleOfThumb(st, ev.trackId, key) ?? ''}`,
          evidence: [misses.at(-1)!.id, ev.id],
        }));
      } else if (ev.mode === 'alone' && (!demo || missedSince(st, demo))) {
        out.push(addRecord(st, {
          kind: 'demonstrated', trackId: ev.trackId, criterion: key, author: 'rule', supersedes: demo?.id,
          title: `“${label}” recognised without help`,
          body: demo ? `Solved again without a hint after a mistake. Replaces ${demo.id}.` : 'Solved alone, without a hint and at the first check.',
          evidence: [ev.id],
        }));
      }
    } catch (err) {
      if (!(err instanceof RecordError)) throw err;
      console.warn(`Learning record not written (${ev.id}, ${key}): ${err.message}`);
    }
  }
  return out;
}

// --- Progress per criterion (from the records, never from the DCC) -----------------------------------------------

export function lernstand(st: Stored, trackId: string, criterion: string): LernstandEntry {
  const recs = st.records.filter((r) => isActive(r) && r.trackId === trackId && r.criterion === criterion);
  const demo = recs.find((r) => r.kind === 'demonstrated');
  let state: LernstandState = 'unbekannt';
  if (demo) state = missedSince(st, demo) ? 'am-ueben' : 'sicher';
  else if (recs.length) state = 'am-ueben';
  const review = st.session.reviewQueue.find((q) => q.trackId === trackId && q.criterion === criterion);
  const latestEvent = [...st.session.events].reverse().find((ev) => ev.trackId === trackId && outcome(ev, criterion) !== null);
  if (review?.lastReviewSource === 'recall' && review.lastReviewedAt && (!latestEvent || review.lastReviewedAt >= latestEvent.at)) {
    state = review.lastCorrect ? 'sicher' : 'am-ueben';
  }
  return { trackId, criterion, state, recordIds: recs.map((r) => r.id) };
}

export function lernstandAll(st: Stored, tracks: Track[]): LernstandEntry[] {
  return tracks.flatMap((t) => t.criteria.map((c) => lernstand(st, t.id, c.id)));
}

// --- Review queue (spacing) ------------------------------------------------------------------------------

function queueReview(st: Stored, rec: LearningRecord) {
  const s = st.session;
  const item = s.reviewQueue.find((q) => q.status === 'waiting' && q.trackId === rec.trackId && q.criterion === rec.criterion);
  const fresh = { recordId: rec.id, addedAt: rec.createdAt, addedAfterEvents: s.events.length, addedInSession: s.sessionNo };
  if (item) item.recordId = rec.id;
  else s.reviewQueue.push({ id: newId('rv'), trackId: rec.trackId, criterion: rec.criterion!, status: 'waiting', dueAt: firstReviewAt(rec.createdAt), intervalDays: 1, streak: 0, lapses: 0, ...fresh });
}

/** Use real deadlines; legacy items retain their old trigger until migrated. */
export function isDue(st: Stored, q: ReviewItem, eventsSoFar = st.session.events.length) {
  return q.status === 'waiting' && (q.dueAt ? Date.parse(q.dueAt) <= Date.now() : eventsSoFar - q.addedAfterEvents >= 2 || st.session.sessionNo > q.addedInSession);
}

export const dueReviews = (st: Stored, trackId?: string) => st.session.reviewQueue
  .filter((q) => isDue(st, q) && (!trackId || q.trackId === trackId))
  .sort((a, b) => Number(b.lastCorrect === false) - Number(a.lastCorrect === false) || (b.lapses ?? 0) - (a.lapses ?? 0) || (a.dueAt ?? a.addedAt).localeCompare(b.dueAt ?? b.addedAt));

/** Keep reviews recurring. A missed criterion in a normal lesson also shortens its deadline. */
export function settleReviews(st: Stored, ev: LearningEvent) {
  const before = st.session.events.findIndex((x) => x.id === ev.id);
  const track = trackIn(st, ev.trackId);
  for (const criterion of track?.criteria ?? []) {
    const result = outcome(ev, criterion.id);
    if (result === null) continue;
    let q = st.session.reviewQueue.find((q) => q.trackId === ev.trackId && q.criterion === criterion.id);
    if (!q) {
      q = { id: newId('rv'), trackId: ev.trackId, criterion: criterion.id, recordId: ev.id, addedAt: ev.at, addedAfterEvents: st.session.events.length, addedInSession: st.session.sessionNo, status: 'waiting', dueAt: firstReviewAt(ev.at), intervalDays: 1, streak: 0, lapses: 0 };
      st.session.reviewQueue.push(q);
    }
    if (result === 'missed') scheduleReview(q, false);
    else if (isDue(st, q, before) && !ev.helpUsed && ev.attempts <= 1) scheduleReview(q, true);
  }
}

// --- Cheat sheet ---------------------------------------------------------------------------------------------

export function addReference(st: Stored, trackId: string, entry: ReferenceEntry): boolean {
  const list = st.reference[trackId] ?? (st.reference[trackId] = []);
  const same = list.find((x) => x.section === entry.section && x.title.toLowerCase() === entry.title.toLowerCase());
  if (same) {
    same.basedOn = [...new Set([...same.basedOn, ...entry.basedOn])];
    if (entry.text && entry.text !== same.text && entry.section === 'term') same.text = swiss(entry.text);
  } else {
    list.push({ ...entry, title: swiss(entry.title), text: swiss(entry.text) });
  }
  writeReference(st.profile.id, trackId, trackIn(st, trackId)?.name ?? trackId, list);
  return !same;
}
