// Narrates podcast lessons: the hosts' lines from the lesson become one audio file with a time for every line.
// Built the first time a learner opens the lesson, then kept, so the same lines with the same voices are paid for once.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PodcastLesson, PodcastManifest, PodcastSpeaker, PodcastStatus } from '@l45/shared';
import type { Speaker } from '../video/build.ts';
import { AUDIO_RATE, Speech, hash, secondSpeechConfig, speechConfig, wav } from '../video/speech.ts';

export const HOSTS: Record<PodcastSpeaker, string> = { a: 'Mira', b: 'Jonas' };
const VERSION = 2;
/** Silence between two contributions, in seconds */
const PAUSE = 0.4;
export interface PodcastServiceOptions { output: string; speechCache: string; speakers?: Record<PodcastSpeaker, Speaker> }

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
async function writeAtomic(path: string, data: string | Buffer) {
  await writeFile(path + '.pending', data);
  await rename(path + '.pending', path);
}

export class PodcastService {
  private jobs = new Map<string, PodcastStatus>();
  private queue = Promise.resolve();
  private speakers: Record<PodcastSpeaker, Speaker>;
  constructor(readonly options: PodcastServiceOptions) {
    this.speakers = options.speakers ?? { a: new Speech(speechConfig(), options.speechCache), b: new Speech(secondSpeechConfig(), options.speechCache) };
  }
  private key(lesson: PodcastLesson) {
    return hash(JSON.stringify([VERSION, lesson.id, HOSTS, lesson.content.lines, this.speakers.a.config, this.speakers.b.config]));
  }
  private ready = (key: string): PodcastStatus => ({ state: 'ready', manifestUrl: `/podcasts/${key}/manifest.json` });
  async status(lesson: PodcastLesson): Promise<PodcastStatus> {
    const key = this.key(lesson);
    const m = await readJson<PodcastManifest>(join(this.options.output, key, 'manifest.json'));
    if (m?.lessonId === lesson.id) return this.ready(key);
    return this.jobs.get(key) ?? { state: 'idle' };
  }
  async prepare(lesson: PodcastLesson): Promise<PodcastStatus> {
    const existing = await this.status(lesson);
    if (existing.state !== 'idle') return existing;
    const key = this.key(lesson);
    // Another concurrent request can have scheduled this build while status read the disk.
    if (this.jobs.has(key)) return this.jobs.get(key)!;
    const initial: PodcastStatus = { state: 'building', completed: 0, total: lesson.content.lines.length };
    this.jobs.set(key, initial);
    this.queue = this.queue.then(async () => {
      try {
        await this.build(lesson, key, (completed, total) => this.jobs.set(key, { state: 'building', completed, total }));
        this.jobs.set(key, this.ready(key));
      } catch (error) {
        console.warn('Podcast could not be voiced:', error instanceof Error ? error.message : 'unknown error');
        this.jobs.set(key, { state: 'error', message: 'The voice-over isn’t possible right now. You can read the conversation here.' });
      }
    });
    return initial;
  }
  private async build(lesson: PodcastLesson, key: string, progress: (completed: number, total: number) => void) {
    const script = lesson.content.lines;
    const chunks: Buffer[] = [], lines: PodcastManifest['lines'] = [];
    let samples = 0;
    for (const [i, line] of script.entries()) {
      const pcm = await this.speakers[line.speaker].pcm(line.text);
      if (!pcm.length || pcm.length % 2) throw new Error('Invalid speech audio.');
      const start = samples / AUDIO_RATE;
      chunks.push(pcm); samples += pcm.length / 2;
      lines.push({ ...line, start, end: samples / AUDIO_RATE });
      if (i < script.length - 1) {
        const pause = Buffer.alloc(Math.round(AUDIO_RATE * PAUSE) * 2);
        chunks.push(pause); samples += pause.length / 2;
      }
      progress(i + 1, script.length);
    }
    const audio = wav(Buffer.concat(chunks));
    const name = `podcast-${hash(audio).slice(0, 12)}.wav`;
    const { a, b } = this.speakers;
    const manifest: PodcastManifest = {
      schemaVersion: 2, lessonId: lesson.id, title: lesson.title, locale: 'en-GB', hosts: HOSTS,
      narration: { provider: a.config.provider, voices: { a: a.config.voice, b: b.config.voice }, model: a.config.model },
      duration: samples / AUDIO_RATE, audioUrl: `/podcasts/${key}/${name}`, lines,
    };
    const folder = join(this.options.output, key);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, name), audio);
    await writeAtomic(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}
