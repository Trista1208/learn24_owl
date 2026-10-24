import { randomInt } from 'node:crypto';
import type { Lesson, ReviewChallenge, ReviewItem, ReviewOverview, ReviewQuestion } from '@l45/shared';
import { allLessons } from './guard.ts';
import { isDue } from './records.ts';
import { firstReviewAt, scheduleReview } from './reviewSchedule.ts';
import { HttpError } from './sessions.ts';
import { criterionLabel, learnerTracks, trackIn } from './tracks.ts';
import { newId } from './util.ts';
import { writeState, type Stored } from './workspace.ts';

/** Upgrade the old one-shot queue, and include learning from before reviews existed. */
export function ensureReviews(st: Stored) {
  let changed = false;
  const s = st.session;
  for (const q of s.reviewQueue) {
    if (q.dueAt) continue;
    const done = q.status === 'done';
    const at = s.events.find((ev) => ev.id === q.doneEventId)?.at ?? q.addedAt;
    const due = !done && isDue(st, q);
    Object.assign(q, { dueAt: due ? new Date().toISOString() : firstReviewAt(at), status: 'waiting', intervalDays: 1, streak: 0, lapses: 0 });
    changed = true;
  }
  for (const track of learnerTracks(st)) {
    for (const criterion of track.criteria) {
      if (s.reviewQueue.some((q) => q.trackId === track.id && q.criterion === criterion.id)) continue;
      const ev = [...s.events].reverse().find((ev) => ev.trackId === track.id && ev.result.criteria.some((c) => c.key === criterion.id));
      if (!ev) continue;
      const q: ReviewItem = { id: newId('rv'), trackId: track.id, criterion: criterion.id, recordId: ev.id, addedAt: ev.at, addedAfterEvents: s.events.indexOf(ev) + 1, addedInSession: s.sessionNo, status: 'waiting', dueAt: firstReviewAt(ev.at), intervalDays: 1, streak: 0, lapses: 0 };
      if (ev.result.criteria.some((c) => c.key === criterion.id && c.status === 'missed')) scheduleReview(q, false, new Date(ev.at));
      s.reviewQueue.push(q);
      changed = true;
    }
  }
  if (changed) writeState(s);
}

export function reviewOverview(st: Stored): ReviewOverview {
  const items = st.session.reviewQueue.filter((q) => q.status === 'waiting' && trackIn(st, q.trackId));
  const priority = (a: ReviewItem, b: ReviewItem) => Number(b.lastCorrect === false) - Number(a.lastCorrect === false)
    || (b.lapses ?? 0) - (a.lapses ?? 0) || a.dueAt!.localeCompare(b.dueAt!);
  const summary = (q: ReviewItem) => ({ id: q.id, trackId: q.trackId, label: criterionLabel(st, q.trackId, q.criterion), dueAt: q.dueAt!, lapses: q.lapses ?? 0 });
  return {
    due: items.filter((q) => isDue(st, q)).sort(priority).map(summary),
    upcoming: items.filter((q) => !isDue(st, q)).sort((a, b) => a.dueAt!.localeCompare(b.dueAt!)).map(summary),
  };
}

type QuestionContent = Pick<ReviewChallenge, 'prompt' | 'options' | 'correctOption' | 'explanation' | 'context'>;
type ReviewCandidate = QuestionContent & { sourceQuestionId: string };

function fromLesson(lesson: Lesson, q: ReviewItem): ReviewCandidate[] {
  if (lesson.type === 'video' || lesson.type === 'podcast') {
    return lesson.content.questions.flatMap((question, index) => (question.criterion ?? lesson.targets[0]) === q.criterion ? [{
      sourceQuestionId: JSON.stringify([lesson.id, 'quiz', index]),
      prompt: question.prompt, options: question.options, correctOption: question.correct, explanation: question.explanation,
    }] : []);
  }
  if (lesson.type === 'mark-evidence') {
    return lesson.content.summary.flatMap((item) => (item.criterion ?? (item.verdict === 'erfunden' ? 'quelle' : lesson.targets[0])) === q.criterion ? [{
      sourceQuestionId: JSON.stringify([lesson.id, 'statement', item.id]),
      prompt: `Is this statement supported by the note? “${item.text}”`, context: lesson.content.note,
      options: ['Supported', 'Made up'], correctOption: item.verdict === 'belegt' ? 0 : 1, explanation: item.explanation,
    }] : []);
  }
  if (lesson.type === 'mock-site') {
    const parts = [...(lesson.content.mail ?? []), ...lesson.content.site];
    return parts.flatMap((part) => part.signal?.criterion === q.criterion ? [{
      sourceQuestionId: JSON.stringify([lesson.id, 'signal', part.id]),
      prompt: 'Which warning sign do you see here?', context: [part.text, ...(part.linkTarget ? [`Link target: ${part.linkTarget}`] : [])],
      options: [part.signal.explanation, ...new Set(parts.filter((p) => p.signal && p.signal.criterion !== q.criterion && p.signal.explanation !== part.signal!.explanation).map((p) => p.signal!.explanation))].slice(0, 3).concat('There is no warning sign here.'),
      correctOption: 0, explanation: part.signal.explanation,
    }] : []);
  }
  return [];
}

/** Include every matching question from every completed lesson, irrespective of the original answer. */
function questionBank(st: Stored, q: ReviewItem): ReviewCandidate[] {
  const lessons = new Map(allLessons(st.session).map((lesson) => [lesson.id, lesson]));
  const learned = [...new Set(st.session.events.filter((ev) => ev.trackId === q.trackId).map((ev) => ev.lessonId))];
  const questions = learned.flatMap((id) => {
    const lesson = lessons.get(id);
    return lesson?.trackId === q.trackId ? fromLesson(lesson, q) : [];
  });
  if (questions.length) return questions;
  const track = trackIn(st, q.trackId)!;
  const criterion = track.criteria.find((c) => c.id === q.criterion)!;
  const options = [criterion.ruleOfThumb, ...track.criteria.filter((c) => c.id !== q.criterion && c.ruleOfThumb !== criterion.ruleOfThumb).map((c) => c.ruleOfThumb).slice(0, 3)];
  // Custom tracks have at least three criteria; keep a meaningful binary fallback for legacy tracks.
  if (options.length < 2) options.push('I do not need to check that.');
  return [{ sourceQuestionId: JSON.stringify([q.trackId, 'rule', q.criterion]), prompt: `What should you keep in mind for “${criterion.label}”?`, options, correctOption: 0, explanation: criterion.ruleOfThumb }];
}

/** Unseen questions first, then the least recently answered. Opening a card never consumes it. */
function questionContent(st: Stored, q: ReviewItem): ReviewCandidate {
  const questions = questionBank(st, q);
  const history = new Map((q.questionHistory ?? []).map((id, index) => [id, index]));
  const rank = (question: ReviewCandidate) => history.get(question.sourceQuestionId) ?? -1;
  return questions.reduce((next, question) => rank(question) < rank(next) ? question : next);
}

function publicQuestion(challenge: ReviewChallenge): ReviewQuestion {
  const { sourceQuestionId: _s, correctOption: _c, explanation: _e, answeredOption: _a, feedback: _f, ...question } = challenge;
  return question;
}

export function startReview(st: Stored, reviewId: string): ReviewQuestion {
  ensureReviews(st);
  const q = st.session.reviewQueue.find((q) => q.id === reviewId && trackIn(st, q.trackId));
  if (!q) throw new HttpError(404, 'Review not found.');
  if (!isDue(st, q)) throw new HttpError(409, 'This review is not due yet.');
  const challenges = st.session.reviewChallenges ??= {};
  const existing = challenges[q.id];
  if (existing && !existing.feedback) return publicQuestion(existing);
  const content = questionContent(st, q);
  const order = content.options.map((text, index) => ({ text, index }));
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const challenge: ReviewChallenge = {
    ...content, options: order.map((x) => x.text), correctOption: order.findIndex((x) => x.index === content.correctOption),
    id: newId('rc'), reviewId: q.id, trackId: q.trackId, label: criterionLabel(st, q.trackId, q.criterion),
  };
  challenges[q.id] = challenge;
  writeState(st.session);
  return publicQuestion(challenge);
}

export function answerReview(st: Stored, reviewId: string, input: { challengeId?: unknown; option?: unknown }) {
  const q = st.session.reviewQueue.find((q) => q.id === reviewId);
  const challenge = st.session.reviewChallenges?.[reviewId];
  if (!q || !challenge || challenge.id !== input.challengeId) throw new HttpError(409, 'Please open the review again.');
  const option = input.option;
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option >= challenge.options.length) throw new HttpError(400, 'Invalid answer.');
  if (challenge.feedback) {
    if (challenge.answeredOption !== option) throw new HttpError(409, 'This answer has already been checked.');
    return challenge.feedback;
  }
  // A normal lesson can reschedule a review while an old browser tab is open.
  if (!isDue(st, q)) throw new HttpError(409, 'This review is already done.');
  const bank = questionBank(st, q);
  // An outstanding card from before rotation was added has no source identity yet.
  const sourceId = challenge.sourceQuestionId ?? [...bank].reverse().find((question) => question.prompt === challenge.prompt
    && question.options[question.correctOption] === challenge.options[challenge.correctOption]
    && JSON.stringify(question.context) === JSON.stringify(challenge.context))?.sourceQuestionId;
  const validIds = new Set(bank.map((question) => question.sourceQuestionId));
  if (sourceId && validIds.has(sourceId)) {
    q.questionHistory = [...(q.questionHistory ?? []).filter((id) => validIds.has(id) && id !== sourceId), sourceId];
  }
  const correct = option === challenge.correctOption;
  scheduleReview(q, correct, new Date(), 'recall');
  challenge.answeredOption = option;
  challenge.feedback = { correct, correctOption: challenge.correctOption, explanation: challenge.explanation, dueAt: q.dueAt!, intervalDays: q.intervalDays! };
  writeState(st.session);
  return challenge.feedback;
}
