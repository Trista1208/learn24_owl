// A checkpoint question that pops up over the paused video. A picked answer shows briefly before the video goes on.
import { useEffect, useState, type Ref } from 'react';
import { useI18n } from '../lib/i18n.tsx';

export function Question({ q, n, total, onAnswer, headingRef, id, note }: {
  q: { prompt: string; options: string[] };
  n: number;
  total: number;
  onAnswer: (option: number) => void;
  headingRef?: Ref<HTMLHeadingElement>;
  id?: string;
  note?: string;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => setPicked(null), [n]);
  const pick = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    window.setTimeout(() => onAnswer(i), 320);
  };
  return (
    <section className="video-pop" id={id} aria-label={t('Question {n}', { n: n + 1 })} key={n}>
      <p className="video-pop-label">
        <span className="video-pop-dots" aria-hidden="true">{Array.from({ length: total }, (_, i) => <i key={i} className={i < n ? 'is-done' : i === n ? 'is-at' : ''} />)}</span>
        {t('Video paused · question {n} of {total}', { n: n + 1, total })}
      </p>
      <h3 ref={headingRef} tabIndex={-1}>{q.prompt}</h3>
      <div className="choices">
        {q.options.map((o, i) => (
          <button key={i} type="button" className="choice" aria-pressed={picked === i} disabled={picked !== null && picked !== i} onClick={() => pick(i)}>
            <span className="choice-key" aria-hidden="true">{String.fromCharCode(65 + i)}</span>{o}
          </button>
        ))}
      </div>
      {note && <p className="small muted">{note}</p>}
    </section>
  );
}
