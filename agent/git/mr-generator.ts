import OpenAI from 'openai';

interface MRContent {
  title: string;
  description: string;
}

interface WorkerSummary {
  repo: string;
  status: 'success' | 'failed';
  filesModified: string[];
  buildPassed?: boolean;
  lintPassed?: boolean;
  output?: string;
}

export class MRGenerator {
  /**
   * Generate an MR/PR title and description from a completed agent session.
   * Uses Groq (fast + cheap) for text generation.
   */
  static async generate(
    taskDescription: string,
    filesModified: string[],
    workerSummaries: WorkerSummary[] = []
  ): Promise<MRContent> {
    const client = getClient();
    if (!client) {
      return buildFallbackMR(taskDescription, filesModified);
    }

    const fileList = filesModified.slice(0, 20).join('\n');
    const verificationStatus = workerSummaries
      .map((w) => `${w.repo}: ${w.status} | Build: ${w.buildPassed ? '✓' : '✗'} | Lint: ${w.lintPassed ? '✓' : '✗'}`)
      .join('\n');

    const prompt = [
      'Generate a concise GitLab/GitHub MR description for the following change.',
      '',
      `Task: ${taskDescription}`,
      '',
      'Files modified:',
      fileList,
      '',
      verificationStatus ? `Verification:\n${verificationStatus}` : '',
      '',
      'Respond with ONLY valid JSON: {"title": "...", "description": "..."}',
      'Title: max 72 chars, imperative mood (e.g. "Add retry logic to payment-processor")',
      'Description: 3-5 bullet points of what changed and why. Add a ## Test Plan section.',
      'Do not include code. Do not include file paths verbatim — summarise the changes.',
    ].filter(Boolean).join('\n');

    try {
      const { client: c, model } = client;
      const res = await c.chat.completions.create({
        model,
        max_tokens: 600,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a precise technical writer for software merge requests.' },
          { role: 'user', content: prompt },
        ],
      });

      const text = res.choices[0]?.message.content ?? '';
      const parsed = JSON.parse(text) as MRContent;
      return {
        title: parsed.title?.slice(0, 72) ?? taskDescription.slice(0, 72),
        description: parsed.description ?? '',
      };
    } catch {
      return buildFallbackMR(taskDescription, filesModified);
    }
  }

  /**
   * Build a short conventional-commits commit message.
   * Called by GitAutomation.runFlow().
   */
  static async buildCommitMessage(
    taskDescription: string,
    filesModified: string[]
  ): Promise<string> {
    // Heuristic: detect commit type from task description keywords
    const lower = taskDescription.toLowerCase();
    const type = lower.includes('fix') || lower.includes('bug')
      ? 'fix'
      : lower.includes('refactor') || lower.includes('clean')
      ? 'refactor'
      : lower.includes('test')
      ? 'test'
      : lower.includes('doc')
      ? 'docs'
      : 'feat';

    const scope = extractScope(filesModified);
    const summary = taskDescription.slice(0, 60).replace(/['"]/g, '');
    return scope ? `${type}(${scope}): ${summary}` : `${type}: ${summary}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getClient(): { client: OpenAI; model: string } | null {
  if (process.env.GROQ_API_KEY) {
    return {
      client: new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }),
      model: 'llama-3.1-8b-instant',
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      client: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' }),
      model: 'deepseek-chat',
    };
  }
  return null;
}

function buildFallbackMR(taskDescription: string, filesModified: string[]): MRContent {
  return {
    title: taskDescription.slice(0, 72),
    description: [
      '## Summary',
      `- ${taskDescription}`,
      '',
      '## Files Changed',
      filesModified.slice(0, 10).map((f) => `- \`${f}\``).join('\n'),
      '',
      '## Test Plan',
      '- [ ] Build passes',
      '- [ ] Lint passes',
      '- [ ] Unit tests pass',
      '- [ ] Manual smoke test',
    ].join('\n'),
  };
}

function extractScope(filesModified: string[]): string {
  if (filesModified.length === 0) return '';
  // Try to extract the service/app name from the first file path
  // e.g. "apps/payment-service/src/retry.ts" → "payment-service"
  const firstFile = filesModified[0];
  const match = firstFile.match(/(?:apps?|services?|libs?)\/([^/]+)/i);
  return match?.[1]?.slice(0, 20) ?? '';
}
