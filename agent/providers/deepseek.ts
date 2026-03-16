import OpenAI from 'openai';
import type {
  Provider,
  ProviderMessage,
  ProviderTool,
  ProviderChatOptions,
  NormalizedResponse,
  NormalizedToolCall,
} from './types.js';

/**
 * T1 Provider — DeepSeek V3.2
 * OpenAI-compatible API. Best cost/quality for implement + research tasks.
 * Cost: $0.28/M input, $0.42/M output. Prefix caching at $0.028/M (auto-enabled).
 */
export class DeepSeekProvider implements Provider {
  readonly providerName = 'deepseek';
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.deepseek.com',
    });
  }

  async chat(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    options: ProviderChatOptions
  ): Promise<NormalizedResponse> {
    // Build system message from blocks (DeepSeek caches prefix automatically)
    const systemContent = options.systemBlocks.map((b) => b.text).join('\n\n');

    const fullMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      ...(messages as OpenAI.ChatCompletionMessageParam[]),
    ];

    const res = await this.client.chat.completions.create({
      model: 'deepseek-chat',
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0,
      messages: fullMessages,
      tools: tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    });

    return normalizeOpenAIResponse(res, this.providerName);
  }
}

// ── Shared normaliser for all OpenAI-compatible providers ────────────────────

export function normalizeOpenAIResponse(
  res: OpenAI.ChatCompletion,
  providerName: string
): NormalizedResponse {
  // Guard: content filter / empty response — return explicit error rather than silent end_turn
  if (!res.choices || res.choices.length === 0) {
    return {
      text: '',
      toolCalls: [],
      stopReason: 'error',
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      providerName,
    };
  }

  const choice = res.choices[0];
  const msg = choice?.message;

  const text = msg?.content ?? '';

  const toolCalls: NormalizedToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: (() => {
      try {
        return JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        return { raw: tc.function.arguments };
      }
    })(),
  }));

  const stopReason = (() => {
    const reason = choice?.finish_reason;
    if (reason === 'tool_calls') return 'tool_use' as const;
    if (reason === 'length') return 'max_tokens' as const;
    return 'end_turn' as const;
  })();

  return {
    text,
    toolCalls,
    stopReason,
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    providerName,
  };
}
