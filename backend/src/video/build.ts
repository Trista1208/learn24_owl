import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compileSource, validateRenderableScene } from '@l45/animlib/core';
import type { NarratedVideoManifest, VideoLesson } from '@l45/shared';
import { AUDIO_RATE, hash, wav, type SpeechConfig } from './speech.ts';
import { VIDEO_TEMPLATE_VERSION, videoScene } from './scenes.ts';

export interface VideoPlan {
  lessonId: string; title: string; version: number;
  scenes: { caption: string; visual: string; items: string[]; narration: string[] }[];
}
export function videoPlan(lesson: VideoLesson): VideoPlan {
  if (lesson.type !== 'video' || !lesson.id || !lesson.title || !Array.isArray(lesson.content.scenes) || !lesson.content.scenes.length || lesson.content.scenes.length > 8) throw new Error('Invalid video lesson.');
  return {
    lessonId: lesson.id, title: lesson.title, version: VIDEO_TEMPLATE_VERSION,
    scenes: lesson.content.scenes.map((scene, i) => {
      if (!scene.caption?.trim() || scene.caption.length > 300 || !['steps','url-parts','next-word','invented-detail','falling','secant-tangent','slope-zoom'].includes(scene.visual) || (scene.items?.length ?? 0) > 6 || scene.items?.some(item => typeof item !== 'string' || item.length > 60)) throw new Error('Invalid video scene.');
      if ((scene.visual === 'steps' && (scene.items?.length ?? 0) < 2) || (scene.visual === 'url-parts' && scene.items?.length !== 5)) throw new Error('Labels for the video are missing.');
      const prompts = lesson.content.questions.filter(q => q.afterScene === i).map(q => q.prompt);
      return { caption: scene.caption, visual: scene.visual, items: scene.items ?? [], narration: [scene.caption, ...prompts.map(prompt => `A short pause to think: ${prompt}`)] };
    }),
  };
}
export const planHash = (lesson: VideoLesson) => hash(JSON.stringify(videoPlan(lesson)));
export interface Speaker { config: SpeechConfig; pcm(text: string): Promise<Buffer> }

export async function readManifest(path: string): Promise<NarratedVideoManifest | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as NarratedVideoManifest; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

export async function buildVideo(lesson: VideoLesson, output: string, publicBase: string, speaker: Speaker, progress = (_completed: number, _total: number) => {}): Promise<NarratedVideoManifest> {
  const plan = videoPlan(lesson);
  // Reject unsupported glyphs/layouts before making any paid speech request.
  for (const index of plan.scenes.keys()) validateRenderableScene(await compileSource(videoScene(lesson, index, 30, 20)));
  const manifest: NarratedVideoManifest = {
    schemaVersion: 1, lessonId: lesson.id, title: lesson.title, locale: 'en-GB', scriptHash: planHash(lesson),
    narration: { provider: speaker.config.provider, voice: speaker.config.voice, model: speaker.config.model }, scenes: [],
  };
  const files: { name: string; bytes: Buffer }[] = [];
  for (const [index, scene] of plan.scenes.entries()) {
    const chunks: Buffer[] = [], captions: NarratedVideoManifest['scenes'][number]['captions'] = [];
    let samples = 0;
    for (const text of scene.narration) {
      const pcm = await speaker.pcm(text);
      if (!pcm.length || pcm.length % 2) throw new Error('Invalid speech audio.');
      const start = samples / AUDIO_RATE;
      chunks.push(pcm); samples += pcm.length / 2;
      captions.push({ start, end: samples / AUDIO_RATE, text });
      const silence = Buffer.alloc(Math.round(AUDIO_RATE * .35) * 2);
      chunks.push(silence); samples += silence.length / 2;
    }
    const duration = samples / AUDIO_RATE;
    const source = videoScene(lesson, index, duration, captions[0].end);
    const compiled = await compileSource(source);
    if (Math.abs(compiled.duration - duration) > .000001) throw new Error('Animation and speech have different lengths.');
    validateRenderableScene(compiled);
    const audio = wav(Buffer.concat(chunks));
    const name = `scene-${index}-${hash(audio).slice(0, 12)}.wav`;
    files.push({ name, bytes: audio });
    manifest.scenes.push({ id: `scene-${index}`, title: scene.caption.length > 70 ? scene.caption.slice(0, 67) + '…' : scene.caption, source, duration, audioUrl: `${publicBase}/${name}`, captions });
    progress(index + 1, plan.scenes.length);
  }
  await mkdir(output, { recursive: true });
  for (const file of files) await writeFile(join(output, file.name), file.bytes);
  await writeFile(join(output, '.manifest.pending'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(join(output, '.manifest.pending'), join(output, 'manifest.json'));
  return manifest;
}
