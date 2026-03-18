import OpenAI from 'openai';
import type { WorkerResult, OrchestratorPlan } from '../types.js';

export class ResultAggregator {
  /**
   * Merge N worker results into a single coherent summary.
   * Uses Groq/DeepSeek (fast + cheap) for synthesis text generation.
   */
  async aggregate(
    results: WorkerResult[],
    originalTask: string,
    plan: OrchestratorPlan
  ): Promise<string> {
    // Build structured table
    const tableRows = results.map((r) => {
      const subTask = plan.subTasks.find((t) => t.id === r.subTaskId);
      const repo = subTask?.repoAlias ?? r.workerId;
      const status = r.success ? '✅' : '❌';
      const build = r.verificationStatus?.graders.find((g) => g.grader === 'build')?.passed;
      const lint = r.verificationStatus?.graders.find((g) => g.grader === 'lint')?.passed;
      const buildStr = build === undefined ? '-' : build ? '✓' : '✗';
      const lintStr = lint === undefined ? '-' : lint ? '✓' : '✗';
      const files = r.filesModified.length > 0 ? r.filesModified.length.toString() : '-';
      return `| \`${repo}\` | ${status} | ${files} files | Build: ${buildStr} | Lint: ${lintStr} |`;
    });

    const table = [
      '| Repo | Status | Files | Build | Lint |',
      '|------|--------|-------|-------|------|',
      ...tableRows,
    ].join('\n');

    // Get errors for failed workers
    const errorDetails = results
      .filter((r) => !r.success || r.verificationStatus?.overall === 'fail')
      .map((r) => {
        const subTask = plan.subTasks.find((t) => t.id === r.subTaskId);
        const repo = subTask?.repoAlias ?? r.workerId;
        const feedback = r.verificationStatus?.feedbackForRetry ?? r.error ?? 'Unknown error';
        return `**\`${repo}\`**: ${feedback.slice(0, 300)}`;
      })
      .join('\n\n');

    // Build synthesis prompt
    const workerSummaries = results
      .map((r) => {
        const subTask = plan.subTasks.find((t) => t.id === r.subTaskId);
        return `[${subTask?.repoAlias ?? 'unknown'}] ${r.success ? 'SUCCESS' : 'FAILED'}: ${r.output.slice(0, 300)}`;
      })
      .join('\n---\n');

    // Get LLM synthesis
    const synthesis = await this.synthesize(originalTask, workerSummaries);

    const parts = [
      synthesis,
      '',
      table,
    ];

    if (errorDetails) {
      parts.push('', '### Issues Requiring Review', errorDetails);
    }

    return parts.join('\n');
  }

  private async synthesize(originalTask: string, workerSummaries: string): Promise<string> {
    const client = getClient();
    if (!client) {
      return `Task completed. ${workerSummaries.slice(0, 500)}`;
    }

    try {
      const { c, model } = client;
      const res = await c.chat.completions.create({
        model,
        max_tokens: 400,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are a technical writer summarising results from a multi-agent software task. Be concise and precise.',
          },
          {
            role: 'user',
            content: `Original task: ${originalTask}\n\nWorker results:\n${workerSummaries}\n\nWrite a 3-5 sentence summary of what was accomplished, any issues, and recommended next steps.`,
          },
        ],
      });
      return res.choices[0]?.message.content ?? 'Task completed.';
    } catch {
      return `Task completed across ${workerSummaries.split('---').length} workers.`;
    }
  }
}

function getClient(): { c: OpenAI; model: string } | null {
  if (process.env.GROQ_API_KEY) {
    return { c: new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }), model: 'llama-3.1-8b-instant' };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return { c: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' }), model: 'deepseek-chat' };
  }
  return null;
}

export const resultAggregator = new ResultAggregator();
