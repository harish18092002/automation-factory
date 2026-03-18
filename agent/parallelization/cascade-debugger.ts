import { runAgentLoop } from '../loop.js';
import { VerificationPipeline } from '../verification/verifier.js';
import { worktreeManager } from './worktree-manager.js';
import { getRepoConfig } from '../config.js';
import type { WorkerResult } from '../types.js';
import { randomUUID } from 'crypto';

interface CascadeInput {
  repoAlias: string;
  serviceHint?: string;
  originalTask: string;
  failedOutput: string;
  errorContext: string;
}

interface CascadeConfig {
  repoPath: string;
  buildScript: string;
  lintScript: string;
}

/**
 * CASCADE recovery: run 3 parallel debug strategies when an agent attempt fails.
 * Picks the best result based on verification status.
 *
 * Strategy A: Root-cause analysis and targeted fix
 * Strategy B: Minimal-change workaround
 * Strategy C: Alternative implementation approach
 */
export async function cascadeRecover(input: CascadeInput): Promise<WorkerResult> {
  const repoConfig = (await getRepoConfig()).repos[input.repoAlias];
  if (!repoConfig) throw new Error(`Unknown repo: ${input.repoAlias}`);

  const config: CascadeConfig = {
    repoPath: repoConfig.path,
    buildScript: repoConfig.buildScript,
    lintScript: repoConfig.lintScript,
  };

  const strategies = [
    {
      name: 'root-cause',
      prompt: buildStrategyPrompt('A', input, 'Analyze the error trace carefully and fix the root cause. Prefer correctness over speed.'),
    },
    {
      name: 'minimal-change',
      prompt: buildStrategyPrompt('B', input, 'Apply the smallest possible change that unblocks the issue. Prefer minimal diff over perfect solution.'),
    },
    {
      name: 'alternative-impl',
      prompt: buildStrategyPrompt('C', input, 'Rewrite the failing section using a completely different approach that avoids the error pattern.'),
    },
  ];

  // Run all 3 strategies in parallel in isolated worktrees
  const results = await Promise.allSettled(
    strategies.map(async (strategy) => {
      const workerId = randomUUID().slice(0, 8);
      const branchName = `cascade/${strategy.name}-${workerId}`;
      const worktreeInfo = await worktreeManager.create(input.repoAlias, branchName);

      try {
        const output = await runAgentLoop(
          input.repoAlias,
          strategy.prompt,
          input.serviceHint,
          undefined,
          'implement'
        );

        const verificationStatus = await VerificationPipeline.run(
          { path: worktreeInfo.worktreePath, buildScript: config.buildScript, lintScript: config.lintScript },
          { runBuild: true, runLint: true }
        );

        return {
          strategy: strategy.name,
          output,
          verificationStatus,
          workerId,
        };
      } finally {
        await worktreeManager.cleanup(worktreeInfo).catch(() => undefined);
      }
    })
  );

  // Select the best result using the output processor
  const successful = results
    .filter((r): r is PromiseFulfilledResult<{ strategy: string; output: string; verificationStatus: ReturnType<typeof VerificationPipeline['run']> extends Promise<infer T> ? T : never; workerId: string }> => r.status === 'fulfilled')
    .map((r) => r.value);

  const best = selectBestResult(successful);

  if (!best) {
    return {
      workerId: 'cascade-failed',
      subTaskId: '',
      success: false,
      output: 'All 3 cascade recovery strategies failed. Manual intervention required.',
      filesModified: [],
      tokensUsed: 0,
      durationMs: 0,
      error: 'CASCADE: all strategies failed',
    };
  }

  return {
    workerId: best.workerId,
    subTaskId: '',
    success: true,
    output: `[CASCADE: ${best.strategy} strategy won]\n\n${best.output}`,
    filesModified: [],
    verificationStatus: best.verificationStatus,
    tokensUsed: 0,
    durationMs: 0,
  };
}

function buildStrategyPrompt(
  label: string,
  input: CascadeInput,
  strategyInstruction: string
): string {
  return [
    `## Recovery Task (Strategy ${label})`,
    '',
    `**Original Task:** ${input.originalTask}`,
    '',
    `**What failed:**`,
    input.failedOutput.slice(0, 500),
    '',
    `**Error context:**`,
    input.errorContext.slice(0, 500),
    '',
    `**Your strategy:** ${strategyInstruction}`,
    '',
    'Implement the fix now.',
  ].join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectBestResult(results: any[]): any | null {
  if (results.length === 0) return null;

  // Prefer results where verification passed
  const passing = results.filter((r) => r.verificationStatus?.overall === 'pass');
  if (passing.length > 0) return passing[0]; // First passer wins (ordered: root-cause > minimal > alt)

  // If none passed, return the one with best partial verification
  const partial = results.filter((r) => r.verificationStatus?.overall === 'partial');
  if (partial.length > 0) return partial[0];

  // Return first result regardless
  return results[0];
}
