// Home: every area with its topics as a plain list. Tapping a topic opens its lessons; a topic the learner has not
// started yet is added first. Own topics sit in their own section, with the way to make a new one.
import { useState, type CSSProperties } from 'react';
import type { SessionView, Skill } from '@l45/shared';
import { CUSTOM_SKILL } from '@l45/shared';
import { Achievements, LearningGoals, RewardsSummary, TopicLevel } from '../rewards/Rewards.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { Icon } from '../lib/icons.tsx';
import { useStore } from '../lib/store.tsx';
import { TRACK_COLOR, trackColors } from '../map/layout.ts';
import { ReviewCard } from '../reviews/Reviews.tsx';

export function Topics({ view, onOpen, onOwnTopic, onShowMap, onReview }: {
  view: SessionView;
  onOpen: (trackId: string) => void;
  onOwnTopic: () => void;
  onShowMap: () => void;
  onReview: () => void;
}) {
  const { content, setView } = useStore();
  const { t, skillName, trackName } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!content) return null;
  const { session } = view;
  const mine = new Set(view.skills.flatMap((s) => s.tracks.map((tr) => tr.id)));
  const colors = trackColors(session.nodes);
  const own = view.skills.find((s) => s.id === CUSTOM_SKILL.id);
  const sections: Skill[] = [...content.skills, { ...CUSTOM_SKILL, tracks: own?.tracks ?? [] } as Skill];
  const doneIn = (trackId: string) => session.nodes.filter((n) => n.kind === 'lesson' && n.trackId === trackId && n.state === 'done').length;
  const lastTrack = view.skills.flatMap((s) => s.tracks).find((tr) => tr.id === session.events.at(-1)?.trackId);

  const open = async (trackId: string) => {
    if (mine.has(trackId)) return onOpen(trackId);
    setBusy(trackId);
    setError(null);
    try {
      const r = await api.addTracks(session.id, [trackId]);
      setView(r.view, r.generated);
      onOpen(trackId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="home">
      <ReviewCard view={view} onStart={onReview} />
      <RewardsSummary progress={view.rewards} name={session.userName} />
      <LearningGoals progress={view.rewards} />
      <h1 className="home-title">{t('What would you like to learn?')}</h1>
      {lastTrack && (
        <button className="continue-card" style={{ ['--tc' as string]: colors.get(lastTrack.id) } as CSSProperties} onClick={() => onOpen(lastTrack.id)}>
          <span className="continue-icon" aria-hidden="true"><Icon name="play" size={24} /></span>
          <span className="topic-row-text">
            <span className="eyebrow next">{t('Keep learning')}</span>
            <strong>{trackName(lastTrack.id, lastTrack.name)}</strong>
          </span>
          <Icon name="chevron" size={22} />
        </button>
      )}
      {error && <p className="error" role="alert">{t(error)}</p>}

      {sections.map((skill) => (
        <section key={skill.id} className="area" aria-labelledby={`area-${skill.id}`}>
          <h2 id={`area-${skill.id}`} className="area-title">{skillName(skill.id, skill.name)}</h2>
          <ul className="topic-list">
            {skill.tracks.map((tr) => {
              const done = doneIn(tr.id);
              return (
                <li key={tr.id}>
                  <button
                    className="topic-row"
                    style={{ ['--tc' as string]: colors.get(tr.id) ?? TRACK_COLOR[tr.id] ?? 'var(--ink-3)' } as CSSProperties}
                    disabled={Boolean(busy)}
                    onClick={() => void open(tr.id)}
                  >
                    <span className="topic-level-disc" aria-hidden="true">{view.rewards.tracks[tr.id]?.level ?? 1}</span>
                    <span className="topic-row-text">
                      <strong>{trackName(tr.id, tr.name)}</strong>
                      {busy === tr.id
                        ? <span className="small muted">{t('Getting ready …')}</span>
                        : mine.has(tr.id) && <span className="small muted">{done === 1 ? t('1 lesson done') : done ? t('{n} lessons done', { n: done }) : ''}</span>}
                      <TopicLevel progress={view.rewards.tracks[tr.id]} name={trackName(tr.id, tr.name)} />
                    </span>
                    <Icon name="chevron" size={22} />
                  </button>
                </li>
              );
            })}
            {skill.id === CUSTOM_SKILL.id && (
              <li>
                <button className="topic-row new" disabled={Boolean(busy) || !view.canCreateTracks} onClick={onOwnTopic}>
                  <span className="topic-plus" aria-hidden="true"><Icon name="plus" size={20} /></span>
                  <span className="topic-row-text">
                    <strong>{t('Create your own topic')}</strong>
                    <span className="small muted">{view.canCreateTracks ? t('You say what you want to learn. The AI plans it for you.') : t('Only works when the AI is connected.')}</span>
                  </span>
                </button>
              </li>
            )}
          </ul>
        </section>
      ))}

      <Achievements achievements={view.rewards.achievements} />
      <button className="linkbtn path-map" onClick={onShowMap}><Icon name="map" size={18} />{t('See everything as a map')}</button>
    </div>
  );
}
