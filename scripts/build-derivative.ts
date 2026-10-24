import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSource, validateRenderableScene } from '@l45/animlib/core';
import type { NarratedVideoManifest } from '@l45/shared';
import { derivativeScene } from './video/derivative-scenes.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const visualsOnly = process.argv.includes('--visuals-only');
if (existsSync(join(root, 'backend/.env'))) process.loadEnvFile(join(root, 'backend/.env'));
const provider = process.env.VIDEO_SPEECH_PROVIDER ?? 'local';
if (provider !== 'local' && provider !== 'elevenlabs') throw new Error('VIDEO_SPEECH_PROVIDER must be local or elevenlabs.');
const voice = provider === 'local' ? (process.env.VIDEO_LOCAL_VOICE ?? 'Samantha') : process.env.ELEVENLABS_VOICE_ID;
if (!visualsOnly && (!voice || (provider === 'elevenlabs' && !process.env.ELEVENLABS_API_KEY))) {
  throw new Error('Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in backend/.env before generating speech.');
}
if (!visualsOnly && provider === 'local' && process.platform !== 'darwin') throw new Error('Local speech uses macOS say. Use the bundled lesson or configure ElevenLabs.');

const rate = 24000;
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function speech(text: string, scratch: string, index: string): Promise<Buffer> {
  if (provider === 'local') {
    const input = join(scratch, `${index}.txt`), aiff = join(scratch, `${index}.aiff`), pcm = join(scratch, `${index}.pcm`);
    await writeFile(input, text);
    execFileSync('/usr/bin/say', ['-v', voice!, '-r', '155', '-f', input, '-o', aiff], { timeout: 120000, stdio: 'pipe' });
    execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-f', 's16le', '-ac', '1', '-ar', String(rate), pcm], { timeout: 120000, stdio: 'pipe' });
    return readFile(pcm);
  }
  // Do not automatically repeat a paid POST after an uncertain network outcome.
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice!)}?output_format=pcm_24000`, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL_ID ?? 'eleven_multilingual_v2', language_code: 'en' }),
  });
  if (!response.ok) throw new Error(`Speech generation failed (HTTP ${response.status}). Existing lesson assets have not been replaced.`);
  return Buffer.from(await response.arrayBuffer());
}

const rawScript = await readFile(join(root, 'data/videos/derivative.json'), 'utf8');
const script = JSON.parse(rawScript) as {
  lessonId: string; title: string; locale: 'en-GB';
  scenes: { id: string; title: string; narration: string[] }[];
};
const manifest: NarratedVideoManifest = {
  schemaVersion: 1, lessonId: script.lessonId, title: script.title, locale: script.locale,
  scriptHash: createHash('sha256').update(rawScript).digest('hex'), narration: { provider, voice: voice ?? '' }, scenes: [],
};
if (visualsOnly) {
  const path=join(root,'frontend/public/videos/math-v1/manifest.json');
  const published=JSON.parse(await readFile(path,'utf8')) as NarratedVideoManifest;
  if (published.scriptHash !== manifest.scriptHash || published.scenes.length !== script.scenes.length) {
    throw new Error('The narration script has changed. Generate new speech before updating its visuals.');
  }
  for (const [index,scene] of published.scenes.entries()) {
    scene.source=derivativeScene(index,scene.duration,scene.captions.map(cue=>cue.end));
    const compiled=await compileSource(scene.source);
    if (Math.abs(compiled.duration-scene.duration)>0.000001) throw new Error(`Scene ${scene.id}: narration and animation durations differ.`);
    validateRenderableScene(compiled);
  }
  await writeFile(path+'.pending',JSON.stringify(published,null,2)+'\n');
  await rename(path+'.pending',path);
  console.log('Updated four animation scenes; narration and captions reused without speech calls.');
  process.exit(0);
}
const scratch = await mkdtemp(join(tmpdir(), 'l45-derivative-'));
try {
  const files: { name: string; bytes: Buffer }[] = [];
  for (const [index, scene] of script.scenes.entries()) {
    const chunks: Buffer[] = [], captions: NarratedVideoManifest['scenes'][number]['captions'] = [];
    let samples = 0;
    for (const [cue, text] of scene.narration.entries()) {
      const pcm = await speech(text, scratch, `${index}-${cue}`);
      if (!pcm.length || pcm.length % 2) throw new Error('Speech returned invalid PCM audio.');
      const start = samples / rate;
      chunks.push(pcm); samples += pcm.length / 2;
      captions.push({ start, end: samples / rate, text });
      const silence = Buffer.alloc(Math.round(rate * 0.35) * 2);
      chunks.push(silence); samples += silence.length / 2;
    }
    const duration = samples / rate;
    const source = derivativeScene(index, duration, captions.map(c => c.end));
    const compiled = await compileSource(source);
    if (Math.abs(compiled.duration - duration) > 0.000001) throw new Error(`Scene ${scene.id}: narration and animation durations differ.`);
    validateRenderableScene(compiled);
    const audio = wav(Buffer.concat(chunks));
    const name = `${scene.id}-${createHash('sha256').update(audio).digest('hex').slice(0, 12)}.wav`;
    files.push({ name, bytes: audio });
    manifest.scenes.push({ id: scene.id, title: scene.title, source, duration, audioUrl: `/videos/math-v1/${name}`, captions });
    console.log(`${scene.title}: ${duration.toFixed(1)} s`);
  }
  // Publish only after every scene has synthesized, compiled and passed render preparation.
  const output = join(root, 'frontend/public/videos/math-v1');
  await mkdir(output, { recursive: true });
  for (const file of files) await writeFile(join(output, file.name), file.bytes);
  const pending = join(output, '.manifest.pending');
  await writeFile(pending, JSON.stringify(manifest, null, 2) + '\n');
  await rename(pending, join(output, 'manifest.json'));
  console.log(`Published ${manifest.scenes.length} scenes with ${provider} narration.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
