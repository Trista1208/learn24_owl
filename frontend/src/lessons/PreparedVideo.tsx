import { useEffect, useMemo, useState } from 'react';
import type { Answer, VideoLesson } from '@l45/shared';
import { useI18n } from '../lib/i18n.tsx';
import NarratedVideo from './NarratedVideo.tsx';

type Status = { state: 'idle' | 'building'; completed: number; total: number } | { state: 'ready'; manifestUrl: string } | { state: 'error'; message: string };
const fallbackMessage = 'The voice-over isn’t possible right now. You can view the lesson as a storyboard.';

export default function PreparedVideo({ lesson, prepareUrl, onComplete, onFallback }: {
  lesson: VideoLesson; prepareUrl: string; onComplete: (answer: Answer) => Promise<void>; onFallback: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>({ state: 'building', completed: 0, total: lesson.content.scenes.length });
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (method: 'POST' | 'GET') => {
      try {
        const response = await fetch(prepareUrl, { method, signal: abort.signal });
        const next = await response.json() as Status;
        if (!response.ok || !['building', 'ready', 'error'].includes(next.state)) throw new Error(fallbackMessage);
        if (abort.signal.aborted) return;
        if (next.state === 'ready' && !/^\/videos\/[\w-]+\/manifest\.json$/.test(next.manifestUrl)) throw new Error(fallbackMessage);
        setStatus(next);
        if (next.state === 'building') timer = setTimeout(() => void check('GET'), 1000);
      } catch {
        if (!abort.signal.aborted) setStatus({ state: 'error', message: fallbackMessage });
      }
    };
    void check('POST');
    return () => { abort.abort(); clearTimeout(timer); };
  }, [prepareUrl]);
  const narrated = useMemo(() => status.state === 'ready'
    ? { ...lesson, content: { ...lesson.content, narrated: { manifestUrl: status.manifestUrl } } } : null, [lesson, status]);
  if (narrated) return <NarratedVideo lesson={narrated} onComplete={onComplete} onFallback={onFallback} />;
  return <div className="panel" role={status.state === 'error' ? 'alert' : 'status'}>
    <h3>{status.state === 'error' ? t('Explainer video not available yet') : t('Your explainer video is being prepared')}</h3>
    <p>{status.state === 'error' ? t(status.message) : t('Voice and animation: {n} of {total} scenes ready.', { n: status.state === 'building' ? status.completed : 0, total: lesson.content.scenes.length })}</p>
    {status.state !== 'error' && <p className="small muted">{t('The first time can take a moment. After that the video is saved.')}</p>}
    <button className="btn secondary" onClick={onFallback}>{t('View the storyboard')}</button>
  </div>;
}
