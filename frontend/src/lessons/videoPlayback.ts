import type { Player, PlayerState } from '@l45/animlib';
import type { VideoQuestion } from '@l45/shared';

type Engine = Pick<Player, 'seek' | 'play' | 'pause' | 'unlockAudio' | 'subscribe' | 'getState' | 'dispose'>;
export interface PlaybackState {
  scene: number;
  time: number;
  playing: boolean;
  asking: number | null;
  answers: Record<number, number>;
  ended: boolean;
  error: string;
}

/** Checkpoints pause once; an open question never locks playback or seeking. */
export class VideoPlayback {
  private state: PlaybackState = { scene: 0, time: 0, playing: false, asking: null, answers: {}, ended: false, error: '' };
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private operations = Promise.resolve();
  private handledEnd = '';
  private disposed = false;
  private navigating = false;
  private wantsPlay = false;

  constructor(private player: Engine, readonly scenes: { id: string; duration: number }[], private questions: VideoQuestion[]) {
    this.unsubscribe = player.subscribe(state => this.accept(state));
    this.accept(player.getState());
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<PlaybackState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    this.listeners.forEach(listener => listener());
  }
  private run(operation: () => Promise<void>) {
    this.operations = this.operations.then(async () => { if (!this.disposed) await operation(); }).catch(() => {
      this.wantsPlay = false;
      this.update({ playing: false, error: 'Playback not possible. Please try again.' });
    });
    return this.operations;
  }
  private pendingThrough(scene: number, answers = this.state.answers) {
    return this.questions.reduce((first, q, i) => q.afterScene <= scene && answers[i] === undefined &&
      (first < 0 || q.afterScene < this.questions[first].afterScene) ? i : first, -1);
  }
  private get atBoundary() { return this.state.time >= this.scenes[this.state.scene].duration - 0.000001; }
  get duration() { return this.scenes.reduce((sum, s) => sum + s.duration, 0); }
  get position() { return this.scenes.slice(0, this.state.scene).reduce((sum, s) => sum + s.duration, 0) + this.state.time; }
  private accept(engine: PlayerState) {
    if (this.disposed || this.navigating) return;
    const scene = this.scenes.findIndex(s => s.id === engine.scene);
    if (scene < 0) return;
    this.update({ scene, time: engine.time, playing: engine.status === 'playing', ...(engine.error ? { error: 'Playback was interrupted. Please start it again.' } : {}) });
    if (engine.status !== 'ended') { this.handledEnd = ''; return; }
    const key = `${scene}:${Object.keys(this.state.answers).length}`;
    if (this.handledEnd === key) return;
    this.handledEnd = key;
    const q = this.pendingThrough(scene);
    const ended = scene === this.scenes.length - 1;
    if (this.state.asking === null && q >= 0) {
      this.wantsPlay = false;
      this.player.pause();
      this.update({ asking: q, ended, playing: false });
    } else if (ended) {
      this.wantsPlay = false;
      this.update({ ended: true, playing: false });
    } else if (this.wantsPlay) void this.run(() => this.go(scene + 1, 0, true));
  }
  private async go(scene: number, time: number, play: boolean) {
    this.navigating = true;
    this.player.pause();
    try {
      await this.player.seek({ scene: this.scenes[scene].id, time });
      this.handledEnd = '';
      // Preserve the question (and its mounted answer feedback) while reviewing.
      this.update({ scene, time, playing: false, ended: false, error: '' });
    } finally { this.navigating = false; }
    if (!this.disposed && play && this.wantsPlay) await this.player.play();
  }
  play() {
    if (this.disposed) return Promise.resolve();
    const unlock = this.player.unlockAudio();
    this.wantsPlay = true;
    return this.run(async () => {
      await unlock;
      this.update({ error: '' });
      if (this.state.ended) await this.go(0, 0, true);
      else if (this.atBoundary) await this.go(Math.min(this.state.scene + 1, this.scenes.length - 1), 0, true);
      else if (this.wantsPlay) await this.player.play();
    });
  }
  pause() { this.wantsPlay = false; this.player.pause(); this.update({ playing: false }); }
  answer(option: number) {
    const q = this.state.asking;
    if (q === null || !Number.isInteger(option) || option < 0 || option >= this.questions[q].options.length) return Promise.resolve();
    const answers = { ...this.state.answers, [q]: option };
    const next = this.pendingThrough(this.state.scene - (this.atBoundary ? 0 : 1), answers);
    this.update({ answers, asking: next >= 0 ? next : null });
    if (next >= 0 || this.state.ended || !this.atBoundary) return Promise.resolve();
    const nextScene = this.state.scene + 1;
    const unlock = this.player.unlockAudio();
    this.wantsPlay = true;
    return this.run(async () => { await unlock; await this.go(nextScene, 0, true); });
  }
  seek(time: number) {
    if (!Number.isFinite(time)) return Promise.resolve();
    const play = this.wantsPlay;
    return this.run(async () => {
      let remaining = Math.max(0, Math.min(time, this.duration));
      let index = 0;
      const epsilon = 0.000001;
      while (index < this.scenes.length - 1 && remaining > this.scenes[index].duration + epsilon) remaining -= this.scenes[index++].duration;
      const atEnd = remaining >= this.scenes[index].duration - epsilon;
      remaining = atEnd ? this.scenes[index].duration : remaining;
      const q = this.state.asking === null ? this.pendingThrough(index - (atEnd ? 0 : 1)) : -1;
      const ended = atEnd && index === this.scenes.length - 1;
      await this.go(index, remaining, play && q < 0 && !ended);
      if (q >= 0 || ended) {
        this.wantsPlay = false;
        this.update({ ...(q >= 0 ? { asking: q } : {}), ended, playing: false });
      }
    });
  }
  dispose() { this.disposed = true; this.wantsPlay = false; this.unsubscribe(); this.listeners.clear(); this.player.dispose(); }
}
