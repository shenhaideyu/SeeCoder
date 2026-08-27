import type { ContentBlock, ModelEvent, ModelMessage, ModelProvider, ModelRequest } from '@seecoder/protocol';

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  contextWindow: number;
  temperature: number;
  maxOutputTokens: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJsonLine(line: string): Record<string, unknown> | null {
  const value = line.trim();
  if (!value || value === '[DONE]' || !value.startsWith('data:')) return null;
  try {
    const parsed: unknown = JSON.parse(value.slice(5).trim());
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

type OpenAIMessage = {
  role: ModelMessage['role'];
  content: string | Array<Record<string, unknown>>;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

function serializeContent(content: ModelMessage['content']): OpenAIMessage['content'] {
  if (typeof content === 'string') return content;
  return content.map((block: ContentBlock) => block.type === 'text'
    ? { type: 'text', text: block.text }
    : { type: 'image_url', image_url: { url: block.data } });
}

/** 将内部 camelCase 消息转换为 Chat Completions 的 snake_case 消息格式。 */
export function serializeModelMessages(messages: ModelMessage[]): OpenAIMessage[] {
  return messages.map((message) => {
    const output: OpenAIMessage = { role: message.role, content: serializeContent(message.content) };
    if (message.toolCallId) output.tool_call_id = message.toolCallId;
    if (message.toolName) output.name = message.toolName;
    if (message.toolCalls?.length) output.tool_calls = message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
    return output;
  });
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly config: ModelConfig) {}

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const apiKey = process.env[this.config.apiKeyEnv];
    if (!apiKey) {
      yield { type: 'error', code: 'missing_api_key', message: `未找到环境变量 ${this.config.apiKeyEnv}`, retryable: false };
      return;
    }

    const body = {
      model: this.config.model || request.model,
      messages: serializeModelMessages(request.messages),
      tools: request.tools,
      temperature: this.config.temperature,
      max_tokens: this.config.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          const message = (await response.text()).slice(0, 1000);
          const retryable = [429, 502, 503, 504].includes(response.status);
          if (retryable && attempt < 2) {
            yield { type: 'retry', attempt: attempt + 1 };
            await sleep(250 * 2 ** attempt + Math.round(Math.random() * 100));
            continue;
          }
          yield { type: 'error', code: `http_${response.status}`, message, retryable };
          return;
        }
        if (!response.body) {
          yield { type: 'error', code: 'empty_response', message: '模型没有返回响应体', retryable: true };
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const callIds = new Map<number, string>();

        const emitChunk = (json: Record<string, unknown>): ModelEvent[] => {
          const output: ModelEvent[] = [];
          const choices = Array.isArray(json.choices) ? json.choices : [];
          const first = choices[0] as Record<string, unknown> | undefined;
          const delta = (first?.delta ?? {}) as Record<string, unknown>;
          const text = stringValue(delta.content);
          if (text) output.push({ type: 'textDelta', text });

          const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          for (const raw of toolCalls) {
            const tool = raw as Record<string, unknown>;
            const index = typeof tool.index === 'number' ? tool.index : 0;
            const fn = (tool.function ?? {}) as Record<string, unknown>;
            const id = stringValue(tool.id) ?? callIds.get(index) ?? `call-${index}`;
            callIds.set(index, id);
            const name = stringValue(fn.name);
            output.push({
              type: 'toolCallDelta',
              callId: id,
              ...(name ? { name } : {}),
              argsDelta: stringValue(fn.arguments) ?? '',
            });
          }

          const usage = (json.usage ?? null) as Record<string, unknown> | null;
          if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
            output.push({ type: 'usage', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
          }
          const finish = stringValue(first?.finish_reason);
          if (finish) output.push({ type: 'completed', finishReason: finish });
          return output;
        };

        let done = false;
        while (!done) {
          const { value, done: readerDone } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !readerDone });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim() === 'data: [DONE]') {
              done = true;
              break;
            }
            const json = parseJsonLine(line);
            if (!json) continue;
            for (const event of emitChunk(json)) yield event;
          }
          if (readerDone) done = true;
        }
        if (buffer.trim()) {
          const json = parseJsonLine(buffer);
          if (json) for (const event of emitChunk(json)) yield event;
        }
        return;
      } catch (error) {
        if (signal.aborted) {
          yield { type: 'error', code: 'cancelled', message: '模型请求已取消', retryable: false };
          return;
        }
        if (attempt < 2) {
          yield { type: 'retry', attempt: attempt + 1 };
          await sleep(250 * 2 ** attempt + Math.round(Math.random() * 100));
          continue;
        }
        yield {
          type: 'error',
          code: 'network_error',
          message: error instanceof Error ? error.message : '模型网络请求失败',
          retryable: true,
        };
        return;
      }
    }
  }
}

export class FakeModelProvider implements ModelProvider {
  private cursor = 0;

  constructor(private readonly turns: ModelEvent[][]) {}

  async *stream(_request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    void _request;
    void _signal;
    const events = this.turns[Math.min(this.cursor++, this.turns.length - 1)] ?? [
      { type: 'textDelta', text: '模拟任务已完成。' },
      { type: 'completed', finishReason: 'stop' },
    ];
    for (const event of events) {
      await Promise.resolve();
      yield event;
    }
  }
}

export function estimateTokens(messages: ModelMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    for (const block of blocks) {
      const text = block.type === 'text' ? block.text : '[image]';
      for (const char of text) tokens += char.charCodeAt(0) <= 0x7f ? 0.25 : 1;
    }
    tokens += 4;
  }
  return Math.ceil(tokens);
}
