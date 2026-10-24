import { describe, expect, it } from 'vitest';
import type { Player, PlayerState } from '@l45/animlib';
import type { VideoQuestion } from '@l45/shared';
import { VideoPlayback } from './videoPlayback.ts';

const scenes = [0, 1, 2, 3].map(i => ({ id: `scene-${i}`, duration: 10 }));
const questions: VideoQuestion[] = [
  { afterScene: 1, prompt: 'Secant?', options: ['A', 'B', 'C'], correct: 2, explanation: '', criterion: 'grenzwert' },
  { afterScene: 3, prompt: 'Derivative?', options: ['A', 'B', 'C'], correct: 1, explanation: '', criterion: 'steigung' },
];
class FakePlayer {
  state: PlayerState = { revision: 1, scene: 'scene-0', time: 0, duration: 10, status: 'paused', scenes, controls: [], orbitEnabled: false, views: [] };
  listeners = new Set<(state: PlayerState) => void>();
  disposed = false;
  getState = () => this.state;
  subscribe = (fn: (state: PlayerState) => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  emit(change: Partial<PlayerState>) { this.state = { ...this.state, ...change }; this.listeners.forEach(fn => fn(this.state)); }
  async seek(position: { scene: string; time: number }) { this.emit({ ...position, status: 'paused' }); }
  async play() { this.emit({ status: 'playing' }); }
  pause() { this.emit({ status: 'paused' }); }
  async unlockAudio() {}
  dispose() { this.disposed = true; }
  end() { this.emit({ time: 10, status: 'ended' }); }
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const setup = (qs = questions) => { const player = new FakePlayer(); return { player, playback: new VideoPlayback(player as unknown as Player, scenes, qs) }; };

describe('narrated lesson checkpoints', () => {
  it('plays through all scenes, pauses at both original questions and retains both answers', async () => {
    const { player, playback } = setup();
    await playback.play();
    player.end(); await settle();
    expect(player.state.scene).toBe('scene-1');
    expect(player.state.status).toBe('playing');
    player.end();
    expect(playback.getState().asking).toBe(0);
    expect(player.state.status).toBe('paused');
    await playback.answer(2);
    expect(player.state.scene).toBe('scene-2');
    player.end(); await settle();
    expect(player.state.scene).toBe('scene-3');
    player.end();
    expect(playback.getState().asking).toBe(1);
    expect(playback.getState().ended).toBe(true);
    await playback.answer(1);
    expect(playback.getState()).toMatchObject({ ended: true, answers: { 0: 2, 1: 1 } });
    await playback.play();
    expect(player.state.scene).toBe('scene-0');
    expect(playback.getState().asking).toBeNull();
    playback.dispose();
    expect(player.disposed).toBe(true);
  });
  it('allows rewinding and playing with a question open without replacing it', async () => {
    const { player, playback } = setup();
    await playback.seek(20);
    expect(playback.getState().asking).toBe(0);
    await playback.seek(4);
    expect(playback.position).toBe(4);
    expect(playback.getState().asking).toBe(0);
    await playback.play();
    expect(player.state.status).toBe('playing');
    player.end(); await settle();
    player.end(); await settle();
    expect(playback.getState()).toMatchObject({ scene: 2, asking: 0, playing: true });
    await playback.answer(2);
    expect(playback.getState()).toMatchObject({ scene: 2, time: 0, asking: null, playing: true, answers: { 0: 2 } });
  });
  it('keeps a rewound position when submitting an answer instead of jumping ahead', async () => {
    const { playback } = setup();
    await playback.seek(20);
    await playback.seek(3);
    await playback.answer(0);
    expect(playback.getState()).toMatchObject({ scene: 0, time: 3, asking: null, playing: false, answers: { 0: 0 } });
  });
  it('can resume forward playback at a checkpoint before answering', async () => {
    const { player, playback } = setup();
    await playback.seek(20);
    await playback.play();
    expect(playback.getState()).toMatchObject({ scene: 2, asking: 0, playing: true });
    player.end(); await settle(); player.end();
    expect(playback.getState()).toMatchObject({ scene: 3, asking: 0, ended: true });
    await playback.answer(2);
    expect(playback.getState().asking).toBe(1);
    await playback.answer(1);
    expect(playback.getState()).toMatchObject({ asking: null, ended: true, answers: { 0: 2, 1: 1 } });
  });
  it('allows seeking to the end but requires every outstanding question in order', async () => {
    const { playback } = setup();
    await playback.seek(100);
    expect(playback.position).toBe(40);
    expect(playback.getState()).toMatchObject({ scene: 3, asking: 0, ended: true });
    await playback.answer(2);
    expect(playback.getState().asking).toBe(1);
    await playback.answer(1);
    expect(playback.getState()).toMatchObject({ asking: null, ended: true, answers: { 0: 2, 1: 1 } });
  });
  it('does not mark a rewound video complete when its final answer is submitted', async () => {
    const { playback } = setup();
    await playback.seek(40);
    await playback.answer(2);
    await playback.seek(2);
    await playback.answer(1);
    expect(playback.getState()).toMatchObject({ scene: 0, time: 2, asking: null, ended: false, answers: { 0: 2, 1: 1 } });
    await playback.seek(40);
    expect(playback.getState()).toMatchObject({ ended: true, asking: null });
  });
  it('handles consecutive questions at one boundary without skipping either', async () => {
    const { playback } = setup([{ ...questions[0], afterScene: 1 }, { ...questions[1], afterScene: 1 }]);
    await playback.seek(20);
    await playback.answer(2);
    expect(playback.getState().asking).toBe(1);
    await playback.answer(1);
    expect(playback.getState()).toMatchObject({ scene: 2, asking: null, answers: { 0: 2, 1: 1 } });
  });
  it('does not skip a checkpoint when fractional audio durations round past its boundary', async () => {
    const player = new FakePlayer();
    const fractional = scenes.map((scene, i) => ({ ...scene, duration: (i + 1) / 10 }));
    const playback = new VideoPlayback(player as unknown as Player, fractional, questions);
    await playback.seek(0.1 + 0.2);
    expect(playback.getState()).toMatchObject({ scene: 1, asking: 0, time: 0.2, ended: false });
    expect(player.state.scene).toBe('scene-1');
  });
  it('preserves a user pause at a scene handoff and ignores invalid answer options', async () => {
    const { player, playback } = setup();
    await playback.play(); player.end(); playback.pause(); await settle();
    expect(player.state.status).toBe('paused');
    await playback.seek(20); await playback.answer(-1);
    expect(playback.getState().asking).toBe(0);
    expect(playback.getState().answers).toEqual({});
  });
});
