// Rule-based judging. Every lesson type returns met/missed per criterion of its track,
// so the agent can treat all types the same way. The track is the learner's: prepared or their own.
import type {
  AiChatLesson, Answer, ChatTurn, CriterionResult, LessonResult, MarkEvidenceLesson, MockPart, MockSiteLesson,
  PartialCheck, PodcastLesson, Track, VideoLesson,
} from '@l45/shared';

const criterionLabel = (track: Track | undefined, id: string) => track?.criteria.find((c) => c.id === id)?.label ?? id;
const ruleOfThumb = (track: Track | undefined, id: string) => track?.criteria.find((c) => c.id === id)?.ruleOfThumb;

const n = (count: number, one: string, many: string) => (count === 1 ? one : many.replace('{n}', String(count)));

// --- Check an AI summary --------------------------------------------------------------

type MarkAnswer = Extract<Answer, { type: 'mark-evidence' }>;

export function partialMarkEvidence(lesson: MarkEvidenceLesson, a: MarkAnswer): PartialCheck {
  const missing = lesson.content.summary.filter((s) => s.verdict === 'erfunden' && a.marks[s.id] !== 'erfunden').length;
  const wrong = lesson.content.summary.filter((s) => s.verdict === 'belegt' && a.marks[s.id] === 'erfunden').length;
  const parts = [
    missing ? n(missing, 'One statement is not covered by the note.', '{n} statements are not covered by the note.') : '',
    wrong ? n(wrong, 'One sentence you marked as made up is in the note as written.', '{n} sentences you marked as made up are in the note as written.') : '',
  ].filter(Boolean);
  return { complete: !missing && !wrong, message: parts.join(' ') || 'Everything is correct.' };
}

export function judgeMarkEvidence(lesson: MarkEvidenceLesson, a: MarkAnswer, track?: Track): LessonResult {
  const criteria: CriterionResult[] = [];
  const items: LessonResult['items'] = [];
  let falseAlarms = 0;
  for (const s of lesson.content.summary) {
    const mark = a.marks[s.id];
    if (s.verdict === 'erfunden') {
      const ok = mark === 'erfunden';
      const key = s.criterion ?? 'quelle';
      criteria.push({ key, label: criterionLabel(track, key), status: ok ? 'met' : 'missed' });
      items.push({ label: s.text, correct: ok, text: `${ok ? 'Correctly spotted.' : 'Missed.'} ${s.explanation}${s.correction ? ` Correct would be: “${s.correction}”` : ''}` });
    } else {
      const ok = mark !== 'erfunden';
      if (!ok) falseAlarms++;
      items.push({ label: s.text, correct: ok, text: `${ok ? 'Correct: supported by the note.' : 'This sentence is supported by the note.'} ${s.explanation}` });
    }
  }
  const missed = criteria.filter((c) => c.status === 'missed').length;
  const allMet = missed === 0 && falseAlarms === 0;
  const summary = allMet
    ? 'Found every made-up statement and suspected none of the supported ones.'
    : [missed ? n(missed, 'Missed one made-up statement.', 'Missed {n} made-up statements.') : '', falseAlarms ? n(falseAlarms, 'Marked one supported statement as made up.', 'Marked {n} supported statements as made up.') : ''].filter(Boolean).join(' ');
  return { allMet, criteria, items, summary, judgedBy: 'rule' };
}

// --- Inspect a website or mail ------------------------------------------------------------

type MockAnswer = Extract<Answer, { type: 'mock-site' }>;
const parts = (l: MockSiteLesson): MockPart[] => [...(l.content.mail ?? []), ...l.content.site];

export function partialMockSite(lesson: MockSiteLesson, a: MockAnswer): PartialCheck {
  const signals = parts(lesson).filter((p) => p.signal);
  const found = signals.filter((p) => a.marked.includes(p.id)).length;
  const verdictOk = a.verdict === lesson.content.correctVerdict;
  const msg = signals.length ? `You found ${found} of ${signals.length} warning signs.` : 'Check again what is really suspicious.';
  return { complete: found === signals.length && verdictOk, message: verdictOk ? msg : `${msg} Check your decision again too.` };
}

export function judgeMockSite(lesson: MockSiteLesson, a: MockAnswer, track?: Track): LessonResult {
  const criteria: CriterionResult[] = [];
  const items: LessonResult['items'] = [];
  for (const p of parts(lesson)) {
    const marked = a.marked.includes(p.id);
    if (p.signal) {
      criteria.push({ key: p.signal.criterion, label: criterionLabel(track, p.signal.criterion), status: marked ? 'met' : 'missed' });
      items.push({ label: p.text, correct: marked, text: `${marked ? 'Found.' : 'Missed.'} ${p.signal.explanation}` });
    } else if (marked) {
      items.push({ label: p.text, correct: lesson.content.correctVerdict === 'phishing', text: `Not a strong sign. ${p.harmless ?? ''}`.trim() });
    }
  }
  const verdictOk = a.verdict === lesson.content.correctVerdict;
  criteria.push({ key: 'entscheid', label: 'Decision: phishing or genuine', status: verdictOk ? 'met' : 'missed' });
  const overFlagged = lesson.content.correctVerdict === 'echt' && a.marked.length > 1;
  const signalsMissed = criteria.filter((c) => c.status === 'missed').length - (verdictOk ? 0 : 1);
  const total = parts(lesson).filter((p) => p.signal).length;
  const verdictText = lesson.content.correctVerdict === 'phishing' ? 'phishing' : 'genuine';
  const summary = [
    verdictOk ? `Correct decision: ${verdictText}.` : `Wrong decision: the email is ${verdictText}.`,
    total ? `Found ${total - signalsMissed} of ${total} warning signs.` : overFlagged ? 'You marked several things as suspicious that are harmless here.' : '',
    lesson.content.verdictExplanation,
  ].filter(Boolean).join(' ');
  return { allMet: verdictOk && signalsMissed === 0 && !overFlagged, criteria, items, summary, judgedBy: 'rule' };
}

// --- Video and podcast: questions with one right answer ---------------------------------------

export function judgeQuiz(lesson: VideoLesson | PodcastLesson, a: { answers: Record<number, number> }, track?: Track): LessonResult {
  const criteria: CriterionResult[] = [];
  const items: LessonResult['items'] = [];
  lesson.content.questions.forEach((q, i) => {
    const ok = a.answers[i] === q.correct;
    const key = q.criterion ?? lesson.targets[0];
    criteria.push({ key, label: criterionLabel(track, key), status: ok ? 'met' : 'missed' });
    items.push({ label: q.prompt, correct: ok, text: `${ok ? 'Correct.' : `The right answer: “${q.options[q.correct]}”.`} ${q.explanation}` });
  });
  const ok = criteria.filter((c) => c.status === 'met').length;
  return { allMet: ok === criteria.length, criteria, items, summary: `${ok} of ${criteria.length} questions correct.`, judgedBy: 'rule' };
}

// --- Chat with the AI (keyword fallback; the model judge is in services.ts) ---------------------

export const learnerText = (turns: ChatTurn[]) => turns.filter((t) => t.role === 'learner').map((t) => t.text).join('\n');

export function judgeChatKeywords(lesson: AiChatLesson, turns: ChatTurn[], track?: Track): LessonResult {
  const text = learnerText(turns).toLowerCase();
  const criteria: CriterionResult[] = lesson.content.criteria.map((c) => ({
    key: c.id,
    label: c.label,
    status: c.patterns.some((p) => new RegExp(p, 'i').test(text)) ? 'met' : 'missed',
  }));
  return chatResult(lesson, criteria, 'keywords', track);
}

export function chatResult(lesson: AiChatLesson, criteria: CriterionResult[], judgedBy: LessonResult['judgedBy'], track?: Track): LessonResult {
  const items = criteria.map((c) => {
    const def = lesson.content.criteria.find((x) => x.id === c.key);
    const tip = ruleOfThumb(track, c.key);
    return {
      label: c.label,
      correct: c.status === 'met',
      text: c.status === 'met' ? `Met.${c.note ? ` ${c.note}` : ''}` : `Still missing.${c.note ? ` ${c.note}` : ''} ${def?.hint ?? ''}${tip ? ` ${tip}` : ''}`.trim(),
    };
  });
  const met = criteria.filter((c) => c.status === 'met').length;
  return {
    allMet: met === criteria.length,
    criteria,
    items,
    summary: `${met} of ${criteria.length} points met.${judgedBy === 'keywords' ? ' (Rough check by keywords, without AI.)' : ''}`,
    judgedBy,
  };
}
