import { useI18n } from '../lib/i18n.tsx';
import type { CSSProperties } from 'react';
import type { Achievement, CompletionReward, LearningProgress, LevelProgress } from '@l45/shared';
import { XP_PER_LEVEL, levelProgress } from '@l45/shared';
import { Icon, type IconName } from '../lib/icons.tsx';

const BADGE_ICONS: Record<Achievement['id'], IconName> = {
  'first-step': 'star', 'five-lessons': 'trophy', explorer: 'map', formats: 'sparkle',
};

export function XpBar({ progress, label, from }: { progress: LevelProgress; label: string; from?: number }) {
  return (
    <span className="xp-bar" role="progressbar" aria-label={label} aria-valuenow={progress.intoLevel} aria-valuemin={0} aria-valuemax={XP_PER_LEVEL} aria-valuetext={`${progress.intoLevel} of ${XP_PER_LEVEL} XP to level ${progress.level + 1}`}>
      <span className={from === undefined ? '' : 'xp-fill-earned'} style={{ width: `${progress.percent}%`, '--xp-from': `${from ?? 0}%` } as CSSProperties} />
    </span>
  );
}

export function RewardsSummary({ progress, name }: { progress: LearningProgress; name: string }) {
  const { t: ui } = useI18n();
  return (
    <section className="rewards-hero" aria-label={`Your learning progress, level ${progress.level}`}>
      <div className="rewards-main">
        <div className="level-emblem" aria-hidden="true"><Icon name="star" size={23} /><strong>{progress.level}</strong><span>{ui("LEVEL")}</span></div>
        <div className="rewards-intro">
          <p className="eyebrow">{name}</p>
          <h2>{ui("Your progress")}</h2>
        </div>
      </div>
      <div className="hero-progress">
        <div className="xp-label"><strong><Icon name="sparkle" size={17} />{progress.xp} {ui("XP collected")}</strong><span>{ui("Level")} {progress.level + 1}</span></div>
        <XpBar progress={progress} label={ui("Your overall level")} />
        <p>{progress.toNextLevel} {ui("XP to the next level")}</p>
      </div>
      <div className="rewards-stats">
        <span><Icon name="book" size={18} /><strong>{progress.completedLessons}</strong> {progress.completedLessons === 1 ? ui('Lesson') : ui('lessons')}</span>
        <span><Icon name="trophy" size={18} /><strong>{progress.achievements.filter((a) => a.unlocked).length}</strong> {ui("of")} {progress.achievements.length} {ui("badges")}</span>
      </div>
    </section>
  );
}

export function LearningGoals({ progress }: { progress: LearningProgress }) {
  const { t: ui } = useI18n();
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return (
    <section className="learning-goals" aria-label={ui("Your learning goals")}>
      <div className={`daily-goal${progress.todayComplete ? ' goal-done' : ''}`}>
        <span className="goal-icon"><Icon name={progress.todayComplete ? 'check' : 'target'} size={23} /></span>
        <div><span className="eyebrow">{ui("Your daily goal")}</span><strong>{progress.todayComplete ? ui('Done!') : ui('Finish one lesson')}</strong></div>
      </div>
      <div className="weekly-goal">
        <div><strong>{ui("Your learning week")}</strong><span className="small muted">{Math.min(progress.weekActiveDays, 3)} {ui("/ 3 learning days")}{progress.weekActiveDays >= 3 ? ui(' · Done!') : ''}</span></div>
        <ol className="week-days" aria-label={ui("Learning days this week")}>
          {days.map((day, index) => <li key={day} className={progress.weekDays[index] ? 'active' : ''} aria-label={`${day}: ${progress.weekDays[index] ? 'learned' : 'still open'}`}><span>{day}</span><span className="day-dot">{progress.weekDays[index] && <Icon name="check" size={14} />}</span></li>)}
        </ol>
      </div>
    </section>
  );
}

export function Achievements({ achievements }: { achievements: Achievement[] }) {
  const { t: ui } = useI18n();
  return (
    <section className="achievements" aria-labelledby="achievements-title">
      <div className="section-heading"><h2 id="achievements-title">{ui("Your milestones")}</h2></div>
      <ul className="badge-grid">
        {achievements.map((badge) => <li key={badge.id} className={`achievement${badge.unlocked ? ' unlocked' : ''}`}>
          <span className="badge-medal" aria-hidden="true"><Icon name={BADGE_ICONS[badge.id]} size={27} /><span className="badge-state"><Icon name={badge.unlocked ? 'check' : 'lock'} size={12} /></span></span>
          <strong>{ui(badge.name)}</strong><p>{ui(badge.description)}</p>
          <span className="badge-count">{badge.unlocked ? ui('Earned!') : `${badge.progress} / ${badge.target}`}</span>
        </li>)}
      </ul>
      <details className="xp-explained"><summary>{ui("How do I collect XP?")}</summary><p>{ui("XP are experience points. A new lesson gives you 40 XP, plus up to 60 XP for learning goals you reach. Every format counts the same. Hints cost no points. When you repeat a lesson, you get the extra XP for a better result. Every 200 XP you go up a level, overall and in each topic. These levels show your learning path; your DCC test result stays separate.")}</p></details>
    </section>
  );
}

export function TopicLevel({ progress = levelProgress(0), name }: { progress?: LevelProgress; name: string }) {
  const { t: ui } = useI18n();
  return <span className="topic-level"><span className="xp-label"><strong>{ui("Level")} {progress.level}</strong><span>{progress.xp} {ui("XP")}</span></span><XpBar progress={progress} label={`Level in ${name}`} /></span>;
}

export function RewardCelebration({ reward, progress, trackId, trackName }: { reward: CompletionReward; progress: LearningProgress; trackId: string; trackName: string }) {
  const { t: ui } = useI18n();
  const levelUp = reward.levelAfter > reward.levelBefore;
  const topicLevelUp = reward.topicLevelAfter > reward.topicLevelBefore;
  const topic = progress.tracks[trackId] ?? levelProgress(0);
  const previous = levelProgress(Math.max(0, topic.xp - reward.xp));
  return (
    <section className={`reward-celebration${levelUp ? ' level-up' : ''}`} aria-label={ui("Your reward")}>
      {reward.xp > 0 && <div className="celebration-sparks" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>}
      <span className="celebration-medal" aria-hidden="true"><Icon name={levelUp ? 'trophy' : 'star'} size={36} /></span>
      <p className="eyebrow">{levelUp ? `Level ${reward.levelAfter} reached!` : reward.firstCompletion ? ui('Done!') : reward.xp > 0 ? ui('Improved!') : ui('Review finished')}</p>
      <h3 className="xp-earned">{reward.xp > 0 ? `+${reward.xp} XP` : ui('Exercise finished')}</h3>
      {reward.xp === 0 && <p>{ui("You get more XP for a better result.")}</p>}
      <div className="reward-topic"><div className="xp-label"><strong>{trackName}</strong><span>{ui("Level")} {topic.level}</span></div><XpBar progress={topic} label={`Your progress in ${trackName}`} from={topicLevelUp ? 0 : previous.percent} /><span className="small muted">{topicLevelUp ? `New topic level: level ${topic.level}!` : `${topic.toNextLevel} XP to level ${topic.level + 1}`}</span></div>
      {reward.achievements.map((badge) => <div className="unlocked-reward" key={badge.id}><Icon name={BADGE_ICONS[badge.id]} size={24} /><span><span className="eyebrow">{ui("New badge")}</span><strong>{ui(badge.name)}</strong></span><Icon name="check" size={20} /></div>)}
      {(reward.dailyGoalReached || reward.weeklyGoalReached) && <p className="goal-reached"><Icon name="check" size={18} />{reward.weeklyGoalReached ? ui('Weekly goal reached: you learned on 3 days!') : ui('You reached your daily goal!')}</p>}
    </section>
  );
}
