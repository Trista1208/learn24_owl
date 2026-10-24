import { ButtonLabel } from '../lib/ButtonLabel.tsx';
import type { MapNode } from '@l45/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { LessonOverlay } from '../lessons/LessonOverlay.tsx';
import { useI18n } from '../lib/i18n.tsx';
import { Icon } from '../lib/icons.tsx';
import { useStore } from '../lib/store.tsx';
import { MindMap } from '../map/MindMap.tsx';
import { NodePanel } from '../map/NodePanel.tsx';
import { Topics } from '../path/Topics.tsx';
import { TrackView } from '../path/TrackView.tsx';
import { AddTrack } from './AddTrack.tsx';
import { Settings } from './Settings.tsx';
import { ReviewOverlay } from '../reviews/Reviews.tsx';

/** The list of topics (and one topic as a line of lessons) or the whole mind map. Remembered per browser; the list is the default. */
type ViewMode = 'path' | 'map';
const MODE_KEY = 'lernagent.view';
const readMode = (): ViewMode => {
  try {
    return localStorage.getItem(MODE_KEY) === 'map' ? 'map' : 'path';
  } catch {
    return 'path';
  }
};
const writeMode = (m: ViewMode) => {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
};

function useWide() {
  const q = '(min-width: 900px)';
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

export function MapScreen() {
  const { view, content, lessonOf, logout, refresh } = useStore();
  const { t } = useI18n();
  const nav = useNavigate();
  const wide = useWide();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [lessonNode, setLessonNode] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [adding, setAdding] = useState(false);
  /** The topic open in the list view; null shows all topics. */
  const [openTrack, setOpenTrack] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [viewMode, setViewModeState] = useState<ViewMode>(readMode);
  const setViewMode = (m: ViewMode) => {
    setViewModeState(m);
    writeMode(m);
  };

  // While the planner agent works, ask the server every 1.5 s. When it is done, its plan replaces the provisional one.
  const planning = Boolean(view?.session.planning);
  // Refresh at the next deadline (including a ten-minute retry), on return to the tab,
  // and at least once per minute while this screen is open.
  useEffect(() => {
    if (!view) return;
    const dueAt = view.reviews.upcoming[0]?.dueAt;
    const delay = dueAt ? Math.min(60_000, Math.max(1000, Date.parse(dueAt) - Date.now() + 100)) : 60_000;
    const timer = setTimeout(() => { void refresh().catch(() => null); }, delay);
    const onFocus = () => { void refresh().catch(() => null); };
    window.addEventListener('focus', onFocus);
    return () => { clearTimeout(timer); window.removeEventListener('focus', onFocus); };
  }, [view, refresh]);
  useEffect(() => {
    if (!planning) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const v = await refresh().catch(() => null);
      if (stop) return;
      if (v && !v.session.planning) {
        // An open lesson shows the next step itself; the toast would only cover its buttons.
        if (v.recommendation?.ruleId === 'A1' && !lessonNode) {
          setToast(t('Your next lesson is ready'));
          setFocusId(v.recommendation.nodeId);
        }
        return;
      }
      timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [planning, refresh, lessonNode, t]);

  useEffect(() => {
    const choices = view?.session.topicChoices;
    const recommended = choices?.topics.find((topic) => topic.recommended);
    if (!lessonNode && choices && recommended && (!selectedId || selectedId === `t-${choices.trackId}`)) {
      setFocusId(`preview-${recommended.id}`);
    }
  }, [view?.session.topicChoices?.id, lessonNode, selectedId]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const closeLesson = useCallback((showNext: boolean) => {
    setLessonNode(null);
    if (showNext) {
      setSelectedId(null);
      setFocusId(null);
      requestAnimationFrame(() => setFocusId(view?.recommendation?.nodeId || null));
    }
  }, [view?.recommendation?.nodeId]);

  // Topic previews show on the map as possible branches; the lessons they would reuse step back meanwhile.
  const mapNodes = useMemo<MapNode[]>(() => {
    if (!view) return [];
    const choices = view.session.topicChoices;
    if (!choices) return view.session.nodes;
    const track = view.skills.flatMap((s) => s.tracks).find((tr) => tr.id === choices.trackId);
    const previews: MapNode[] = choices.topics.map((topic) => ({
      id: `preview-${topic.id}`, kind: 'lesson', parentId: choices.parentNodeId,
      label: topic.title, topicId: topic.id, trackId: choices.trackId, skillId: track?.skillId,
      state: topic.recommended ? 'recommended' : 'alternative',
    }));
    const previewedLessons = new Set(choices.topics.map((topic) => topic.lessonId).filter(Boolean));
    const existing = view.session.nodes.filter((n) => !(n.kind === 'lesson' && n.state !== 'done' && previewedLessons.has(n.lessonId) && !view.session.nodes.some((child) => child.parentId === n.id)));
    return [...existing.map((n) => n.state === 'recommended' || n.state === 'alternative' ? { ...n, state: 'planned' as const } : n), ...previews];
  }, [view]);

  if (!view || !content) return <Navigate to="/" replace />;
  const selected = mapNodes.find((n) => n.id === selectedId) ?? null;

  const back = viewMode === 'map' ? () => setViewMode('path') : openTrack ? () => setOpenTrack(null) : null;

  const select = (id: string | null) => {
    setSelectedId(id);
    setSheetOpen(true);
  };

  return (
    <div className="mapscreen">
      <header className="topbar">
        {back
          ? <button className="btn secondary small" onClick={back}><Icon name="back" size={18} />{t('All topics')}</button>
          : <BrandMark />}
        <span className="spacer" />
        {view.reviews.due.length > 0 && <button className="btn secondary small review-nav" onClick={() => setReviewing('all')}><Icon name="repeat" />{t('Review ({n})', { n: view.reviews.due.length })}</button>}
        <span className="header-xp" aria-label={`Level ${view.rewards.level}, ${view.rewards.xp} XP`}><Icon name="star" size={18} /><strong>Level {view.rewards.level}</strong><span>{view.rewards.xp} XP</span></span>
        <button className="btn quiet small who" onClick={() => setSettings(true)} aria-label={t('My account ({name})', { name: view.session.userName })}>
          <span className="avatar" aria-hidden="true">{view.session.userName.slice(0, 1).toUpperCase()}</span>
          <span className="name">{t('My account')}</span>
        </button>
      </header>

      {viewMode === 'path' ? (
        <main className="path-area" key={openTrack ?? 'topics'}>
          {openTrack
            ? <TrackView view={view} trackId={openTrack} onStart={setLessonNode} onReview={() => setReviewing(openTrack)} paused={Boolean(lessonNode)} />
            : <Topics view={view} onOpen={setOpenTrack} onOwnTopic={() => setAdding(true)} onShowMap={() => setViewMode('map')} onReview={() => setReviewing('all')} />}
        </main>
      ) : (
        <main className="map-area">
          <MindMap
            nodes={mapNodes}
            skills={view.skills}
            dcc={view.dcc}
            lessonOf={lessonOf}
            selectedId={selectedId}
            focusId={focusId}
            onSelect={select}
            rightInset={wide ? 400 : 0}
            bottomCoverage={!wide && sheetOpen ? 0.6 : 0}
          />
          <aside className={`side${wide ? '' : ' sheet'}${!wide && !sheetOpen ? ' collapsed' : ''}`} aria-label={t('Details')}>
            {!wide && (
              <button className="sheet-handle" onClick={() => setSheetOpen(!sheetOpen)} aria-expanded={sheetOpen}>
                <ButtonLabel variants={['Fold down', 'Up next']}>{sheetOpen ? t('Fold down') : t('Up next')}</ButtonLabel>
              </button>
            )}
            {(wide || sheetOpen) && !lessonNode && (
              <NodePanel
                view={view}
                selected={selected}
                onSelect={(id) => {
                  select(id);
                  if (id) setFocusId(id);
                }}
                onStart={(id) => setLessonNode(id)}
                onAddTrack={() => setAdding(true)}
                onFocus={(id) => {
                  setSelectedId(null);
                  setFocusId(null);
                  if (id) requestAnimationFrame(() => setFocusId(id));
                }}
              />
            )}
          </aside>
        </main>
      )}

      {toast && <div className="toast" role="status" aria-live="polite"><Icon name="sparkle" />{toast}</div>}
      {lessonNode && <LessonOverlay key={lessonNode} nodeId={lessonNode} onClose={closeLesson} />}
      {reviewing && <ReviewOverlay trackId={reviewing === 'all' ? undefined : reviewing} onClose={() => setReviewing(null)} />}
      {settings && <Settings onClose={() => setSettings(false)} onLogout={() => { logout(); nav('/'); }} />}
      {adding && (
        <AddTrack
          onClose={() => setAdding(false)}
          onAdded={(nodeId) => {
            setAdding(false);
            if (viewMode === 'path' && nodeId?.startsWith('t-')) return setOpenTrack(nodeId.slice(2));
            setSelectedId(nodeId?.startsWith('t-') ? nodeId : null);
            setSheetOpen(true);
            setFocusId(null);
            // After the first topic the whole map stays in view; later ones move to the new lesson.
            if (nodeId && view.skills.length) requestAnimationFrame(() => setFocusId(nodeId));
          }}
        />
      )}
    </div>
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark">
      <img className="logo" src="/icons/owl.svg" alt="" width={32} height={32} />
      <BrandName />
    </span>
  );
}

/** AIthena: the AI in Athena, whose bird is the owl. The two letters carry the brand colour. */
export function BrandName() {
  return <span className="brand-name"><span className="brand-ai">AI</span>thena</span>;
}
