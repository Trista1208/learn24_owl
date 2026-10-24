import type { NarratedVideoManifest, VideoLesson } from '@l45/shared';

/** Check the delivery envelope before handing scene source and audio to the sandboxed engine. */
export function parseVideoManifest(value: unknown, lesson: VideoLesson): NarratedVideoManifest {
  const m = value as NarratedVideoManifest;
  const invalid = () => { throw new Error('The video format is invalid.'); };
  if (!m || m.schemaVersion !== 1 || m.lessonId !== lesson.id || m.locale !== 'en-GB' ||
      !Array.isArray(m.scenes) || m.scenes.length !== lesson.content.scenes.length || !m.scenes.length) invalid();
  const ids = new Set<string>();
  for (const scene of m.scenes) {
    if (!scene || typeof scene.id !== 'string' || ids.has(scene.id) || typeof scene.title !== 'string' ||
        typeof scene.source !== 'string' || !scene.source.length || scene.source.length > 256000 ||
        !Number.isFinite(scene.duration) || scene.duration <= 0 || scene.duration > 600 ||
        typeof scene.audioUrl !== 'string' || !/^\/videos\/[\w-]+\/[\w-]+\.wav$/.test(scene.audioUrl) ||
        !Array.isArray(scene.captions) || !scene.captions.length) invalid();
    ids.add(scene.id);
    let previousEnd = 0;
    for (const cue of scene.captions) {
      if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < previousEnd ||
          cue.end <= cue.start || cue.end > scene.duration || typeof cue.text !== 'string' || !cue.text.trim()) invalid();
      previousEnd = cue.end;
    }
  }
  if (lesson.content.questions.some(q => !Number.isInteger(q.afterScene) || q.afterScene < 0 || q.afterScene >= m.scenes.length)) invalid();
  return m;
}
