import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const AUDIO_RATE = 24000;
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface SpeechConfig { provider: 'local' | 'elevenlabs'; voice: string; model: string }
export function speechConfig(): SpeechConfig {
  const provider = process.env.VIDEO_SPEECH_PROVIDER ?? (process.env.ELEVENLABS_API_KEY ? 'elevenlabs' : 'local');
  if (provider !== 'local' && provider !== 'elevenlabs') throw new Error('Unknown speech service.');
  return { provider, voice: provider === 'local' ? process.env.VIDEO_LOCAL_VOICE ?? 'Samantha' : process.env.ELEVENLABS_VOICE_ID ?? '', model: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2' };
}
/** The second podcast host: same provider, another voice. */
export function secondSpeechConfig(): SpeechConfig {
  const first = speechConfig();
  return { ...first, voice: first.provider === 'local' ? process.env.VIDEO_LOCAL_SECOND_VOICE ?? 'Daniel' : process.env.ELEVENLABS_SECOND_VOICE_ID ?? '' };
}

export function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(AUDIO_RATE, 24); header.writeUInt32LE(AUDIO_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Cache every completed cue immediately, including when a later scene fails. */
export class Speech {
  private pending = new Map<string, Promise<Buffer>>();
  constructor(readonly config: SpeechConfig, private cache: string, private retryFailed = false) {}
  pcm(text: string): Promise<Buffer> {
    const key = hash(JSON.stringify([this.config, AUDIO_RATE, 'de', text]));
    let task = this.pending.get(key);
    if (!task) {
      task = this.load(key, text); this.pending.set(key, task);
      // Disk owns completed cues; keep only concurrent requests in memory.
      void task.then(() => this.pending.delete(key), () => this.pending.delete(key));
    }
    return task;
  }
  private async load(key: string, text: string): Promise<Buffer> {
    await mkdir(this.cache, { recursive: true });
    const file = join(this.cache, key + '.pcm'), attempt = join(this.cache, key + '.attempt');
    try {
      const cached = await readFile(file);
      if (!cached.length || cached.length % 2) throw new Error('Invalid speech cache.');
      return cached;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (this.config.provider === 'elevenlabs' && (!process.env.ELEVENLABS_API_KEY || !this.config.voice)) throw new Error('ElevenLabs key or voice missing.');
    if (this.config.provider === 'local' && process.platform !== 'darwin') throw new Error('Local speech needs macOS. Please configure ElevenLabs.');
    if (this.retryFailed) await rm(attempt, { force: true });
    try { await writeFile(attempt, new Date().toISOString(), { flag: 'wx' }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('An earlier speech call is incomplete. Please regenerate it with --retry-failed.');
      throw e;
    }
    // Keep the marker on failure: an uncertain paid POST must not repeat on refresh/restart.
    const pcm = await this.synthesize(text);
    if (!pcm.length || pcm.length % 2 || pcm.length > AUDIO_RATE * 2 * 600) throw new Error('The speech service returned invalid audio.');
    await writeFile(file + '.pending', pcm);
    await rename(file + '.pending', file);
    await rm(attempt, { force: true });
    return pcm;
  }
  private async synthesize(text: string): Promise<Buffer> {
    if (this.config.provider === 'elevenlabs') {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.config.voice)}?output_format=pcm_24000`, {
        method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: this.config.model, language_code: 'en' }),
      });
      if (!response.ok) throw new Error(`Speech generation failed (HTTP ${response.status}).`);
      return Buffer.from(await response.arrayBuffer());
    }
    const scratch = await mkdtemp(join(tmpdir(), 'l45-speech-'));
    try {
      const input = join(scratch, 'text.txt'), aiff = join(scratch, 'speech.aiff'), pcm = join(scratch, 'speech.pcm');
      await writeFile(input, text);
      execFileSync('/usr/bin/say', ['-v', this.config.voice, '-r', '155', '-f', input, '-o', aiff], { timeout: 120000, stdio: 'pipe' });
      execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-f', 's16le', '-ac', '1', '-ar', String(AUDIO_RATE), pcm], { timeout: 120000, stdio: 'pipe' });
      return await readFile(pcm);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
