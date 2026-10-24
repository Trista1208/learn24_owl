// Schema check for every lesson type. The same check runs for data/lessons/*.json at startup
// and for lessons the model generates. Returns a list of problems; empty = valid.
import type { Lesson, PodcastQuestion, Track } from '@l45/shared';
import { DCC_LEVELS } from '@l45/shared';

export const MAX_LESSON_MIN = 5;

const TYPES = ['video', 'ai-chat', 'mock-site', 'mark-evidence', 'podcast'];
const MODES = ['alone', 'ai', 'peer'];
const VISUALS = ['next-word', 'invented-detail', 'secant-tangent', 'slope-zoom', 'steps', 'falling', 'url-parts'];
/** Generated videos may only use the generic visuals; the others are hand-made animations for one topic. */
const GENERATED_VISUALS = ['steps', 'url-parts'];
const PART_KINDS = ['from', 'subject', 'greeting', 'paragraph', 'link', 'signature', 'url', 'logo', 'heading', 'field', 'button', 'footer'];
const CHAT_KINDS = ['tutor', 'roleplay', 'prompt-lab'];

/** Real brands that must never appear in a practice mail or site. Not complete; .example domains are the main guard. */
const REAL_BRANDS = [
  'postfinance', 'ubs', 'raiffeisen', 'swisscom', 'die post', 'post.ch', 'migros', 'coop', 'microsoft', 'apple', 'google', 'paypal',
  'amazon', 'netflix', 'dhl', 'sbb', 'sunrise', 'salt mobile', 'twint', 'credit suisse', 'zkb', 'kantonalbank', 'visa', 'mastercard',
  'galaxus', 'digitec', 'ricardo', 'tutti', 'facebook', 'instagram', 'whatsapp', 'linkedin', 'booking.com', 'swiss pass', 'swisspass',
  'dpd', 'ups', 'fedex', 'zalando', 'spotify', 'outlook', 'office 365', 'icloud', 'yahoo', 'bluewin',
];

export interface ValidateOpts {
  track?: Track;
  /** Allowed primary source urls; required for generated lessons */
  sourceUrls?: string[];
}

const isStr = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

/** Answers of one question may differ by this many words. More, and the right answer often gives itself away by its length. */
const MAX_WORD_GAP = 2;

/** Quiz questions of videos and podcasts: 2 to 4 answers of about equal length, the right one not always in the same place. */
function quizErrors(questions: PodcastQuestion[], knownCrit: (id: unknown) => boolean, extra?: (q: PodcastQuestion, n: string) => string[]): string[] {
  const e: string[] = [];
  questions.forEach((q, i) => {
    const n = `Question ${i + 1}`;
    if (!isStr(q?.prompt, 300)) e.push(`${n}: question is missing`);
    if (!Array.isArray(q?.options) || q.options.length < 2 || q.options.length > 4 || !q.options.every((o) => isStr(o, 120))) {
      e.push(`${n}: 2 to 4 answers needed`);
      return;
    }
    if (new Set(q.options.map((o) => o.trim().toLowerCase())).size !== q.options.length) e.push(`${n}: answers repeat`);
    const counts = q.options.map(words);
    if (Math.max(...counts) - Math.min(...counts) > MAX_WORD_GAP) e.push(`${n}: the answers may differ by at most ${MAX_WORD_GAP} words (now ${counts.join('/')})`);
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) e.push(`${n}: right answer is missing`);
    e.push(...(extra?.(q, n) ?? []));
    if (!isStr(q.explanation, 400)) e.push(`${n}: explanation is missing`);
    if (q.criterion !== undefined && !knownCrit(q.criterion)) e.push(`${n}: unknown criterion ${q.criterion}`);
  });
  const positions = questions.map((q) => q?.correct);
  if (questions.length >= 2 && new Set(positions).size === 1) e.push('The right answer is in the same place in every question');
  return e;
}

/** Host names in a text: anything like name.tld, also after an @. */
function hosts(text: string): string[] {
  return [...text.toLowerCase().matchAll(/(?:[a-z0-9-]+\.)+[a-z]{2,}(?![a-z0-9-])/g)].map((m) => m[0]);
}

export function validateLesson(input: unknown, opts: ValidateOpts = {}): string[] {
  const e: string[] = [];
  const l = input as Lesson;
  if (!l || typeof l !== 'object') return ['Lesson is not an object'];
  const track = opts.track;
  const crit = new Set(track?.criteria.map((c) => c.id) ?? []);
  const knownCrit = (id: unknown) => !track || (typeof id === 'string' && crit.has(id));
  const generated = l.source === 'model';

  if (!isStr(l.id, 120)) e.push('id is missing');
  if (!isStr(l.trackId)) e.push('trackId is missing');
  else if (track && l.trackId !== track.id) e.push(`trackId ${l.trackId} does not match the area ${track.id}`);
  if (!TYPES.includes(l.type)) e.push(`unknown type ${String(l.type)}`);
  if (!(DCC_LEVELS as string[]).includes(l.level)) e.push(`unknown level ${String(l.level)}`);
  if (!isStr(l.title, 80)) e.push('title is missing or longer than 80 characters');
  if (!isStr(l.intro, 400)) e.push('intro is missing');
  if (typeof l.durationMin !== 'number' || l.durationMin < 1 || l.durationMin > MAX_LESSON_MIN) e.push(`duration must be 1 to ${MAX_LESSON_MIN} minutes`);
  if (!MODES.includes(l.mode)) e.push(`unknown mode ${String(l.mode)}`);
  if (!Array.isArray(l.targets) || l.targets.length === 0) e.push('targets are missing');
  else for (const t of l.targets) if (!knownCrit(t)) e.push(`unknown criterion ${String(t)}`);
  if (l.source !== 'prepared' && l.source !== 'model') e.push('source must be prepared or model');

  if (generated) {
    if (!l.provenance || l.provenance.by !== 'model') e.push('provenance is missing');
    if (!l.primarySource || !isStr(l.primarySource.title) || !isStr(l.primarySource.url)) e.push('primary source is missing');
    else if (opts.sourceUrls && !opts.sourceUrls.includes(l.primarySource.url)) e.push(`primary source ${l.primarySource.url} is not among the area\'s sources`);
  }

  const c = (l as { content?: unknown }).content as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return [...e, 'content is missing'];

  switch (l.type) {
    case 'video': {
      const { scenes, questions } = l.content;
      if (!Array.isArray(scenes) || scenes.length === 0 || scenes.length > 8) e.push('video needs 1 to 8 scenes');
      else {
        scenes.forEach((s, i) => {
          if (!isStr(s?.caption, 300)) e.push(`Scene ${i + 1}: text is missing`);
          if (!VISUALS.includes(s?.visual)) e.push(`Scene ${i + 1}: unknown visual ${String(s?.visual)}`);
          else if (generated && !GENERATED_VISUALS.includes(s.visual)) e.push(`Scene ${i + 1}: generated videos only use ${GENERATED_VISUALS.join(' or ')}`);
          if ((s?.visual === 'steps' || s?.visual === 'url-parts') && (!Array.isArray(s.items) || s.items.length < 2 || s.items.length > 6 || !s.items.every((x) => isStr(x, 60)))) {
            e.push(`Scene ${i + 1}: needs 2 or more short keywords (items)`);
          }
          if (typeof s?.seconds !== 'number' || s.seconds < 2 || s.seconds > 30) e.push(`Scene ${i + 1}: duration 2 to 30 seconds`);
        });
      }
      if (!Array.isArray(questions) || questions.length === 0) e.push('video without questions');
      else {
        e.push(...quizErrors(questions, knownCrit, (q, n) => {
          const afterScene = (q as { afterScene?: unknown }).afterScene;
          return !Array.isArray(scenes) || !Number.isInteger(afterScene) || (afterScene as number) < 0 || (afterScene as number) >= scenes.length ? [`${n}: afterScene is outside the scenes`] : [];
        }));
      }
      break;
    }
    case 'podcast': {
      // Every line is paid speech: about two minutes at most, and both hosts speak.
      const { lines, questions } = l.content;
      if (!Array.isArray(lines) || lines.length < 6 || lines.length > 16) e.push('podcast needs 6 to 16 turns');
      else {
        lines.forEach((x, i) => {
          if (x?.speaker !== 'a' && x?.speaker !== 'b') e.push(`Turn ${i + 1}: speaker must be a or b`);
          if (!isStr(x?.text, 400)) e.push(`Turn ${i + 1}: text is missing or longer than 400 characters`);
        });
        if (!lines.some((x) => x?.speaker === 'a') || !lines.some((x) => x?.speaker === 'b')) e.push('both hosts speak in the podcast');
        if (lines.reduce((n, x) => n + String(x?.text ?? '').length, 0) > 3000) e.push('podcast is longer than 3000 characters');
      }
      if (!Array.isArray(questions) || questions.length === 0 || questions.length > 4) e.push('podcast needs 1 to 4 questions');
      else e.push(...quizErrors(questions, knownCrit));
      break;
    }
    case 'ai-chat': {
      const k = l.content;
      if (!CHAT_KINDS.includes(k.kind)) e.push(`unknown chat kind ${String(k.kind)}`);
      if (!isStr(k.goal, 400)) e.push('goal is missing');
      if (!isStr(k.aiRole, 2000)) e.push('AI role is missing');
      if (!isStr(k.opening, 500)) e.push('opening is missing');
      if (k.material !== undefined && (!isStr(k.material.title) || !Array.isArray(k.material.lines) || !k.material.lines.every((x) => isStr(x, 400)))) e.push('material is incomplete');
      if (!Array.isArray(k.criteria) || k.criteria.length === 0) e.push('chat without criteria');
      else {
        for (const cr of k.criteria) {
          if (!knownCrit(cr?.id)) e.push(`unknown criterion ${String(cr?.id)}`);
          if (!isStr(cr?.label) || !isStr(cr?.hint, 400)) e.push(`Criterion ${String(cr?.id)}: name or hint is missing`);
          if (!Array.isArray(cr?.patterns) || cr.patterns.length === 0) e.push(`Criterion ${String(cr?.id)}: keywords are missing`);
          else {
            for (const p of cr.patterns) {
              try {
                new RegExp(p, 'i');
              } catch {
                e.push(`Criterion ${cr.id}: invalid pattern ${p}`);
              }
            }
          }
        }
      }
      if (!Array.isArray(k.fallbackReplies) || k.fallbackReplies.length === 0 || !k.fallbackReplies.every((x) => isStr(x, 500))) e.push('prepared replies are missing');
      if (!Number.isInteger(k.minTurns) || k.minTurns < 1 || k.minTurns > 6) e.push('minTurns must be 1 to 6');
      break;
    }
    case 'mock-site': {
      const k = l.content;
      const all = [...(Array.isArray(k.mail) ? k.mail : []), ...(Array.isArray(k.site) ? k.site : [])];
      if (!isStr(k.disclaimer, 500)) e.push('the “made up” notice is missing');
      else if (generated && !/made[- ]up|invented|fictional/i.test(k.disclaimer)) e.push('the notice must say that the brand and addresses are made up');
      if (!Array.isArray(k.site) || k.site.length === 0) e.push('website is missing');
      if (k.mail !== undefined && !Array.isArray(k.mail)) e.push('mail must be a list');
      const ids = new Set<string>();
      for (const p of all) {
        if (!isStr(p?.id)) e.push('part without id');
        else if (ids.has(p.id)) e.push(`part ${p.id} appears twice`);
        else ids.add(p.id);
        if (!PART_KINDS.includes(p?.kind)) e.push(`part ${String(p?.id)}: unknown kind ${String(p?.kind)}`);
        if (!isStr(p?.text, 400)) e.push(`part ${String(p?.id)}: text is missing`);
        if (p?.signal && (!knownCrit(p.signal.criterion) || !isStr(p.signal.explanation))) e.push(`part ${p.id}: warning sign with unknown criterion ${String(p.signal.criterion)}`);
        if (p?.kind === 'link' && !isStr(p.linkTarget)) e.push(`part ${p.id}: link target is missing`);
      }
      const text = strings(k).join(' \n ');
      const real = [...new Set(hosts(text).filter((h) => !h.endsWith('.example')))];
      if (real.length) e.push(`only made-up .example addresses are allowed, found: ${real.join(', ')}`);
      const lower = text.toLowerCase();
      const brands = REAL_BRANDS.filter((b) => new RegExp(`(^|[^a-z0-9])${escapeRe(b)}([^a-z0-9]|$)`).test(lower));
      if (brands.length) e.push(`real brands are not allowed: ${brands.join(', ')}`);
      const signals = all.filter((p) => p?.signal).length;
      if (k.correctVerdict !== 'phishing' && k.correctVerdict !== 'echt') e.push('verdict must be phishing or echt');
      else if (k.correctVerdict === 'phishing' && signals === 0) e.push('verdict "phishing", but no warning sign marked');
      else if (k.correctVerdict === 'echt' && signals > 0) e.push('verdict "echt" (genuine), but warning signs marked');
      if (!isStr(k.verdictExplanation, 600)) e.push('explanation of the verdict is missing');
      break;
    }
    case 'mark-evidence': {
      const k = l.content;
      if (!isStr(k.noteTitle)) e.push('title of the note is missing');
      if (!Array.isArray(k.note) || k.note.length === 0 || !k.note.every((x) => isStr(x, 400))) e.push('note is missing');
      if (!Array.isArray(k.summary) || k.summary.length < 2) e.push('summary needs 2 or more sentences');
      else {
        const ids = new Set<string>();
        for (const s of k.summary) {
          if (!isStr(s?.id) || ids.has(s.id)) e.push(`Sentence ${String(s?.id)}: id is missing or repeats`);
          else ids.add(s.id);
          if (!isStr(s?.text, 400)) e.push(`Sentence ${String(s?.id)}: text is missing`);
          if (s?.verdict !== 'belegt' && s?.verdict !== 'erfunden') e.push(`Sentence ${String(s?.id)}: verdict must be belegt or erfunden`);
          if (!isStr(s?.explanation, 400)) e.push(`Sentence ${String(s?.id)}: explanation is missing`);
          if (s?.verdict === 'erfunden' && s.criterion !== undefined && !knownCrit(s.criterion)) e.push(`Sentence ${s.id}: unknown criterion ${s.criterion}`);
        }
        if (!k.summary.some((s) => s?.verdict === 'erfunden' && isStr(s.criterion) && knownCrit(s.criterion))) {
          e.push('at least one sentence must be "erfunden" (made up), with a criterion of the area');
        }
      }
      break;
    }
  }
  return e;
}
