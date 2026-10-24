// Side panel next to the map: the agent's next step with its reasons, or details of a selected node.
import { useState } from 'react';
import type { Lesson, MapNode, Recommendation, SessionView, Track } from '@l45/shared';
import { LERNSTAND_LABEL } from '@l45/shared';
import { TopicLevel } from '../rewards/Rewards.tsx';
import { NextTopics } from '../lessons/NextTopics.tsx';
import { api } from '../lib/api.ts';
import { localeOf, useI18n } from '../lib/i18n.tsx';
import { Icon } from '../lib/icons.tsx';
import { useStore } from '../lib/store.tsx';

type T = (de: string, vars?: Record<string, string | number>) => string;
const same: T = (de) => de;

const LEVEL_TEXT: Record<string, string> = { Grundstufe: 'none or a little', Mittelstufe: 'some', Fortgeschritten: 'a lot' };

/** Own tracks in which nothing is left to do. */
const idleOwnTracks = (view: SessionView): Track[] =>
  view.skills.find((s) => s.id === 'custom')?.tracks.filter((t) => !view.session.nodes.some((n) => n.kind === 'lesson' && n.trackId === t.id && n.state !== 'done' && n.state !== 'skipped')) ?? [];

/** Own tracks have no prepared lessons. When nothing is open there, the learner can ask for the next one. */
function NextLesson({ track, onFocus }: { track: Track; onFocus: (nodeId: string | null) => void }) {
  const { view, setView } = useStore();
  const { t, trackName } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!view?.canCreateTracks) return null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.nextLesson(view.session.id, track.id);
      setView(r.view, r.generated);
      onFocus(r.view.recommendation?.nodeId || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <button className="btn secondary block" disabled={busy} onClick={go}><Icon name="sparkle" size={16} />{busy ? t('Creating the lesson …') : t('New lesson in “{name}”', { name: trackName(track.id, track.name) })}</button>
      {error && <p className="error small" role="alert">{t(error)}</p>}
    </div>
  );
}

/** Which plan this is: the agent's (A1), the rules' while the agent still works, or the rules' alone. */
export function planLabel(rec: Recommendation, view: SessionView, t: T = same) {
  if (rec.ruleId === 'A1') return t('Agent plan');
  if (rec.provisional) return t('provisional');
  return view.agentAvailable ? t('Rule') : t('Rule-based plan');
}

/** The records and events a recommendation cites, in words. */
export function BasedOn({ rec, view }: { rec: Recommendation; view: SessionView }) {
  const { t, lessonTitle } = useI18n();
  if (!rec.basedOn?.length) return null;
  const { records } = view.workspace;
  const { events, nodes } = view.session;
  return (
    <ul className="based-on">
      {rec.basedOn.map((id) => {
        const r = records.find((x) => x.id === id);
        const e = events.find((x) => x.id === id);
        const text = r ? `${r.id}: ${r.title}` : e ? `${t('Result “{label}”', { label: lessonTitle(e.lessonId, nodes.find((n) => n.id === e.nodeId)?.label ?? e.lessonId) })}: ${e.result.summary}` : id;
        return <li key={id}>{text}</li>;
      })}
    </ul>
  );
}

/** Shown while the planner agent works on the next step. */
export function PlanStatus({ view }: { view: SessionView }) {
  const { t } = useI18n();
  if (view.session.planning) {
    return <p className="planning" role="status"><span className="dot-pulse" aria-hidden="true" />{t('The agent is planning … Until then the provisional rule-based suggestion applies.')}</p>;
  }
  if (!view.agentAvailable) return <p className="small muted">{t('Rule-based plan: without the AI the agent plans with the rules and the prepared lessons.')}</p>;
  return null;
}

/** Where a lesson comes from. Only lessons the AI wrote are marked: their examples are invented. */
export function LessonSource({ lesson }: { lesson: Lesson }) {
  const { view } = useStore();
  const { t } = useI18n();
  // In own tracks the AI proposed the sources too; prepared tracks have vetted ones.
  const own = view?.skills.some((s) => s.id === 'custom' && s.tracks.some((t) => t.id === lesson.trackId));
  if (lesson.source === 'model') {
    return (
      <p className="small source-line">
        <span className="tag model">{t('Made by the AI')}</span>
        <span className="tag model">{t('Invented example')}</span>
        {lesson.primarySource && <> {t('Source:')} <a href={lesson.primarySource.url} target="_blank" rel="noreferrer">{lesson.primarySource.title}</a></>}
        {own && <span className="muted">{t('(suggested by the AI)')}</span>}
      </p>
    );
  }
  return <p className="small source-line"><span className="tag prepared">{t('Prepared')}</span></p>;
}

function Reason({ rec, view }: { rec: Recommendation; view: SessionView }) {
  const { t, source } = useI18n();
  return (
    <dl className="reason">
      <div><dt>{t('What the agent saw')}</dt><dd>{t(rec.observation)}</dd></div>
      <div><dt>{t('Suggestion')}</dt><dd>{t(rec.reason)}</dd></div>
      <div><dt>{t('Why this helps now')}</dt><dd>{t(rec.why)}</dd></div>
      {rec.basedOn?.length ? <div><dt>{t('Based on')}</dt><dd><BasedOn rec={rec} view={view} /></dd></div> : null}
      <div>
        <dt>{t('Rule')}</dt>
        <dd>
          {rec.ruleId} {t(rec.ruleName)}{' '}
          {rec.tags.map((tag) => <span key={tag} className={`tag ${tag}`}>{source(tag)}</span>)}
          <span className={`tag${rec.provisional ? ' provisional' : ''}`}>{planLabel(rec, view, t)}</span>
        </dd>
      </div>
    </dl>
  );
}

export function NodePanel({
  view, selected, onSelect, onStart, onAddTrack, onFocus,
}: {
  view: SessionView;
  selected: MapNode | null;
  onSelect: (id: string | null) => void;
  onStart: (nodeId: string) => void;
  onAddTrack: () => void;
  /** Move the map to a node, e.g. a lesson that was just made */
  onFocus: (nodeId: string | null) => void;
}) {
  const { lessonOf, content } = useStore();
  const { t, lang, level, lessonTitle, trackName: trackLabel, skillName } = useI18n();
  const { session, recommendation: rec, dcc } = view;
  const byId = (id?: string) => session.nodes.find((n) => n.id === id);
  // A started recommendation counts as accepted and leaves the view; its node still shows what comes next.
  const recNode = byId(rec?.nodeId) ?? session.nodes.find((n) => n.kind === 'lesson' && n.state === 'recommended');
  const altNode = byId(rec?.alternativeNodeId);
  const trackName = (id?: string) => trackLabel(id, view.skills.flatMap((s) => s.tracks).find((tr) => tr.id === id)?.name ?? '');
  const labelOf = (n?: MapNode) => (n ? lessonTitle(n.lessonId, n.kind === 'track' ? trackLabel(n.trackId, n.label) : n.kind === 'skill' ? skillName(n.skillId, n.label) : n.label) : '');

  // --- Empty map: choose what to learn ---
  if (!selected && !view.skills.length) {
    return (
      <div className="panel-inner">
        <span className="empty-hero" aria-hidden="true"><Icon name="map" size={26} /></span>
        <p className="eyebrow">{t("Let’s go")}</p>
        <h2>{t('What do you want to learn?')}</h2>
        <p>{t('Your map is still empty. Pick your own topic, for example “Pass the Security+ exam”, or a prepared area.')}</p>
        <button className="btn primary block" onClick={onAddTrack}><Icon name="plus" size={16} />{t('Add an area')}</button>
        <p className="small muted">
          {view.canCreateTracks
            ? t('For your own topic the agent uses the AI to plan what you need to know, finds sources and creates a first lesson.')
            : t('Without the AI you can pick the prepared areas. The agent plans own topics only with the AI.')}
        </p>
      </div>
    );
  }

  // --- Default: choose the next topic and format. Topic previews on the map open the same chooser. ---
  const nextTrackId = selected?.topicId ? selected.trackId : recNode?.trackId ?? session.events.at(-1)?.trackId ?? view.skills.flatMap((s) => s.tracks)[0]?.id;
  if ((!selected || selected.topicId) && nextTrackId) {
    return (
      <div className="panel-inner">
        <NextTopics key={`${nextTrackId}:${selected?.topicId ?? 'next'}`} trackId={nextTrackId} initialTopicId={selected?.topicId} onStart={onStart} onFocus={onFocus} />
        <button className="btn secondary block" onClick={onAddTrack}><Icon name="plus" size={16} />{t('Add an area')}</button>
      </div>
    );
  }

  if (!selected) return null;
  const lesson = lessonOf(selected.lessonId);

  if (selected.kind === 'lesson' && lesson) {
    const isRec = selected.state === 'recommended';
    const isAlt = selected.state === 'alternative';
    return (
      <div className="panel-inner">
        <BackLink onClick={() => onSelect(null)} />
        <p className="eyebrow">{trackName(selected.trackId)}</p>
        <h2>{labelOf(selected)}</h2>
        {selected.trackId && <TopicLevel progress={view.rewards.tracks[selected.trackId]} name={labelOf(selected)} />}
        <LessonFacts node={selected} />
        <p>{lesson.intro}</p>
        <LessonSource lesson={lesson} />
        {selected.addedByAgent && <p className="note small">{t('The agent added this lesson after your results.')}</p>}
        {isAlt && recNode && (
          <p className="note">{t('This is the alternative to the suggestion “{label}”. If you start it, the agent remembers that you declined the suggestion.', { label: labelOf(recNode) })}</p>
        )}
        {selected.state === 'planned' && <p className="small muted">{t('Planned. You can start it whenever you like.')}</p>}
        {selected.state === 'done' && selected.result && (
          <div className={`result ${selected.result.allMet ? 'ok' : 'gap'}`}>
            <strong>{selected.result.allMet ? t('Solved') : t('With gaps')}{selected.helpUsed ? t(', with a hint') : ''}</strong>
            <p className="small">{selected.result.summary}</p>
          </div>
        )}
        <div className="panel-actions">
          <button className="btn primary" onClick={() => onStart(selected.id)}>
            <Icon name="play" size={16} />{isAlt ? t('Start the alternative') : selected.state === 'done' ? t('Again') : t('Start')}
          </button>
          {isRec && altNode && <button className="btn secondary" onClick={() => onSelect(altNode.id)}>{t('Something else instead')}</button>}
        </div>
        {isRec && rec && <><PlanStatus view={view} /><Reason rec={rec} view={view} /></>}
      </div>
    );
  }

  if (selected.kind === 'track') {
    const skill = view.skills.find((s) => s.tracks.some((t) => t.id === selected.trackId));
    const lv = selected.trackId ? dcc.levels[selected.trackId] : null;
    const lessons = session.nodes.filter((n) => n.kind === 'lesson' && n.trackId === selected.trackId);
    const done = lessons.filter((n) => n.state === 'done').length;
    const track = skill?.tracks.find((t) => t.id === selected.trackId);
    const mission = view.workspace.missions.find((m) => m.trackId === selected.trackId);
    const stand = view.workspace.lernstand.filter((l) => l.trackId === selected.trackId);
    return (
      <div className="panel-inner">
        <BackLink onClick={() => onSelect(null)} />
        <h2>{labelOf(selected)}</h2>
        {selected.trackId && <TopicLevel progress={view.rewards.tracks[selected.trackId]} name={labelOf(selected)} />}
        <p>
          {skill?.dccBased ? (
            <>{t('DCC level:')} <strong>{level(lv)}</strong> <span className="muted small">{t('(from the DCC, not changed here)')}</span></>
          ) : track?.custom ? (
            <>{t('Own topic: “{topic}”. Prior knowledge as you stated: {level}.', { topic: track.custom.topic, level: t(LEVEL_TEXT[track.custom.selfLevel]) })} <span className="muted small">{t('The AI suggested the criteria and sources.')}</span></>
          ) : t('No DCC area. The agent plans here only from your learning history.')}
        </p>
        {mission && <p className="small"><strong>{t('Your goal:')}</strong> {t(mission.text)}</p>}
        <h3 className="small-head">{t('Learning progress (from learning, not DCC)')}</h3>
        <ul className="lernstand">
          {stand.map((l) => (
            <li key={l.criterion}>
              <span className="grow">{track?.criteria.find((c) => c.id === l.criterion)?.label ?? l.criterion}</span>
              <span className={`ls ${l.state}`}>{t(LERNSTAND_LABEL[l.state])}</span>
            </li>
          ))}
        </ul>
        <ul className="nodelist">
          {lessons.map((n) => (
            <li key={n.id}>
              <button onClick={() => onSelect(n.id)}>
                <span className={`dotmark ${n.state}`} aria-hidden="true" />
                <span className="grow">{lessonTitle(n.lessonId, n.label)}</span>
                <span className="muted small">{stateLabel(n, t)}</span>
              </button>
            </li>
          ))}
        </ul>
        {track && <NextTopics key={track.id} trackId={track.id} onStart={onStart} onFocus={onFocus} />}
        {track?.custom && (
          <>
            <h3 className="small-head">{t('Sources')}</h3>
            <ul className="sources small">
              {track.custom.sources.map((x) => (
                <li key={x.url}><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a>{x.note ? `: ${x.note}` : ''}</li>
              ))}
            </ul>
            <p className="small muted">{t('Suggested by the AI and reachable when created, but not checked by people.')}</p>
            {idleOwnTracks(view).some((tr) => tr.id === track.id) && <NextLesson track={track} onFocus={onFocus} />}
          </>
        )}
      </div>
    );
  }

  if (selected.kind === 'skill') {
    const skill = view.skills.find((s) => s.id === selected.skillId);
    const text = skill?.dccBased
      ? t('Competence areas according to DigComp 2.2. The levels come from your DCC profile.')
      : skill?.id === 'custom'
        ? t('Your own topics. The agent planned them with the AI and creates the lessons for them.')
        : t('Area without a DCC level. Here the agent plans only from your learning history.');
    return (
      <div className="panel-inner">
        <BackLink onClick={() => onSelect(null)} />
        <h2>{labelOf(selected)}</h2>
        {selected.trackId && <TopicLevel progress={view.rewards.tracks[selected.trackId]} name={labelOf(selected)} />}
        <p>{text}</p>
        <button className="btn secondary block" onClick={onAddTrack}><Icon name="plus" size={16} />{t('Add an area')}</button>
      </div>
    );
  }

  // Start node: the learner
  const dccTracks = content?.skills.filter((s) => s.dccBased).flatMap((s) => s.tracks) ?? [];
  const done = session.nodes.filter((n) => n.kind === 'lesson' && n.state === 'done').length;
  return (
    <div className="panel-inner">
      <BackLink onClick={() => onSelect(null)} />
      <h2>{session.userName}</h2>
      <p className="small muted">
        {t('DCC profile')} {dcc.source === 'file' ? t('from “{file}”', { file: dcc.fileName ?? t('file') }) : t('entered by hand')}
        {dcc.assessedOn ? t(', assessed on {date}', { date: new Date(dcc.assessedOn).toLocaleDateString(localeOf(lang)) }) : ''}
      </p>
      <table className="levels">
        <tbody>
          {content?.skills.filter((s) => s.dccBased).flatMap((s) => s.tracks).map((tr) => (
            <tr key={tr.id}><td>{tr.dccArea} {trackLabel(tr.id, tr.name)}</td><td>{dcc.levels[tr.id] ? level(dcc.levels[tr.id]) : <span className="muted">{t('not assessed')}</span>}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function stateLabel(n: MapNode, t: T) {
  switch (n.state) {
    case 'recommended': return t('next step');
    case 'alternative': return t('Alternative');
    case 'done': return n.result?.allMet ? t('solved') : t('with gaps');
    case 'skipped': return t('skipped');
    default: return t('planned');
  }
}

function LessonFacts({ node }: { node: MapNode }) {
  const { lessonOf } = useStore();
  const { t, type, mode, level } = useI18n();
  const l = lessonOf(node.lessonId);
  if (!l) return null;
  return (
    <p className="facts">
      <span className="pill">{type(l.type)}</span>
      <span>{mode(l.mode)}</span>
      <span>{l.durationMin} {t('min')}</span>
      <span>{level(l.level)}</span>
    </p>
  );
}

function Legend() {
  const { t } = useI18n();
  return (
    <div className="legend" aria-label={t('Legend')}>
      <span><i className="lg rec" />{t('next step')}</span>
      <span><i className="lg alt" />{t('Alternative')}</span>
      <span><i className="lg planned" />{t('planned')}</span>
      <span><i className="lg done" />{t('done')}</span>
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return <button className="linkbtn small back" onClick={onClick}><Icon name="back" size={16} />{t('Back to the next step')}</button>;
}
