// Generates one lesson with the model, using only the existing lesson types. The model fills content into
// the schema; the server sets ids, targets, labels and provenance, shuffles quiz answers and validates.
import { randomInt } from 'node:crypto';
import type { DccLevel, Lesson, LessonType, ModelCall, Track } from '@l45/shared';
import { DCC_LEVELS } from '@l45/shared';
import { keywordPatterns } from './agent.ts';
import { slug } from './md.ts';
import { callModel, plannerModelName } from './provider.ts';
import { sourcesOf } from './resources.ts';
import { extractJson, nowIso } from './util.ts';
import { validateLesson } from './validate.ts';

export const LESSON_TYPES: LessonType[] = ['video', 'mark-evidence', 'mock-site', 'ai-chat'];
/** Types a learner can choose for any topic. A podcast needs only criteria and sources, so it fits every track;
 *  the planner keeps to LESSON_TYPES and the track's own types, so only learners ask for podcasts. */
export const typesFor = (track: Track): LessonType[] => [...new Set([...(track.custom?.lessonTypes ?? LESSON_TYPES), 'podcast' as const])];
/** At most this many lessons per session come from the model (agent, rules and new tracks together). */
export const GENERATED_PER_SESSION = 10;

export interface GenerateInput {
  type: LessonType;
  /** A track of this learner: prepared, or their own with its own sources */
  track: Track;
  criterion: string;
  level: DccLevel;
  /** From the planner: what the example should be about, tied to the mission */
  contextHint?: string;
  /** Mixed review: further criteria of the same track to bring back */
  reviewOf?: string[];
  /** The exam on the peak of a mountain: one task per criterion, on a new example */
  exam?: boolean;
  mission: string;
  preferences: string[];
  basedOn: string[];
  sessionNo: number;
  timeoutMs: number;
  /** Validator errors of a rejected earlier draft, so a second attempt can fix them */
  previousErrors?: string[];
}

/** `rejected`: the model answered, but its lesson was not valid. Worth one more attempt with the errors. */
export type GenerateResult = { ok: true; lesson: Lesson } | { ok: false; errors: string[]; rejected?: true };

const SCHEMAS: Record<LessonType, string> = {
  video: `{"scenes":[{"caption":"One sentence that explains","visual":"steps","items":["Keyword","Keyword","Keyword"],"seconds":7}],
 "questions":[{"afterScene":0,"prompt":"Question","options":["Answer A","Answer B","Answer C"],"correct":0,"explanation":"Why","criterion":"<criterion-id>"}]}
Rules: 2 to 3 scenes. visual is always "steps" (2 to 4 keywords) or "url-parts" (items exactly: scheme, prefix, domain, ending, path, e.g. ["https://","login.","example-shop",".example","/account"]).
1 question per criterion. All answers to a question are the same length: the same number of words, at most 2 words difference. The first answer is the right one (correct: 0); the server shuffles the order.`,
  'mark-evidence': `{"noteTitle":"Title of the note","note":["Line of the source","..."],
 "summary":[{"id":"s1","text":"Sentence of the AI summary","verdict":"belegt","explanation":"The note says this."},
            {"id":"s2","text":"Sentence with a made-up claim","verdict":"erfunden","criterion":"<criterion-id>","explanation":"Why it is not supported","hint":"Question without the solution","correction":"What would be correct"}]}
Rules: note 3 to 5 lines, summary 3 to 4 sentences, 1 or 2 of them made up (verdict "erfunden"), each with criterion. verdict is always "belegt" (supported) or "erfunden" (made up).`,
  'mock-site': `{"disclaimer":"Practice example with the made-up brand “...” and addresses on .example. Everything is made up.",
 "mail":[{"id":"m-from","kind":"from","text":"Name <address@domain.example>","signal":{"criterion":"<criterion-id>","explanation":"Why suspicious"}},
         {"id":"m-p1","kind":"paragraph","text":"...","harmless":"Why harmless"},
         {"id":"m-link","kind":"link","text":"Link text","linkTarget":"https://...example/..."}],
 "site":[{"id":"w-url","kind":"url","text":"https://...example/..."},{"id":"w-fields","kind":"field","text":"Field · Field"}],
 "correctVerdict":"phishing","verdictExplanation":"..."}
kind is one of: from, subject, greeting, paragraph, link, signature, url, logo, heading, field, button, footer.
Rules: only made-up brands, only addresses on .example, no real companies. correctVerdict is "phishing" or "echt" (genuine). With "phishing" at least one part has a signal, with "echt" none. 4 to 6 parts in the mail, 3 to 5 on the site.`,
  'ai-chat': `{"kind":"tutor","goal":"What the learner can do at the end","aiRole":"Who the AI plays and how it behaves","opening":"The AI's first message",
 "material":{"title":"Made-up material","lines":["..."]},
 "criteria":[{"id":"<criterion-id>","label":"Name","hint":"Hint if it is missing"}],
 "fallbackReplies":["Reply without a model 1","2","3"],"minTurns":3}
kind is tutor (asks questions), roleplay (plays a role) or prompt-lab (carries out prompts literally). material is optional.`,
  podcast: `{"lines":[{"speaker":"a","text":"Question or transition"},{"speaker":"b","text":"Explanation with an example"}],
 "questions":[{"prompt":"Question","options":["Answer A","Answer B","Answer C"],"correct":0,"explanation":"Why","criterion":"<criterion-id>"}]}
Rules: a conversation between Mira (speaker "a", asks the questions learners ask themselves) and Jonas (speaker "b", explains with a concrete example).
Spoken language: short sentences, no lists, no brackets, no abbreviations, no addresses. Both speak to the listener as "you".
8 to 14 turns, together at most 2500 characters (about two minutes), each turn at most three sentences. End: the rule of thumb in one sentence.
Then 2 to 3 questions about what was heard. All answers to a question are the same length: the same number of words, at most 2 words difference. The first answer is the right one (correct: 0); the server shuffles the order.`,
};

const swiss = <T,>(x: T): T => JSON.parse(JSON.stringify(x).replace(/ß/g, 'ss')) as T;

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Moves the right answer to a random place, and to a different place in each question. */
export function shuffleQuiz<Q extends { options: string[]; correct: number }>(questions: Q[]): Q[] {
  const offset = randomInt(12);
  return questions.map((q, i) => {
    if (!Array.isArray(q.options) || q.options.length < 2 || !q.options[q.correct]) return q;
    const target = (offset + i) % q.options.length;
    const others = shuffle(q.options.filter((_, k) => k !== q.correct));
    others.splice(target, 0, q.options[q.correct]);
    return { ...q, options: others, correct: target };
  });
}

export async function generateLesson(input: GenerateInput, onCall: (c: ModelCall) => void): Promise<GenerateResult> {
  const { track } = input;
  const types = typesFor(track);
  if (!types.includes(input.type)) return { ok: false, errors: [`type must be one of ${types.join(', ')} in this area`] };
  if (!DCC_LEVELS.includes(input.level)) return { ok: false, errors: ['level must be Grundstufe, Mittelstufe or Fortgeschritten'] };
  const targets = [...new Set([input.criterion, ...(input.reviewOf ?? [])])];
  const unknown = targets.filter((t) => !track.criteria.some((c) => c.id === t));
  if (unknown.length) return { ok: false, errors: [`unknown criteria: ${unknown.join(', ')}`] };
  const sources = sourcesOf(track);
  if (!sources.length) return { ok: false, errors: ['There are no checked sources for this area'] };
  const review = targets.length > 1;

  const system = [
    'You write a short lesson for a learning app. Answer ONLY with JSON, with no text before or after.',
    'Rules:',
    '- Write in plain English. Address the learner as "you". Short, clear sentences.',
    '- At most 5 minutes, exactly one learning goal, one concrete success at the end.',
    '- Keep the theory light; the practice may be demanding.',
    '- The example fits the learner\'s mission. All names, companies, addresses and numbers in the example are made up.',
    '- Use only the given sources, criteria and rules of thumb. No knowledge of your own beyond them.',
    '- Choose exactly one primary source from the list (primarySourceUrl).',
  ].join('\n');
  const user = [
    `Area: ${track.name}`,
    `Lesson type: ${input.type}`,
    `Lesson level: ${input.level}`,
    input.exam
      ? 'Summit test: the learner has completed five lessons on these criteria on this mountain. Test each criterion with its own task, on a new example. Keep the recap short; the focus is on the tasks. The title starts with “Summit test:”. Criteria:'
      : review ? 'Mixed review (recall from memory), criteria:' : 'Learning goal (criterion):',
    ...targets.map((id) => {
      const c = track.criteria.find((x) => x.id === id)!;
      return `- ${c.id}: ${c.label}. Rule of thumb: ${c.ruleOfThumb}`;
    }),
    `The learner\'s mission: ${input.mission}`,
    input.contextHint ? `Hint for the example: ${input.contextHint}` : '',
    input.preferences.length ? `Preferences: ${input.preferences.join('; ')}` : '',
    'Sources:',
    ...sources.map((s) => `- ${s.title} (${s.url}): ${s.note}`),
    '',
    'Answer format:',
    '{"title":"at most 60 characters","intro":"One sentence: what the learner does","durationMin":3,"transfer":"One sentence for work","primarySourceUrl":"<url from the list>","content":<see below>}',
    'content for this lesson type:',
    SCHEMAS[input.type],
    input.previousErrors?.length ? `\nYour last draft was rejected. Fix exactly these points:\n${input.previousErrors.map((e) => `- ${e}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');

  const reply = await callModel({ purpose: 'generate', system, messages: [{ role: 'user', content: user }], maxTokens: 3000, timeoutMs: input.timeoutMs, planner: true });
  onCall(reply.call);
  if (!reply.ok) return { ok: false, errors: [`Model: ${reply.error}`] };
  const raw = extractJson<{ title?: string; intro?: string; durationMin?: number; transfer?: string; primarySourceUrl?: string; content?: Record<string, unknown> }>(reply.text);
  if (!raw?.content) {
    console.warn(`Generated lesson discarded (${track.id}, ${input.type}): the answer is not JSON with content`);
    return { ok: false, errors: ['The answer is not JSON with content'], rejected: true };
  }

  const source = sources.find((s) => s.url === raw.primarySourceUrl);
  const title = String(raw.title ?? '').trim();
  let content = swiss(raw.content) as Record<string, unknown>;
  if (input.type === 'video' && Array.isArray(content.questions)) {
    content = { scenes: content.scenes, questions: shuffleQuiz(content.questions as { options: string[]; correct: number }[]) };
  }
  if (input.type === 'podcast' && Array.isArray(content.questions)) {
    content = { lines: content.lines, questions: shuffleQuiz(content.questions as { options: string[]; correct: number }[]) };
  }
  if (input.type === 'ai-chat' && Array.isArray(content.criteria)) {
    // Keyword patterns for judging without a model come from the track, not from the model.
    content = {
      ...content,
      criteria: (content.criteria as { id: string; label?: string; hint?: string }[]).map((c) => {
        const tc = track.criteria.find((x) => x.id === c.id);
        return { id: c.id, label: c.label ?? tc?.label ?? c.id, hint: c.hint ?? tc?.ruleOfThumb ?? '', patterns: keywordPatterns(`${tc?.label ?? ''} ${tc?.ruleOfThumb ?? ''}`) };
      }),
    };
  }
  const lesson = swiss({
    id: `ki-${track.id.replace(/^t-/, '')}-${slug(title || input.criterion)}-${randomInt(1e6).toString(36)}`,
    trackId: track.id,
    type: input.type,
    level: input.level,
    title,
    intro: String(raw.intro ?? ''),
    durationMin: Number(raw.durationMin),
    mode: input.type === 'ai-chat' ? 'ai' : 'alone',
    targets,
    transfer: raw.transfer ? String(raw.transfer) : undefined,
    source: 'model',
    primarySource: source ? { title: source.title, url: source.url } : { title: 'unknown', url: String(raw.primarySourceUrl ?? '') },
    provenance: {
      by: 'model',
      model: plannerModelName(),
      at: nowIso(),
      basedOn: input.basedOn,
      sessionNo: input.sessionNo,
      ...(review ? { reviewOf: targets } : {}),
      ...(input.exam ? { exam: true as const } : {}),
    },
    content,
  }) as Lesson;

  const errors = validateLesson(lesson, { track, sourceUrls: sources.map((s) => s.url) });
  if (errors.length) {
    console.warn(`Generated lesson discarded (${track.id}, ${input.type}): ${errors.join('; ')}`);
    return { ok: false, errors, rejected: true };
  }
  return { ok: true, lesson };
}
