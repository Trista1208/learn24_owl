import { ButtonLabel } from '../lib/ButtonLabel.tsx';
// Settings, in tabs that keep the areas apart: general settings and account, the profile (DCC read-only,
// learning progress, missions), what was learned (records, key points, history, transfer) and the agent's decisions.
import { useEffect, useRef, useState } from 'react';
import type { Mission, SessionView, Track } from '@l45/shared';
import { LERNSTAND_LABEL, RECORD_KIND_LABEL, SOURCE_LABEL } from '@l45/shared';
import { MISSION_PRIVACY } from '../lessons/MissionCard.tsx';
import { api } from '../lib/api.ts';
import { Icon, type IconName } from '../lib/icons.tsx';
import { localeOf, useI18n } from '../lib/i18n.tsx';
import { useStore } from '../lib/store.tsx';
import { ThemeSwitch } from '../lib/theme.tsx';

const time = (iso: string) => new Date(iso).toLocaleTimeString(localeOf(), { hour: '2-digit', minute: '2-digit' });
const date = (iso: string) => new Date(iso).toLocaleDateString(localeOf());

const STATUS: Record<string, string> = { online: 'AI on', offline: 'No AI', simulation: 'AI off (demo)' };

type Tab = 'general' | 'profile' | 'learning' | 'agent';
const TABS: { id: Tab; label: string; icon: IconName; intro: string }[] = [
  { id: 'general', label: 'General', icon: 'settings', intro: 'AI connection and account.' },
  { id: 'profile', label: 'Profile', icon: 'user', intro: 'DCC profile, learning progress and your missions.' },
  { id: 'learning', label: 'Learning', icon: 'book', intro: 'What you have shown and done.' },
  { id: 'agent', label: 'Agent', icon: 'agent', intro: 'How the agent decided and why.' },
];

/** Changing a mission takes two steps: write, then confirm. Only then the agent uses it. */
function MissionRow({ track, mission, onSave }: { track: Track; mission?: Mission; onSave: (text: string, confirm: boolean) => Promise<boolean> }) {
  const { t, trackName } = useI18n();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(mission?.text ?? '');
  const reset = () => {
    setEditing(false);
    setConfirming(false);
    setText(mission?.text ?? '');
  };
  const next = async () => {
    if (mission) setConfirming(true);
    else if (await onSave(text, false)) reset();
  };
  return (
    <li>
      <div className="meta">
        <strong>{trackName(track.id, track.name)}</strong>
        {mission?.status === 'default' && <span>{t('Default (skipped)')}</span>}
        {!mission && <span>{t('still open')}</span>}
      </div>
      {!editing ? (
        <p>
          {mission?.text ? t(mission.text) : <span className="muted">{t('A personal goal is optional. You can start the lessons right away.')}</span>}{' '}
          <button className="linkbtn small" onClick={() => setEditing(true)}><ButtonLabel variants={['Change', 'Set']}>{mission ? t('Change') : t('Set')}</ButtonLabel></button>
        </p>
      ) : (
        <div className="mission-edit">
          {track.mission?.suggestions && <div className="choices">{track.mission.suggestions.map((suggestion) => <button key={suggestion} className="choice small" onClick={() => setText(suggestion)} disabled={confirming}>{t(suggestion)}</button>)}</div>}
          <textarea rows={2} maxLength={300} value={text} disabled={confirming} onChange={(e) => setText(e.target.value)} aria-label={t('Mission for {name}', { name: trackName(track.id, track.name) })} />
          {confirming ? (
            <div className="row">
              <span className="small">{t('Use the new mission? From now on the agent plans with it.')}</span>
              <button className="btn primary small" onClick={async () => { if (await onSave(text, true)) reset(); }}>{t('Yes, change it')}</button>
              <button className="btn quiet small" onClick={() => setConfirming(false)}>{t('Back')}</button>
            </div>
          ) : (
            <div className="row">
              <button className="btn secondary small" disabled={text.trim().length < 3 || text.trim() === mission?.text} onClick={next}>{t('Continue')}</button>
              <button className="btn quiet small" onClick={reset}>{t('Cancel')}</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Records({ view, tname }: { view: SessionView; tname: (id: string) => string }) {
  const { t } = useI18n();
  const { records } = view.workspace;
  if (!records.length) return <p className="muted small">{t('None yet. A record only appears once you have shown something without help. Covered is not learned.')}</p>;
  const item = (r: (typeof records)[number]) => (
    <li key={r.id} className={r.status === 'active' ? '' : 'outdated'}>
      <div className="meta">
        <strong>{r.id}</strong>
        <span>{t(RECORD_KIND_LABEL[r.kind])}</span>
        <span>{tname(r.trackId)}</span>
        <span>{r.author === 'agent' ? t('by the agent') : t('by rule')}</span>
        {r.status !== 'active' && <span>{r.status.replace('superseded by', t('replaced by'))}</span>}
      </div>
      <p><strong>{r.title}</strong> {r.body}</p>
      <p className="small muted">{t('Evidence:')} {r.evidence.join(', ')}</p>
    </li>
  );
  const old = records.filter((r) => r.status !== 'active');
  return (
    <>
      <ul className="log">{records.filter((r) => r.status === 'active').map(item)}</ul>
      {old.length > 0 && (
        <>
          <h5>{t('Replaced')}</h5>
          <ul className="log">{old.map(item)}</ul>
        </>
      )}
    </>
  );
}

export function Settings({ onClose, onLogout }: { onClose: () => void; onLogout: () => void }) {
  const { view, setView, content } = useStore();
  const { t, level, trackName, nodeLabel } = useI18n();
  const [tab, setTab] = useState<Tab>('general');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!view || !content) return null;
  const { session, dcc } = view;
  const ws = view.workspace;
  // The learner's tracks: prepared ones they added and their own. The DCC table lists the whole DCC.
  const tracks = view.skills.flatMap((s) => s.tracks);
  const tname = (id: string) => {
    const tk = tracks.find((x) => x.id === id);
    return tk ? trackName(tk.id, tk.name) : id;
  };
  const node = (id: string) => session.nodes.find((n) => n.id === id);
  const label = (id: string) => {
    const n = node(id);
    return n ? nodeLabel(n) : undefined;
  };
  const current = TABS.find((tk) => tk.id === tab)!;

  const patch = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      setView(await api.patch(session.id, body));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const saveMission = async (trackId: string, text: string, confirm: boolean) => {
    setError(null);
    try {
      setView(await api.mission(session.id, trackId, { text, confirm }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  // Arrow keys move between tabs, as in a native tab list.
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((tk) => tk.id === tab);
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length].id;
    setTab(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label={t('Settings sections')} onKeyDown={onTabKey}>
          <h2 id="settings-title">{t('Settings')}</h2>
          {TABS.map((tk) => (
            <button
              key={tk.id}
              id={`settings-tab-${tk.id}`}
              role="tab"
              aria-selected={tab === tk.id}
              aria-controls="settings-panel"
              tabIndex={tab === tk.id ? 0 : -1}
              onClick={() => setTab(tk.id)}
            >
              <Icon name={tk.icon} />{t(tk.label)}
            </button>
          ))}
        </nav>

        <div className="settings-body" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
          <header className="settings-head">
            <div>
              <h3>{t(current.label)}</h3>
              <p className="small muted">{t(current.intro)}</p>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label={t('Close')}><Icon name="close" size={20} /></button>
          </header>
          {error && <p className="error" role="alert">{t(error)}</p>}

          {tab === 'general' && (
            <>
              <section>
                <div className="setting-group has-menu">
                  <div className="setting-row">
                    <strong>{t('Appearance')}</strong>
                    <ThemeSwitch />
                  </div>
                </div>
              </section>
              <section>
                <h4>{t('AI')}</h4>
                <div className="setting-group">
                  <div className="setting-row">
                    <div className="text">
                      <strong>{t('Status')}</strong>
                      <span>{t('Without AI, chat replies and hints come from prepared texts.')}</span>
                    </div>
                    <span className={`status ${view.modelStatus}`}>{t(STATUS[view.modelStatus] ?? '')}</span>
                  </div>
                  <label className="setting-row switch">
                    <span className="text">
                      <strong>{t('Disconnect the AI for the demo')}</strong>
                      <span>{t('The app then uses prepared content and marks it.')}</span>
                    </span>
                    <input type="checkbox" role="switch" checked={session.simulation} onChange={(e) => patch({ simulation: e.target.checked })} />
                  </label>
                </div>
              </section>
              <section>
                <h4>{t('Account')}</h4>
                <div className="setting-group">
                  <div className="setting-row">
                    <div className="row">
                      <span className="avatar" aria-hidden="true">{session.userName.slice(0, 1).toUpperCase()}</span>
                      <div className="text">
                        <strong>{session.userName}</strong>
                        <span>{t('Session {n} · since {date}', { n: session.sessionNo, date: date(session.createdAt) })}</span>
                      </div>
                    </div>
                    <button className="btn secondary small" onClick={onLogout}><Icon name="logout" size={16} />{t('Sign out')}</button>
                  </div>
                </div>
                <div className="stats">
                  <div><strong>{session.events.length}</strong><span>{t('Lessons done')}</span></div>
                  <div><strong>{tracks.length}</strong><span>{t('Areas')}</span></div>
                  <div><strong>{ws.records.filter((r) => r.status === 'active').length}</strong><span>{t('Learning records')}</span></div>
                </div>
                <p className="small muted">{t('Prototype for Learn45. Sign-in without a password, invented data only.')}</p>
              </section>
            </>
          )}

          {tab === 'profile' && (
            <>
              <section>
                <h4>{t('DCC profile')}</h4>
                <p className="small muted">{t('From the DCC only. Learning in this app does not change these values.')}</p>
                <div className="setting-group">
                  <table className="levels">
                    <tbody>
                      {content.skills.filter((s) => s.dccBased).flatMap((s) => s.tracks).map((tk) => (
                        <tr key={tk.id}><td>{tk.dccArea} {trackName(tk.id, tk.name)}</td><td>{dcc.levels[tk.id] ? level(dcc.levels[tk.id]) : <span className="muted">{t('not assessed')}</span>}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {ws.dccSnapshots.length > 1 && (
                  <p className="small muted">
                    {t('DCC results:')} {ws.dccSnapshots.map((d) => `${date(d.at)} (${d.source === 'file' ? d.fileName ?? t('file') : t('by hand')})`).join(', ')}. {t('The newest one applies.')}
                  </p>
                )}
              </section>

              <section>
                <h4>{t('Learning progress (from learning, not DCC)')}</h4>
                <p className="small muted">{t('From your learning records. “unknown” means: no evidence yet, not: weak. The DCC levels above stay untouched.')}</p>
                {tracks.length === 0 && <p className="small muted">{t('No areas on your map yet.')}</p>}
                <div>
                  {tracks.map((tk) => {
                    const stand = ws.lernstand.filter((l) => l.trackId === tk.id);
                    const known = stand.filter((l) => l.state !== 'unbekannt').length;
                    return (
                      <details key={tk.id} className="lernstand-track">
                        <summary>{trackName(tk.id, tk.name)} <span className="muted small">({t('{known} of {total} with evidence', { known, total: stand.length })})</span></summary>
                        <ul className="lernstand">
                          {stand.map((l) => (
                            <li key={l.criterion}>
                              <span className="grow">{tk.criteria.find((c) => c.id === l.criterion)?.label ?? l.criterion}</span>
                              <span className={`ls ${l.state}`}>{t(LERNSTAND_LABEL[l.state])}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    );
                  })}
                </div>
              </section>

              <section>
                <h4>{t('Mission per area')}</h4>
                <p className="small muted">{t(MISSION_PRIVACY)}</p>
                {tracks.length === 0 && <p className="small muted">{t('A mission belongs to an area. Add one first.')}</p>}
                <ul className="log">
                  {tracks.map((tk) => {
                    const m = ws.missions.find((x) => x.trackId === tk.id);
                    return <MissionRow key={`${tk.id}-${m?.updatedAt ?? ''}`} track={tk} mission={m} onSave={(text, confirm) => saveMission(tk.id, text, confirm)} />;
                  })}
                </ul>
              </section>
            </>
          )}

          {tab === 'learning' && (
            <>
              <section>
                <h4>{t('Learning records')}</h4>
                <Records view={view} tname={tname} />
              </section>

              <section>
                <h4>{t('Key points')}</h4>
                {tracks.every((tk) => !ws.reference[tk.id]?.length) ? <p className="muted small">{t('Grows with what you show without help.')}</p> : (
                  tracks.filter((tk) => ws.reference[tk.id]?.length).map((tk) => (
                    <div key={tk.id} className="merkblatt">
                      <h5>{trackName(tk.id, tk.name)}</h5>
                      <ul>
                        {ws.reference[tk.id].map((e) => (
                          <li key={`${e.section}-${e.title}`}><strong>{e.title}{e.section === 'term' ? ` (${t('term')})` : ''}:</strong> {e.text}</li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
                {ws.notes.length > 0 && (
                  <>
                    <h5>{t('The agent’s notes on your preferences')}</h5>
                    <ul className="log">{ws.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                  </>
                )}
              </section>

              <section>
                <h4>{t('Learning history')}</h4>
                {session.events.length === 0 ? <p className="muted small">{t('No lesson finished yet.')}</p> : (
                  <ul className="log">
                    {[...session.events].reverse().map((e) => (
                      <li key={e.id}>
                        <div className="meta"><span>{date(e.at)} {time(e.at)}</span><span>{tname(e.trackId)}</span>{e.helpUsed && <span>{t('with a hint')}</span>}<span>{e.id}</span></div>
                        <p><strong>{label(e.nodeId)}</strong>: {e.result.summary}</p>
                      </li>
                    ))}
                  </ul>
                )}
                {session.observations.length > 0 && (
                  <>
                    <h5>{t('Observations')}</h5>
                    <ul className="log">
                      {session.observations.map((o) => (
                        <li key={o.id} className={o.status}>{o.text} ({tname(o.trackId)}){o.status === 'outdated' ? t(', outdated') : ''}</li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              <section>
                <h4>{t('Using it at work')}</h4>
                {session.transfer.length === 0 ? <p className="muted small">{t('After each lesson a note for your work appears here.')}</p> : (
                  <ul className="log">
                    {[...session.transfer].reverse().map((tk, i) => <li key={i}><strong>{tk.lessonTitle}:</strong> {tk.text}</li>)}
                  </ul>
                )}
              </section>
            </>
          )}

          {tab === 'agent' && (
            <>
              <section>
                <h4>{t('The agent’s decisions')}</h4>
                {session.recommendations.length === 0 && <p className="muted small">{t('None yet. Add an area.')}</p>}
                <ul className="log">
                  {[...session.recommendations].reverse().map((r) => (
                    <li key={r.id}>
                      <div className="meta"><span>{time(r.createdAt)}</span><strong>{r.ruleId} {t(r.ruleName)}</strong><span>{t(r.status === 'open' ? 'open' : r.status === 'accepted' ? 'accepted' : 'declined')}</span></div>
                      <p>{label(r.nodeId) ?? t('No next step')}{r.alternativeNodeId ? `. ${t('Alternative')}: ${label(r.alternativeNodeId)}` : ''}</p>
                      <p className="small muted">{t(r.observation)} {r.tags.map((tk) => t(SOURCE_LABEL[tk])).join(', ')}</p>
                      {r.basedOn?.length ? <p className="small muted">{t('Based on:')} {r.basedOn.join(', ')}</p> : null}
                    </li>
                  ))}
                </ul>
              </section>
              {session.plannerRuns.length > 0 && (
                <section>
                  <h4>{t('Planner agent runs')}</h4>
                  <ul className="log">
                    {[...session.plannerRuns].reverse().map((r) => (
                      <li key={r.id}>
                        <div className="meta">
                          <span>{time(r.startedAt)}</span>
                          <span>{tname(r.trackId)}</span>
                          <strong>{t(r.outcome === 'accepted' ? 'Plan adopted' : r.outcome === 'running' ? 'running' : 'Rule-based plan')}</strong>
                          <span>{t('{n} steps', { n: r.steps })}</span>
                        </div>
                        <p className="small">{r.note}</p>
                        {r.tools.length > 0 && <p className="small muted">{t('Tools:')} {r.tools.join(', ')}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <p className="small muted">{t('AI calls in this session: {calls}, of which {fallback} fell back to prepared content or rules.', { calls: session.modelCalls.length, fallback: session.modelCalls.filter((c) => c.fallback).length })}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
