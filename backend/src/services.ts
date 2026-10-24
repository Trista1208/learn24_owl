// Model-backed services, each with a prepared fallback. Only the lesson material and the learner's
// own messages are sent; never the name or the DCC profile.
import type { AiChatLesson, ChatTurn, CriterionResult, LessonResult, MarkEvidenceLesson, MockSiteLesson, ModelCall, Source, Track } from '@l45/shared';
import { chatResult, judgeChatKeywords, learnerText } from './judge.ts';
import { callModel } from './provider.ts';
import { extractJson } from './util.ts';

const STYLE = 'Write in plain English, address the learner as "you", at most three short sentences.';

export interface Opts {
  offline: boolean;
  onCall: (c: ModelCall) => void;
}

// --- Chat lessons ---------------------------------------------------------------------------

export async function chatReply(lesson: AiChatLesson, turns: ChatTurn[], opts: Opts): Promise<{ text: string; source: Source }> {
  const learnerTurns = turns.filter((t) => t.role === 'learner').length;
  const replies = lesson.content.fallbackReplies;
  const fallback = { text: replies[Math.min(Math.max(learnerTurns - 1, 0), replies.length - 1)], source: 'prepared' as Source };
  if (opts.offline) return fallback;

  const c = lesson.content;
  const system = [
    c.aiRole,
    `The learner's goal: ${c.goal}`,
    c.material ? `Material (made up) that the learner sees:\n${c.material.title}\n${c.material.lines.join('\n')}` : '',
    'Rules:',
    `- ${STYLE}`,
    '- Ask at most one question per reply.',
    c.kind === 'prompt-lab'
      ? '- When the learner writes a prompt: carry it out literally. Where the prompt leaves something open, fill the gap visibly with a plausible assumption and mark it with [Assumption]. Then ask what they would like to improve in the prompt.'
      : '- Never give away a finished solution. Help with questions so the learner works it out themselves.',
    `- After ${c.minTurns} replies from the learner: sum up briefly and say they can finish the lesson.`,
  ].filter(Boolean).join('\n');
  const messages = [
    { role: 'user' as const, content: '(start of conversation)' },
    { role: 'assistant' as const, content: c.opening },
    ...turns.map((t) => ({ role: t.role === 'ai' ? ('assistant' as const) : ('user' as const), content: t.text })),
  ];
  const reply = await callModel({ purpose: 'chat', system, messages, maxTokens: c.kind === 'prompt-lab' ? 600 : 250 });
  opts.onCall(reply.call);
  if (!reply.ok || reply.text.trim().length > 2000) return fallback;
  return { text: reply.text.trim(), source: 'model' };
}

export async function judgeChat(lesson: AiChatLesson, turns: ChatTurn[], opts: Opts, track?: Track): Promise<LessonResult> {
  const text = learnerText(turns);
  if (opts.offline || !text.trim()) return judgeChatKeywords(lesson, turns, track);
  const system = [
    'In a learning app, you judge what a learner wrote in a practice conversation.',
    'A criterion is only met if the learner wrote it explicitly themselves (not the AI).',
    'Give the reason for each verdict in one short sentence, in English.',
    'Answer ONLY with JSON: {"criteria":[{"id":"...","met":true,"reason":"..."}]}',
  ].join('\n');
  const user = [
    `Goal: ${lesson.content.goal}`,
    'Criteria:',
    ...lesson.content.criteria.map((c) => `- ${c.id}: ${c.label} (${c.hint})`),
    'Conversation:',
    ...turns.map((t) => `${t.role === 'ai' ? 'AI' : 'Learner'}: ${t.text}`),
  ].join('\n');
  const reply = await callModel({ purpose: 'judge', system, messages: [{ role: 'user', content: user }], maxTokens: 500 });
  opts.onCall(reply.call);
  if (!reply.ok) return judgeChatKeywords(lesson, turns, track);
  const parsed = extractJson<{ criteria?: { id: string; met: boolean; reason?: string }[] }>(reply.text);
  const byId = new Map((parsed?.criteria ?? []).map((c) => [c.id, c]));
  if (!lesson.content.criteria.every((c) => typeof byId.get(c.id)?.met === 'boolean')) return judgeChatKeywords(lesson, turns, track);
  const criteria: CriterionResult[] = lesson.content.criteria.map((c) => ({
    key: c.id,
    label: c.label,
    status: byId.get(c.id)!.met ? 'met' : 'missed',
    note: (byId.get(c.id)!.reason ?? '').slice(0, 240),
  }));
  return chatResult(lesson, criteria, 'model', track);
}

// --- Hints after a first mistake (R6) -----------------------------------------------------------

const MOCK_HINTS: Record<string, string> = {
  absender: 'Look closely at the address after the @. Does it really belong to the company?',
  druck: 'What is the subject line trying to make you feel?',
  anrede: 'How does a company you are a customer of normally address you?',
  link: 'Where does the link really go? Show the link target.',
  adresse: 'Which part of the web address comes right before the ending?',
  daten: 'Which data would a trustworthy company never ask for through a link?',
};

export async function hintMarkEvidence(lesson: MarkEvidenceLesson, marks: Record<string, string>, opts: Opts): Promise<{ text: string; source: Source }> {
  const missed = lesson.content.summary.find((s) => s.verdict === 'erfunden' && marks[s.id] !== 'erfunden');
  const wrong = lesson.content.summary.find((s) => s.verdict === 'belegt' && marks[s.id] === 'erfunden');
  if (!missed) {
    return { text: wrong ? `Read “${wrong.text}” again next to the note. Maybe it does say that after all?` : 'Your marks are correct.', source: 'prepared' };
  }
  const fallback = { text: missed.hint ?? 'Read each sentence word by word and find the place in the note.', source: 'prepared' as Source };
  if (opts.offline) return fallback;
  const reply = await callModel({
    purpose: 'hint',
    system: `You help someone check an AI summary. Ask exactly ONE short question that leads to the given sentence without revealing what is wrong. ${STYLE} Only the question.`,
    messages: [{ role: 'user', content: `Note: ${lesson.content.note.join(' ')}\nSummary: ${lesson.content.summary.map((s) => s.text).join(' ')}\nSentence: ${missed.text}` }],
    maxTokens: 100,
  });
  opts.onCall(reply.call);
  const text = reply.ok ? reply.text.trim().replace(/^["«»„“]+|["«»„“]+$/g, '') : '';
  if (!text || text.length > 240 || (missed.correction && text.includes(missed.correction))) return fallback;
  return { text, source: 'model' };
}

export function hintMockSite(lesson: MockSiteLesson, marked: string[]): { text: string; source: Source } {
  const all = [...(lesson.content.mail ?? []), ...lesson.content.site];
  const missing = all.find((p) => p.signal && !marked.includes(p.id));
  if (missing?.signal) return { text: MOCK_HINTS[missing.signal.criterion] ?? 'Look at the sender and the link target again.', source: 'prepared' };
  if (lesson.content.correctVerdict === 'echt') return { text: 'Check the sender, link target and web address: do they match the real domain? Did you ask for this yourself?', source: 'prepared' };
  return { text: 'You found all the warning signs. Now check your decision.', source: 'prepared' };
}
