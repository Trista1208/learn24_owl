// The only place that talks to a language model. API keys stay on the server.
// Every call has a timeout and is logged; callers fall back to prepared content on failure.
import type { ModelCall, ModelStatus } from '@l45/shared';

type ModelPurpose = ModelCall['purpose'];
import { nowIso } from './util.ts';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  purpose: ModelPurpose;
  system: string;
  messages: ModelMessage[];
  maxTokens?: number;
  /** Overrides MODEL_TIMEOUT_MS */
  timeoutMs?: number;
  /** Use the planner model (generator calls) instead of the chat model */
  planner?: boolean;
}

export type ModelReply = { ok: true; text: string; call: ModelCall } | { ok: false; error: string; call: ModelCall };

type Provider = 'anthropic' | 'openai' | 'qwen' | 'mock' | 'none';

export function providerName(): Provider {
  const p = (process.env.MODEL_PROVIDER ?? 'none').toLowerCase();
  if (p === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (p === 'openai' && process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) return 'openai';
  if (p === 'qwen') return 'qwen';
  if (p === 'mock') return 'mock';
  return 'none';
}

export function modelStatus(simulation: boolean): ModelStatus {
  if (simulation) return 'simulation';
  return providerName() === 'none' ? 'offline' : 'online';
}

/** Global log of model calls (no content, only purpose, timing and outcome). */
export const modelLog: ModelCall[] = [];

/** Test hook: replaces the mock provider's answer. */
let mockHandler: ((req: ModelRequest) => string | Promise<string>) | null = null;
export function setMockHandler(fn: typeof mockHandler) {
  mockHandler = fn;
}

const chatModel = () => process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const plannerModel = () => process.env.ANTHROPIC_PLANNER_MODEL || 'claude-opus-5-5';
const openAIModel = (planner = false) => (planner && process.env.OPENAI_PLANNER_MODEL) || process.env.OPENAI_MODEL!;
// Explicit low effort keeps latency and reasoning costs bounded for this interactive app.
const openAIReasoning = (planner = false) => {
  const effort = (planner && process.env.OPENAI_PLANNER_REASONING_EFFORT) || process.env.OPENAI_REASONING_EFFORT || 'low';
  if (!['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('invalid OpenAI reasoning effort');
  return { effort };
};
// Qwen over an OpenAI-compatible chat completions endpoint. The default is the free OVHcloud endpoint the owl chat
// uses (no key). Ollama (http://localhost:11434/v1) and OpenRouter work the same way via QWEN_BASE_URL.
const qwenBase = () => (process.env.QWEN_BASE_URL || 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1').replace(/\/$/, '');
const qwenModel = (planner = false) => (planner && process.env.QWEN_PLANNER_MODEL) || process.env.QWEN_MODEL || 'Qwen2.5-VL-72B-Instruct';

/** Name of the model the planner and generator use, for the provenance of generated lessons. */
export function plannerModelName(): string {
  const provider = providerName();
  return provider === 'anthropic' ? plannerModel() : provider === 'openai' ? openAIModel(true) : provider === 'qwen' ? qwenModel(true) : provider;
}

/** The mock provider honours timeouts too, so tests can simulate a slow model. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function logCall(purpose: ModelPurpose, started: number, ok: boolean, error?: string): ModelCall {
  const call: ModelCall = { at: nowIso(), purpose, ok, fallback: !ok, ms: Date.now() - started };
  if (error) console.warn(`model call failed (${providerName()}, ${purpose}): ${error}`);
  modelLog.push(call);
  if (modelLog.length > 500) modelLog.shift();
  return call;
}

export async function callModel(req: ModelRequest): Promise<ModelReply> {
  const provider = providerName();
  const started = Date.now();
  const timeoutMs = req.timeoutMs ?? Number(process.env.MODEL_TIMEOUT_MS ?? 8000);
  const finish = (ok: boolean, error?: string) => logCall(req.purpose, started, ok, error);

  try {
    let text: string;
    if (provider === 'none') throw new Error('no model configured');
    if (provider === 'mock') {
      if (!mockHandler) throw new Error('mock provider without handler');
      text = await withTimeout(Promise.resolve(mockHandler(req)), timeoutMs);
    } else if (provider === 'anthropic') {
      text = await callAnthropic(req, timeoutMs);
    } else if (provider === 'qwen') {
      text = await callQwen(req, timeoutMs);
    } else {
      text = await callOpenAI(req, timeoutMs);
    }
    if (!text.trim()) throw new Error('empty reply');
    return { ok: true, text, call: finish(true) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, call: finish(false, error) };
  }
}

/**
 * Current models think before they answer, and thinking counts against max_tokens. Callers size maxTokens for the
 * visible reply, so the request adds room for a short thought; low effort keeps that thought short.
 */
const THINKING_HEADROOM = 2000;

/** Like the OpenAI errors: status and error type (e.g. invalid_request_error), never the provider's message. */
async function anthropicError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => ({})) as { error?: { type?: string } };
  const type = body.error?.type;
  return new Error(`anthropic ${res.status}${type && /^[a-z_]+$/.test(type) ? ` (${type})` : ''}`);
}

async function callAnthropic(req: ModelRequest, timeoutMs: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: req.planner ? plannerModel() : chatModel(),
      max_tokens: (req.maxTokens ?? 700) + THINKING_HEADROOM,
      output_config: { effort: 'low' },
      system: req.system,
      messages: req.messages,
    }),
  });
  if (!res.ok) throw await anthropicError(res);
  const data = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
  const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  if (!text.trim()) throw new Error(`no text in reply (stop_reason ${data.stop_reason ?? 'unknown'})`);
  return text;
}

async function callOpenAI(req: ModelRequest, timeoutMs: number): Promise<string> {
  const data = await openAIResponse({
    model: openAIModel(req.planner),
    reasoning: openAIReasoning(req.planner),
    instructions: req.system,
    input: req.messages,
    max_output_tokens: (req.maxTokens ?? 700) + 2000,
  }, timeoutMs);
  return responseText(data.output);
}

interface OpenAIOutput extends Record<string, unknown> {
  type: string;
  content?: { type: string; text?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

function responseText(output: OpenAIOutput[]): string {
  if (output.some(item => item.content?.some(c => c.type === 'refusal'))) throw new Error('refusal');
  return output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
    .filter(c => c.type === 'output_text').map(c => c.text ?? '').join('');
}

async function openAIResponse(body: Record<string, unknown>, timeoutMs: number): Promise<{ output: OpenAIOutput[] }> {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
    body: JSON.stringify({ store: false, ...body }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({})) as { error?: { code?: string } };
    const code = error.error?.code;
    // Retain a useful failure code without logging provider messages or request content.
    throw new Error(`openai ${res.status}${code && /^[a-z_]+$/.test(code) ? ` (${code})` : ''}`);
  }
  const data = (await res.json()) as { output?: OpenAIOutput[]; status?: string };
  if (data.status !== 'completed') throw new Error(`openai response ${data.status ?? 'invalid'}`);
  return { output: data.output ?? [] };
}

interface QwenToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

interface QwenChoice {
  finish_reason?: string;
  message?: { content?: string | null; refusal?: string | null; tool_calls?: QwenToolCall[] };
}

async function qwenChat(body: Record<string, unknown>, timeoutMs: number): Promise<QwenChoice & { message: NonNullable<QwenChoice['message']> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.QWEN_API_KEY) headers.authorization = `Bearer ${process.env.QWEN_API_KEY}`;
  const res = await fetch(`${qwenBase()}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers,
    body: JSON.stringify({ ...body, stream: false }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({})) as { error?: { code?: unknown; type?: unknown } };
    const code = [error.error?.code, error.error?.type].find((c): c is string => typeof c === 'string' && /^[a-z_]+$/.test(c));
    // Like the OpenAI errors: a safe code only, never the provider's message.
    throw new Error(`qwen ${res.status}${code ? ` (${code})` : ''}`);
  }
  const data = (await res.json()) as { choices?: QwenChoice[] };
  const choice = data.choices?.[0];
  if (!choice?.message) throw new Error('no message in qwen reply');
  if (choice.message.refusal) throw new Error('refusal');
  return choice as QwenChoice & { message: NonNullable<QwenChoice['message']> };
}

/** Reasoning variants of Qwen put their thought in think tags; the app only wants the answer. */
function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
}

async function callQwen(req: ModelRequest, timeoutMs: number): Promise<string> {
  const choice = await qwenChat({
    model: qwenModel(req.planner),
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    max_tokens: (req.maxTokens ?? 700) + THINKING_HEADROOM,
  }, timeoutMs);
  if (choice.finish_reason === 'length') throw new Error('qwen reply cut off');
  return withoutThinking(choice.message.content ?? '');
}

// --- Tool use for the planner agent ---------------------------------------------------------------
// Messages API with client tools. The caller runs the loop; this sends one step.

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /** Replay complete Responses output, including encrypted reasoning, within this planning run. */
  | { type: 'openai_response'; output: OpenAIOutput[] }
  /** Other blocks (thinking) are passed back unchanged */
  | { type: 'thinking' | 'redacted_thinking'; [key: string]: unknown };

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | AgentBlock[];
}

export interface AgentRequest {
  system: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  maxTokens?: number;
  timeoutMs: number;
}

export type AgentReply =
  | { ok: true; content: AgentBlock[]; stopReason: string; call: ModelCall }
  | { ok: false; error: string; call: ModelCall };

let mockAgent: ((req: AgentRequest) => AgentBlock[] | Promise<AgentBlock[]>) | null = null;
/** Test hook: scripts the planner's model. Returns the content blocks of one assistant turn. */
export function setMockAgentHandler(fn: typeof mockAgent) {
  mockAgent = fn;
}

export async function callAgent(req: AgentRequest): Promise<AgentReply> {
  const provider = providerName();
  const started = Date.now();
  try {
    let content: AgentBlock[];
    let stopReason: string;
    if (provider === 'mock') {
      if (!mockAgent) throw new Error('mock provider without agent handler');
      content = await withTimeout(Promise.resolve(mockAgent(structuredClone(req))), req.timeoutMs);
      stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    } else if (provider === 'anthropic') {
      ({ content, stopReason } = await callAnthropicTools(req));
    } else if (provider === 'openai') {
      ({ content, stopReason } = await callOpenAITools(req));
    } else if (provider === 'qwen') {
      ({ content, stopReason } = await callQwenTools(req));
    } else {
      throw new Error(`no tool use with provider ${provider}`);
    }
    if (stopReason === 'refusal') throw new Error('refusal');
    return { ok: true, content, stopReason, call: logCall('plan', started, true) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, call: logCall('plan', started, false, error) };
  }
}

async function callOpenAITools(req: AgentRequest): Promise<{ content: AgentBlock[]; stopReason: string }> {
  const input = req.messages.flatMap((message): Record<string, unknown>[] => {
    if (typeof message.content === 'string') return [{ role: message.role, content: message.content }];
    const replay = message.content.find(b => b.type === 'openai_response');
    if (replay?.type === 'openai_response') return replay.output;
    return message.content.flatMap((block): Record<string, unknown>[] => {
      if (block.type === 'tool_result') return [{ type: 'function_call_output', call_id: block.tool_use_id, output: block.content }];
      if (block.type === 'text') return [{ role: message.role, content: block.text }];
      return [];
    });
  });
  const { output } = await openAIResponse({
    model: openAIModel(true),
    reasoning: openAIReasoning(true),
    instructions: req.system,
    input,
    tools: req.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false })),
    tool_choice: 'auto',
    max_output_tokens: (req.maxTokens ?? 4000) + 2000,
  }, req.timeoutMs);
  const content: AgentBlock[] = [{ type: 'openai_response', output }];
  const text = responseText(output);
  if (text) content.push({ type: 'text', text });
  for (const item of output.filter(o => o.type === 'function_call')) {
    const args: unknown = JSON.parse(item.arguments ?? '{}');
    if (!item.call_id || !item.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid OpenAI tool call');
    content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: args as Record<string, unknown> });
  }
  return { content, stopReason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
}

async function callAnthropicTools(req: AgentRequest): Promise<{ content: AgentBlock[]; stopReason: string }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(req.timeoutMs),
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: plannerModel(),
      max_tokens: req.maxTokens ?? 4000,
      // Low effort keeps each step within the per-call limit; the rules are the safety net.
      output_config: { effort: 'low' },
      system: req.system,
      tools: req.tools,
      tool_choice: { type: 'auto' },
      messages: req.messages,
    }),
  });
  if (!res.ok) throw await anthropicError(res);
  const data = (await res.json()) as { content?: AgentBlock[]; stop_reason?: string };
  return { content: data.content ?? [], stopReason: data.stop_reason ?? 'end_turn' };
}

async function callQwenTools(req: AgentRequest): Promise<{ content: AgentBlock[]; stopReason: string }> {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const text = message.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');
    if (message.role === 'assistant') {
      const toolCalls = message.content.flatMap(b => b.type === 'tool_use'
        ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }]
        : []);
      messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      for (const block of message.content) {
        if (block.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
      }
      if (text) messages.push({ role: 'user', content: text });
    }
  }
  const choice = await qwenChat({
    model: qwenModel(true),
    messages,
    tools: req.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
    tool_choice: 'auto',
    max_tokens: (req.maxTokens ?? 4000) + THINKING_HEADROOM,
  }, req.timeoutMs);
  const content: AgentBlock[] = [];
  const text = withoutThinking(choice.message.content ?? '');
  if (text) content.push({ type: 'text', text });
  (choice.message.tool_calls ?? []).forEach((call, index) => {
    const raw = call.function?.arguments;
    const args: unknown = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
    if (!call.function?.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid Qwen tool call');
    content.push({ type: 'tool_use', id: call.id || `call-${index}`, name: call.function.name, input: args as Record<string, unknown> });
  });
  return { content, stopReason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
}
