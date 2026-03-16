import pLimit from 'p-limit';
import { runAgentLoop, type ProgressCallback } from '../loop.js';
import { VerificationPipeline } from '../verification/verifier.js';
import { worktreeManager } from './worktree-manager.js';
import { getRepoConfig } from '../config.js';
import type { SubTask, WorkerResult } from '../types.js';
import { randomUUID } from 'crypto';

export interface ParallelRunConfig {
  maxConcurrency?: number;
  progressCallback?: ProgressCallback;
  runVerification?: boolean;
}

/**
 * Run N subtasks in parallel, each in an isolated git worktree.
 * Uses p-limit to cap concurrency.
 */
export async function runParallel(
  subTasks: SubTask[],
  config: ParallelRunConfig = {}
): Promise<WorkerResult[]> {
  const { maxConcurrency = 3, progressCallback, runVerification = true } = config;
  const limit = pLimit(maxConcurrency);

  const workerTasks = subTasks.map((subTask) =>
    limit(() => runWorker(subTask, progressCallback, runVerification))
  );

  return Promise.all(workerTasks);
}

async function runWorker(
  subTask: SubTask,
  progressCallback?: ProgressCallback,
  runVerification = true
): Promise<WorkerResult> {
  const workerId = randomUUID().slice(0, 8);
  const startTime = Date.now();

  const repoConfig = (await getRepoConfig()).repos[subTask.repoAlias];
  if (!repoConfig) {
    return {
      workerId,
      subTaskId: subTask.id,
      success: false,
      output: `Unknown repo alias: ${subTask.repoAlias}`,
      filesModified: [],
      tokensUsed: 0,
      durationMs: Date.now() - startTime,
      error: `Unknown repo alias: ${subTask.repoAlias}`,
    };
  }

  let worktreeInfo: Awaited<ReturnType<typeof worktreeManager.create>> | null = null;

  try {
    // Create isolated worktree for implement tasks
    if (subTask.isolatedWorktree) {
      const branchName = `worker/${workerId}-${subTask.id.slice(0, 8)}`;
      if (progressCallback) {
        await progressCallback(`🌱 Worker ${workerId}: creating worktree \`${branchName}\``);
      }
      worktreeInfo = await worktreeManager.create(subTask.repoAlias, branchName);
    }

    // Build the task description with subtask context
    const taskWithContext = buildSubtaskPrompt(subTask);

    // Run agent loop (using worktree path if available)
    const output = await runAgentLoop(
      subTask.repoAlias,
      taskWithContext,
      subTask.serviceHint,
      progressCallback,
      subTask.executionMode
    );

    // Run verification if enabled and this was an implement task
    let verificationStatus = undefined;
    if (runVerification && subTask.executionMode === 'implement') {
      if (progressCallback) {
        await progressCallback(`🔬 Worker ${workerId}: verifying changes...`);
      }
      verificationStatus = await VerificationPipeline.run(
        { path: worktreeInfo?.worktreePath ?? repoConfig.path, buildScript: repoConfig.buildScript, lintScript: repoConfig.lintScript },
        { runBuild: true, runLint: true }
      );
    }

    return {
      workerId,
      subTaskId: subTask.id,
      success: true,
      output,
      filesModified: [], // Populated by agent output parsing in a future iteration
      verificationStatus,
      tokensUsed: 0,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      workerId,
      subTaskId: subTask.id,
      success: false,
      output: '',
      filesModified: [],
      tokensUsed: 0,
      durationMs: Date.now() - startTime,
      error: String(err),
    };
  } finally {
    if (worktreeInfo) {
      await worktreeManager.cleanup(worktreeInfo).catch(() => undefined);
    }
  }
}

function buildSubtaskPrompt(subTask: SubTask): string {
  const lines = [subTask.description];
  if (subTask.id) {
    lines.push(`\n[SubTask Context: task ID ${subTask.id}, priority ${subTask.priority}]`);
  }
  return lines.join('\n');
}
