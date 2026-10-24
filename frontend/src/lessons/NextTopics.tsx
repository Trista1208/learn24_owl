import { useI18n } from '../lib/i18n.tsx';
import { ButtonLabel } from '../lib/ButtonLabel.tsx';
// "What comes next?": the learner picks the next topic of a track, then how to learn it. Tapping a format starts the
// lesson; a topic with only one format starts right away. Topics are cheap previews; only the choice makes a lesson.
import { useEffect, useRef, useState } from 'react';
import type { LessonType, NextTopic, TopicChoices } from '@l45/shared';
import { TYPE_LABEL } from '@l45/shared';
import { api, ApiError } from '../lib/api.ts';
import { Icon, type IconName } from '../lib/icons.tsx';
import { useStore } from '../lib/store.tsx';

export const FORMAT_HELP: Record<LessonType, string> = {
  video: 'Explanation with questions',
  podcast: 'A conversation to listen to',
  'ai-chat': 'Practise in a conversation',
  'mark-evidence': 'Compare with a note',
  'mock-site': 'Check an email or a website',
};
export const FORMAT_ICON: Record<LessonType, IconName> = {
  video: 'play', podcast: 'headphones', 'ai-chat': 'chat', 'mark-evidence': 'book', 'mock-site': 'globe',
};

export function NextTopics({ trackId, initialTopicId, onStart, onFocus }: {
  trackId: string;
  initialTopicId?: string;
  onStart: (nodeId: string) => void;
  onFocus: (nodeId: string | null) => void;
}) {
  const { t: ui } = useI18n();
  const { view, setView, lessonOf } = useStore();
  const [choices, setChoices] = useState<TopicChoices | null>(null);
  const [selected, setSelected] = useState<NextTopic | null>(null);
  const [own, setOwn] = useState(false);
  const [topic, setTopic] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [retry, setRetry] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const sessionId = view!.session.id;
  const lastEvent = view!.session.events.at(-1)?.id;
  const simulation = view!.session.simulation;
  const planning = view!.session.planning;
  const preferred = view!.session.preferredLessonType;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setChoices(null);
    setSelected(null);
    setError(null);
    setStale(false);
    if (planning) return;
    api.topics(sessionId, trackId).then((r) => {
      if (cancelled) return;
      setChoices(r.choices);
      setView(r.view);
      const initial = initialTopicId && r.choices.topics.find((t) => t.id === initialTopicId);
      if (initial) setSelected(initial);
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, trackId, lastEvent, simulation, planning, retry, initialTopicId, setView]);

  useEffect(() => {
    if (selected || own) heading.current?.focus();
  }, [selected, own]);

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setStale(e instanceof ApiError && e.status === 409);
  };
  const start = async (t: NextTopic, format: LessonType) => {
    if (!choices || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await api.chooseTopic(sessionId, { choiceSetId: choices.id, topicId: t.id, format });
      setView(r.view, r.generated);
      onFocus(r.nodeId);
      onStart(r.nodeId);
    } catch (e) { fail(e); }
    finally { submitting.current = false; setBusy(false); }
  };
  const pick = (t: NextTopic) => {
    setError(null);
    if (t.formats.length === 1) void start(t, t.formats[0]);
    else setSelected(t);
  };
  const suggest = async () => {
    if (!choices || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await api.suggestTopic(sessionId, { choiceSetId: choices.id, topic: topic.trim() });
      setView(r.view);
      setOwn(false);
      pick(r.topic);
    } catch (e) { fail(e); }
    finally { submitting.current = false; setBusy(false); }
  };
  // Formats in a stable order, the one chosen last time first.
  const formats = selected ? [...selected.formats].sort((a, b) => Number(b === preferred) - Number(a === preferred)) : [];

  return (
    <section className="next-topics" aria-label={ui("Next lessons")} aria-busy={loading || busy}>
      {loading ? (
        <p className="planning" role="status"><span className="dot-pulse" aria-hidden="true" />{planning ? ui('One moment …') : ui('Loading lessons …')}</p>
      ) : busy && !own ? (
        <p className="planning" role="status"><span className="dot-pulse" aria-hidden="true" />{ui("Preparing the lesson …")}</p>
      ) : selected ? (
        <>
          <h2 ref={heading} tabIndex={-1}>{ui("How would you like to learn?")}</h2>
          <p><strong>{selected.title}</strong></p>
          <div className="format-options">
            {formats.map((t) => (
              <button key={t} className="format-option" disabled={busy || stale} onClick={() => void start(selected, t)}>
                <span className="format-icon" aria-hidden="true"><Icon name={FORMAT_ICON[t]} size={24} /></span>
                <span className="format-text">
                  <strong>{ui(TYPE_LABEL[t])}{preferred === t && <span className="format-preferred">{ui("Chosen last time")}</span>}</strong>
                  <span className="small muted">{ui(FORMAT_HELP[t])}</span>
                </span>
              </button>
            ))}
          </div>
          <button className="btn quiet small back" disabled={busy} onClick={() => { setSelected(null); setError(null); }}><Icon name="back" size={18} />{ui("Another topic")}</button>
        </>
      ) : own ? (
        <form className="own-topic" onSubmit={(e) => { e.preventDefault(); void suggest(); }}>
          <h2 ref={heading} tabIndex={-1}>{ui("What would you like to learn next?")}</h2>
          <label className="field"><span>{ui("What you’d like")}</span><textarea autoFocus rows={3} minLength={3} maxLength={120} required value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={ui("I want to understand how …")} disabled={busy} /></label>
          <button className="btn primary" disabled={busy || topic.trim().length < 3 || stale}><ButtonLabel variants={['Continue', 'One moment …']}>{busy ? ui('One moment …') : ui('Continue')}</ButtonLabel></button>
          <button className="btn quiet small back" type="button" disabled={busy} onClick={() => { setOwn(false); setError(null); }}><Icon name="back" size={18} />{ui("Back")}</button>
        </form>
      ) : choices ? (
        <>
          <h2>{ui("Up next")}</h2>
          {choices.topics.length ? (
            <div className="topic-options">
              {choices.topics.map((t) => {
                const lesson = lessonOf(t.lessonId);
                return <button key={t.id} className={`topic-option${t.recommended ? ' recommended' : ''}`} title={t.reason} disabled={stale} onClick={() => pick(t)}>
                  <span className="topic-choice-text">
                    {t.exam
                      ? <span className="topic-recommended"><Icon name="trophy" size={15} />{ui("Peak exam")}</span>
                      : t.recommended && <span className="topic-recommended"><Icon name="sparkle" size={15} />{ui("Recommended")}</span>}
                    <strong>{t.exam ? ui("Everything from this mountain in one lesson") : ui(t.title)}</strong>
                    {t.exam && <span className="small muted">{ui(t.reason)}</span>}
                    <span className="topic-choice-meta">{t.formats.length === 1 && <Icon name={FORMAT_ICON[t.formats[0]]} size={15} />}{t.formats.length === 1 ? ui(TYPE_LABEL[t.formats[0]]) : ui('Choose a format')}{lesson && t.formats.length === 1 && lesson.type === t.formats[0] && ` · ${lesson.durationMin} Min.`}</span>
                  </span>
                  <span className="topic-start" aria-hidden="true"><Icon name={t.formats.length === 1 ? 'play' : 'chevron'} size={17} /></span>
                </button>;
              })}
              {choices.canSuggestOwn && (
                <button className="topic-option own" disabled={stale} onClick={() => setOwn(true)}>
                  <strong><Icon name="plus" size={18} />{ui("Suggest something else")}</strong>
                </button>
              )}
            </div>
          ) : (
            <p>{ui("All done. Choose another topic.")}</p>
          )}
        </>
      ) : null}
      {error && <p className="error small" role="alert">{ui(error)}</p>}
      {(!loading && !choices || stale) && <button className="btn secondary" disabled={busy} onClick={() => setRetry((n) => n + 1)}>{ui("Try again")}</button>}
    </section>
  );
}
