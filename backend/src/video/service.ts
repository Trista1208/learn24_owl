import { join } from 'node:path';
import type { VideoLesson } from '@l45/shared';
import { buildVideo, planHash, readManifest, type Speaker } from './build.ts';
import { Speech, speechConfig } from './speech.ts';

export type VideoStatus =
  | { state: 'idle' | 'building'; completed: number; total: number }
  | { state: 'ready'; manifestUrl: string }
  | { state: 'error'; message: string };
export interface VideoServiceOptions { output: string; published: string; speechCache: string; speaker?: Speaker }

/** One build per content version, queued to avoid duplicate paid calls and compilation races. */
export class VideoService {
  private jobs = new Map<string, VideoStatus>();
  private queue = Promise.resolve();
  private speaker: Speaker;
  constructor(readonly options: VideoServiceOptions) {
    this.speaker = options.speaker ?? new Speech(speechConfig(), options.speechCache);
  }
  async status(lesson: VideoLesson): Promise<VideoStatus> {
    const key = planHash(lesson);
    const declared = lesson.source === 'prepared' ? lesson.content.narrated?.manifestUrl : undefined;
    const published = declared?.match(/^\/videos\/([\w-]+)\/manifest\.json$/)?.[1] ?? (/^[\w-]+$/.test(lesson.id) ? lesson.id : undefined);
    if (published) {
      const m = await readManifest(join(this.options.published, published, 'manifest.json'));
      if (m?.lessonId === lesson.id && m.scenes.length === lesson.content.scenes.length && (declared || m.scriptHash === key)) {
        return { state: 'ready', manifestUrl: `/videos/${published}/manifest.json` };
      }
    }
    const m = await readManifest(join(this.options.output, key, 'manifest.json'));
    if (m?.scriptHash === key && m.lessonId === lesson.id) return { state: 'ready', manifestUrl: `/videos/${key}/manifest.json` };
    return this.jobs.get(key) ?? { state: 'idle', completed: 0, total: lesson.content.scenes.length };
  }
  async prepare(lesson: VideoLesson): Promise<VideoStatus> {
    const existing = await this.status(lesson);
    if (existing.state !== 'idle') return existing;
    const key = planHash(lesson);
    // Another concurrent request can have scheduled this build while status read the disk.
    if (this.jobs.has(key)) return this.jobs.get(key)!;
    const initial: VideoStatus = { state: 'building', completed: 0, total: lesson.content.scenes.length };
    this.jobs.set(key, initial);
    this.queue = this.queue.then(async () => {
      try {
        await buildVideo(lesson, join(this.options.output, key), `/videos/${key}`, this.speaker,
          (completed, total) => this.jobs.set(key, { state: 'building', completed, total }));
        this.jobs.set(key, { state: 'ready', manifestUrl: `/videos/${key}/manifest.json` });
      } catch (error) {
        console.warn('Explainer video could not be created:', error instanceof Error ? error.message : 'unknown error');
        this.jobs.set(key, { state: 'error', message: 'The voice-over isn’t possible right now. You can view the lesson as a storyboard.' });
      }
    });
    return initial;
  }
}
