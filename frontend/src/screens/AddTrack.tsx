// Makes an own topic: the agent plans it with the AI (criteria and sources); the learner then picks the first lesson.
// Prepared topics are on the home list. The goal ("What for?") is not asked here; the mission card asks it at the first lesson.
import { useEffect, useRef, useState } from 'react';
import type { DccLevel } from '@l45/shared';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { Icon } from '../lib/icons.tsx';
import { useStore } from '../lib/store.tsx';

const PRIOR: { level: DccLevel; label: string }[] = [
  { level: 'Grundstufe', label: 'A little' },
  { level: 'Mittelstufe', label: 'Some' },
  { level: 'Fortgeschritten', label: 'A lot' },
];
const EXAMPLES = ['Strong passwords', 'Photos from the phone to the computer', 'Video calls with the family'];

export function AddTrack({ onClose, onAdded }: { onClose: () => void; onAdded: (nodeId?: string) => void }) {
  const { view, setView } = useStore();
  const { t } = useI18n();
  const [topic, setTopic] = useState('');
  const [prior, setPrior] = useState<DccLevel>('Grundstufe');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  if (!view) return null;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createTrack(view.session.id, { topic, selfLevel: prior, deferLesson: true });
      setView(r.view, r.generated);
      onAdded(`t-${r.trackId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <div className="overlay-panel add-track" role="dialog" aria-modal="true" aria-labelledby="add-track-title" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <header className="overlay-head">
          <h2 id="add-track-title">{t('Own topic')}</h2>
          <button className="btn quiet small" disabled={busy} onClick={onClose}><Icon name="close" size={18} />{t('Close')}</button>
        </header>
        {error && <p className="error" role="alert">{error}</p>}
        {!view.canCreateTracks ? (
          <p className="muted">{t('Your own topics need the AI. No AI is connected right now. Please choose a topic from the list.')}</p>
        ) : (
          <form className="add-own" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <label className="field">
              <span>{t('What would you like to learn about?')}</span>
              <input type="text" value={topic} maxLength={120} placeholder={t('e.g. Strong passwords')} onChange={(e) => setTopic(e.target.value)} disabled={busy} />
            </label>
            <div className="chips" aria-label={t('Examples')}>
              {EXAMPLES.map((x) => <button key={x} type="button" className="chip" disabled={busy} onClick={() => setTopic(x)}>{t(x)}</button>)}
            </div>
            <fieldset className="prior">
              <legend>{t('How much do you already know about it?')}</legend>
              <div className="seg" role="radiogroup" aria-label={t('Prior knowledge')}>
                {PRIOR.map((p) => (
                  <button key={p.level} type="button" role="radio" aria-checked={prior === p.level} disabled={busy} onClick={() => setPrior(p.level)}>{t(p.label)}</button>
                ))}
              </div>
            </fieldset>
            <button className="btn primary big" disabled={topic.trim().length < 3 || busy}><Icon name="sparkle" size={20} />{t("Let’s go")}</button>
            {busy && <p className="planning" role="status"><span className="dot-pulse" aria-hidden="true" />{t('The AI is planning “{topic}” for you. This can take up to a minute.', { topic: topic.trim() })}</p>}
            <p className="small muted">{t('The AI only gets your topic, not your name.')}</p>
          </form>
        )}
      </div>
    </div>
  );
}
