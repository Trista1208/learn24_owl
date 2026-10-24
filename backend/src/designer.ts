// Designs a track from what the learner wants to learn ("pass the Security+ exam") with the model:
// name, 3 to 6 criteria with rules of thumb, mission suggestions, sources and the lesson types that fit.
// The server checks the design and keeps only sources whose address answers. Without a model there are no own tracks.
import type { DccLevel, LessonType, ModelCall, Track, TrackSource } from '@l45/shared';
import { CUSTOM_SKILL } from '@l45/shared';
import { LESSON_TYPES } from './generator.ts';
import { callModel, plannerModelName } from './provider.ts';
import { extractJson, newId, nowIso } from './util.ts';

export interface DesignInput {
  topic: string;
  /** Why the learner wants it; becomes the mission */
  goal?: string;
  selfLevel: DccLevel;
  timeoutMs: number;
}

export type DesignResult = { ok: true; track: Track } | { ok: false; errors: string[] };

interface RawDesign {
  error?: string;
  name?: string;
  criteria?: { id?: string; label?: string; ruleOfThumb?: string }[];
  mission?: { suggestions?: string[]; default?: string };
  sources?: { title?: string; url?: string; note?: string }[];
  lessonTypes?: string[];
}

const SYSTEM = `In a learning app, you plan a new learning area for a topic someone wants to learn. Answer ONLY with JSON, with no text before or after.

Rules:
- Write in plain English. Short, clear sentences.
- name: short name of the area, at most 40 characters.
- criteria: 3 to 6 things you need to be able to do or recognise for the goal. Narrow, testable in an exercise, from basic to demanding. id: short, only a-z, digits and hyphen. label: at most 40 characters. ruleOfThumb: one rule of thumb in one sentence.
- mission: three suggestions in the first person ("I ... and want to ..."), plus a default for people who give none.
- sources: 2 to 5 trustworthy sources that really exist: official bodies, the organisation behind an exam, universities, standards. No blogs, no forums. Prefer a main page to a deep subpage that may not exist. Only https. note: what the source is good for.
- lessonTypes: which lesson types fit the topic. video: short explanation with quiz questions. ai-chat: conversation with an AI as tutor, role play or a prompt for the AI. mark-evidence: check an AI summary against a note. mock-site: check a made-up email or website for warning signs, only for topics like phishing or fraud.
- If the topic cannot be learned, is too vague or is harmful, answer {"error":"Reason in one sentence"}.

Format:
{"name":"...","criteria":[{"id":"...","label":"...","ruleOfThumb":"..."}],"mission":{"suggestions":["...","...","..."],"default":"..."},"sources":[{"title":"...","url":"https://...","note":"..."}],"lessonTypes":["video","ai-chat"]}`;

const LEVEL_TEXT: Record<DccLevel, string> = {
  Grundstufe: 'no or little prior knowledge',
  Mittelstufe: 'some prior knowledge',
  Fortgeschritten: 'a lot of prior knowledge',
};

const swiss = (s: unknown) => String(s ?? '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();
const fits = (s: string, min: number, max: number) => s.length >= min && s.length <= max;

/** Default check: the address answers. 404 and 410 mean the page does not exist; 401/403/429 often only block robots. */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Lernagent-Quellenpruefung/1.0' } });
    await res.body?.cancel().catch(() => {});
    return res.status < 500 && res.status !== 404 && res.status !== 410;
  } catch {
    return false;
  }
}

let checkSource: (url: string) => Promise<boolean> = answers;
/** Test hook: replaces the check whether a source address answers. null = the real check. */
export function setSourceCheck(fn: typeof checkSource | null) {
  checkSource = fn ?? answers;
}

/** Problems with a design, or the track it describes (without the sources check). */
export function checkDesign(raw: RawDesign | null, input: Pick<DesignInput, 'topic' | 'selfLevel'>): { errors: string[]; track?: Track } {
  if (!raw) return { errors: ['The answer is not JSON'] };
  if (raw.error) return { errors: [swiss(raw.error)] };
  const e: string[] = [];
  const name = swiss(raw.name);
  if (!fits(name, 3, 40)) e.push('name needs 3 to 40 characters');

  const criteria = (Array.isArray(raw.criteria) ? raw.criteria : []).map((c) => ({
    id: String(c?.id ?? '').trim().toLowerCase(),
    label: swiss(c?.label),
    ruleOfThumb: swiss(c?.ruleOfThumb),
  }));
  if (criteria.length < 3 || criteria.length > 6) e.push('3 to 6 criteria needed');
  const ids = new Set<string>();
  for (const c of criteria) {
    // 'entscheid' is the verdict of a mock-site lesson, not a criterion of a track.
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(c.id) || c.id === 'entscheid') e.push(`Criterion “${c.id}”: id only a-z, digits and hyphen, 2 to 24 characters`);
    else if (ids.has(c.id)) e.push(`Criterion “${c.id}” appears twice`);
    ids.add(c.id);
    if (!fits(c.label, 2, 60)) e.push(`Criterion “${c.id}”: label is missing or too long`);
    if (!fits(c.ruleOfThumb, 5, 240)) e.push(`Criterion “${c.id}”: rule of thumb is missing or too long`);
  }

  const suggestions = (Array.isArray(raw.mission?.suggestions) ? raw.mission.suggestions : []).map(swiss).filter((x) => fits(x, 3, 300)).slice(0, 3);
  const fallback = swiss(raw.mission?.default);

  const seen = new Set<string>();
  const sources: TrackSource[] = [];
  for (const x of Array.isArray(raw.sources) ? raw.sources : []) {
    const url = String(x?.url ?? '').trim();
    if (!/^https:\/\/[^\s/]+\.[^\s/]+(\/\S*)?$/.test(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: swiss(x?.title).slice(0, 120) || url, url, note: swiss(x?.note).slice(0, 300) });
  }
  if (!sources.length) e.push('no source with an https address');

  const lessonTypes = [...new Set((Array.isArray(raw.lessonTypes) ? raw.lessonTypes : []).filter((t): t is LessonType => (LESSON_TYPES as string[]).includes(t)))];
  if (e.length) return { errors: e };

  const track: Track = {
    id: newId('u'),
    skillId: CUSTOM_SKILL.id,
    name,
    criteria,
    mission: { suggestions, default: fits(fallback, 3, 300) ? fallback : `I want to learn “${name}”.` },
    custom: {
      topic: input.topic,
      createdAt: nowIso(),
      model: plannerModelName(),
      selfLevel: input.selfLevel,
      sources: sources.slice(0, 5),
      lessonTypes: lessonTypes.length ? lessonTypes : ['video', 'ai-chat'],
    },
  };
  return { errors: [], track };
}

export async function designTrack(input: DesignInput, onCall: (c: ModelCall) => void): Promise<DesignResult> {
  const user = [
    `Topic: ${input.topic}`,
    input.goal ? `What the learner needs it for: ${input.goal}` : '',
    `Prior knowledge (self-assessed): ${LEVEL_TEXT[input.selfLevel]}`,
  ].filter(Boolean).join('\n');
  const reply = await callModel({ purpose: 'design', system: SYSTEM, messages: [{ role: 'user', content: user }], maxTokens: 2000, timeoutMs: input.timeoutMs, planner: true });
  onCall(reply.call);
  if (!reply.ok) return { ok: false, errors: [`Model: ${reply.error}`] };
  const { errors, track } = checkDesign(extractJson<RawDesign>(reply.text), input);
  if (!track) {
    console.warn(`Area “${input.topic}” discarded: ${errors.join('; ')}`);
    return { ok: false, errors };
  }
  // Models invent addresses. Only sources that answer are kept.
  const custom = track.custom!;
  const ok = await Promise.all(custom.sources.map((s) => checkSource(s.url)));
  custom.sources = custom.sources.filter((_, i) => ok[i]);
  if (!custom.sources.length) return { ok: false, errors: ['None of the suggested sources could be reached'] };
  return { ok: true, track };
}
