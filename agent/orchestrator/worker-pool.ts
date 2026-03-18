import pLimit from 'p-limit';
import { runAgentLoop, type ProgressCallback } from '../loop.js';
import { VerificationPipeline } from '../verification/verifier.js';
import { worktreeManager } from '../parallelization/worktree-manager.js';
import { getRepoConfig } from '../config.js';
import { contextBuilder } from './context-builder.js';
import { memoryManager } from '../memory/memory-manager.js';
import type { SubTask, WorkerResult, OrchestratorPlan } from '../types.js';
import { randomUUID } from 'crypto';

export interface WorkerPoolConfig {
  maxConcurrency?: number;
  progressCallback?: ProgressCallback;
  runVerification?: boolean;
}

/**
 * Manages concurrent worker agents for an orchestrator plan.
 * Respects dependency ordering: tasks with dependencies wait for their deps to complete.
 */
export class WorkerPool {
  async execute(
    plan: OrchestratorPlan,
    config: WorkerPoolConfig = {}
  ): Promise<WorkerResult[]> {
    const { maxConcurrency = 3, progressCallback, runVerification = true } = config;
    const limit = pLimit(maxConcurrency);
    const results = new Map<string, WorkerResult>();
    const inProgress = new Map<string, Promise<WorkerResult>>();

    // Topological execution: process waves of tasks as dependencies complete
    const pending = [...plan.subTasks];

    while (pending.length > 0 || inProgress.size > 0) {
      // Find tasks whose dependencies are all satisfied
      const ready = pending.filter((task) =>
        task.dependencies.every((depId) => results.has(depId) && results.get(depId)!.success)
      );

      // Submit ready tasks up to concurrency limit
      for (const task of ready) {
        if (inProgress.size >= maxConcurrency) break;
        pending.splice(pending.indexOf(task), 1);

        const dependencyResults = task.dependencies.map((depId) => results.get(depId)!);
        const dependencySummaries = dependencyResults.map((r) => r.output.slice(0, 200));

        const workerPromise = limit(() =>
          this.runWorker(task, plan, dependencySummaries, progressCallback, runVerification)
        );

        inProgress.set(task.id, workerPromise);
        workerPromise.then((result) => {
          results.set(task.id, result);
          inProgress.delete(task.id);
        });
      }

      // If no tasks are ready and we're still waiting, something failed a dependency
      if (ready.length === 0 && inProgress.size === 0 && pending.length > 0) {
        // Mark remaining tasks as blocked
        for (const task of pending) {
          results.set(task.id, {
            workerId: 'blocked',
            subTaskId: task.id,
            success: false,
            output: 'Blocked: dependency failed',
            filesModified: [],
            tokensUsed: 0,
            durationMs: 0,
            error: 'Dependency failed',
          });
        }
        break;
      }

      if (inProgress.size > 0) {
        // Wait for at least one task to complete before re-evaluating
        await Promise.race([...inProgress.values()]);
      }
    }

    // Return results in original task order
    return plan.subTasks.map((t) => results.get(t.id)!).filter(Boolean);
  }

  private async runWorker(
    subTask: SubTask,
    plan: OrchestratorPlan,
    dependencySummaries: string[],
    progressCallback?: ProgressCallback,
    runVerification = true
  ): Promise<WorkerResult> {
    const workerId = randomUUID().slice(0, 8);
    const startTime = Date.now();

    const repoConfig = (await getRepoConfig()).repos[subTask.repoAlias];
    if (!repoConfig) {
      return errorResult(workerId, subTask.id, `Unknown repo: ${subTask.repoAlias}`, startTime);
    }

    let worktreeInfo: Awaited<ReturnType<typeof worktreeManager.create>> | null = null;

    try {
      if (progressCallback) {
        await progressCallback(`🤖 Worker \`${workerId}\`: starting subtask \`${subTask.id}\` on \`${subTask.repoAlias}\``);
      }

      // Load memory for this subtask
      const memoryBundle = await memoryManager.query({
        repoAlias: subTask.repoAlias,
        taskDescription: subTask.description,
        maxSkills: 3,
        maxFacts: 5,
      });

      // Build isolated context for this worker
      const systemBlocks = await contextBuilder.buildForSubTask(subTask, memoryBundle, {
        totalSubTasks: plan.subTasks.length,
        completedDependencySummaries: dependencySummaries,
      });

      // Create worktree if needed
      if (subTask.isolatedWorktree) {
        const branchName = `worker/${workerId}-${subTask.id.slice(0, 8)}`;
        worktreeInfo = await worktreeManager.create(subTask.repoAlias, branchName);
      }

      // Run agent — the system blocks are passed indirectly through loop.ts
      // For now we pass them as context in the task description
      const taskWithContext = `${subTask.description}\n\n${systemBlocks.at(-1)?.text ?? ''}`;
      const output = await runAgentLoop(
        subTask.repoAlias,
        taskWithContext,
        subTask.serviceHint,
        progressCallback,
        subTask.executionMode
      );

      // Verify if this was an implement task
      let verificationStatus = undefined;
      if (runVerification && subTask.executionMode === 'implement') {
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
        filesModified: [],
        verificationStatus,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return errorResult(workerId, subTask.id, String(err), startTime);
    } finally {
      if (worktreeInfo) {
        await worktreeManager.cleanup(worktreeInfo).catch(() => undefined);
      }
    }
  }
}

function errorResult(workerId: string, subTaskId: string, error: string, startTime: number): WorkerResult {
  return {
    workerId,
    subTaskId,
    success: false,
    output: '',
    filesModified: [],
    tokensUsed: 0,
    durationMs: Date.now() - startTime,
    error,
  };
}

export const workerPool = new WorkerPool();
