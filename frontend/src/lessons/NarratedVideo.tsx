import { useI18n } from '../lib/i18n.tsx';
import { ButtonLabel } from '../lib/ButtonLabel.tsx';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Player } from '@l45/animlib';
import type { Answer, NarratedVideoManifest, VideoLesson } from '@l45/shared';
import { VideoPlayback, type PlaybackState } from './videoPlayback.ts';
import { parseVideoManifest } from './videoManifest.ts';
import { LessonProgress, QuestionCard } from './LessonActivity.tsx';
import { Icon } from '../lib/icons.tsx';

const initial: PlaybackState = { scene: 0, time: 0, playing: false, asking: null, answers: {}, ended: false, error: '' };
const subscribeLoading = () => () => {};
const getLoading = () => initial;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;


export default function NarratedVideo({ lesson, onComplete, onFallback }: {
  lesson: VideoLesson; onComplete: (answer: Answer) => Promise<void>; onFallback: () => void;
}) {
  const { t: ui } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const [controller, setController] = useState<VideoPlayback>();
  const [manifest, setManifest] = useState<NarratedVideoManifest>();
  const [error, setError] = useState('');
  const [captions, setCaptions] = useState(true);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const engine = useRef<Player | undefined>(undefined);
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeLoading, controller?.getState ?? getLoading);
  const questions = lesson.content.questions;
  const manifestUrl = lesson.content.narrated!.manifestUrl;

  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    let player: Player | undefined;
    let playback: VideoPlayback | undefined;
    const container = host.current!;
    void (async () => {
      const response = await fetch(manifestUrl, { signal: abort.signal });
      if (!response.ok) throw new Error('Video not reachable.');
      const next = parseVideoManifest(await response.json(), lesson);
      const { createPlayer } = await import('@l45/animlib');
      if (!active) return;
      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Animation: ${lesson.title}`);
      container.append(canvas);
      player = createPlayer({ canvas, assets: Object.fromEntries(next.scenes.map((scene, i) => [`narration-${i}`, { kind: 'audio' as const, url: scene.audioUrl }])) });
      engine.current = player;
      const loaded = await player.submit({ type: 'load', scenes: next.scenes.map(scene => ({ id: scene.id, source: scene.source })) });
      if (!loaded.ok) throw new Error(loaded.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n'));
      if (!active) return;
      playback = new VideoPlayback(player, next.scenes, questions);
      setManifest(next);
      setController(playback);
    })().catch(cause => {
      if (active) {
        console.error('Explainer video could not be loaded:', cause);
        player?.dispose();
        container.replaceChildren();
        engine.current = undefined;
        setError('The explainer video could not be loaded. You can view the lesson as a storyboard.');
      }
    });
    return () => {
      active = false; abort.abort();
      if (playback) playback.dispose(); else player?.dispose();
      engine.current = undefined;
      container.replaceChildren();
    };
  }, [manifestUrl, lesson, questions]);

  const answerQuestion = async (option: number) => {
    await controller!.answer(option);
    const next = controller!.getState();
    if (next.ended && questions.every((_, i) => next.answers[i] !== undefined)) {
      await onComplete({ type: 'video', answers: next.answers });
    } else if (next.asking === null) requestAnimationFrame(() => playButton.current?.focus({ preventScroll: true }));
  };
  const scene = manifest?.scenes[state.scene];
  const caption = scene?.captions.find(cue => state.time >= cue.start && state.time < cue.end)?.text ?? '';
  const problem = error || state.error;
  const ready = Boolean(controller && manifest);

  const completed = Object.keys(state.answers).length;
  const finish = async () => {
    setBusy(true);
    try { await onComplete({ type: 'video', answers: state.answers }); }
    finally { setBusy(false); }
  };

  return (
    <div className="narrated-video" ref={screen}>
      <LessonProgress completed={completed} total={questions.length} label={ui("Your knowledge checks")} detail={ready ? `Section ${state.scene + 1} / ${manifest!.scenes.length} · ${completed} / ${questions.length} Checks` : 'Loading the video …'} />
      <div className="video-workspace">
        <div className="video-player">
          <div className="narrated-stage" hidden={Boolean(error) && !ready}>
            <div className="narrated-canvas" ref={host} />
            {captions && caption && <p className="in-video-caption" lang="de">{caption}</p>}
          </div>
          {!ready && !problem && <p role="status">{ui("Loading the explainer video …")}</p>}
          {problem && <div className="note" role="alert"><p>{ui(problem)}</p><button className="btn secondary" onClick={onFallback}>{ui("View the storyboard")}</button></div>}
          {ready && <>
            <div className="video-timeline">
              <label className="sr-only" htmlFor={`seek-${lesson.id}`}>{ui("Video position")}</label>
              <input id={`seek-${lesson.id}`} type="range" min={0} max={controller!.duration} step="any" value={controller!.position}
                aria-valuetext={`${clock(controller!.position)} of ${clock(controller!.duration)}`} onChange={event => void controller!.seek(Number(event.target.value))} />
              <span>{clock(controller!.position)} / {clock(controller!.duration)}</span>
            </div>
            <div className="video-controls" role="group" aria-label={ui("Video controls")}>
              <button ref={playButton} className="btn primary small" onClick={() => state.playing ? controller!.pause() : void controller!.play()}><ButtonLabel variants={['Play', 'Pause', 'Play again']}>{state.playing ? ui('Pause') : state.ended ? ui('Play again') : ui('Play')}</ButtonLabel></button>
              <button className="btn quiet small" aria-label={ui("Back 10 seconds")} onClick={() => void controller!.seek(controller!.position - 10)}><Icon name="back" size={17} />{ui("10 s")}</button>
              <button className="btn quiet small" aria-label={muted ? ui('Turn sound on') : ui('Turn sound off')} aria-pressed={muted} onClick={() => { engine.current?.setMuted(!muted); setMuted(!muted); }}><Icon name="headphones" size={17} /><ButtonLabel variants={['Sound on', 'Sound off']}>{muted ? ui('Sound off') : ui('Sound on')}</ButtonLabel></button>
              <button className="btn quiet small" aria-pressed={captions} onClick={() => setCaptions(!captions)}>{ui("Subtitles")}</button>
            </div>
            <details className="video-transcript"><summary>{ui("Transcript")}</summary>
              {manifest!.scenes.map(scene => <section key={scene.id}><h3>{scene.title}</h3>{scene.captions.map((cue, i) => <p key={i}>{cue.text}</p>)}</section>)}
            </details>
          </>}
        </div>
        {state.asking !== null && <aside className="video-question-panel" aria-label={ui("Knowledge check")}>
          <QuestionCard key={state.asking} prompt={questions[state.asking].prompt} options={questions[state.asking].options} index={state.asking} total={questions.length}
            check={(option) => ({ type: 'quiz', questionIndex: state.asking!, option })}
            onContinue={answerQuestion} continueLabel={state.ended && completed + 1 === questions.length ? ui('Finish lesson') : ui('Continue')} />
        </aside>}
        {state.ended && state.asking === null && <aside className="video-question-panel video-end-card"><span className="finish-disc"><Icon name="check" size={32} /></span><h3>{ui("All sections done!")}</h3><button className="btn primary" disabled={busy} onClick={() => void finish()}><ButtonLabel variants={['Checking …', 'Finish lesson']}>{busy ? ui('Checking …') : ui('Finish lesson')}</ButtonLabel><Icon name="star" size={18} /></button></aside>}
      </div>
    </div>
  );
}
