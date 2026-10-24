import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { Icon } from '../lib/icons.tsx';
import { useI18n } from '../lib/i18n.tsx';

interface Hit { title: string; url: string; snippet: string; image?: string }

export function LearnMore({ query }: { query: string }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videos, setVideos] = useState<Hit[] | null>(null);
  const [web, setWeb] = useState<Hit[] | null>(null);
  const [forQuery, setForQuery] = useState(`${lang}:${query}`);
  if (forQuery !== `${lang}:${query}`) {
    setForQuery(`${lang}:${query}`);
    setVideos(null);
    setWeb(null);
    setError(null);
  }

  useEffect(() => {
    if (!open || videos) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    api.learnMore(query, lang).then((r) => {
      if (cancelled) return;
      setVideos(r.videos);
      setWeb(r.web);
    }).catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Search is not reachable just now.');
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [open, query, lang, videos]);

  return (
    <section className="learn-more">
      <button type="button" className="learn-more-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="play" size={16} />
        {t('Learn more')}
      </button>
      {open && (
        <div className="learn-more-body">
          <p className="small muted">{t('Videos and pages on this topic.')}</p>
          {busy && <p className="small" role="status">{t('Searching …')}</p>}
          {error && <p className="error small" role="alert">{t(error)}</p>}
          {videos && web && !videos.length && !web.length && <p className="small muted">{t('Nothing turned up for this just now.')}</p>}
          {!!videos?.length && (
            <div>
              <h3>{t('Related videos')}</h3>
              <ul className="learn-videos">
                {videos.map((v) => (
                  <li key={v.url}>
                    <a href={v.url} target="_blank" rel="noreferrer">
                      {v.image && <img src={v.image} alt="" />}
                      <span>{v.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!web?.length && (
            <div>
              <h3>{t('On the web')}</h3>
              <ul className="learn-web">
                {web.map((item) => (
                  <li key={item.url}>
                    <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a>
                    {item.snippet && <p className="small muted">{item.snippet}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
