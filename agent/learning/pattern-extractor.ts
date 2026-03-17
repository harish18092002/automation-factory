import OpenAI from 'openai';
import { episodicStore } from '../memory/episodic-store.js';

export interface ExtractedPattern {
  name: string;
  description: string;
  category: 'pattern' | 'workflow' | 'debug_strategy' | 'api_usage' | 'testing';
  prompt: string;           // reusable prompt fragment to inject in future sessions
  triggerKeywords: string[];
}

/**
 * Analyzes a completed session's event log and extracts reusable patterns.
 * Called automatically after successful implement sessions.
 */
export class PatternExtractor {
  async extract(sessionId: string, repoAlias: string): Promise<ExtractedPattern[]> {
    const events = await episodicStore.getSession(sessionId, repoAlias);
    if (events.length < 3) return []; // Not enough data to extract patterns

    const complete = events.find((e) => e.eventType === 'task_complete');
    if (!complete || complete.data.outcome !== 'success') return []; // Only extract from successes

    const client = getClient();
    if (!client) return [];

    // Build session transcript for analysis
    const start = events.find((e) => e.eventType === 'task_start');
    const toolCalls = events.filter((e) => e.eventType === 'tool_call');
    const filesModified = (complete.data.filesModified as string[]) ?? [];

    const transcript = [
      `Task: ${start?.data.taskDescription ?? 'unknown'}`,
      `Files modified: ${filesModified.join(', ')}`,
      `Tools used: ${toolCalls.map((e) => e.data.toolName).join(' → ')}`,
      `Outcome: ${complete.data.outcome}`,
    ].join('\n');

    const prompt = [
      'Analyze this successfully completed agent session and extract 1-3 reusable patterns.',
      '',
      'Session summary:',
      transcript,
      '',
      'Rules:',
      '1. Only extract patterns that are GENERAL and would help future sessions',
      '2. Do NOT extract patterns specific to file paths or variable names',
      '3. Focus on: architectural patterns, debugging strategies, API usage patterns, workflow patterns',
      '4. If there are no reusable patterns, return an empty array',
      '',
      'Respond with ONLY valid JSON: {"patterns": [{"name":"...","description":"...","category":"pattern","prompt":"...","triggerKeywords":["..."]}]}',
      'category must be one of: pattern, workflow, debug_strategy, api_usage, testing',
      'prompt: 1-2 sentence instruction to inject into future system prompts. Be specific but general enough to reuse.',
      'triggerKeywords: 3-5 keywords that indicate when this pattern is relevant.',
    ].join('\n');

    try {
      const { c, model } = client;
      const res = await c.chat.completions.create({
        model,
        max_tokens: 600,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a software engineering pattern analyst. Extract reusable patterns from agent sessions.' },
          { role: 'user', content: prompt },
        ],
      });

      const text = res.choices[0]?.message.content ?? '';
      const parsed = JSON.parse(text) as { patterns: ExtractedPattern[] };
      return (parsed.patterns ?? []).slice(0, 3); // Max 3 patterns per session
    } catch {
      return [];
    }
  }
}

function getClient(): { c: OpenAI; model: string } | null {
  if (process.env.DEEPSEEK_API_KEY) {
    return { c: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' }), model: 'deepseek-chat' };
  }
  if (process.env.GROQ_API_KEY) {
    return { c: new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }), model: 'llama-3.1-8b-instant' };
  }
  return null;
}

export const patternExtractor = new PatternExtractor();
