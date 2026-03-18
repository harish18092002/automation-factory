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

/**
 * Sanitize tool definitions for Gemini's OpenAI-compat endpoint.
 * Strips any non-standard fields that Gemini does not support to avoid API errors.
 */
function sanitizeToolsForGemini(tools: ProviderTool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

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

    const sanitizedTools = tools.length > 0 ? sanitizeToolsForGemini(tools) : undefined;

    const res = await this.client.chat.completions.create({
      model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? 0,
      messages: fullMessages,
      tools: sanitizedTools,
      tool_choice: sanitizedTools ? 'auto' : undefined,
    });

    return normalizeOpenAIResponse(res, this.providerName);
  }
}
