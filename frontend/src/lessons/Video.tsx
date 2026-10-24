import { useI18n } from '../lib/i18n.tsx';
import { ButtonLabel } from '../lib/ButtonLabel.tsx';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Answer, VideoLesson, VideoVisual } from '@l45/shared';
import { LessonProgress, QuestionCard } from './LessonActivity.tsx';
import { Icon } from '../lib/icons.tsx';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Progress 0..1 through the current scene while playing. */
function useSceneProgress(playing: boolean, seconds: number, sceneKey: string, onEnd: () => void) {
  const [p, setP] = useState(0);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    setP(reduced() ? 1 : 0);
  }, [sceneKey]);
  useEffect(() => {
    if (!playing) return;
    if (reduced()) {
      const id = setTimeout(() => endRef.current(), seconds * 1000);
      return () => clearTimeout(id);
    }
    let raf = 0;
    let finished = false;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setP((prev) => {
        const next = Math.min(1, prev + dt / seconds);
        if (next >= 1 && !finished) { finished = true; queueMicrotask(() => endRef.current()); }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, seconds, sceneKey]);
  return p;
}

const INK = '#e6ece7';
const DIM = '#8fa39a';
const YELLOW = '#f5c400';
const RED = '#ff8a7a';

function NextWord({ p, chosen }: { p: number; chosen: boolean }) {
  const words: [string, number][] = [['Monday', 0.46], ['Tuesday', 0.21], ['Wednesday', 0.17], ['Friday', 0.1], ['June', 0.06]];
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label="Bars: how well each next word fits">
      <text x="16" y="30" fill={INK} fontSize="15">The team meets next{chosen && p > 0.5 ? '' : ' …'}</text>
      {chosen && p > 0.5 && <text x="166" y="30" fill={YELLOW} fontSize="15" fontWeight="700">Monday.</text>}
      {words.map(([w, v], i) => {
        const y = 56 + i * 26;
        const width = 190 * v * Math.min(1, p * 1.6) / 0.46;
        const highlight = chosen && i === 0;
        return (
          <g key={w}>
            <text x="16" y={y + 13} fill={highlight ? YELLOW : DIM} fontSize="13">{w}</text>
            <rect x="100" y={y} width={width} height="16" rx="3" fill={highlight ? YELLOW : DIM} opacity={highlight ? 1 : 0.7} />
          </g>
        );
      })}
      <text x="16" y="192" fill={DIM} fontSize="10">Example values for illustration</text>
    </svg>
  );
}

function InventedDetail({ p }: { p: number }) {
  const show = (t: number) => (p >= t ? 1 : 0.15);
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label="Note and summary compared">
      <text x="16" y="24" fill={DIM} fontSize="12">Note</text>
      <text x="16" y="44" fill={INK} fontSize="13">The team meets next week.</text>
      <text x="16" y="62" fill={INK} fontSize="13">The day is still open.</text>
      <text x="16" y="120" fill={DIM} fontSize="12">AI summary</text>
      <text x="16" y="140" fill={INK} fontSize="13">The team meets next</text>
      <text x="146" y="140" fill={RED} fontSize="13" fontWeight="700">Monday.</text>
      <path d="M60 128 L60 70" stroke={YELLOW} strokeWidth="2" strokeDasharray="4 3" opacity={show(0.25)} />
      <text x="66" y="100" fill={YELLOW} fontSize="11" opacity={show(0.25)}>supported</text>
      <ellipse cx="172" cy="135" rx="34" ry="14" fill="none" stroke={RED} strokeWidth="2" strokeDasharray="5 3" opacity={show(0.55)} />
      <text x="130" y="172" fill={RED} fontSize="12" opacity={show(0.55)}>not in the note anywhere</text>
    </svg>
  );
}

// Coordinates for the curve y = 0.5 x^2
const X = (x: number, cx = 0.5, z = 1) => 160 + (x - cx) * 60 * z;
const Y = (y: number, cy = 0.125, z = 1) => 120 - (y - cy) * 60 * z;
const f = (x: number) => 0.5 * x * x;

function curvePath(cx: number, z: number) {
  const pts: string[] = [];
  for (let x = -2.5; x <= 3.01; x += 0.05) pts.push(`${X(x, cx, z).toFixed(1)},${Y(f(x), f(cx), z).toFixed(1)}`);
  return `M${pts.join(' L')}`;
}

function SecantTangent({ p, moving }: { p: number; moving: boolean }) {
  const a = 0.5;
  const b = moving ? 2.2 - (2.2 - 0.62) * p : 2.2;
  const slope = (f(b) - f(a)) / (b - a);
  const line = (x: number) => f(a) + slope * (x - a);
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label="Curve with a secant through two points">
      <path d={curvePath(a, 1)} fill="none" stroke={INK} strokeWidth="2" />
      <line x1={X(-1.2)} y1={Y(line(-1.2), f(a))} x2={X(2.6)} y2={Y(line(2.6), f(a))} stroke={YELLOW} strokeWidth="2" />
      <circle cx={X(a)} cy={Y(f(a), f(a))} r="5" fill={YELLOW} />
      <circle cx={X(b)} cy={Y(f(b), f(a))} r="5" fill={INK} />
      <text x="16" y="24" fill={INK} fontSize="13">Slope of the secant: {slope.toFixed(2)}</text>
    </svg>
  );
}

function SlopeZoom({ p, zoom }: { p: number; zoom: boolean }) {
  const a = 0.5;
  const z = zoom ? 1 + p * 6 : 1;
  const tangent = (x: number) => f(a) + a * (x - a);
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label="Tangent to the curve, zoomed in">
      <path d={curvePath(a, z)} fill="none" stroke={INK} strokeWidth="2" />
      <line x1={X(a - 3, a, z)} y1={Y(tangent(a - 3), f(a), z)} x2={X(a + 3, a, z)} y2={Y(tangent(a + 3), f(a), z)} stroke={YELLOW} strokeWidth="2" />
      <circle cx={X(a, a, z)} cy={Y(f(a), f(a), z)} r="5" fill={YELLOW} />
      <text x="16" y="24" fill={INK} fontSize="13">Slope of the tangent: {a.toFixed(2)}</text>
      {zoom && <text x="16" y="190" fill={DIM} fontSize="11">Zoom ×{z.toFixed(1)}</text>}
    </svg>
  );
}

function Steps({ p, items }: { p: number; items: string[] }) {
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label={items.join(', ')}>
      {items.map((it, i) => {
        const shown = p >= i / Math.max(1, items.length);
        const y = 40 + i * (130 / Math.max(1, items.length - 1 || 1));
        return (
          <g key={it} opacity={shown ? 1 : 0.15}>
            <circle cx="34" cy={y} r="11" fill={i === items.length - 1 && p > 0.9 ? YELLOW : 'none'} stroke={YELLOW} strokeWidth="2" />
            <text x="34" y={y + 4} textAnchor="middle" fill={i === items.length - 1 && p > 0.9 ? '#10201a' : YELLOW} fontSize="11" fontWeight="700">{i + 1}</text>
            <text x="58" y={y + 5} fill={INK} fontSize="15">{it}</text>
          </g>
        );
      })}
    </svg>
  );
}

function UrlParts({ p, items }: { p: number; items: string[] }) {
  // items: scheme, prefix, domain, tld, path. The domain + tld are highlighted.
  const widths = items.map((t) => t.length * 9.2);
  const total = widths.reduce((a, b) => a + b, 0);
  let x = (320 - total) / 2;
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label={items.join('')}>
      {items.map((it, i) => {
        const key = i === 2 || i === 3;
        const el = (
          <g key={i}>
            <text x={x} y="92" fill={key && p > 0.4 ? YELLOW : INK} fontSize="16" fontWeight={key && p > 0.4 ? 700 : 400} fontFamily="monospace">{it}</text>
          </g>
        );
        x += widths[i];
        return el;
      })}
      {p > 0.4 && (() => {
        const start = (320 - total) / 2 + widths[0] + widths[1];
        const w = widths[2] + widths[3];
        return (
          <g>
            <path d={`M${start} 104 h${w}`} stroke={YELLOW} strokeWidth="3" />
            <text x={start + w / 2} y="130" textAnchor="middle" fill={YELLOW} fontSize="13">This domain counts</text>
          </g>
        );
      })()}
    </svg>
  );
}

function Falling({ p, vacuum }: { p: number; vacuum: boolean }) {
  const ball = 30 + p * 140;
  const feather = vacuum ? ball : 30 + p * 55;
  return (
    <svg viewBox="0 0 320 200" role="img" aria-label={vacuum ? 'Without air, the ball and the feather fall equally fast' : 'With air, the feather falls more slowly'}>
      <text x="16" y="20" fill={DIM} fontSize="12">{vacuum ? 'without air (vacuum)' : 'with air'}</text>
      <path d="M40 185 H280" stroke={DIM} strokeWidth="1.5" />
      <circle cx="110" cy={Math.min(ball, 174)} r="11" fill={INK} />
      <text x="110" y="198" textAnchor="middle" fill={DIM} fontSize="10">Ball</text>
      <path d={`M210 ${Math.min(feather, 174)} q 14 -10 26 -2 q -14 4 -26 2 z`} fill={YELLOW} />
      <text x="222" y="198" textAnchor="middle" fill={DIM} fontSize="10">Feather</text>
    </svg>
  );
}

function Visual({ visual, p, scene, first, items }: { visual: VideoVisual; p: number; scene: number; first: boolean; items?: string[] }) {
  switch (visual) {
    case 'steps':
      return <Steps p={p} items={items ?? []} />;
    case 'url-parts':
      return <UrlParts p={p} items={items ?? []} />;
    case 'falling':
      return <Falling p={p} vacuum={!first} key={scene} />;
    case 'next-word':
      return <NextWord p={p} chosen={!first} />;
    case 'invented-detail':
      return <InventedDetail p={first ? p : 1} />;
    case 'secant-tangent':
      return <SecantTangent p={p} moving={!first} />;
    case 'slope-zoom':
      return <SlopeZoom p={p} zoom={!first} key={scene} />;
  }
}

const NarratedVideo = lazy(() => import('./NarratedVideo.tsx'));
const PreparedVideo = lazy(() => import('./PreparedVideo.tsx'));

export function Video(props: { lesson: VideoLesson; prepareUrl?: string; onComplete: (a: Answer) => Promise<void> }) {
  const [fallback, setFallback] = useState(false);
  if (props.lesson.content.narrated && !fallback) {
    return <Suspense fallback={<p role="status">Loading the explainer video …</p>}><NarratedVideo {...props} onFallback={() => setFallback(true)} /></Suspense>;
  }
  if (props.prepareUrl && !fallback) {
    return <Suspense fallback={<p role="status">Preparing the explainer video …</p>}><PreparedVideo {...props} prepareUrl={props.prepareUrl} onFallback={() => setFallback(true)} /></Suspense>;
  }
  return <StoryboardVideo {...props} />;
}


function StoryboardVideo({ lesson, onComplete }: { lesson: VideoLesson; onComplete: (a: Answer) => Promise<void> }) {
  const { t: ui } = useI18n();
  const { scenes, questions } = lesson.content;
  const [scene, setScene] = useState(0);
  const [revision, setRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [ended, setEnded] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [asking, setAsking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const rawVideo = useRef<HTMLVideoElement>(null);
  const pending = (through: number, next = answers) => questions.findIndex((q, i) => q.afterScene <= through && next[i] === undefined);
  const go = (index: number, play = playing) => {
    setScene(index); setRevision(value => value + 1); setEnded(false); setAtEnd(false); setPlaying(play);
  };
  const onSceneEnd = () => {
    const q = pending(scene);
    const last = scene === scenes.length - 1;
    if (last) setEnded(true);
    if (asking === null && q >= 0) { setPlaying(false); setAtEnd(true); setAsking(q); return; }
    if (!last) go(scene + 1);
    else { setPlaying(false); setAtEnd(true); }
  };
  const p = useSceneProgress(playing, scenes[scene].seconds, `${scene}:${revision}`, onSceneEnd);
  const first = scenes.findIndex(s => s.visual === scenes[scene].visual) === scene;
  const rawPosition = () => {
    const video = rawVideo.current!;
    const total = scenes.reduce((sum, s) => sum + s.seconds, 0);
    let remaining = video.duration && Number.isFinite(video.duration) ? video.currentTime / video.duration * total : 0;
    let index = 0;
    while (index < scenes.length - 1 && remaining > scenes[index].seconds) remaining -= scenes[index++].seconds;
    return { index, atBoundary: remaining >= scenes[index].seconds - .05 };
  };
  const checkRaw = () => {
    const video = rawVideo.current;
    if (!video) return;
    const { index, atBoundary } = rawPosition();
    setScene(index); setAtEnd(atBoundary); setEnded(video.ended);
    const q = pending(index - (atBoundary ? 0 : 1));
    if (asking === null && q >= 0) { video.pause(); setAsking(q); }
  };
  const answer = async (option: number) => {
    if (asking === null) return;
    const next = { ...answers, [asking]: option };
    setAnswers(next);
    const q = pending(scene - (atEnd ? 0 : 1), next);
    setAsking(q >= 0 ? q : null);
    if (q >= 0) return;
    if (ended && questions.every((_, i) => next[i] !== undefined)) {
      await onComplete({ type: 'video', answers: next });
    } else if (lesson.content.videoUrl) {
      if (rawVideo.current?.paused && atEnd) await rawVideo.current.play();
    } else if (atEnd && scene + 1 < scenes.length) go(scene + 1, true);
  };

  return <div className="storyboard-video">
    <LessonProgress completed={Object.keys(answers).length} total={questions.length} label={ui("Your knowledge checks")} detail={`Abschnitt ${scene + 1} / ${scenes.length} · ${Object.keys(answers).length} / ${questions.length} Checks`} />
    <div className="video-workspace">
      <div className="video-player">
        <div className="stage storyboard-stage">
          {lesson.content.videoUrl ? <video ref={rawVideo} src={lesson.content.videoUrl} controls onTimeUpdate={checkRaw} onSeeking={checkRaw} onEnded={() => { setEnded(true); setAtEnd(true); if (asking === null) { const q = pending(scenes.length - 1); if (q >= 0) setAsking(q); } }} />
            : <Visual visual={scenes[scene].visual} p={p} scene={scene} first={first} items={scenes[scene].items} />}
        </div>
        {!lesson.content.videoUrl && <>
          <p className="storyboard-caption" aria-live="polite">{scenes[scene].caption}</p>
          <div className="video-timeline">
            <label className="sr-only" htmlFor={`scene-${lesson.id}`}>{ui("Section")}</label>
            <input id={`scene-${lesson.id}`} type="range" min={1} max={scenes.length} step={1} value={scene + 1} onChange={event => go(Number(event.target.value) - 1)} />
            <span>{scene + 1} / {scenes.length}</span>
          </div>
          <div className="video-controls" role="group" aria-label={ui("Video controls")}>
            <button className="btn primary small" onClick={() => playing ? setPlaying(false) : atEnd ? go(ended ? 0 : Math.min(scene + 1, scenes.length - 1), true) : setPlaying(true)}><ButtonLabel variants={['Play', 'Pause', 'Play again']}>{playing ? ui('Pause') : ended ? ui('Play again') : ui('Play')}</ButtonLabel></button>
            <button className="btn quiet small" onClick={() => go(scene, true)}><Icon name="back" size={17} />{ui("Repeat section")}</button>
            {!ended && <button className="btn quiet small" onClick={onSceneEnd}>{ui("Continue")}<Icon name="chevron" size={16} /></button>}
          </div>
        </>}
      </div>
      {asking !== null && <aside className="video-question-panel" aria-label={ui("Knowledge check")}><QuestionCard key={asking} prompt={questions[asking].prompt} options={questions[asking].options} index={asking} total={questions.length}
        check={(option) => ({ type: 'quiz', questionIndex: asking, option })} onContinue={answer} continueLabel={ended && Object.keys(answers).length + 1 === questions.length ? ui('Finish lesson') : ui('Continue')} /></aside>}
      {ended && asking === null && <aside className="video-question-panel video-end-card"><span className="finish-disc"><Icon name="check" size={30} /></span><h3>{ui("All sections done!")}</h3><button className="btn primary" disabled={busy || questions.some((_, i) => answers[i] === undefined)} onClick={async () => { setBusy(true); try { await onComplete({ type: 'video', answers }); } finally { setBusy(false); } }}>{ui("Finish lesson")}</button></aside>}
    </div>
  </div>;
}
