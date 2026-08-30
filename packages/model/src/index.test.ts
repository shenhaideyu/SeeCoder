import { describe, expect, it, vi } from 'vitest';
import { FakeModelProvider, normalizeToolProtocolMessages, OpenAICompatibleProvider, serializeModelMessages } from './index';

describe('OpenAICompatibleProvider', () => {
  it('serializes tool messages to the Chat Completions wire format', () => {
    expect(serializeModelMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
      { role: 'tool', content: '{"ok":true}', toolCallId: 'call-1', toolName: 'read_file' },
    ])).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1', name: 'read_file' },
    ]);
  });

  it('drops orphan and incomplete tool groups before sending', () => {
    expect(normalizeToolProtocolMessages([
      { role: 'tool', content: 'orphan', toolCallId: 'missing' },
      { role: 'assistant', content: '先读取文件', toolCalls: [
        { id: 'call-1', name: 'read_file', arguments: '{}' },
        { id: 'call-2', name: 'read_file', arguments: '{}' },
      ] },
      { role: 'tool', content: 'only one result', toolCallId: 'call-1' },
      { role: 'user', content: '继续' },
    ])).toEqual([
      { role: 'assistant', content: '先读取文件' },
      { role: 'user', content: '继续' },
    ]);
  });

  it('keeps a complete multi-tool group and orders results by tool call order', () => {
    const assistant = { role: 'assistant' as const, content: '', toolCalls: [
      { id: 'call-1', name: 'read_file', arguments: '{}' },
      { id: 'call-2', name: 'search_text', arguments: '{}' },
    ] };
    expect(normalizeToolProtocolMessages([
      assistant,
      { role: 'tool', content: 'second', toolCallId: 'call-2' },
      { role: 'tool', content: 'first', toolCallId: 'call-1' },
    ])).toEqual([
      assistant,
      { role: 'tool', content: 'first', toolCallId: 'call-1' },
      { role: 'tool', content: 'second', toolCallId: 'call-2' },
    ]);
  });

  it('disables DeepSeek thinking for tool requests without persisting reasoning content', async () => {
    process.env.SEECODER_TEST_KEY = 'test-key';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); },
    });
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKeyEnv: 'SEECODER_TEST_KEY', contextWindow: 1000, temperature: 0, maxOutputTokens: 100 });
    for await (const _event of provider.stream({ messages: [], tools: [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }], model: 'deepseek-chat', temperature: 0, maxOutputTokens: 100 }, new AbortController().signal)) void _event;
    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({ thinking: { type: 'disabled' } });
    vi.unstubAllGlobals();
    delete process.env.SEECODER_TEST_KEY;
  });

  it('reassembles streamed text and tool calls', async () => {
    process.env.SEECODER_TEST_KEY = 'test-key';
    const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const chunks = [
      data({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a' } }] }, finish_reason: null }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }),
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { const encoder = new TextEncoder(); chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk))); controller.close(); },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
    const provider = new OpenAICompatibleProvider({ baseUrl: 'https://example.test/v1', model: 'demo', apiKeyEnv: 'SEECODER_TEST_KEY', contextWindow: 1000, temperature: 0, maxOutputTokens: 100 });
    const events = [];
    for await (const event of provider.stream({ messages: [], tools: [], model: 'demo', temperature: 0, maxOutputTokens: 100 }, new AbortController().signal)) events.push(event);
    expect(events).toContainEqual({ type: 'textDelta', text: '你好' });
    expect(events.filter((event) => event.type === 'toolCallDelta').map((event) => event.type)).toHaveLength(2);
    expect(events).toContainEqual({ type: 'usage', inputTokens: 4, outputTokens: 3 });
    vi.unstubAllGlobals();
    delete process.env.SEECODER_TEST_KEY;
  });

  it('keeps context-summary requests isolated from the main scripted cursor', async () => {
    const provider = new FakeModelProvider([
      [{ type: 'textDelta', text: '主任务第一轮' }, { type: 'completed', finishReason: 'stop' }],
    ], [[
      { type: 'textDelta', text: '{"userIntent":"摘要","requirements":[],"activeDecisions":[],"supersededDecisions":[],"completedWork":[],"unresolvedQuestions":[],"narrative":"摘要"}' },
      { type: 'completed', finishReason: 'stop' },
    ]]);
    const summary = [];
    for await (const event of provider.stream({ purpose: 'context_summary', messages: [], tools: [], model: 'fake', temperature: 0, maxOutputTokens: 100 }, new AbortController().signal)) summary.push(event);
    const agent = [];
    for await (const event of provider.stream({ purpose: 'agent', messages: [], tools: [], model: 'fake', temperature: 0, maxOutputTokens: 100 }, new AbortController().signal)) agent.push(event);
    expect(summary).toContainEqual({ type: 'textDelta', text: expect.stringContaining('摘要') });
    expect(agent).toContainEqual({ type: 'textDelta', text: '主任务第一轮' });
  });
});
