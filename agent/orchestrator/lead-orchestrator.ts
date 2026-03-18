import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { getRepoConfig } from '../config.js';
import { workerPool } from './worker-pool.js';
import { resultAggregator } from './result-aggregator.js';
import { memoryManager } from '../memory/memory-manager.js';
import type { OrchestratorPlan, SubTask, WorkerResult } from '../types.js';
import type { ExecutionMode } from '../classifier.js';
import type { ProgressCallback } from '../loop.js';

interface OrchestratorInput {
  taskId?: string;
  originalTask: string;
  repoAliases: string[];
  primaryRepo: string;
  executionMode: ExecutionMode;
  serviceHint?: string;
  progressCallback?: ProgressCallback;
}

/**
 * LeadOrchestrator — the top-level brain for complex multi-repo tasks.
 *
 * 1. Queries memory for relevant context
 * 2. Decomposes the task into subtasks (via LLM planning)
 * 3. Executes subtasks in parallel via WorkerPool
 * 4. Aggregates and returns a unified summary
 */
export class LeadOrchestrator {
  /**
   * Plan: decompose the task into SubTasks using an LLM call.
   * Falls back to a single SubTask for the primary repo if planning fails.
   */
  async plan(input: OrchestratorInput): Promise<OrchestratorPlan> {
    const taskId = input.taskId ?? randomUUID();
    const config = await getRepoConfig();

    // Build repo context for the planning prompt
    const repoContext = input.repoAliases
      .map((alias) => {
        const repo = config.repos[alias];
        if (!repo) return null;
        const services = repo.services.slice(0, 10).join(', ');
        return `- \`${alias}\`: ${repo.description ?? repo.type} (${repo.services.length} services: ${services}${repo.services.length > 10 ? '...' : ''})`;
      })
      .filter(Boolean)
      .join('\n');

    const client = getPlanningClient();

    if (!client) {
      // No LLM available — create a single subtask for the primary repo
      return this.buildFallbackPlan(taskId, input);
    }

    const planningPrompt = [
      'You are a task decomposition agent for a multi-repo software factory.',
      '',
      'Available repos:',
      repoContext,
      '',
      `Task: ${input.originalTask}`,
      `Execution mode: ${input.executionMode}`,
      '',
      'Decompose this into subtasks. Rules:',
      '1. Cross-service changes in the SAME repo → single SubTask (one agent handles them together)',
      '2. Cross-repo changes → separate SubTask per repo',
      '3. Read-only analysis → use executionMode "research" (cheaper)',
      '4. List dependencies between tasks (e.g. shared lib change before service change)',
      '5. Maximum 5 subtasks total',
      '',
      'Respond with ONLY valid JSON matching this schema:',
      JSON.stringify({
        strategy: 'parallel|sequential|hybrid',
        estimatedComplexity: 'low|medium|high',
        subTasks: [{
          id: 'st-1',
          repoAlias: 'alias',
          serviceHint: 'service-name or null',
          description: 'What this worker should do',
          executionMode: 'question|research|implement',
          priority: 1,
          dependencies: [],
          isolatedWorktree: true,
        }],
      }),
    ].join('\n');

    try {
      const { c, model } = client;
      const res = await c.chat.completions.create({
        model,
        max_tokens: 800,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a precise task decomposition agent. Output only valid JSON.' },
          { role: 'user', content: planningPrompt },
        ],
      });

      const text = res.choices[0]?.message.content ?? '';
      const parsed = JSON.parse(text) as { strategy: OrchestratorPlan['strategy']; estimatedComplexity: OrchestratorPlan['estimatedComplexity']; subTasks: Omit<SubTask, 'parentTaskId' | 'status' | 'result'>[] };

      // Validate and enrich subtasks
      const subTasks: SubTask[] = parsed.subTasks
        .filter((st) => st.repoAlias && input.repoAliases.includes(st.repoAlias))
        .map((st) => ({
          ...st,
          id: st.id ?? randomUUID().slice(0, 8),
          parentTaskId: taskId,
          status: 'pending' as const,
          isolatedWorktree: st.isolatedWorktree ?? (st.executionMode === 'implement'),
        }));

      if (subTasks.length === 0) return this.buildFallbackPlan(taskId, input);

      return {
        taskId,
        originalTask: input.originalTask,
        repoAliases: input.repoAliases,
        subTasks,
        strategy: parsed.strategy ?? 'parallel',
        estimatedComplexity: parsed.estimatedComplexity ?? 'medium',
      };
    } catch {
      return this.buildFallbackPlan(taskId, input);
    }
  }

  /**
   * Execute a plan: run all subtasks, aggregate results, log to memory.
   */
  async execute(
    plan: OrchestratorPlan,
    input: OrchestratorInput
  ): Promise<string> {
    const { progressCallback } = input;

    if (progressCallback) {
      const strategyLabel = plan.strategy === 'parallel' ? '🔀 parallel' : plan.strategy === 'sequential' ? '⬇️ sequential' : '🔀⬇️ hybrid';
      await progressCallback(
        `📋 *Plan:* ${plan.subTasks.length} subtask(s) | strategy: ${strategyLabel} | complexity: ${plan.estimatedComplexity}`
      );
    }

    // Record session start
    const session = memoryManager.createSession(
      input.primaryRepo,
      input.originalTask,
      input.executionMode
    );
    await memoryManager.recordSessionStart(session);

    let results: WorkerResult[];
    try {
      results = await workerPool.execute(plan, {
        progressCallback,
        runVerification: input.executionMode === 'implement',
      });
    } catch (err) {
      await memoryManager.recordSessionEnd(session, 'failed');
      throw err;
    }

    // Aggregate results into a unified summary
    const summary = await resultAggregator.aggregate(results, input.originalTask, plan);

    const allSuccess = results.every((r) => r.success);
    await memoryManager.recordSessionEnd(session, allSuccess ? 'success' : 'partial');

    return summary;
  }

  private buildFallbackPlan(taskId: string, input: OrchestratorInput): OrchestratorPlan {
    return {
      taskId,
      originalTask: input.originalTask,
      repoAliases: input.repoAliases,
      subTasks: input.repoAliases.map((repoAlias, i) => ({
        id: `st-${i + 1}`,
        parentTaskId: taskId,
        repoAlias,
        serviceHint: repoAlias === input.primaryRepo ? input.serviceHint : undefined,
        description: input.originalTask,
        executionMode: input.executionMode,
        priority: i + 1,
        dependencies: i === 0 ? [] : [`st-${i}`], // sequential fallback
        isolatedWorktree: input.executionMode === 'implement',
        status: 'pending',
      })),
      strategy: input.repoAliases.length > 1 ? 'sequential' : 'sequential',
      estimatedComplexity: 'medium',
    };
  }
}

function getPlanningClient(): { c: OpenAI; model: string } | null {
  if (process.env.DEEPSEEK_API_KEY) {
    return { c: new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' }), model: 'deepseek-chat' };
  }
  if (process.env.GROQ_API_KEY) {
    return { c: new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }), model: 'llama-3.1-8b-instant' };
  }
  if (process.env.GEMINI_API_KEY) {
    return { c: new OpenAI({ apiKey: process.env.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' }), model: 'gemini-2.5-flash-preview-05-20' };
  }
  return null;
}

export const leadOrchestrator = new LeadOrchestrator();
