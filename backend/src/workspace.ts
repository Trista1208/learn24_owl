// The teaching workspace of a learner on disk, one folder per learner:
//   profile.json, state.json, tracks/<trackId>.json, missions/<trackId>.md, learning-records/0001-<slug>.md,
//   lessons/0001-<slug>.json, reference/<trackId>.md, notes.md
// Every write goes to a temp file first and is then renamed, so a crash never leaves half a file.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DccProfile, LearnerProfile, LearningRecord, Lesson, Mission, ReferenceEntry, Session, Track } from '@l45/shared';
import { bullets, fromMd, section, slug, toMd } from './md.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const learnersRoot = () => process.env.LEARNER_DIR ?? join(here, '..', 'var', 'learners');
const dir = (learnerId: string, ...parts: string[]) => join(learnersRoot(), learnerId, ...parts);

/** What state.json holds: the session without what lives in its own files. */
export type StoredState = Omit<Session, 'userName' | 'generatedLessons' | 'planning'> & { version: 1 };

/** A learner's workspace in memory. dcc is the latest DCC snapshot, read-only. */
export interface Stored {
  session: Session;
  dcc: DccProfile;
  profile: LearnerProfile;
  /** Tracks the learner created from own topics. Prepared tracks they added are only nodes on the map. */
  tracks: Track[];
  missions: Mission[];
  records: LearningRecord[];
  reference: Record<string, ReferenceEntry[]>;
  notes: string[];
}

export function loadLearner(learnerId: string): Stored | null {
  const profile = readProfile(learnerId);
  const state = readState(learnerId);
  const dcc = profile?.dccSnapshots.at(-1)?.profile;
  if (!profile || !state || !dcc) return null;
  const { version: _v, ...rest } = state;
  return {
    session: { ...rest, userName: profile.name, generatedLessons: readLessons(learnerId), planning: false },
    dcc: Object.freeze({ ...dcc, levels: Object.freeze({ ...dcc.levels }) }),
    profile,
    tracks: readTracks(learnerId),
    missions: readMissions(learnerId),
    records: readRecords(learnerId),
    reference: readReference(learnerId),
    notes: readNotes(learnerId),
  };
}

export function atomicWrite(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  // Windows can refuse a rename for a moment while a scanner holds the target file.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true });
        throw err;
      }
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* short wait */ }
    }
  }
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const list = (path: string, ext: string) => (existsSync(path) ? readdirSync(path).filter((f) => f.endsWith(ext)).sort() : []);
const nextNumber = (files: string[]) => Math.max(0, ...files.map((f) => Number.parseInt(f, 10)).filter(Number.isFinite)) + 1;
const pad = (n: number) => String(n).padStart(4, '0');

// --- Profile and state --------------------------------------------------------------------------

export function learnerIds(): string[] {
  const root = learnersRoot();
  return existsSync(root) ? readdirSync(root).filter((d) => existsSync(join(root, d, 'profile.json'))) : [];
}

export function readProfile(learnerId: string): LearnerProfile | null {
  const t = readText(dir(learnerId, 'profile.json'));
  return t ? (JSON.parse(t) as LearnerProfile) : null;
}

export function writeProfile(p: LearnerProfile) {
  atomicWrite(dir(p.id, 'profile.json'), JSON.stringify(p, null, 2));
}

export function readState(learnerId: string): StoredState | null {
  const t = readText(dir(learnerId, 'state.json'));
  return t ? (JSON.parse(t) as StoredState) : null;
}

export function writeState(s: Session) {
  const { userName: _u, generatedLessons: _g, planning: _p, ...rest } = s;
  const state: StoredState = { version: 1, ...rest };
  atomicWrite(dir(s.learnerId, 'state.json'), JSON.stringify(state, null, 2));
}

/** Learners with this name (case-insensitive), newest first. */
export function findByName(name: string): LearnerProfile[] {
  const key = name.trim().toLowerCase();
  return learnerIds()
    .map(readProfile)
    .filter((p): p is LearnerProfile => Boolean(p && p.name.trim().toLowerCase() === key))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findBySession(sessionId: string): string | null {
  return learnerIds().find((id) => readState(id)?.id === sessionId) ?? null;
}

// --- Own tracks -------------------------------------------------------------------------------

export function readTracks(learnerId: string): Track[] {
  const d = dir(learnerId, 'tracks');
  return list(d, '.json')
    .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Track)
    .sort((a, b) => (a.custom?.createdAt ?? '').localeCompare(b.custom?.createdAt ?? ''));
}

export function writeTrack(learnerId: string, t: Track) {
  atomicWrite(dir(learnerId, 'tracks', `${t.id}.json`), JSON.stringify(t, null, 2));
}

// --- Missions -----------------------------------------------------------------------------------

export function readMissions(learnerId: string): Mission[] {
  const d = dir(learnerId, 'missions');
  return list(d, '.md').map((f) => {
    const { meta, body } = fromMd(readFileSync(join(d, f), 'utf8'));
    return {
      trackId: String(meta.track ?? f.replace(/\.md$/, '')),
      status: meta.status === 'default' ? 'default' : 'set',
      updatedAt: String(meta.updatedAt ?? ''),
      text: section(body, 'Why'),
    };
  });
}

export function writeMission(learnerId: string, m: Mission, trackName: string) {
  const body = `# Mission: ${trackName}\n\n## Why\n${m.text}\n`;
  atomicWrite(dir(learnerId, 'missions', `${m.trackId}.md`), toMd({ track: m.trackId, status: m.status, updatedAt: m.updatedAt }, body));
}

// --- Learning records -------------------------------------------------------------------------------

export function readRecords(learnerId: string): LearningRecord[] {
  const d = dir(learnerId, 'learning-records');
  return list(d, '.md').map((f) => {
    const { meta, body } = fromMd(readFileSync(join(d, f), 'utf8'));
    const lines = body.trim().split('\n');
    const title = (lines[0] ?? '').replace(/^#\s*/, '');
    return {
      id: String(meta.id),
      trackId: String(meta.track),
      criterion: meta.criterion ? String(meta.criterion) : undefined,
      kind: meta.kind as LearningRecord['kind'],
      status: String(meta.status ?? 'active'),
      evidence: Array.isArray(meta.evidence) ? meta.evidence.map(String) : [],
      createdAt: String(meta.createdAt ?? ''),
      author: meta.author === 'agent' ? 'agent' : 'rule',
      title,
      body: lines.slice(1).join('\n').trim(),
    };
  });
}

/** Next record id, from the highest number on disk (as in the teach skill). */
export function nextRecordId(learnerId: string): string {
  return `LR-${pad(nextNumber(list(dir(learnerId, 'learning-records'), '.md')))}`;
}

export function writeRecord(learnerId: string, r: LearningRecord) {
  const d = dir(learnerId, 'learning-records');
  const num = r.id.replace(/^LR-/, '');
  const file = list(d, '.md').find((f) => f.startsWith(`${num}-`)) ?? `${num}-${slug(r.title)}.md`;
  const meta = { id: r.id, track: r.trackId, criterion: r.criterion, kind: r.kind, status: r.status, evidence: r.evidence, createdAt: r.createdAt, author: r.author };
  atomicWrite(join(d, file), toMd(meta, `# ${r.title}\n\n${r.body}\n`));
}

// --- Generated lessons ---------------------------------------------------------------------------

export function readLessons(learnerId: string): Lesson[] {
  const d = dir(learnerId, 'lessons');
  return list(d, '.json').map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as Lesson);
}

export function nextLessonNumber(learnerId: string): number {
  return nextNumber(list(dir(learnerId, 'lessons'), '.json'));
}

export function writeLesson(learnerId: string, n: number, l: Lesson) {
  atomicWrite(dir(learnerId, 'lessons', `${pad(n)}-${slug(l.title)}.json`), JSON.stringify(l, null, 2));
}

/** Saves a lesson made during learning to the workspace (lessons/0001-<slug>.json). */
export function storeLesson(st: Stored, lesson: Lesson) {
  st.session.generatedLessons.push(lesson);
  writeLesson(st.profile.id, nextLessonNumber(st.profile.id), lesson);
}

/** Removes a lesson file, e.g. a rule template made only for a provisional plan the agent replaced. */
export function deleteLesson(learnerId: string, lessonId: string) {
  const d = dir(learnerId, 'lessons');
  for (const f of list(d, '.json')) {
    if ((JSON.parse(readFileSync(join(d, f), 'utf8')) as Lesson).id === lessonId) rmSync(join(d, f), { force: true });
  }
}

// --- Key points per track -----------------------------------------------------------------------------

const SECTIONS: [ReferenceEntry['section'], string][] = [['rule', 'Rules of thumb'], ['term', 'Terms']];

export function readReference(learnerId: string): Record<string, ReferenceEntry[]> {
  const d = dir(learnerId, 'reference');
  const out: Record<string, ReferenceEntry[]> = {};
  for (const f of list(d, '.md')) {
    const body = readFileSync(join(d, f), 'utf8');
    out[f.replace(/\.md$/, '')] = SECTIONS.flatMap(([kind, heading]) =>
      bullets(section(body, heading)).map((line) => {
        const m = /^\*\*(.+?)\*\*:\s*(.*?)(?:\s+\(((?:LR-\d+|ev-[\w-]+)(?:,\s*(?:LR-\d+|ev-[\w-]+))*)\))?$/.exec(line);
        return m
          ? { section: kind, title: m[1], text: m[2], basedOn: m[3] ? m[3].split(/,\s*/) : [] }
          : { section: kind, title: '', text: line, basedOn: [] };
      }),
    );
  }
  return out;
}

export function writeReference(learnerId: string, trackId: string, trackName: string, entries: ReferenceEntry[]) {
  const line = (e: ReferenceEntry) => `- **${e.title}**: ${e.text}${e.basedOn.length ? ` (${e.basedOn.join(', ')})` : ''}`;
  const body = [
    `# Key points: ${trackName}`,
    '',
    'What you have shown without help, short and easy to look up.',
    ...SECTIONS.flatMap(([kind, heading]) => {
      const items = entries.filter((e) => e.section === kind);
      return items.length ? ['', `## ${heading}`, ...items.map(line)] : [];
    }),
  ].join('\n');
  atomicWrite(dir(learnerId, 'reference', `${trackId}.md`), `${body}\n`);
}

// --- Notes ---------------------------------------------------------------------------------------------

export function readNotes(learnerId: string): string[] {
  const t = readText(dir(learnerId, 'notes.md'));
  return t ? bullets(t.replace(/\r\n/g, '\n')) : [];
}

export function writeNotes(learnerId: string, notes: string[]) {
  atomicWrite(dir(learnerId, 'notes.md'), `# Notes\n\nLearning preferences, noted by the agent.\n\n${notes.map((n) => `- ${n}`).join('\n')}\n`);
}

/** Test helper: removes all learner folders. Only allowed for a LEARNER_DIR set explicitly (tests use a temp folder). */
export function _wipe() {
  if (!process.env.LEARNER_DIR) throw new Error('_wipe only with LEARNER_DIR');
  rmSync(learnersRoot(), { recursive: true, force: true });
}
