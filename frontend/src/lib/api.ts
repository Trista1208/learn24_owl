import type { ReviewQuestion, ReviewFeedback, LessonAnswerCheck, LessonAnswerFeedback, CompletionReward, Answer, ChatTurn, ContentBundle, DccLevel, Lesson, LessonResult, LessonType, NextTopic, TopicChoices, PartialCheck, PodcastStatus, SessionView, Source } from '@l45/shared';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'No connection to the server. Is the backend running?');
  }
  // Only the access gate answers 401. The service worker serves the page without asking for the login,
  // so a navigation past it lets the browser ask, and the server sends the learner back.
  if (res.status === 401) window.location.assign('/api/auth');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Error ${res.status}`, data as Record<string, unknown>);
  return data as T;
}

const s = (id: string) => `/api/sessions/${id}`;
const n = (id: string, node: string) => `${s(id)}/nodes/${encodeURIComponent(node)}`;

export interface LoginBody {
  name: string;
  dccFile?: unknown;
  fileName?: string;
  levels?: Record<string, DccLevel | null>;
  /** After a 409 for an existing name: continue that learner or start a new one */
  resume?: 'continue' | 'new';
}

export const api = {
  health: () => call<{ ok: boolean; provider: string }>('GET', '/api/health'),
  owlChat: (body: { messages: { role: 'user' | 'assistant'; text: string }[]; lang: string; where: string }) =>
    call<{ text: string }>('POST', '/api/owl', body),
  learnMore: (q: string, lang: string) => call<{ videos: { title: string; url: string; snippet: string; image?: string }[]; web: { title: string; url: string; snippet: string }[] }>('GET', `/api/learn-more?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`),
  content: () => call<ContentBundle>('GET', '/api/content'),
  login: (body: LoginBody) => call<SessionView>('POST', '/api/login', body),
  session: (id: string) => call<SessionView>('GET', s(id)),
  startReview: (id: string, reviewId: string) => call<{ question: ReviewQuestion; view: SessionView }>('POST', `${s(id)}/reviews/${encodeURIComponent(reviewId)}/start`, {}),
  answerReview: (id: string, reviewId: string, challengeId: string, option: number) => call<{ feedback: ReviewFeedback; view: SessionView }>('POST', `${s(id)}/reviews/${encodeURIComponent(reviewId)}/answer`, { challengeId, option }),
  generated: (id: string) => call<Lesson[]>('GET', `${s(id)}/lessons`),
  patch: (id: string, body: Record<string, unknown>) => call<SessionView>('PATCH', s(id), body),
  addTracks: (id: string, trackIds: string[]) => call<{ view: SessionView; generated: Lesson[] }>('POST', `${s(id)}/tracks`, { trackIds }),
  createTrack: (id: string, body: { topic: string; goal?: string; selfLevel: DccLevel; lessonType?: 'video'; deferLesson?: boolean }) =>
    call<{ trackId: string; view: SessionView; generated: Lesson[] }>('POST', `${s(id)}/own-tracks`, body),
  nextLesson: (id: string, trackId: string) =>
    call<{ view: SessionView; generated: Lesson[] }>('POST', `${s(id)}/tracks/${encodeURIComponent(trackId)}/next`, {}),
  /** Audio of a podcast lesson. POST narrates it if that has not happened yet, GET only reports where it stands. */
  podcast: (id: string, node: string, method: 'GET' | 'POST') => call<PodcastStatus>(method, `${n(id, node)}/podcast`),
  topics: (id: string, trackId: string) =>
    call<{ choices: TopicChoices; view: SessionView }>('POST', `${s(id)}/tracks/${encodeURIComponent(trackId)}/topics`, {}),
  suggestTopic: (id: string, body: { choiceSetId: string; topic: string }) =>
    call<{ topic: NextTopic; view: SessionView }>('POST', `${s(id)}/topics/custom`, body),
  chooseTopic: (id: string, body: { choiceSetId: string; topicId: string; format: LessonType }) =>
    call<{ nodeId: string; view: SessionView; generated: Lesson[] }>('POST', `${s(id)}/topics/choose`, body),
  mission: (id: string, trackId: string, body: { text?: string; skip?: boolean; confirm?: boolean }) =>
    call<SessionView>('PUT', `${s(id)}/missions/${encodeURIComponent(trackId)}`, body),
  start: (id: string, node: string) => call<{ lesson: Lesson; switched?: string; view: SessionView }>('POST', `${n(id, node)}/start`, {}),
  answerFeedback: (id: string, node: string, check: LessonAnswerCheck) => call<LessonAnswerFeedback>('POST', `${n(id, node)}/answer-feedback`, check),
  check: (id: string, node: string, answer: Answer) => call<PartialCheck>('POST', `${n(id, node)}/check`, { answer }),
  hint: (id: string, node: string, answer: Answer) => call<{ text: string; source: Source }>('POST', `${n(id, node)}/hint`, { answer }),
  chat: (id: string, node: string, turns: ChatTurn[]) => call<{ text: string; source: Source }>('POST', `${n(id, node)}/chat`, { turns }),
  complete: (id: string, node: string, answer: Answer, durationMin: number) =>
    call<{ result: LessonResult; reward: CompletionReward; view: SessionView; generated: Lesson[] }>('POST', `${n(id, node)}/complete`, { answer, durationMin }),
};
