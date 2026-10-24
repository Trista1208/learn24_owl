// Owl, the learning companion. Talks through OVHcloud's anonymous Qwen tier: no API key.
import { HttpError } from './sessions.ts';

const ENDPOINT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
// Qwen2.5 answers in message.content. Qwen3.5 thinks first, and this endpoint
// rejects the switch that would turn thinking off, so the reply comes back empty.
const MODEL = 'Qwen2.5-VL-72B-Instruct';

const MENTOR = [
  'You are the mentor. In one conversation you handle everything: the way through the website, explaining, and the next learning step.',
  'If the learner is stuck, you say which button to press.',
  'If the learner wants to learn something, you explain it simply, give a short example and ask a small question.',
  'You are calm and encouraging. You name one small next step.',
  'You do not invent menus, you change nothing yourself and you never mark a lesson as done.',
  'Answer in English only.',
].join(' ');

const LABELS = 'The app labels are: "What would you like to learn?", "Digital competence", "Mathematics", "Science", "Own topics", "What comes next?", "Recommended", "Add an area", "Let\'s go", "My account".';

export interface OwlTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface OwlAsk {
  turns: OwlTurn[];
  where: string;
}

export function owlMessages(body: unknown): OwlAsk {
  const raw = (body as { messages?: unknown; where?: unknown }) ?? {};
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) throw new HttpError(400, 'Write Owl a message.');
  const turns: OwlTurn[] = [];
  for (const item of raw.messages.slice(-10)) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: string }).role;
    const text = String((item as { text?: string }).text ?? '').trim().slice(0, 800);
    if ((role !== 'user' && role !== 'assistant') || !text) continue;
    turns.push({ role, text });
  }
  if (!turns.some((t) => t.role === 'user')) throw new HttpError(400, 'Write Owl a message.');
  return {
    turns,
    where: String(raw.where ?? '').replace(/\s+/g, ' ').trim().slice(0, 180),
  };
}

export function owlReply(payload: unknown): string {
  const message = (payload as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message;
  const text = String(message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return text;
}

export async function askOwl({ turns, where }: OwlAsk): Promise<string> {
  const system = [
    'You are Owl from AIthena. At most four short sentences.',
    LABELS,
    MENTOR,
    where ? `The learner is here right now: ${where}.` : '',
    'If you do not know something, say so.',
  ].filter(Boolean).join(' ');
  const messages = [
    { role: 'system', content: system },
    ...turns.map((t) => ({ role: t.role, content: t.text })),
  ];
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: 220,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (err) {
    console.error('owl', err);
    throw new HttpError(503, 'Owl cannot reach Qwen just now. Try again in a moment.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new HttpError(429, 'Owl needs a short moment. Ask again in a little while.');
  if (!res.ok) throw new HttpError(502, 'Qwen did not answer just now.');
  const text = owlReply(data);
  if (!text) throw new HttpError(502, 'Owl thought about it, but no answer came back. Ask again.');
  return text;
}
