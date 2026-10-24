import type { LearningProgress } from './rewards.ts';

// Shared types. Three separate data areas: diagnostics (DCC), learning (map, results), transfer.

export type DccLevel = 'Grundstufe' | 'Mittelstufe' | 'Fortgeschritten';
export const DCC_LEVELS: DccLevel[] = ['Grundstufe', 'Mittelstufe', 'Fortgeschritten'];
export const DCC_LEVEL_LABEL: Record<DccLevel, string> = { Grundstufe: 'Foundation', Mittelstufe: 'Intermediate', Fortgeschritten: 'Advanced' };

export type Mode = 'alone' | 'ai' | 'peer';
/** Where content or a decision came from. Shown as a tag in the UI. */
export type Source = 'rule' | 'model' | 'prepared' | 'simulation';

// ---------------------------------------------------------------------------
// Diagnostics: the DCC profile. Read-only once loaded. Learning never changes it.
// ---------------------------------------------------------------------------

export interface DccProfile {
  /** How the profile came in */
  source: 'file' | 'manual';
  fileName?: string;
  assessedOn: string | null;
  /** level per track id; null = "not assessed" (never treated as low) */
  levels: Record<string, DccLevel | null>;
}

/** Format of a DCC result file (synthetic). */
export interface DccResultFile {
  type: 'dcc-result';
  version: 1;
  synthetic: true;
  assessedOn?: string;
  areas: { area: string; name?: string; level: DccLevel | null }[];
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface Skill {
  id: string;
  name: string;
  dccBased: boolean;
  tracks: Track[];
}

export interface Track {
  id: string;
  skillId: string;
  name: string;
  /** DigComp 2.2 area number, only for DCC-based skills */
  dccArea?: string;
  /** Kinds of things the learner should notice or include, used as criteria */
  criteria: Criterion[];
  /** Asked the first time the track is opened: three suggestions, plus a default when skipped */
  mission?: { suggestions: string[]; default: string };
  /** Only for a track the learner created from an own topic. Prepared tracks come from data/skills.json. */
  custom?: CustomTrackInfo;
}

/** A source a lesson may build on. Prepared tracks: data/resources/<trackId>.md. Custom tracks: proposed by the model. */
export interface TrackSource {
  title: string;
  url: string;
  /** What it covers, when to use it */
  note: string;
}

export interface CustomTrackInfo {
  /** What the learner typed, e.g. "Pass the Security+ exam" */
  topic: string;
  createdAt: string;
  /** Model that designed the track */
  model: string;
  /** Prior knowledge the learner stated. Sets the level of the first lessons. Not a DCC level. */
  selfLevel: DccLevel;
  /** Proposed by the model; kept only if the address answered when the track was made */
  sources: TrackSource[];
  /** Lesson types that fit the topic */
  lessonTypes: LessonType[];
}

/** Skill that holds the tracks a learner created from own topics */
export const CUSTOM_SKILL = { id: 'custom', name: 'Own topics', dccBased: false } as const;

export interface Criterion {
  id: string;
  label: string;
  ruleOfThumb: string;
}

export type LessonType = 'video' | 'ai-chat' | 'mock-site' | 'mark-evidence' | 'podcast';

interface LessonBase {
  id: string;
  trackId: string;
  type: LessonType;
  /** Which DCC level this lesson is written for */
  level: DccLevel;
  title: string;
  /** One sentence: what the learner does */
  intro: string;
  durationMin: number;
  mode: Mode;
  /** Criterion ids of the track this lesson trains */
  targets: string[];
  transfer?: string;
  source: 'prepared' | 'model';
  /** The one high-trust source the lesson builds on (from data/resources/<trackId>.md) */
  primarySource?: { title: string; url: string };
  /** Only for lessons made during learning (by a rule template or by the model) */
  provenance?: LessonProvenance;
}

export interface LessonProvenance {
  by: 'rule' | 'model';
  model?: string;
  at: string;
  /** Learning record and event ids the lesson was made for */
  basedOn: string[];
  sessionNo: number;
  /** Criteria a mixed review lesson brings back */
  reviewOf?: string[];
  /** The exam on the peak of a mountain: a mixed review of what the mountain's lessons trained */
  exam?: true;
}

// --- Video (Aha video or placeholder storyboard) ---
export type VideoVisual = 'next-word' | 'invented-detail' | 'secant-tangent' | 'slope-zoom' | 'steps' | 'falling' | 'url-parts';
export interface VideoScene {
  caption: string;
  visual: VideoVisual;
  /** For 'steps' and 'url-parts': short labels shown in the animation */
  items?: string[];
  seconds: number;
}
export interface VideoQuestion {
  afterScene: number;
  prompt: string;
  options: string[];
  correct: number;
  explanation: string;
  criterion?: string;
}
export interface VideoLesson extends LessonBase {
  type: 'video';
  content: { videoUrl?: string; narrated?: { manifestUrl: string }; scenes: VideoScene[]; questions: VideoQuestion[] };
}

/** Published animation assets contain no checkpoint solutions. Times are scene-local seconds. */
export interface NarratedVideoManifest {
  schemaVersion: 1;
  lessonId: string;
  title: string;
  locale: 'en-GB';
  scriptHash: string;
  narration: { provider: 'local' | 'elevenlabs'; voice: string; model?: string };
  scenes: {
    id: string;
    title: string;
    source: string;
    duration: number;
    audioUrl: string;
    captions: { start: number; end: number; text: string }[];
  }[];
}

// --- Podcast: two hosts talk about one topic, then a few questions ---
export type PodcastSpeaker = 'a' | 'b';
export interface PodcastLine { speaker: PodcastSpeaker; text: string }
export interface PodcastQuestion {
  prompt: string;
  options: string[];
  correct: number;
  explanation: string;
  criterion?: string;
}
export interface PodcastLesson extends LessonBase {
  type: 'podcast';
  content: { lines: PodcastLine[]; questions: PodcastQuestion[] };
}

/** The narrated audio of a podcast lesson. Times are seconds in the one audio file. */
export interface PodcastManifest {
  schemaVersion: 2;
  lessonId: string;
  title: string;
  locale: 'en-GB';
  hosts: Record<PodcastSpeaker, string>;
  narration: { provider: 'local' | 'elevenlabs'; voices: Record<PodcastSpeaker, string>; model?: string };
  duration: number;
  audioUrl: string;
  lines: (PodcastLine & { start: number; end: number })[];
}

export type PodcastStatus =
  | { state: 'idle' }
  | { state: 'building'; completed: number; total: number }
  | { state: 'ready'; manifestUrl: string }
  /** The script is part of the lesson, so the learner can still read it when narration fails. */
  | { state: 'error'; message: string };

// --- Chat with the AI ---
export interface ChatCriterion {
  id: string;
  label: string;
  hint: string;
  /** Case-insensitive regex for judging without a model (learner messages only) */
  patterns: string[];
}
export interface AiChatLesson extends LessonBase {
  type: 'ai-chat';
  content: {
    /** tutor: asks questions; roleplay: plays a role; prompt-lab: executes the learner's prompt literally */
    kind: 'tutor' | 'roleplay' | 'prompt-lab';
    /** What the learner should achieve, shown on screen */
    goal: string;
    /** Instructions for the model: who it plays and how it behaves */
    aiRole: string;
    /** First AI message */
    opening: string;
    /** Synthetic material shown next to the chat (notes, error message, ...) */
    material?: { title: string; lines: string[] };
    criteria: ChatCriterion[];
    /** Scripted AI replies used without a model, in order; the last one repeats */
    fallbackReplies: string[];
    /** Number of learner messages before the lesson can be finished */
    minTurns: number;
  };
}

// --- Inspect a fictional website or mail ---
export type MockPartKind = 'from' | 'subject' | 'greeting' | 'paragraph' | 'link' | 'signature' | 'url' | 'logo' | 'heading' | 'field' | 'button' | 'footer';
export interface MockPart {
  id: string;
  kind: MockPartKind;
  text: string;
  linkTarget?: string;
  signal?: { criterion: string; explanation: string };
  harmless?: string;
}
export interface MockSiteLesson extends LessonBase {
  type: 'mock-site';
  content: {
    disclaimer: string;
    mail?: MockPart[];
    site: MockPart[];
    correctVerdict: 'phishing' | 'echt';
    verdictExplanation: string;
  };
}

// --- Check an AI summary against its source ---
export interface SummarySentence {
  id: string;
  text: string;
  verdict: 'belegt' | 'erfunden';
  criterion?: string;
  explanation: string;
  hint?: string;
  correction?: string;
}
export interface MarkEvidenceLesson extends LessonBase {
  type: 'mark-evidence';
  content: { noteTitle: string; note: string[]; summary: SummarySentence[] };
}

export type Lesson = VideoLesson | AiChatLesson | MockSiteLesson | MarkEvidenceLesson | PodcastLesson;

// ---------------------------------------------------------------------------
// Answers and results
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: 'ai' | 'learner';
  text: string;
  source?: Source;
}

export type Answer =
  | { type: 'video'; answers: Record<number, number> }
  | { type: 'podcast'; answers: Record<number, number> }
  | { type: 'ai-chat'; turns: ChatTurn[] }
  | { type: 'mock-site'; marked: string[]; verdict: 'phishing' | 'echt' | null }
  | { type: 'mark-evidence'; marks: Record<string, 'belegt' | 'erfunden'> };

export interface CriterionResult {
  key: string;
  label: string;
  status: 'met' | 'missed';
  note?: string;
}

export interface LessonResult {
  allMet: boolean;
  criteria: CriterionResult[];
  items: { label: string; correct: boolean; text: string }[];
  summary: string;
  judgedBy: 'rule' | 'model' | 'keywords';
}

/** Feedback is revealed only after submitting this individual answer. */
export type LessonAnswerCheck =
  | { type: 'quiz'; questionIndex: number; option: number }
  | { type: 'mark-evidence'; itemId: string; mark: 'belegt' | 'erfunden' };

export interface LessonAnswerFeedback {
  correct: boolean;
  explanation: string;
  correctOption: number;
}

export interface PartialCheck {
  complete: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Learning area: the mind map and what happened on it
// ---------------------------------------------------------------------------

export type NodeKind = 'start' | 'skill' | 'track' | 'lesson';
export type NodeState = 'planned' | 'recommended' | 'alternative' | 'done' | 'skipped';

export interface MapNode {
  id: string;
  kind: NodeKind;
  parentId: string | null;
  label: string;
  skillId?: string;
  trackId?: string;
  lessonId?: string;
  /** Display-only topic preview; never a completed lesson. */
  topicId?: string;
  state?: NodeState;
  /** Added by the agent after a result (the map grows) */
  addedByAgent?: boolean;
  /** Added by the rules only for a provisional plan; removed again if the agent's plan is accepted */
  provisionalOf?: string;
  recommendationId?: string;
  result?: LessonResult;
  helpUsed?: boolean;
}

export type RuleId = 'R0' | 'R1' | 'R2' | 'R3' | 'R5' | 'R6' | 'R7' | 'R8' | 'A1';

export interface Recommendation {
  id: string;
  createdAt: string;
  ruleId: RuleId;
  ruleName: string;
  nodeId: string;
  alternativeNodeId?: string;
  /** What the agent saw */
  observation: string;
  /** Short reason */
  reason: string;
  /** Didactic justification: why this step and mode help now */
  why: string;
  tags: Source[];
  status: 'open' | 'accepted' | 'declined' | 'chosen';
  /** A learner chose another direction, without rejecting the recommendation. */
  chosenNodeId?: string;
  /** Rule plan shown while the planner agent still works on it */
  provisional?: boolean;
  /** Learning record and event ids the recommendation cites (A1) */
  basedOn?: string[];
}

export interface Observation {
  id: string;
  trackId: string;
  criterion: string;
  text: string;
  count: number;
  status: 'active' | 'outdated';
  createdAt: string;
}

export interface LearningEvent {
  id: string;
  at: string;
  nodeId: string;
  lessonId: string;
  trackId: string;
  mode: Mode;
  helpUsed: boolean;
  /** 1 = right at the first check */
  attempts: number;
  durationMin: number;
  result: LessonResult;
  source: Source;
}

export interface ModelCall {
  at: string;
  purpose: 'chat' | 'judge' | 'hint' | 'generate' | 'plan' | 'design' | 'podcast';
  ok: boolean;
  fallback: boolean;
  ms: number;
}

export type ModelStatus = 'online' | 'offline' | 'simulation';

// ---------------------------------------------------------------------------
// Teaching workspace per learner (on disk). Learning area only, never diagnostics.
// ---------------------------------------------------------------------------

/** One DCC result as it came in. The latest snapshot is the active profile. */
export interface DccSnapshot {
  at: string;
  source: DccProfile['source'];
  fileName?: string;
  profile: DccProfile;
}

export interface LearnerProfile {
  id: string;
  name: string;
  createdAt: string;
  dccSnapshots: DccSnapshot[];
}

export interface Mission {
  trackId: string;
  text: string;
  /** set: chosen or written by the learner. default: skipped, the track's default is used */
  status: 'set' | 'default';
  updatedAt: string;
}

/** A change of a mission the learner confirmed. Its id is evidence for a mission-shift record. */
export interface MissionChange {
  id: string;
  at: string;
  trackId: string;
  from: string;
  to: string;
}

export type RecordKind = 'demonstrated' | 'prior-knowledge' | 'misconception' | 'mission-shift';

/** Decision-grade insight, not a log entry. Cites the events that prove it. */
export interface LearningRecord {
  id: string;
  trackId: string;
  criterion?: string;
  kind: RecordKind;
  /** 'active' or 'superseded by LR-0007' */
  status: string;
  evidence: string[];
  title: string;
  body: string;
  createdAt: string;
  author: 'rule' | 'agent';
}

/** Cheat sheet line: a rule of thumb or a glossary term the learner has demonstrated */
export interface ReferenceEntry {
  section: 'rule' | 'term';
  title: string;
  text: string;
  basedOn: string[];
}

/** A practiced criterion in the recurring retrieval schedule. */
export interface ReviewItem {
  id: string;
  trackId: string;
  criterion: string;
  recordId: string;
  addedAt: string;
  /** Legacy queue trigger: due after two more lessons when no deadline exists yet. */
  addedAfterEvents: number;
  /** Legacy queue trigger: due in a later session when no deadline exists yet. */
  addedInSession: number;
  status: 'waiting' | 'done';
  doneEventId?: string;
  /** UTC deadline. Older queues are migrated when the workspace is opened. */
  dueAt?: string;
  intervalDays?: number;
  streak?: number;
  lapses?: number;
  lastReviewedAt?: string;
  lastCorrect?: boolean;
  lastReviewSource?: 'lesson' | 'recall';
  /** Stable question identities, oldest to most recently answered; independent of success streaks. */
  questionHistory?: string[];
}

export interface ReviewSummary {
  id: string;
  trackId: string;
  label: string;
  dueAt: string;
  lapses: number;
}

export interface ReviewOverview {
  due: ReviewSummary[];
  upcoming: ReviewSummary[];
}

export interface ReviewQuestion {
  id: string;
  reviewId: string;
  trackId: string;
  label: string;
  prompt: string;
  context?: string[];
  options: string[];
}

export interface ReviewFeedback {
  correct: boolean;
  correctOption: number;
  explanation: string;
  dueAt: string;
  intervalDays: number;
}

/** Server-only challenge and receipt: never included in SessionView. */
export interface ReviewChallenge extends ReviewQuestion {
  /** Identity in the learned question bank; omitted from the browser response. */
  sourceQuestionId?: string;
  correctOption: number;
  explanation: string;
  answeredOption?: number;
  feedback?: ReviewFeedback;
}

export type LernstandState = 'unbekannt' | 'am-ueben' | 'sicher';

/** Learning progress per criterion, derived from learning records. Not a DCC level. */
export interface LernstandEntry {
  trackId: string;
  criterion: string;
  state: LernstandState;
  recordIds: string[];
}

export interface PlannerRun {
  id: string;
  eventId: string;
  trackId: string;
  startedAt: string;
  finishedAt?: string;
  steps: number;
  outcome: 'running' | 'accepted' | 'fallback';
  /** Why the rules decided, or what the agent did */
  note: string;
  /** Tools the agent called, in order */
  tools: string[];
}

/** A topic preview, with only the existing lesson formats. No lesson content is generated yet. */
export interface NextTopic {
  id: string;
  title: string;
  reason: string;
  criterion: string;
  formats: LessonType[];
  level: DccLevel;
  recommended: boolean;
  /** An existing lesson can be reused if the learner chooses its format. */
  lessonId?: string;
  /** The exam on the peak of a mountain. It is then the only topic offered. */
  exam?: true;
}

export interface TopicChoices {
  id: string;
  trackId: string;
  parentNodeId: string;
  revision: string;
  topics: NextTopic[];
  customTopic?: NextTopic;
  canSuggestOwn: boolean;
  source: 'rule' | 'model';
}

export interface Session {
  id: string;
  learnerId: string;
  /** Counts logins of this learner; 1 = first session */
  sessionNo: number;
  createdAt: string;
  userName: string;
  /** Forces prepared content, as if the model were unreachable */
  simulation: boolean;
  nodes: MapNode[];
  recommendations: Recommendation[];
  observations: Observation[];
  events: LearningEvent[];
  transfer: { at: string; lessonTitle: string; text: string }[];
  helpUsed: Record<string, boolean>;
  checks: Record<string, number>;
  modelCalls: ModelCall[];
  generatedLessons: Lesson[];
  /** Enabled when the client requests topic previews; legacy clients keep their original flow. */
  topicChoiceFlow?: boolean;
  topicChoices?: TopicChoices;
  /** Saved in the learner workspace, retained across server restarts and new sessions. */
  preferredLessonType?: LessonType;
  reviewQueue: ReviewItem[];
  reviewChallenges?: Record<string, ReviewChallenge>;
  missionChanges: MissionChange[];
  plannerRuns: PlannerRun[];
  /** True while the planner agent works on the next step */
  planning: boolean;
}

export interface WorkspaceView {
  missions: Mission[];
  records: LearningRecord[];
  reference: Record<string, ReferenceEntry[]>;
  notes: string[];
  lernstand: LernstandEntry[];
  dccSnapshots: Omit<DccSnapshot, 'profile'>[];
}

/** What the browser gets: session and the read-only DCC profile, kept apart */
export interface SessionView {
  reviews: ReviewOverview;
  /** Game progress from learning history; independent of the diagnostic DCC levels. */
  rewards: LearningProgress;
  session: Omit<Session, 'generatedLessons' | 'reviewChallenges'>;
  dcc: DccProfile;
  recommendation: Recommendation | null;
  modelStatus: ModelStatus;
  /** Whether a planner agent can run (Anthropic or mock, not simulated offline) */
  agentAvailable: boolean;
  /** Whether the learner can create tracks from own topics (needs a model) */
  canCreateTracks: boolean;
  /** The learner's tracks, grouped by skill: prepared ones they added and their own. Empty at the start. */
  skills: Skill[];
  workspace: WorkspaceView;
}

/** Login with a name that already exists: the learner chooses to continue or start fresh */
export interface LoginConflict {
  code: 'learner-exists';
  name: string;
  createdAt: string;
  lessonsDone: number;
}

export interface ContentBundle {
  skills: Skill[];
  lessons: Lesson[];
}

export const MODE_LABEL: Record<Mode, string> = { alone: 'Alone', ai: 'With AI', peer: 'With others' };
export const SOURCE_LABEL: Record<Source, string> = { rule: 'Rule', model: 'AI', prepared: 'Prepared', simulation: 'Simulation' };
export const RECORD_KIND_LABEL: Record<RecordKind, string> = {
  demonstrated: 'Shown without help',
  'prior-knowledge': 'Prior knowledge',
  misconception: 'Misconception corrected',
  'mission-shift': 'Mission changed',
};
export const LERNSTAND_LABEL: Record<LernstandState, string> = { unbekannt: 'still open', 'am-ueben': 'practising', sicher: 'I can do it' };
export const TYPE_LABEL: Record<LessonType, string> = {
  video: 'Video',
  'ai-chat': 'With the AI',
  'mock-site': 'Check a website',
  'mark-evidence': 'Check a text',
  podcast: 'Podcast',
};
