import { useEffect, useRef, useState } from 'react';
import type { ReviewFeedback, ReviewQuestion, SessionView } from '@l45/shared';
import { api } from '../lib/api.ts';
import { localeOf, useI18n } from '../lib/i18n.tsx';
import { Icon } from '../lib/icons.tsx';
import { useStore } from '../lib/store.tsx';

function useReviewTime() {
  const { lang } = useI18n();
  return (at: string) => new Intl.DateTimeFormat(localeOf(lang), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' }).format(new Date(at));
}

export function ReviewCard({ view, trackId, onStart }: { view: SessionView; trackId?: string; onStart: () => void }) {
  const { t } = useI18n();
  const time = useReviewTime();
  const due = view.reviews.due.filter((q) => !trackId || q.trackId === trackId);
  const next = view.reviews.upcoming.find((q) => !trackId || q.trackId === trackId);
  if (!due.length) return next ? <p className="review-upcoming"><Icon name="repeat" />{t('Next review: {at}', { at: time(next.dueAt) })}</p> : null;
  const failed = due.filter((q) => q.lapses > 0).length;
  return (
    <section className="review-card" aria-label={t('Quick review')}>
      <div className="review-card-title"><Icon name="repeat" size={28} /><h2>{t('Quick review')}</h2><span className="review-count">{due.length}</span></div>
      <p>{t('{n} short questions about what you have learned.', { n: due.length })}</p>
      {failed > 0 && <p className="review-priority"><Icon name="target" />{t('We start with what you found difficult last time.')}</p>}
      <ul className="review-concepts">{due.slice(0, 3).map((q) => <li key={q.id}>{q.label}</li>)}</ul>
      <button className="btn primary" onClick={onStart}><Icon name="play" />{t('Review now')}</button>
      <p className="small muted">{t('Just questions, no new lesson. Missed answers come back sooner.')}</p>
    </section>
  );
}

export function ReviewOverlay({ trackId, onClose }: { trackId?: string; onClose: () => void }) {
  const { view, setView } = useStore();
  const { t } = useI18n();
  const time = useReviewTime();
  const sessionId = view!.session.id;
  // Each round is bounded; unanswered questions remain due even when the dialog is closed.
  const [ids] = useState(() => view!.reviews.due.filter((q) => !trackId || q.trackId === trackId).slice(0, 5).map((q) => q.id));
  const [index, setIndex] = useState(0);
  const [question, setQuestion] = useState<ReviewQuestion | null>(null);
  const [feedback, setFeedback] = useState<ReviewFeedback | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [correct, setCorrect] = useState(0);
  const submitting = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const finished = index >= ids.length;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);

  useEffect(() => {
    if (finished) return;
    let stopped = false;
    setQuestion(null);
    setFeedback(null);
    setSelected(null);
    setError(null);
    api.startReview(sessionId, ids[index]).then((r) => {
      if (stopped) return;
      setQuestion(r.question);
      setView(r.view);
    }).catch((e) => { if (!stopped) setError(e.message); });
    return () => { stopped = true; };
  }, [sessionId, ids, index, retry, finished, setView]);

  useEffect(() => { heading.current?.focus(); }, [question?.id]);

  const answer = async (option: number) => {
    if (!question || feedback || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setSelected(option);
    setError(null);
    try {
      const r = await api.answerReview(sessionId, question.reviewId, question.id, option);
      setFeedback(r.feedback);
      setCorrect((n) => n + Number(r.feedback.correct));
      setView(r.view);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      submitting.current = false;
    }
  };

  return (
    <dialog ref={dialog} className="review-dialog" aria-labelledby="review-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="overlay-head"><div><p className="eyebrow">{t('Quick review')}</p><h2 id="review-title">{finished ? t('Done for now!') : t('Question {n} of {total}', { n: index + 1, total: ids.length })}</h2></div><button className="btn quiet small" disabled={busy} onClick={onClose} aria-label={t('Close')}><Icon name="close" /></button></header>
      {!finished && <progress value={index} max={ids.length} aria-label={t('Progress')} />}
      {error && <div role="alert"><p className="error">{t(error)}</p><button className="btn secondary" disabled={busy} onClick={() => question && selected !== null ? void answer(selected) : setRetry((n) => n + 1)}>{t('Try again')}</button></div>}
      {!finished && !question && !error && <p role="status">{t('Loading …')}</p>}
      {!finished && question && <div className="review-question">
        <p className="small muted">{question.label}</p>
        {question.context && <blockquote>{question.context.map((line, i) => <p key={i}>{line}</p>)}</blockquote>}
        <h3 ref={heading} tabIndex={-1}>{question.prompt}</h3>
        <div className="question-options">{question.options.map((option, i) => <button key={i} className={`question-option${feedback?.correctOption === i ? ' is-correct' : feedback && selected === i ? ' is-missed' : ''}`} disabled={busy || Boolean(feedback) || (Boolean(error) && selected !== null)} aria-pressed={selected === i} onClick={() => void answer(i)}><span className="option-letter">{String.fromCharCode(65 + i)}</span><span>{option}</span>{feedback?.correctOption === i && <Icon name="check" />}</button>)}</div>
        {busy && <p role="status">{t('Checking your answer …')}</p>}
        {feedback && <div className={`review-feedback ${feedback.correct ? 'ok' : 'gap'}`} role="status">
          <strong>{feedback.correct ? t('You remembered!') : t('We will practise this again soon.')}</strong>
          {!feedback.correct && <p>{feedback.explanation}</p>}
          <p>{feedback.correct ? t('Next review: {at}', { at: time(feedback.dueAt) }) : t('We will review this concept again in 10 minutes.')}</p>
          <button className="btn primary" onClick={() => setIndex((n) => n + 1)}>{index + 1 === ids.length ? t('Finish this round') : t('Next question')}</button>
        </div>}
      </div>}
      {finished && <div className="review-finished"><Icon name="check" size={44} /><p>{t('You remembered {n} of {total} correctly.', { n: correct, total: ids.length })}</p><p>{t('Correct answers return after longer gaps. Difficult questions come back more often.')}</p>{view!.reviews.due.length > 0 && <p>{t('More questions are waiting on the home screen.')}</p>}<button className="btn primary" onClick={onClose}>{t('Back to learning')}</button></div>}
    </dialog>
  );
}
