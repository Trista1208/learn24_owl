import { afterEach, expect, it, vi } from 'vitest';
import { callAgent, callModel, plannerModelName, type AgentMessage } from '../src/provider.ts';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function setup(provider = 'openai') {
  vi.stubEnv('MODEL_PROVIDER', provider);
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_MODEL', 'gpt-6-luna');
  vi.stubEnv('OPENAI_PLANNER_MODEL', 'gpt-6-sol');
  vi.stubEnv('OPENAI_REASONING_EFFORT', '');
  vi.stubEnv('OPENAI_PLANNER_REASONING_EFFORT', '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubEnv('ANTHROPIC_MODEL', 'claude-haiku-5-5');
  vi.stubEnv('ANTHROPIC_PLANNER_MODEL', 'claude-opus-5-5');
  const bodies: Record<string, any>[] = [];
  const replies: unknown[] = [];
  const fetch = vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json(replies.shift());
  });
  vi.stubGlobal('fetch', fetch);
  return { bodies, replies, fetch };
}
const text = (value: string) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] }] });
const request = { purpose: 'generate' as const, system: 'Write a lesson.', messages: [{ role: 'user' as const, content: 'Photosynthese' }], maxTokens: 3000 };
const tool = { name: 'get_learner_state', description: 'Read state', input_schema: { type: 'object', properties: { trackId: { type: 'string' } }, required: ['trackId'] } };

it('routes ordinary calls to Luna and new lessons to Sol with explicit low reasoning and bounded output', async () => {
  const { bodies, replies, fetch } = setup();
  replies.push(text('ordinary'), text('lesson'));
  expect(await callModel(request)).toMatchObject({ ok: true, text: 'ordinary' });
  expect(await callModel({ ...request, planner: true })).toMatchObject({ ok: true, text: 'lesson' });
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/responses'))).toBe(true);
  expect(bodies.map(b => b.model)).toEqual(['gpt-6-luna', 'gpt-6-sol']);
  expect(bodies.every(b => b.reasoning.effort === 'low' && b.store === false && b.max_output_tokens === 5000)).toBe(true);
  expect(plannerModelName()).toBe('gpt-6-sol');
});

it('replays Sol reasoning and tool calls exactly once, with matching tool outputs on the next step', async () => {
  const { bodies, replies } = setup();
  const output = [
    { type: 'reasoning', id: 'rs-1', encrypted_content: 'opaque', summary: [] },
    { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: tool.name, arguments: '{"trackId":"photosynthese"}' },
  ];
  replies.push({ status: 'completed', output }, text('done'));
  const messages: AgentMessage[] = [{ role: 'user', content: 'Plan next step' }];
  const first = await callAgent({ system: 'Plan', messages, tools: [tool], timeoutMs: 1000 });
  expect(first).toMatchObject({ ok: true, stopReason: 'tool_use' });
  if (!first.ok) throw new Error(first.error);
  expect(first.content).toContainEqual({ type: 'tool_use', id: 'call-1', name: tool.name, input: { trackId: 'photosynthese' } });
  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '{"state":"ready"}' }] });
  expect(await callAgent({ system: 'Plan', messages, tools: [tool], timeoutMs: 1000 })).toMatchObject({ ok: true, stopReason: 'end_turn' });
  expect(bodies[1].input).toEqual([messages[0], ...output, { type: 'function_call_output', call_id: 'call-1', output: '{"state":"ready"}' }]);
  expect(bodies[1]).toMatchObject({ model: 'gpt-6-sol', reasoning: { effort: 'low' }, tools: [{ type: 'function', name: tool.name, parameters: tool.input_schema, strict: false }] });
});

it('rejects incomplete or refused OpenAI output instead of accepting partial lessons', async () => {
  const { replies } = setup();
  replies.push({ ...text('{"partial":'), status: 'incomplete' }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] });
  expect(await callModel(request)).toMatchObject({ ok: false, error: 'openai response incomplete' });
  expect(await callModel(request)).toMatchObject({ ok: false, error: 'refusal' });
});

it('reports a safe quota error code without exposing provider messages or retrying paid calls', async () => {
  setup();
  const fetch = vi.fn(async () => Response.json({ error: { code: 'credit_balance_exhausted', message: 'private provider detail' } }, { status: 429 }));
  vi.stubGlobal('fetch', fetch);
  const result = await callModel(request);
  expect(result).toMatchObject({ ok: false, error: 'openai 429 (credit_balance_exhausted)' });
  expect(JSON.stringify(result)).not.toContain('private provider detail');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('allows separate reasoning levels while falling back to the ordinary model when no planner model is set', async () => {
  const { bodies, replies } = setup();
  vi.stubEnv('OPENAI_PLANNER_MODEL', '');
  vi.stubEnv('OPENAI_REASONING_EFFORT', 'none');
  vi.stubEnv('OPENAI_PLANNER_REASONING_EFFORT', 'medium');
  replies.push(text('ordinary'), text('lesson'));
  await callModel(request); await callModel({ ...request, planner: true });
  expect(bodies.map(b => [b.model, b.reasoning.effort])).toEqual([['gpt-6-luna', 'none'], ['gpt-6-luna', 'medium']]);
  expect(plannerModelName()).toBe('gpt-6-luna');
});

it('keeps Anthropic generation and multi-turn planner tools supported with low effort', async () => {
  const { bodies, replies, fetch } = setup('anthropic');
  const output = [{ type: 'tool_use', id: 'tu-1', name: tool.name, input: { trackId: 'photosynthese' } }];
  replies.push({ content: [{ type: 'text', text: 'lesson' }] }, { content: output, stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' });
  expect(await callModel({ ...request, planner: true })).toMatchObject({ ok: true, text: 'lesson' });
  const messages: AgentMessage[] = [{ role: 'user', content: 'Plan next' }];
  const first = await callAgent({ system: 'Plan', messages, tools: [tool], timeoutMs: 1000 });
  if (!first.ok) throw new Error(first.error);
  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ready' }] });
  expect(await callAgent({ system: 'Plan', messages, tools: [tool], timeoutMs: 1000 })).toMatchObject({ ok: true, stopReason: 'end_turn' });
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/v1/messages'))).toBe(true);
  expect(bodies.every(b => b.model === 'claude-opus-5-5' && b.output_config.effort === 'low')).toBe(true);
  expect(bodies[2].messages).toEqual(messages);
  expect(plannerModelName()).toBe('claude-opus-5-5');
});

it('gives Anthropic chat calls low effort and room to think, so a reply is never only a thought', async () => {
  const { bodies, replies } = setup('anthropic');
  const chat = { purpose: 'chat' as const, system: 'Role play', messages: [{ role: 'user' as const, content: 'Hallo' }], maxTokens: 250 };
  replies.push({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'max_tokens' }, { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Was ist passiert?' }] });
  expect(await callModel(chat)).toMatchObject({ ok: false, error: 'no text in reply (stop_reason max_tokens)' });
  expect(await callModel(chat)).toMatchObject({ ok: true, text: 'Was ist passiert?' });
  expect(bodies.every(b => b.model === 'claude-haiku-5-5' && b.output_config.effort === 'low' && b.max_tokens === 2250)).toBe(true);
});

it('reports the Anthropic error type without exposing provider messages', async () => {
  setup('anthropic');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'private provider detail' } }, { status: 400 })));
  const result = await callModel(request);
  expect(result).toMatchObject({ ok: false, error: 'anthropic 400 (invalid_request_error)' });
  expect(JSON.stringify(result)).not.toContain('private provider detail');
});

function setupQwen(env: Record<string, string> = {}) {
  vi.stubEnv('MODEL_PROVIDER', 'qwen');
  for (const key of ['QWEN_BASE_URL', 'QWEN_API_KEY', 'QWEN_MODEL', 'QWEN_PLANNER_MODEL']) vi.stubEnv(key, env[key] ?? '');
  const calls: { url: string; headers: Record<string, string>; body: Record<string, any> }[] = [];
  const replies: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return Response.json(replies.shift());
  }));
  return { calls, replies };
}
const qwenText = (content: string, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { role: 'assistant', content } }] });

it('sends Qwen calls to the free OVH endpoint without a key by default', async () => {
  const { calls, replies } = setupQwen();
  replies.push(qwenText('Hallo!'));
  expect(await callModel(request)).toMatchObject({ ok: true, text: 'Hallo!' });
  expect(calls[0].url).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions');
  expect(calls[0].headers.authorization).toBeUndefined();
  expect(calls[0].body).toMatchObject({ model: 'Qwen2.5-VL-72B-Instruct', stream: false, max_tokens: 5000, messages: [{ role: 'system', content: 'Write a lesson.' }, ...request.messages] });
  expect(plannerModelName()).toBe('Qwen2.5-VL-72B-Instruct');
});

it('works with a local Ollama Qwen and strips its thinking', async () => {
  const { calls, replies } = setupQwen({ QWEN_BASE_URL: 'http://localhost:11434/v1', QWEN_MODEL: 'qwen2.5:7b' });
  replies.push(qwenText('<think>Ich überlege.</think>\n\nDie Antwort.'));
  expect(await callModel(request)).toMatchObject({ ok: true, text: 'Die Antwort.' });
  expect(calls[0]).toMatchObject({ url: 'http://localhost:11434/v1/chat/completions', body: { model: 'qwen2.5:7b' } });
});

it('sends a bearer key to a hosted Qwen endpoint and trims its trailing slash', async () => {
  const { calls, replies } = setupQwen({ QWEN_BASE_URL: 'https://openrouter.ai/api/v1/', QWEN_API_KEY: 'test-key', QWEN_PLANNER_MODEL: 'qwen/qwen3-235b' });
  replies.push(qwenText('lesson'));
  await callModel({ ...request, planner: true });
  expect(calls[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', headers: { authorization: 'Bearer test-key' }, body: { model: 'qwen/qwen3-235b' } });
});

it('runs the planner tool loop over Qwen tool calls and tool messages', async () => {
  const { calls, replies } = setupQwen();
  replies.push(
    { choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'q-1', type: 'function', function: { name: tool.name, arguments: '{"trackId":"photosynthese"}' } }] } }] },
    qwenText('done'),
  );
  const messages: AgentMessage[] = [{ role: 'user', content: 'Plan next step' }];
  const first = await callAgent({ system: 'Plan', messages, tools: [tool], timeoutMs: 1000 });
  if (!first.ok) throw new Error(first.error);
  expect(first).toMatchObject({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'q-1', name: tool.name, input: { trackId: 'photosynthese' } }] });
  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'q-1', content: '{"state":"ready"}' }] });
  expect(await callAgent({ system: 'Plan', messages, tools: [tool], timeoutMs: 1000 })).toMatchObject({ ok: true, stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] });
  expect(calls[0].body).toMatchObject({ tool_choice: 'auto', tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }] });
  expect(calls[1].body.messages).toEqual([
    { role: 'system', content: 'Plan' },
    { role: 'user', content: 'Plan next step' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'q-1', type: 'function', function: { name: tool.name, arguments: '{"trackId":"photosynthese"}' } }] },
    { role: 'tool', tool_call_id: 'q-1', content: '{"state":"ready"}' },
  ]);
});

it('rejects cut-off Qwen replies and reports rate limits without provider messages', async () => {
  const { replies } = setupQwen();
  replies.push(qwenText('{"partial":', 'length'));
  expect(await callModel(request)).toMatchObject({ ok: false, error: 'qwen reply cut off' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'rate_limited', message: 'private provider detail' } }, { status: 429 })));
  const result = await callModel(request);
  expect(result).toMatchObject({ ok: false, error: 'qwen 429 (rate_limited)' });
  expect(JSON.stringify(result)).not.toContain('private provider detail');
});
