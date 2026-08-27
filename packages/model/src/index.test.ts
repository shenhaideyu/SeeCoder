import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from './index';

describe('OpenAICompatibleProvider', () => {
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
});
