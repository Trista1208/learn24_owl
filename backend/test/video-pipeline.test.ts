import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { compileSource, evaluateScene, getWorldBounds, validateRenderableScene } from '@l45/animlib/core';
import type { VideoLesson } from '@l45/shared';
import { content } from '../src/content.ts';
import { createApp } from '../src/app.ts';
import { get, save } from '../src/sessions.ts';
import { buildVideo, planHash, videoPlan, type Speaker } from '../src/video/build.ts';
import { videoScene } from '../src/video/scenes.ts';
import { Speech } from '../src/video/speech.ts';
import { VideoService } from '../src/video/service.ts';

const lessons = content.lessons.filter((lesson): lesson is VideoLesson => lesson.type === 'video');
const pcm = Buffer.alloc(24000 * 2 * 3, 1);
const config = { provider: 'elevenlabs' as const, voice: 'test-voice', model: 'test-model' };
const temp = () => mkdtemp(join(tmpdir(), 'l45-video-test-'));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('general video pipeline', () => {
  it('compiles every existing lesson visual and keeps long labels in frame', async () => {
    const seen = new Set<string>();
    for (const lesson of lessons) for (const [index, scene] of lesson.content.scenes.entries()) {
      seen.add(scene.visual);
      const compiled = await compileSource(videoScene(lesson, index, 12, 8));
      validateRenderableScene(compiled);
      expect(compiled.duration).toBeCloseTo(12, 5);
      expect(evaluateScene(compiled, 6).elements.length).toBeGreaterThan(3);
    }
    expect(seen.size).toBe(7);
    const long = structuredClone(lessons.find(l => l.id === 'inh-v1')!);
    long.title = 'Explaining changes and transitions with difficult terminology clearly';
    long.content.scenes = [{ visual: 'steps', seconds: 7, caption: 'Check the changes.', items: Array(6).fill('Check changes, larger transitions and possible follow-up questions.') }];
    const compiled = await compileSource(videoScene(long, 0, 12, 8));
    validateRenderableScene(compiled);
    const frame = evaluateScene(compiled, 12);
    for (const element of frame.elements.filter(e => e.geometry.kind === 'text')) {
      const bounds = getWorldBounds(frame, element.id, { width: 1280, height: 800 });
      if (bounds) {
        expect(bounds.min[0], element.id).toBeGreaterThan(-6.4);
        expect(bounds.max[0], element.id).toBeLessThan(6.4);
        expect(bounds.min[1], element.id).toBeGreaterThan(-4);
        expect(bounds.max[1], element.id).toBeLessThan(4);
      }
    }
  }, 20000);

  it('hashes only narrated/public material, not solutions or shuffled answers', () => {
    const lesson = structuredClone(lessons[1]);
    const before = planHash(lesson);
    lesson.content.questions.forEach(q => { q.correct = 0; q.options.reverse(); q.explanation = 'SECRET SOLUTION'; });
    expect(planHash(lesson)).toBe(before);
    expect(JSON.stringify(videoPlan(lesson))).not.toContain('SECRET SOLUTION');
    lesson.content.scenes[0].caption += ' New.';
    expect(planHash(lesson)).not.toBe(before);
  });

  it('does not replace a published manifest when a later speech cue fails', async () => {
    const folder = await temp();
    await writeFile(join(folder, 'manifest.json'), 'previous published lesson');
    let calls = 0;
    const speaker: Speaker = { config, pcm: async () => { if (++calls === 2) throw new Error('speech unavailable'); return pcm; } };
    await expect(buildVideo(lessons.find(l => l.id === 'inh-v1')!, folder, '/videos/test', speaker)).rejects.toThrow('speech unavailable');
    expect(await readFile(join(folder, 'manifest.json'), 'utf8')).toBe('previous published lesson');
  });

  it('rejects an unknown visual before paying for speech', async () => {
    const lesson = structuredClone(lessons[0]);
    (lesson.content.scenes[0] as { visual: string }).visual = 'unknown';
    const speak = vi.fn(async () => pcm);
    await expect(buildVideo(lesson, await temp(), '/videos/test', { config, pcm: speak })).rejects.toThrow();
    expect(speak).not.toHaveBeenCalled();
  });

  it('caches completed cues and never repeats uncertain paid calls after a restart', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    const folder = await temp();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(pcm)).mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(new Response(pcm));
    vi.stubGlobal('fetch', fetch);
    const first = new Speech(config, folder);
    await Promise.all([first.pcm('First passage.'), first.pcm('First passage.')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(first.pcm('Second passage.')).rejects.toThrow('connection lost');
    const restarted = new Speech(config, folder);
    await restarted.pcm('First passage.');
    await expect(restarted.pcm('Second passage.')).rejects.toThrow('--retry-failed');
    expect(fetch).toHaveBeenCalledTimes(2);
    await new Speech(config, folder, true).pcm('Second passage.');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('prepares a novel generated video once, serves its audio, persists it, and grades existing questions', async () => {
    const folder = await temp();
    const calls = vi.fn(async () => pcm);
    const options = { output: join(folder, 'videos'), published: join(folder, 'published'), speechCache: join(folder, 'speech'), speaker: { config, pcm: calls } };
    const service = new VideoService(options), app = createApp({ videoService: service });
    const login = await request(app).post('/api/login').send({ name: 'Novel-video', timeBudgetMin: 30, levels: {} }).expect(201);
    await request(app).post(`/api/sessions/${login.body.session.id}/tracks`).send({ trackIds: ['t-inhalte'] }).expect(201);
    const st = get(login.body.session.id);
    const lesson = structuredClone(lessons.find(l => l.id === 'inh-v1')!);
    lesson.id = 'ki-new-topic'; lesson.title = 'How does a new process work?'; lesson.source = 'model';
    lesson.content.scenes = lesson.content.scenes.slice(0, 2);
    lesson.content.questions[0].afterScene = 0; lesson.content.questions[1].afterScene = 1;
    st.session.generatedLessons.push(lesson);
    const base = st.session.nodes.find(n => n.lessonId === 'inh-v1')!;
    st.session.nodes.push({ ...base, id: 'novel-node', lessonId: lesson.id, label: lesson.title }); save(st);
    const url = `/api/sessions/${st.session.id}/nodes/novel-node/video`;
    const prepared = await Promise.all([request(app).post(url), request(app).post(url)]);
    expect(prepared.every(r => r.status === 202)).toBe(true);
    let manifestUrl = '';
    await vi.waitFor(async () => {
      const status = await request(app).get(url).expect(200);
      expect(status.body.state).toBe('ready'); manifestUrl = status.body.manifestUrl;
    }, { timeout: 15000, interval: 30 });
    expect(calls).toHaveBeenCalledTimes(4);
    const manifest = await request(app).get(manifestUrl).expect(200);
    expect(manifest.body.lessonId).toBe(lesson.id);
    expect(JSON.stringify(manifest.body)).not.toContain('"correct"');
    expect(manifest.body.scenes[0].captions[0].end).toBe(3);
    await request(app).get(manifest.body.scenes[0].audioUrl).expect(200).expect('content-type', /audio/);
    await request(app).get('/videos/missing/manifest.json').expect(404);
    expect((await new VideoService(options).status(lesson)).state).toBe('ready');
    expect(calls).toHaveBeenCalledTimes(4);
    const result = await request(app).post(`/api/sessions/${st.session.id}/nodes/novel-node/complete`)
      .send({ answer: { type: 'video', answers: { 0: lesson.content.questions[0].correct, 1: lesson.content.questions[1].correct } } }).expect(200);
    expect(result.body.result.allMet).toBe(true);
  }, 20000);

  it('uses a bundled manifest without a speech key or paid request', async () => {
    const folder = await temp();
    const speak = vi.fn(async () => pcm);
    const service = new VideoService({ output: folder, published: fileURLToPath(new URL('../../frontend/public/videos', import.meta.url)), speechCache: folder, speaker: { config, pcm: speak } });
    for (const lesson of lessons) {
      const status = await service.prepare(lesson);
      expect(status).toEqual({ state: 'ready', manifestUrl: `/videos/${lesson.id}/manifest.json` });
    }
    expect(speak).not.toHaveBeenCalled();
  });
});
