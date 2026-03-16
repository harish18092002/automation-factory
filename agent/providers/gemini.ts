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
 * T2 Provider — Gemini 2.5 Flash
 * OpenAI-compatible endpoint via Google AI. Best for large codebase tasks (1M context).
 * Cost: $0.30/M input, $2.50/M output. Free tier: 1,500 req/day, 15 RPM.
 */
export class GeminiProvider implements Provider {
  readonly providerName = 'gemini';
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
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
      model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0,
      messages: fullMessages,
      tools: tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    });

    return normalizeOpenAIResponse(res, this.providerName);
  }
}
