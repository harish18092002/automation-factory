import OpenAI from 'openai';
import type {
  Provider,
  ProviderMessage,
  ProviderTool,
  ProviderChatOptions,
  NormalizedResponse,
} from './types.js';
import { normalizeOpenAIResponse } from './deepseek.js';

/**
 * T3 Provider — Groq
 * Two models:
 *   llama-3.1-8b-instant    — routing / question (ultra-fast, cheap)
 *   llama-3.3-70b-versatile — research / implement (smarter, still very fast on Groq)
 */
export class GroqProvider implements Provider {
  readonly providerName = 'groq';
  private client: OpenAI;
  private model: string;

  constructor(model: 'fast' | 'smart' = 'fast') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY not set');
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    this.model = model === 'smart' ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant';
  }

  async chat(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    options: ProviderChatOptions
  ): Promise<NormalizedResponse> {
    const systemContent = options.systemBlocks.map((b) => b.text).join('\n\n');

    const fullMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemContent },
      ...(messages as OpenAI.ChatCompletionMessageParam[]),
    ];

    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0,
      messages: fullMessages,
      tools: tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      // Force JSON when no tools are provided (routing/classification)
      response_format: tools.length === 0 ? { type: 'json_object' } : undefined,
    });

    // Wrap normalizer in try/catch: json_object mode may return non-JSON on some models
    try {
      return normalizeOpenAIResponse(res, this.providerName);
    } catch (err) {
      return {
        text: res.choices[0]?.message?.content ?? '',
        toolCalls: [],
        stopReason: 'end_turn',
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        providerName: this.providerName,
      };
    }
  }
}
