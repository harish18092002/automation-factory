import OpenAI from 'openai';

// Models are now managed by ProviderRouter — these constants kept for reference only
export const GROQ_MODEL = 'llama-3.1-8b-instant';

export type ExecutionMode = 'question' | 'research' | 'implement';

export interface ClassificationResult {
  executionMode: ExecutionMode;
  repos: string[];
  primaryRepo: string | null;
  needsWebSearch: boolean;
  isRegistration: boolean;
  registrationAlias?: string;
  registrationPath?: string;
}

// Lazy Groq client (only initialised when GROQ_API_KEY is available)
function getGroqClient(): OpenAI | null {
  if (!process.env.GROQ_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
}

// Fallback: DeepSeek for classification when Groq is unavailable
function getDeepSeekClient(): OpenAI | null {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
}

export async function classifyTask(
  userMessage: string,
  availableRepos: string[]
): Promise<ClassificationResult> {
  const client = getGroqClient() ?? getDeepSeekClient();

  // If no API key is available at all, return a safe default
  if (!client) {
    return {
      executionMode: 'implement',
      repos: [],
      primaryRepo: null,
      needsWebSearch: false,
      isRegistration: false,
    };
  }

  const model = process.env.GROQ_API_KEY ? GROQ_MODEL : 'deepseek-chat';

  const systemPrompt = [
    'You are a task classifier for a multi-repo engineering bot.',
    `Available repo aliases: ${availableRepos.join(', ')}`,
    '',
    'Classify the message into executionMode:',
    '  "question" — asking about code, architecture, or behavior (no code changes needed)',
    '  "research" — wants code analysis, explanation, or review (no code changes)',
    '  "implement" — wants code changes, features, bug fixes, or refactors',
    '',
    'isRegistration: true if user wants to register/add a new project repo.',
    'registrationAlias: new repo alias (only if isRegistration).',
    'registrationPath: filesystem path (only if isRegistration).',
    'repos: list ONLY aliases that appear in the available list. Empty array if none match.',
    'primaryRepo: the main repo, or null if unclear.',
    '',
    'Respond with ONLY valid JSON — no markdown, no backticks.',
    'Schema: {"executionMode":"...","repos":["..."],"primaryRepo":"...","needsWebSearch":false,"isRegistration":false}',
  ].join('\n');

  try {
    const res = await client.chat.completions.create({
      model,
      max_tokens: 300,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const text = res.choices[0]?.message.content ?? '';
    const raw = JSON.parse(text) as ClassificationResult;
    raw.repos = (raw.repos ?? []).filter((r) => availableRepos.includes(r));
    if (raw.primaryRepo && !availableRepos.includes(raw.primaryRepo)) {
      raw.primaryRepo = raw.repos[0] ?? null;
    }
    return raw;
  } catch {
    return {
      executionMode: 'implement',
      repos: [],
      primaryRepo: null,
      needsWebSearch: false,
      isRegistration: false,
    };
  }
}
