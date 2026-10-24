// Sessions and the actions on them. A session is one sitting of a learner; the learner's workspace
// (map, events, records, missions, generated lessons) lives on disk and survives a restart.
import type {
  Answer, ChatTurn, DccLevel, DccProfile, DccSnapshot, LearnerProfile, LearningEvent, Lesson, LessonResult, LoginConflict, MapNode,
  LessonAnswerFeedback, Mission, MockPart, PartialCheck, Recommendation, Session, SessionView, Source, Track,
} from '@l45/shared';
import { CUSTOM_SKILL, DCC_LEVELS, learningProgress } from '@l45/shared';
import { decide, planTrack, updateObservations, type Decision } from './agent.ts';
import { content } from './content.ts';
import { designTrack } from './designer.ts';
import { GENERATED_PER_SESSION } from './generator.ts';
import { allLessons, checkPlan } from './guard.ts';
import {
  judgeMarkEvidence, judgeMockSite, judgeQuiz, partialMarkEvidence, partialMockSite,
} from './judge.ts';
import { firstLesson, generatedThisSession, ruleLesson } from './ownlessons.ts';
import { modelStatus, providerName } from './provider.ts';
import { addRecord, lernstandAll, recordFromEvent, settleReviews } from './records.ts';
import { ensureReviews, reviewOverview } from './reviews.ts';
import { chatReply, hintMarkEvidence, hintMockSite, judgeChat, type Opts } from './services.ts';
import { catalogTrack, criterionLabel, defaultMission, learnerSkills, learnerTracks, missionOf, skillIn, trackIn } from './tracks.ts';
import { newId, nowIso } from './util.ts';
import {
  _wipe, findByName, findBySession, loadLearner, readState, storeLesson, writeMission, writeProfile, writeState, writeTrack,
  type Stored,
} from './workspace.ts';

export type { Stored } from './workspace.ts';
export { storeLesson } from './workspace.ts';
export { defaultMission, missionOf } from './tracks.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: object) {
    super(message);
  }
}

/** Loaded workspaces by session id. Only a cache: everything is on disk. */
const cache = new Map<string, Stored>();

export function get(id: string): Stored {
  let st = cache.get(id);
  if (!st) {
    const learnerId = findBySession(id);
    const loaded = learnerId ? loadLearner(learnerId) : null;
    if (loaded?.session.id === id) {
      cache.set(id, loaded);
      st = loaded;
    }
  }
  if (!st) throw new HttpError(404, 'Session not found. Please sign in again.');
  return st;
}

const offline = (s: Session) => s.simulation || providerName() === 'none';
const opts = (s: Session): Opts => ({ offline: offline(s), onCall: (c) => s.modelCalls.push(c) });

/** Both configured model providers support the planner's tools; rules remain the fallback. */
const plannerProvider = () => providerName() !== 'none';
export const agentAvailable = (s: Session) => !s.simulation && plannerProvider();

export function save(st: Stored) {
  writeState(st.session);
}

function lessonById(s: Session, id: string): Lesson {
  const l = allLessons(s).find((x) => x.id === id);
  if (!l) throw new HttpError(404, 'Lesson not found');
  return l;
}

function nodeById(s: Session, id: string): MapNode & { lessonId: string } {
  const n = s.nodes.find((x) => x.id === id);
  if (!n || n.kind !== 'lesson' || !n.lessonId) throw new HttpError(404, 'Node not found');
  return n as MapNode & { lessonId: string };
}

export function openRecommendation(s: Session): Recommendation | null {
  const r = s.recommendations.at(-1);
  return r && r.status === 'open' ? r : null;
}

// --- Login -------------------------------------------------------------------------------------

const snapshot = (dcc: DccProfile): DccSnapshot => ({ at: nowIso(), source: dcc.source, fileName: dcc.fileName, profile: dcc });
const sameDcc = (a: DccProfile, b: DccProfile) => JSON.stringify(a.levels) === JSON.stringify(b.levels) && a.assessedOn === b.assessedOn;

export interface LoginInput {
  name: string;
  dcc: DccProfile;
  /** Needed when a learner with this name exists */
  resume?: 'continue' | 'new';
}

export function login(input: LoginInput): Stored {
  const name = input.name.trim().slice(0, 40) || 'Du';
  const existing = findByName(name)[0];
  if (existing && input.resume !== 'continue' && input.resume !== 'new') {
    const conflict: LoginConflict = { code: 'learner-exists', name: existing.name, createdAt: existing.createdAt, lessonsDone: readState(existing.id)?.events.length ?? 0 };
    throw new HttpError(409, `There is already a history for “${existing.name}”.`, conflict);
  }
  if (existing && input.resume === 'continue') return resume(existing.id, input);
  return createLearner(name, input);
}

/** Kept for callers that always want a new learner. */
export const createSession = (input: Omit<LoginInput, 'resume'>) => login({ ...input, resume: 'new' });

function createLearner(name: string, input: LoginInput): Stored {
  const profile: LearnerProfile = { id: newId('l'), name, createdAt: nowIso(), dccSnapshots: [snapshot(input.dcc)] };
  const session: Session = {
    id: newId('s'),
    learnerId: profile.id,
    sessionNo: 1,
    createdAt: nowIso(),
    userName: name,
    simulation: false,
    // The map starts empty. The learner adds tracks: prepared ones or own topics (addTracks, createTrack).
    nodes: [{ id: 'start', kind: 'start', parentId: null, label: name }],
    recommendations: [],
    observations: [],
    events: [],
    transfer: [],
    helpUsed: {},
    checks: {},
    modelCalls: [],
    generatedLessons: [],
    reviewQueue: [],
    missionChanges: [],
    plannerRuns: [],
    planning: false,
  };
  const st: Stored = { session, dcc: input.dcc, profile, tracks: [], missions: [], records: [], reference: {}, notes: [] };
  writeProfile(profile);
  recommend(st);
  save(st);
  cache.set(session.id, st);
  return st;
}

/** "Continue": a new session on the existing workspace. Nothing is deleted. */
function resume(learnerId: string, input: LoginInput): Stored {
  const cached = [...cache.values()].find((x) => x.profile.id === learnerId);
  const st = cached ?? loadLearner(learnerId);
  if (!st) throw new HttpError(500, 'History could not be read');
  for (const [id, x] of cache) if (x === st) cache.delete(id);

  if (!sameDcc(st.dcc, input.dcc)) {
    // A new DCC result is a new snapshot. The old ones and all learning records stay.
    st.profile.dccSnapshots.push(snapshot(input.dcc));
    writeProfile(st.profile);
    const before = st.dcc;
    st.dcc = input.dcc;
    replanUntouched(st, before);
  }
  const s = st.session;
  Object.assign(s, {
    id: newId('s'),
    sessionNo: s.sessionNo + 1,
    createdAt: nowIso(),
    simulation: false,
    helpUsed: {},
    checks: {},
    modelCalls: [],
    planning: false,
  });
  for (const r of s.plannerRuns) if (r.outcome === 'running') Object.assign(r, { outcome: 'fallback', note: 'Cancelled: new session', finishedAt: nowIso() });
  keepOrRecommend(st);
  save(st);
  cache.set(s.id, st);
  return st;
}

/** Tracks without any finished lesson get a fresh branch for the new DCC level. Branches with progress stay. */
function replanUntouched(st: Stored, before: DccProfile) {
  const s = st.session;
  for (const track of learnerTracks(st)) {
    const skill = skillIn(st, track.id);
    if (!skill?.dccBased || before.levels[track.id] === st.dcc.levels[track.id]) continue;
    const branch = s.nodes.filter((n) => n.kind === 'lesson' && n.trackId === track.id);
    if (branch.some((n) => n.state === 'done') || s.events.some((e) => e.trackId === track.id)) continue;
    s.nodes = s.nodes.filter((n) => !branch.includes(n));
    fillFromPool(st, track.id, agentAvailable(s) ? 1 : undefined);
  }
}

/**
 * Puts the pool lessons the DCC plan foresees for a track on the map, after the track's last lesson.
 * Used when a track is added, without the agent and when the agent fails. limit caps the lessons per track
 * (1 = starter only). Only the learner's tracks; own tracks have no pool.
 */
export function fillFromPool(st: Stored, trackId?: string, limit?: number): number {
  const s = st.session;
  let added = 0;
  for (const track of learnerTracks(st).filter((t) => !trackId || t.id === trackId)) {
    const skill = skillIn(st, track.id)!;
    const plan = planTrack(track, skill.dccBased ? st.dcc.levels[track.id] ?? null : undefined, content.lessons).slice(0, limit);
    const branch = () => s.nodes.filter((n) => n.kind === 'lesson' && n.trackId === track.id);
    for (const lesson of plan) {
      if (branch().some((n) => n.lessonId === lesson.id)) continue;
      const parent = branch().at(-1)?.id ?? `t-${track.id}`;
      const id = s.nodes.some((n) => n.id === `n-${lesson.id}`) ? `n-${lesson.id}-${s.nodes.length}` : `n-${lesson.id}`;
      s.nodes.push({ id, kind: 'lesson', parentId: parent, label: lesson.title, skillId: skill.id, trackId: track.id, lessonId: lesson.id, state: 'planned' });
      added++;
    }
  }
  return added;
}

// --- The next step ---------------------------------------------------------------------------------

/** Marks the recommended and alternative node and stores the recommendation as the open one. */
export function applyRecommendation(s: Session, rec: Recommendation) {
  const open = openRecommendation(s);
  if (open) s.recommendations = s.recommendations.filter((r) => r.id !== open.id);
  for (const n of s.nodes) if (n.state === 'recommended' || n.state === 'alternative') n.state = 'planned';
  s.recommendations.push(rec);
  for (const n of s.nodes) {
    if (n.id === rec.nodeId) {
      n.state = 'recommended';
      n.recommendationId = rec.id;
    } else if (n.id === rec.alternativeNodeId) {
      n.state = 'alternative';
      n.recommendationId = rec.id;
    }
  }
}

function toRecommendation(d: Decision, provisional = false): Recommendation {
  return {
    id: newId('r'),
    createdAt: nowIso(),
    ruleId: d.ruleId,
    ruleName: d.ruleName,
    nodeId: d.nodeId ?? '',
    alternativeNodeId: d.alternativeNodeId,
    observation: d.observation,
    reason: d.reason,
    why: d.why,
    tags: d.tags,
    status: 'open',
    ...(provisional ? { provisional: true } : {}),
  };
}

/**
 * The rule engine decides. Also the fallback whenever the planner agent fails.
 * Without the agent the whole pool is on the map. A provisional plan marks the nodes it adds, so they can go again.
 * focusTrackId: the learner just chose this track (R8).
 */
export function recommend(st: Stored, provisional = false, focusTrackId?: string) {
  const s = st.session;
  if (!agentAvailable(s)) fillFromPool(st);
  // The open plan is replaced: its nodes count as planned again before the rules decide.
  const open = openRecommendation(s);
  if (open) s.recommendations = s.recommendations.filter((r) => r.id !== open.id);
  for (const n of s.nodes) if (n.state === 'recommended' || n.state === 'alternative') n.state = 'planned';
  const d = decide({
    skills: learnerSkills(st),
    dcc: st.dcc,
    nodes: s.nodes,
    events: s.events,
    observations: s.observations,
    lessons: allLessons(s),
    counter: s.nodes.length,
    focusTrackId,
  });
  const lastEvent = s.events.at(-1)?.id;
  for (const l of d.newLessons) {
    storeLesson(st, { ...l, provenance: { by: 'rule', at: nowIso(), basedOn: lastEvent ? [lastEvent] : [], sessionNo: s.sessionNo } });
  }
  const rec = toRecommendation(d, provisional && Boolean(d.nodeId));
  s.nodes.push(...(rec.provisional ? d.newNodes.map((n) => ({ ...n, provisionalOf: rec.id })) : d.newNodes));
  applyRecommendation(s, rec);
}

/** After a change of settings or session: an open agent plan stays if it still passes the guardrails. */
function keepOrRecommend(st: Stored) {
  if (st.session.topicChoiceFlow) return;
  const rec = openRecommendation(st.session);
  if (rec?.ruleId === 'A1') {
    const problems = checkPlan(st, { nodeId: rec.nodeId, alternativeNodeId: rec.alternativeNodeId ?? '', reason: rec.reason, basedOn: rec.basedOn ?? [] });
    if (!problems.length) return;
  }
  recommend(st);
}

// --- Tracks --------------------------------------------------------------------------------------------

const MAX_OWN_TRACKS = 8;
const generateMs = () => Number(process.env.GENERATE_TIMEOUT_MS ?? 30_000);

/** Puts the skill node (once) and the track node on the map. */
function placeTrack(s: Session, track: Track, skill: { id: string; name: string }) {
  const sid = `s-${skill.id}`;
  if (!s.nodes.some((n) => n.id === sid)) s.nodes.push({ id: sid, kind: 'skill', parentId: 'start', label: skill.name, skillId: skill.id });
  s.nodes.push({ id: `t-${track.id}`, kind: 'track', parentId: sid, label: track.name, skillId: skill.id, trackId: track.id });
}

/**
 * Adds prepared tracks from the catalog. With the agent each starts with one lesson, without it the whole plan.
 * One track: the next step is its first lesson (R8). Several at once: the rules choose by the DCC profile (R3).
 */
export function addTracks(st: Stored, ids: unknown) {
  const s = st.session;
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))] : [];
  if (!list.length) throw new HttpError(400, 'Which areas? trackIds is missing.');
  for (const id of list) {
    const t = catalogTrack(id);
    if (!t) throw new HttpError(404, `The area ${id} does not exist.`);
    if (trackIn(st, id)) throw new HttpError(409, `“${t.name}” is already on your map.`);
  }
  for (const id of list) {
    placeTrack(s, catalogTrack(id)!, content.skills.find((x) => x.tracks.some((t) => t.id === id))!);
    fillFromPool(st, id, agentAvailable(s) ? 1 : undefined);
  }
  recommend(st, false, list.length === 1 ? list[0] : undefined);
  save(st);
}

const clean = (v: unknown) => String(v ?? '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();

/**
 * Creates a track from an own topic, e.g. "pass the Security+ exam". The model designs it (designer.ts),
 * New clients defer the first lesson until topic/format selection; legacy clients receive a starter.
 */
export async function createTrack(st: Stored, body: { topic?: unknown; goal?: unknown; selfLevel?: unknown; lessonType?: unknown; deferLesson?: unknown }): Promise<Track> {
  const s = st.session;
  if (offline(s)) throw new HttpError(409, 'The agent plans your own areas with AI. Without AI you can choose a prepared area.');
  const topic = clean(body.topic);
  const goal = clean(body.goal);
  if (body.lessonType !== undefined && body.lessonType !== 'video') throw new HttpError(400, 'Only video is possible as the first lesson for now.');
  if (topic.length < 3 || topic.length > 120) throw new HttpError(400, 'The topic needs 3 to 120 characters.');
  if (goal.length > 300) throw new HttpError(400, 'What for: at most 300 characters.');
  const selfLevel = (DCC_LEVELS as unknown[]).includes(body.selfLevel) ? (body.selfLevel as DccLevel) : 'Grundstufe';
  if (st.tracks.length >= MAX_OWN_TRACKS) throw new HttpError(409, `At most ${MAX_OWN_TRACKS} own areas.`);
  if (generatedThisSession(s) >= GENERATED_PER_SESSION) {
    throw new HttpError(429, `The AI has already created ${GENERATED_PER_SESSION} lessons in this session. It continues in the next session.`);
  }

  const design = await designTrack({ topic, goal: goal || undefined, selfLevel, timeoutMs: generateMs() }, (c) => s.modelCalls.push(c));
  if (!design.ok) throw new HttpError(502, `The agent could not plan “${topic}” as an area: ${design.errors.join('; ')}`);
  const { track } = design;
  if (body.lessonType === 'video') track.custom!.lessonTypes = [...new Set(['video' as const, ...track.custom!.lessonTypes])];
  const first = body.deferLesson === true ? undefined : await firstLesson(st, track, goal || undefined, body.lessonType === 'video' ? 'video' : undefined);
  if (first && !first.ok) throw new HttpError(502, `The area “${track.name}” is planned, but the first lesson was invalid: ${first.errors.join('; ')}. Try again.`);

  st.tracks.push(track);
  writeTrack(st.profile.id, track);
  placeTrack(s, track, CUSTOM_SKILL);
  if (first?.ok) {
    storeLesson(st, first.lesson);
    s.nodes.push({
      id: `n-${first.lesson.id}`, kind: 'lesson', parentId: `t-${track.id}`, label: first.lesson.title,
      skillId: CUSTOM_SKILL.id, trackId: track.id, lessonId: first.lesson.id, state: 'planned',
    });
  }
  if (body.deferLesson === true) {
    s.topicChoiceFlow = true;
    delete s.topicChoices;
  }
  // What the learner wrote under "What for" is their mission; otherwise it is asked before the first lesson.
  if (goal.length >= 3) setMission(st, track.id, { text: goal });
  else if (body.lessonType === 'video') setMission(st, track.id, { skip: true });
  recommend(st, false, track.id);
  save(st);
  return track;
}

/** A new lesson in an own track with nothing left to do, e.g. after a break. The rules pick the target. */
export async function nextLesson(st: Stored, trackId: string) {
  const s = st.session;
  const track = trackIn(st, trackId);
  if (!track) throw new HttpError(404, 'Area not found');
  if (!track.custom) throw new HttpError(400, 'New lessons on request are only available in your own areas.');
  if (offline(s)) throw new HttpError(409, 'The agent creates new lessons with AI.');
  if (s.planning) throw new HttpError(409, 'The agent is planning your next step right now.');
  if (!(await ruleLesson(st, trackId))) {
    throw new HttpError(409, 'No new lesson right now: one is still open, the limit for this session is reached, or the AI did not create a valid lesson.');
  }
  recommend(st, false, trackId);
  save(st);
}

// --- Missions ----------------------------------------------------------------------------------------

/**
 * Sets the mission of a track. The first answer (or skipping) needs no confirmation.
 * A change of an existing mission needs `confirm` and is recorded as a mission-shift.
 */
export function setMission(st: Stored, trackId: string, body: { text?: unknown; skip?: unknown; confirm?: unknown }): Mission {
  const track = trackIn(st, trackId);
  if (!track) throw new HttpError(404, 'Area not found');
  const existing = missionOf(st, trackId);
  const at = nowIso();
  let mission: Mission;
  if (body.skip) {
    if (existing) return existing;
    mission = { trackId, text: defaultMission(st, trackId), status: 'default', updatedAt: at };
  } else {
    const text = String(body.text ?? '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();
    if (text.length < 3 || text.length > 300) throw new HttpError(400, 'The mission needs 3 to 300 characters.');
    if (existing && existing.text === text) return existing;
    if (existing && body.confirm !== true) throw new HttpError(409, 'Please confirm the new mission.');
    mission = { trackId, text, status: 'set', updatedAt: at };
    if (existing) {
      const change = { id: newId('mi'), at, trackId, from: existing.text, to: text };
      st.session.missionChanges.push(change);
      addRecord(st, {
        kind: 'mission-shift', trackId, author: 'rule', evidence: [change.id],
        title: `Mission in “${track.name}” changed`,
        body: `Before: “${existing.text}”. Now: “${text}”. Confirmed by the learner.`,
      });
    }
  }
  st.missions = [...st.missions.filter((m) => m.trackId !== trackId), mission];
  writeMission(st.profile.id, mission, track.name);
  save(st);
  return mission;
}

// --- Lessons -------------------------------------------------------------------------------------

/** Strips solutions before a lesson goes to the browser. */
export function publicLesson(l: Lesson): Lesson {
  switch (l.type) {
    case 'mark-evidence':
      return { ...l, content: { ...l.content, summary: l.content.summary.map((x) => ({ id: x.id, text: x.text, verdict: 'belegt' as const, explanation: '' })) } };
    case 'mock-site': {
      const strip = (p: MockPart): MockPart => ({ id: p.id, kind: p.kind, text: p.text, linkTarget: p.linkTarget });
      return {
        ...l,
        content: { ...l.content, mail: l.content.mail?.map(strip), site: l.content.site.map(strip), correctVerdict: 'phishing', verdictExplanation: '' },
      };
    }
    case 'video':
      return { ...l, content: { ...l.content, questions: l.content.questions.map((q) => ({ ...q, correct: -1, explanation: '' })) } };
    case 'podcast':
      return { ...l, content: { ...l.content, questions: l.content.questions.map((q) => ({ ...q, correct: -1, explanation: '' })) } };
    case 'ai-chat':
      return { ...l, content: { ...l.content, aiRole: '', fallbackReplies: [], criteria: l.content.criteria.map((c) => ({ ...c, patterns: [] })) } };
  }
}

export function startNode(st: Stored, nodeId: string): { lesson: Lesson; switched?: string } {
  const s = st.session;
  const node = nodeById(s, nodeId);
  const rec = openRecommendation(s);
  let switched: string | undefined;
  if (rec && node.state === 'recommended') rec.status = 'accepted';
  if (rec && node.state === 'alternative') {
    // A different topic is a neutral choice in the new flow; preserve legacy API behaviour.
    rec.status = s.topicChoiceFlow ? 'chosen' : 'declined';
    rec.chosenNodeId = nodeId;
    switched = s.topicChoiceFlow ? 'You chose a different direction. The other topics stay open.' : 'You chose the alternative. The agent remembers this and plans again afterwards.';
  }
  delete s.helpUsed[nodeId];
  delete s.checks[nodeId];
  save(st);
  return { lesson: publicLesson(lessonById(s, node.lessonId)), switched };
}

/** Checks one committed response without exposing the other questions or changing the final result. */
export function answerFeedback(st: Stored, nodeId: string, input: unknown): LessonAnswerFeedback {
  const lesson = lessonById(st.session, nodeById(st.session, nodeId).lessonId);
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Answer is missing');
  const check = input as Record<string, unknown>;
  if ((lesson.type === 'video' || lesson.type === 'podcast') && check.type === 'quiz') {
    const index = check.questionIndex;
    const option = check.option;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= lesson.content.questions.length) throw new HttpError(400, 'Question not found');
    const question = lesson.content.questions[index];
    if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option >= question.options.length) throw new HttpError(400, 'Invalid answer');
    return { correct: option === question.correct, correctOption: question.correct, explanation: question.explanation };
  }
  if (lesson.type === 'mark-evidence' && check.type === 'mark-evidence') {
    const item = lesson.content.summary.find((item) => item.id === check.itemId);
    if (!item || (check.mark !== 'belegt' && check.mark !== 'erfunden')) throw new HttpError(400, 'Invalid answer');
    return { correct: check.mark === item.verdict, correctOption: item.verdict === 'belegt' ? 0 : 1, explanation: [item.explanation, item.correction ? `Correct would be: “${item.correction}”` : ''].filter(Boolean).join(' ') };
  }
  throw new HttpError(400, 'This answer does not fit the lesson');
}

export function partialCheck(st: Stored, nodeId: string, a: Answer): PartialCheck {
  const s = st.session;
  const l = lessonById(s, nodeById(s, nodeId).lessonId);
  let c: PartialCheck;
  if (l.type === 'mark-evidence' && a.type === 'mark-evidence') c = partialMarkEvidence(l, a);
  else if (l.type === 'mock-site' && a.type === 'mock-site') c = partialMockSite(l, a);
  else throw new HttpError(400, 'Checking in between is only available for text and website tasks');
  if (!c.complete) s.checks[nodeId] = (s.checks[nodeId] ?? 0) + 1;
  save(st);
  return c;
}

export async function hint(st: Stored, nodeId: string, a: Answer): Promise<{ text: string; source: Source }> {
  const s = st.session;
  const l = lessonById(s, nodeById(s, nodeId).lessonId);
  s.helpUsed[nodeId] = true;
  save(st);
  if (l.type === 'mark-evidence' && a.type === 'mark-evidence') return hintMarkEvidence(l, a.marks, opts(s));
  if (l.type === 'mock-site' && a.type === 'mock-site') return hintMockSite(l, a.marked);
  return { text: 'Read the task again and go through it point by point.', source: 'prepared' };
}

export async function chat(st: Stored, nodeId: string, turns: ChatTurn[]): Promise<{ text: string; source: Source }> {
  const s = st.session;
  const l = lessonById(s, nodeById(s, nodeId).lessonId);
  if (l.type !== 'ai-chat') throw new HttpError(400, 'Not a chat lesson');
  const reply = await chatReply(l, turns.slice(-20), opts(s));
  save(st);
  return reply;
}

export async function complete(st: Stored, nodeId: string, a: Answer, durationMin?: number): Promise<LessonResult> {
  const s = st.session;
  const node = nodeById(s, nodeId);
  const l = lessonById(s, node.lessonId);
  const track = trackIn(st, l.trackId);
  let result: LessonResult;
  if (l.type === 'mark-evidence' && a.type === 'mark-evidence') result = judgeMarkEvidence(l, a, track);
  else if (l.type === 'mock-site' && a.type === 'mock-site') result = judgeMockSite(l, a, track);
  else if ((l.type === 'video' && a.type === 'video') || (l.type === 'podcast' && a.type === 'podcast')) result = judgeQuiz(l, a, track);
  else if (l.type === 'ai-chat' && a.type === 'ai-chat') result = await judgeChat(l, a.turns.slice(-30), opts(s), track);
  else throw new HttpError(400, 'Answer does not fit the lesson');

  const helpUsed = Boolean(s.helpUsed[nodeId]);
  const attempts = 1 + (s.checks[nodeId] ?? 0);
  delete s.helpUsed[nodeId];
  delete s.checks[nodeId];

  const at = nowIso();
  const usedModel = result.judgedBy === 'model' || (a.type === 'ai-chat' && a.turns.some((t) => t.source === 'model'));
  const event: LearningEvent = {
    id: newId('ev'), at, nodeId, lessonId: l.id, trackId: l.trackId, mode: l.mode, helpUsed, attempts,
    durationMin: Math.max(1, Math.round(durationMin ?? l.durationMin)), result,
    source: (usedModel ? 'model' : 'prepared') as Source,
  };
  s.events.push(event);
  s.observations = updateObservations(s.observations, event, (trackId, key) => criterionLabel(st, trackId, key), () => newId('ob'));
  if (l.transfer) s.transfer.push({ at, lessonTitle: l.title, text: l.transfer });
  settleReviews(st, event);
  recordFromEvent(st, event);

  // Settle the recommendation; another direction in the topic flow is a neutral choice.
  const rec = openRecommendation(s);
  if (rec && rec.nodeId !== nodeId) rec.status = s.topicChoiceFlow ? 'chosen' : 'declined';
  if (rec && rec.nodeId === nodeId) rec.status = 'accepted';

  Object.assign(node, { state: 'done', result, helpUsed });
  // Topic-choice clients plan lightweight previews on demand. Never generate a full next lesson here.
  if (s.topicChoiceFlow) {
    delete s.topicChoices;
    for (const n of s.nodes) if (n.state === 'recommended' || n.state === 'alternative') n.state = 'planned';
    save(st);
    return result;
  }
  // The rules answer at once. With an agent, their plan is provisional until the agent is done.
  const withAgent = agentAvailable(s) && !s.plannerRuns.some((r) => r.eventId === event.id);
  // Own tracks have no prepared lessons: without the agent, the rules let the generator write the next one.
  if (!withAgent && !offline(s)) await ruleLesson(st, l.trackId);
  recommend(st, withAgent);
  if (withAgent) startPlanner(st, event);
  save(st);
  return result;
}

// --- Planner agent (runs in the background) ------------------------------------------------------------

const running = new Map<Promise<void>, Stored>();

function startPlanner(st: Stored, ev: LearningEvent) {
  st.session.planning = true;
  const p: Promise<void> = import('./planner.ts')
    .then((m) => m.runPlanner(st, ev))
    .catch((err) => console.error('planner crashed', err))
    .finally(() => {
      running.delete(p);
      if (![...running.values()].includes(st)) st.session.planning = false;
    });
  running.set(p, st);
}

/** Test hook: waits until no planner runs. */
export async function _idle() {
  while (running.size) await Promise.all([...running.keys()]);
}

export function patch(st: Stored, body: { simulation?: unknown }) {
  const s = st.session;
  if (body.simulation !== undefined) s.simulation = Boolean(body.simulation);
  keepOrRecommend(st);
  save(st);
}

export function view(st: Stored): SessionView {
  ensureReviews(st);
  const { generatedLessons: _g, reviewChallenges: _r, ...session } = st.session;
  return {
    session,
    reviews: reviewOverview(st),
    rewards: learningProgress(st.session.events, allLessons(st.session)),
    dcc: st.dcc,
    recommendation: openRecommendation(st.session),
    modelStatus: modelStatus(st.session.simulation),
    agentAvailable: agentAvailable(st.session),
    canCreateTracks: !offline(st.session),
    skills: learnerSkills(st),
    workspace: {
      missions: st.missions,
      records: st.records,
      reference: st.reference,
      notes: st.notes,
      lernstand: lernstandAll(st, learnerTracks(st)),
      dccSnapshots: st.profile.dccSnapshots.map(({ profile: _p, ...rest }) => rest),
    },
  };
}

/** Lessons the agent created for this learner (without solutions), so the map can show them. */
export function generatedPublic(st: Stored): Lesson[] {
  return st.session.generatedLessons.map(publicLesson);
}

/** Drops the in-memory cache, as after a server restart. Disk stays. */
export function clearCache() {
  cache.clear();
}

/** Test hook: forgets everything, also the learner folders in the test directory. */
export function _reset() {
  cache.clear();
  _wipe();
}
