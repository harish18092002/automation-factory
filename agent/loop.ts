import fs from 'fs/promises';
import path from 'path';
import { toolDefinitions, readOnlyToolDefinitions, questionToolDefinitions, executeToolCall } from './tools.js';
import { getRepoConfig, addRepo } from './config.js';
import { type ExecutionMode } from './classifier.js';
import { ProviderRouter } from './providers/router.js';
import type { ProviderMessage, ProviderSystemBlock, ProviderTool } from './providers/types.js';
import { memoryManager } from './memory/memory-manager.js';
import type { AgentSession, AgentLoopResult } from './types.js';
import { detectProject } from './project-detector.js';
import { CheckpointManager } from './checkpoint-manager.js';

// Iteration budgets per execution mode
const ITERATION_LIMITS: Record<ExecutionMode, number> = {
  question: 5,
  research: 8,
  implement: 12,
};

// Max output tokens per execution mode
const MAX_TOKENS: Record<ExecutionMode, number> = {
  question: 2048,
  research: 4096,
  implement: 8096,
};

// Workflow instructions injected into system prompt per mode
const WORKFLOW_INSTRUCTIONS: Record<ExecutionMode, string> = {
  question: `## Response Instructions — Question Mode
Follow these steps strictly:
1. **DISCOVER** — call list_directory on the repo root (".") to see what services/apps/libs exist.
2. **LOCATE** — use search_files or list_directory on the relevant service directory to find related files.
3. **READ** — read the specific file(s) needed to answer the question accurately.
4. **ANSWER** — give a clear, direct answer based only on what you read. Do NOT guess or hallucinate.
Do NOT write files. If a file you expected does not exist, use list_directory to find the correct path first.`,

  research: `## Execution Workflow — Research Mode (follow strictly in order)
1. **DISCOVER** — Start by calling list_directory on the repo root (".") to see all top-level services/apps/libs. Then call list_directory on the specific service or folder mentioned in the task.
2. **LOCATE** — Use search_files to find relevant files by name or content pattern. If search returns no results, try a shorter/different keyword. Use list_directory to confirm paths exist before reading.
3. **READ** — Read the entry point (main.ts or index.ts), the module file, and 2-3 key implementation files for the target service. Always verify a file path exists before calling read_file.
4. **ANALYSE** — Based on what you read, explain: what the service does, how it is structured, key dependencies, and any important patterns.
5. **SUMMARISE** — End with a clear structured summary: purpose, architecture, key files, notable patterns.
Do NOT write files. If a path does not exist, use list_directory to discover the correct path instead of giving up.`,

  implement: `## Execution Workflow — Implement Mode (follow strictly in order)
1. **DISCOVER** — call list_directory on the repo root and on the target service directory to understand the structure.
2. **EXPLORE** — Use search_files and read_file to understand existing code patterns. Find entry points, existing similar implementations, and shared lib usage.
3. **PLAN** — Before writing any file, state your implementation plan explicitly: list each file to modify/create and what change you'll make.
4. **IMPLEMENT** — Execute your plan: read each file fully before writing it, follow the repo's existing patterns and conventions.
5. **VERIFY** — Run the build/lint commands after all writes. Fix any TypeScript or lint errors.
6. **REPORT** — In your final response, list every file you created or modified with its relative path.`,
};

export type ProgressCallback = (update: string) => Promise<void>;

// Tool emoji for Slack progress updates
const TOOL_EMOJI: Record<string, string> = {
  read_file: '📂',
  read_file_section: '📖',
  write_file: '✍️',
  list_directory: '📁',
  search_files: '🔍',
  run_command: '⚡',
  git_status: '🌿',
  git_diff: '📊',
  git_create_branch: '🌱',
  git_commit: '💾',
  web_search: '🌐',
  read_memory: '🧠',
  write_memory: '📝',
  write_note: '📌',
};

export async function buildSystemPromptBlocks(
  repoAlias: string,
  serviceHint?: string,
  executionMode: ExecutionMode = 'implement',
  memoryFragment?: string,
  feedbackFromPreviousAttempt?: string
): Promise<ProviderSystemBlock[]> {
  const config = await getRepoConfig();
  const repo = config.repos[repoAlias];
  if (!repo) {
    throw new Error(
      `Repo not found: "${repoAlias}". Available: ${Object.keys(config.repos).join(', ')}`
    );
  }

  // Load AGENT_CONTEXT.md — large static section; mark for caching
  const contextPath = path.join(repo.path, 'AGENT_CONTEXT.md');
  let repoContext: string;
  try {
    repoContext = await fs.readFile(contextPath, 'utf-8');
  } catch {
    throw new Error(
      `AGENT_CONTEXT.md not found at ${contextPath}.\n` +
        `Run "register project ${repoAlias} at ${repo.path}" or create AGENT_CONTEXT.md manually.`
    );
  }

  // Optionally load service-level context
  let serviceContext = '';
  if (serviceHint) {
    const svcPath = path.join(repo.path, repo.srcDir, serviceHint, 'SERVICE_CONTEXT.md');
    try {
      serviceContext = await fs.readFile(svcPath, 'utf-8');
    } catch {
      // Optional — silently skip
    }
  }

  const toolNames =
    executionMode === 'implement'
      ? 'read_file, read_file_section, list_directory, search_files, write_file, run_command, git_status, git_diff, web_search'
      : executionMode === 'question'
      ? 'read_file, read_file_section, list_directory, search_files, git_status, git_diff'
      : 'read_file, read_file_section, list_directory, search_files, git_status, git_diff, web_search';

  // Convert SSH remote to HTTPS for display (purely informational — agent must not use this for git ops)
  const gitRemoteDisplay = repo.gitRemote
    ? repo.gitRemote.replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/')
    : 'not configured';

  // Dynamic session block — changes per request, never cache
  const sessionLines = [
    serviceContext ? `\n\n## Target Service Override Context\n${serviceContext}` : '',
    `\n\n---\n## Active Agent Session`,
    `- **Repo**: \`${repoAlias}\` at \`${repo.path}\``,
    `- **srcDir**: \`${repo.srcDir}/\``,
    `- **Runtime**: ${repo.runtime}`,
    `- **Build command**: \`${repo.buildScript}\``,
    `- **Lint command**: \`${repo.lintScript}\``,
    `- **Git remote**: \`${gitRemoteDisplay}\``,
    serviceHint
      ? `- **Target service**: \`${serviceHint}\` (at \`${repo.srcDir}/${serviceHint}/\`)`
      : '- **Target service**: not specified',
    `- **Available tools**: ${toolNames}`,
    '',
    '## Agent Rules',
    '1. Read before writing — always call read_file before write_file on existing files.',
    '2. Stay in scope — only modify target service unless task requires shared lib changes.',
    '3. Path aliases — use the repo\'s import aliases, never relative cross-lib imports.',
    '4. No secrets — never write API keys, tokens, or credentials into source files.',
    '5. Report all changes — list every file created/modified in final response.',
    '',
    '## Anti-Hallucination Rules — STRICTLY ENFORCED',
    'VIOLATION of any rule below is a critical failure:',
    '- NEVER invent or guess URLs of any kind (PR links, MR links, API URLs, web links).',
    '- NEVER fabricate file paths, function names, class names, or identifiers you have not read from a file.',
    '- NEVER assume a library, framework, or pattern is used without reading a file that proves it.',
    '- NEVER generate git remote URLs or branch URLs — the system handles all git operations automatically after your code changes.',
    '- If you do not know something, say "I need to read X first" and use a tool. Never guess.',
    '- Only state facts you have directly observed by calling a tool in this session.',
    '',
    WORKFLOW_INSTRUCTIONS[executionMode],
  ]
    .filter(Boolean)
    .join('\n');

  const blocks: ProviderSystemBlock[] = [
    // Block 1: Large static AGENT_CONTEXT.md — cache across calls for same repo
    { text: repoContext, cache: true },
  ];

  // Block 2: Memory fragment — cached if non-empty (stable across requests for same repo)
  if (memoryFragment && memoryFragment.trim()) {
    blocks.push({ text: memoryFragment, cache: true });
  }

  // Block 3: Dynamic session info — never cache (different every request)
  const retryBlock = feedbackFromPreviousAttempt
    ? `\n\n## ⚠️ Previous Attempt Failed — Fix These Issues\n${feedbackFromPreviousAttempt}`
    : '';
  blocks.push({ text: sessionLines + retryBlock, cache: false });

  return blocks;
}

// Estimate rough token count from system blocks (chars / 4 ≈ tokens)
function estimateTokens(blocks: ProviderSystemBlock[]): number {
  return Math.ceil(blocks.reduce((acc, b) => acc + b.text.length, 0) / 4);
}

// ── Upgrade 2: Context compression helpers ───────────────────────────────────

// Estimate token count across the running message history
function estimateMessageTokens(messages: ProviderMessage[]): number {
  return Math.ceil(
    messages.reduce((acc, m) => {
      const text =
        typeof m.content === 'string'
          ? m.content
          : m.content == null
          ? ''
          : JSON.stringify(m.content);
      return acc + text.length / 4;
    }, 0)
  );
}

// Token threshold at which we start compressing old tool results.
// ~28K message tokens + ~10K system ≈ 38K total, safely below most provider limits.
const CONTEXT_COMPRESS_AT = 28_000;
// How many recent messages to leave untouched (preserve latest reasoning context)
const KEEP_RECENT_MESSAGES = 10;
// Tool result content longer than this gets truncated in the compressed view
const TOOL_RESULT_TRUNCATE_AT = 1_800;
const TOOL_RESULT_KEEP_CHARS = 600;

/**
 * Returns a version of the messages array safe to send to the provider.
 * The original `messages` array is NOT mutated — this is a read-only view.
 *
 * Strategy: keep the first 2 messages (user task + planning turn) and the
 * most recent KEEP_RECENT_MESSAGES intact.  Tool results in the middle that
 * exceed TOOL_RESULT_TRUNCATE_AT chars have their `content` field truncated.
 * The agent should use write_note to save anything critical before it ages
 * into the compression zone.
 */
function compressOldToolResults(messages: ProviderMessage[]): ProviderMessage[] {
  if (estimateMessageTokens(messages) < CONTEXT_COMPRESS_AT) return messages;

  const pivotHead = 2; // never compress user task or planning turn
  const pivotTail = messages.length - KEEP_RECENT_MESSAGES;
  if (pivotTail <= pivotHead) return messages; // too few messages — nothing to compress

  return messages.map((m, idx) => {
    if (idx < pivotHead || idx >= pivotTail) return m; // keep head + tail intact
    if (m.role !== 'tool' || typeof m.content !== 'string') return m;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(m.content) as Record<string, unknown>;
    } catch {
      return m; // non-JSON tool result — leave as-is
    }

    const text = typeof parsed.content === 'string' ? parsed.content : null;
    if (!text || text.length <= TOOL_RESULT_TRUNCATE_AT) return m;

    return {
      ...m,
      content: JSON.stringify({
        ...parsed,
        content:
          text.slice(0, TOOL_RESULT_KEEP_CHARS) +
          `\n…[${text.length - TOOL_RESULT_KEEP_CHARS} chars truncated — use write_note to preserve key findings]`,
      }),
    };
  });
}

// After an implement run, detect new/removed services or libs and patch AGENT_CONTEXT.md
async function maybeUpdateAgentContext(repoAlias: string): Promise<void> {
  const config = await getRepoConfig();
  const repo = config.repos[repoAlias];
  if (!repo) return;

  const detected = await detectProject(repoAlias, repo.path);
  const newServices = detected.configEntry.services;
  const newLibs = detected.configEntry.sharedLibs ?? [];
  const oldServices = repo.services ?? [];
  const oldLibs = (repo as unknown as Record<string, string[]>).sharedLibs ?? [];

  const addedServices = newServices.filter((s) => !oldServices.includes(s));
  const removedServices = oldServices.filter((s) => !newServices.includes(s));
  const addedLibs = newLibs.filter((l) => !oldLibs.includes(l));

  if (addedServices.length === 0 && removedServices.length === 0 && addedLibs.length === 0) return;

  // Persist updated service/lib list in config
  await addRepo(repoAlias, { ...repo, services: newServices });

  // Append a dated change note to AGENT_CONTEXT.md
  const contextPath = path.join(repo.path, 'AGENT_CONTEXT.md');
  const changeNote = [
    `\n\n## Auto-Detected Structural Changes (${new Date().toISOString().slice(0, 10)})`,
    addedServices.length > 0 ? `- **New services**: ${addedServices.join(', ')}` : '',
    removedServices.length > 0 ? `- **Removed services**: ${removedServices.join(', ')}` : '',
    addedLibs.length > 0 ? `- **New libs**: ${addedLibs.join(', ')}` : '',
    '> Auto-detected breaking structural change — review Services table above.',
  ].filter(Boolean).join('\n');
  await fs.appendFile(contextPath, changeNote, 'utf-8').catch(() => {});
}

// Build a short human-readable summary of a tool call for Slack progress
function buildInputSummary(toolName: string, inp: Record<string, unknown>): string {
  if (['read_file', 'write_file', 'list_directory', 'read_file_section'].includes(toolName)) {
    return `\`${inp.repo}/${inp.relative_path}\``;
  }
  if (toolName === 'search_files') {
    return `\`${inp.pattern}\` in \`${inp.repo}/${inp.relative_path || '.'}\``;
  }
  if (toolName === 'run_command') {
    return `\`${inp.command}\`${inp.relative_cwd ? ` in \`${inp.relative_cwd}\`` : ''}`;
  }
  if (toolName === 'git_status' || toolName === 'git_diff' || toolName === 'git_create_branch' || toolName === 'git_commit') {
    return `\`${inp.repo}\`${inp.branch_name ? ` → \`${inp.branch_name}\`` : ''}`;
  }
  if (toolName === 'web_search') {
    return `\`${inp.query}\``;
  }
  return JSON.stringify(inp).slice(0, 80);
}

export async function runAgentLoop(
  repoAlias: string,
  userTask: string,
  serviceHint?: string,
  progressCallback?: ProgressCallback,
  executionMode: ExecutionMode = 'implement',
  feedbackFromPreviousAttempt?: string
): Promise<AgentLoopResult> {
  // Query memory for relevant context (skills, facts, recent sessions)
  // Errors here are non-fatal — degrade gracefully to no memory
  let memoryFragment: string | undefined;
  try {
    const bundle = await memoryManager.query({
      repoAlias,
      taskDescription: userTask,
      maxSkills: 3,
      maxFacts: 5,
      maxEpisodic: 2,
    });
    memoryFragment = bundle.memoryPromptFragment || undefined;
  } catch {
    // Memory unavailable (first run, data dir missing, etc.) — continue without it
  }

  // Create and record session start — non-fatal if memory system unavailable
  const session: AgentSession = memoryManager.createSession(repoAlias, userTask, executionMode);
  await memoryManager.recordSessionStart(session).catch(() => {});
  const filesModified: string[] = [];

  // Upgrade 4: Checkpoint manager — saves loop state after each iteration
  const checkpointManager = new CheckpointManager(session.sessionId);
  // Upgrade 3: Reflection cadence — inject a mid-loop review every N iterations
  const REFLECTION_INTERVAL = 4;
  let lastReflectionIteration = 0;

  const systemBlocks = await buildSystemPromptBlocks(repoAlias, serviceHint, executionMode, memoryFragment, feedbackFromPreviousAttempt);

  // Resolve repo path for Claude CLI --add-dir (grants filesystem access)
  const repoConfig = await getRepoConfig();
  const repoPaths = repoConfig.repos[repoAlias] ? [repoConfig.repos[repoAlias].path] : [];

  const activeTools: ProviderTool[] =
    executionMode === 'implement'
      ? toolDefinitions
      : executionMode === 'question'
      ? questionToolDefinitions
      : readOnlyToolDefinitions;
  const maxTokens = MAX_TOKENS[executionMode];
  const maxIterations = ITERATION_LIMITS[executionMode];

  // Select provider based on mode + estimated context size
  const estimatedTokens = estimateTokens(systemBlocks);
  const provider = ProviderRouter.select(executionMode, estimatedTokens);

  if (progressCallback) {
    await progressCallback(`🤖 Using provider: *${provider.providerName}* (~${estimatedTokens.toLocaleString()} ctx tokens)`);
  }

  // OpenAI-format message history
  const messages: ProviderMessage[] = [
    { role: 'user', content: userTask },
  ];

  // ── Upgrade 1: Pre-loop planning step (implement mode only) ─────────────────
  // One focused LLM call — no tools, no iteration budget consumed — that forces
  // the model to decompose the task before touching any file.  The resulting
  // plan is injected as the first assistant turn so every subsequent iteration
  // can reference it.  Failure here is non-fatal: we silently continue without.
  if (executionMode === 'implement') {
    if (progressCallback) {
      await progressCallback('📋 *Planning phase* — decomposing task before execution...');
    }
    try {
      const planMessages: ProviderMessage[] = [
        {
          role: 'user',
          content:
            `Before writing any code, produce a concise numbered implementation plan for:\n\n${userTask}\n\n` +
            `Your plan must cover:\n` +
            `1. Files to READ first (understand existing patterns before changing anything)\n` +
            `2. Files to CREATE or MODIFY — one line each explaining the specific change\n` +
            `3. Shared libs, types, or services involved\n` +
            `4. Risks or unknowns that need investigation\n\n` +
            `Be concrete. Max 12 numbered items. No code — just the plan.`,
        },
      ];
      const planResponse = await provider.chat(planMessages, [], {
        maxTokens: 1024,
        systemBlocks,
        repoPaths,
      });
      if (planResponse.text.trim()) {
        messages.push({ role: 'assistant', content: planResponse.text.trim() });
        messages.push({ role: 'user', content: 'Good plan. Now execute it step by step using tools.' });
        if (progressCallback) {
          const preview = planResponse.text.trim().slice(0, 380);
          await progressCallback(
            `📋 *Implementation plan:*\n\`\`\`\n${preview}${planResponse.text.length > 380 ? '\n…' : ''}\n\`\`\``
          );
        }
      }
    } catch {
      // Planning is non-fatal — continue without it
    }
  }

  let iteration = 0;
  let lastTextResponse = '';
  let webSearchCount = 0;
  const MAX_WEB_SEARCHES = 3;

  // Deduplicate file reads — prevents infinite loops where the model re-reads the same files
  const filesAlreadyRead = new Set<string>();

  // Batch Slack messages: accumulate read_file calls and post as a single summary
  const pendingReadSummaries: string[] = [];
  let pendingReadFlushTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushPendingReads(): Promise<void> {
    if (pendingReadSummaries.length === 0 || !progressCallback) return;
    if (pendingReadFlushTimer) { clearTimeout(pendingReadFlushTimer); pendingReadFlushTimer = null; }
    const batch = pendingReadSummaries.splice(0);
    await progressCallback(`📂 *Reading files* (${batch.length}):\n${batch.map((f) => `  • ${f}`).join('\n')}`);
  }

  while (iteration < maxIterations) {
    iteration++;

    if (progressCallback && iteration > 1) {
      await progressCallback(`🔄 Step ${iteration}/${maxIterations}...`);
    }

    // Upgrade 2: Compress old tool results before sending to provider.
    // messagesForProvider is a read-only view — messages[] is never mutated here.
    const messagesForProvider = compressOldToolResults(messages);

    // Call provider with cascading fallback through all tiers on error
    const chatOptions = { maxTokens, systemBlocks, repoPaths };
    let response = await provider.chat(messagesForProvider, activeTools, chatOptions).catch(
      async (err: unknown) => {
        const errMsg = String(err);
        // Retry with next tiers for transient/compatibility errors
        if (/400|404|429|503|502|ECONNRESET|timeout|rate.?limit/i.test(errMsg)) {
          if (progressCallback) {
            await progressCallback(`⚠️ Provider \`${provider.providerName}\` error (${errMsg.slice(0, 80)}), falling back to next tier...`);
          }
          // Try tier 1, then tier 2 (Claude CLI), cascading until something works
          for (const tier of [1, 2, 999]) {
            const fallback = ProviderRouter.selectAtTier(tier);
            if (fallback.providerName === provider.providerName) continue; // skip same provider
            try {
              return await fallback.chat(messages, activeTools, chatOptions);
            } catch (fallbackErr) {
              if (tier === 999) throw fallbackErr; // exhausted all tiers
              if (progressCallback) {
                await progressCallback(`⚠️ Tier ${tier} (${fallback.providerName}) also failed, trying next...`);
              }
            }
          }
        }
        throw err;
      }
    );

    if (response.text.trim()) {
      lastTextResponse = response.text;
    }

    if (response.stopReason === 'end_turn' || response.stopReason === 'error') break;

    if (response.stopReason === 'tool_use' && response.toolCalls.length > 0) {
      // Add assistant message with tool calls (OpenAI format)
      messages.push({
        role: 'assistant',
        content: response.text || null,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });

      // Flush any pending read summaries before non-read tool calls
      await flushPendingReads();

      // Execute each tool call and append tool result messages
      for (const toolCall of response.toolCalls) {
        const isReadOp = toolCall.name === 'read_file' || toolCall.name === 'read_file_section';

        // Deduplicate reads — if the model asks for the same file twice, short-circuit
        if (isReadOp && toolCall.input.relative_path) {
          const readKey = `${String(toolCall.input.repo ?? repoAlias)}/${String(toolCall.input.relative_path)}`;
          if (filesAlreadyRead.has(readKey)) {
            // Return cached hint instead of re-reading
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({ success: false, error: 'Already read this file. Use the content from earlier in context.' }),
            });
            continue;
          }
          filesAlreadyRead.add(readKey);
          // Batch into pending summary instead of individual Slack message
          pendingReadSummaries.push(buildInputSummary(toolCall.name, toolCall.input));
          // Schedule a timer flush after first read is queued (500ms debounce)
          if (pendingReadSummaries.length === 1 && progressCallback) {
            pendingReadFlushTimer = setTimeout(() => { flushPendingReads().catch(() => {}); }, 500);
          }
          if (pendingReadSummaries.length >= 5) await flushPendingReads();
        } else {
          // Non-read tool: flush pending reads first, then post this tool immediately
          await flushPendingReads();
          const emoji = TOOL_EMOJI[toolCall.name] ?? '🔧';
          const inputSummary = buildInputSummary(toolCall.name, toolCall.input);
          if (progressCallback) {
            await progressCallback(`${emoji} *${toolCall.name}* ${inputSummary}`);
          }
        }

        // Track files written for session memory
        if (toolCall.name === 'write_file' && toolCall.input.relative_path) {
          const fp = `${String(toolCall.input.repo ?? repoAlias)}/${String(toolCall.input.relative_path)}`;
          if (!filesModified.includes(fp)) filesModified.push(fp);
        }

        let result: unknown;
        try {
          if (toolCall.name === 'web_search') {
            if (webSearchCount >= MAX_WEB_SEARCHES) {
              result = { success: false, error: `web_search limit reached (${MAX_WEB_SEARCHES} max per session). Use repo read tools instead.` };
            } else {
              webSearchCount++;
              result = await executeToolCall(toolCall.name, toolCall.input);
            }
          } else {
            result = await executeToolCall(toolCall.name, toolCall.input);
          }
        } catch (err) {
          result = { success: false, error: `Tool execution error: ${String(err)}` };
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      // Upgrade 3: Mid-loop reflection trigger
      // Every REFLECTION_INTERVAL iterations, inject a user message that prompts
      // the model to reassess its plan before continuing.  The guard conditions
      // prevent double-triggering and ensure we don't fire on the last iteration
      // (no point reflecting when there is no budget left).
      if (
        executionMode === 'implement' &&
        iteration % REFLECTION_INTERVAL === 0 &&
        iteration > lastReflectionIteration &&
        iteration < maxIterations - 1
      ) {
        lastReflectionIteration = iteration;
        messages.push({
          role: 'user',
          content:
            `[Auto-reflection — step ${iteration}/${maxIterations}] ` +
            `Briefly review your progress before continuing:\n` +
            `1. Which files have you modified or created so far?\n` +
            `2. Is your original plan still accurate, or do you need to adjust it?\n` +
            `3. What is your single most important next action?\n\n` +
            `Answer in 2-3 sentences, then IMMEDIATELY call a tool to continue.`,
        });
        if (progressCallback) {
          await progressCallback(`🔍 *Reflection checkpoint* at step ${iteration}/${maxIterations} — reviewing plan...`);
        }
      }

      // Upgrade 4: Save checkpoint after each iteration so a crashed process can
      // resume from the last known good state rather than restarting from scratch.
      await checkpointManager.save({
        iteration,
        messages,
        filesModified: [...filesModified],
        webSearchCount,
      }).catch(() => {}); // non-fatal — never block execution for checkpoint I/O

      continue;
    }

    // Unexpected stop reason or empty tool calls
    break;
  }

  // Flush any remaining batched read summaries before recording session end
  await flushPendingReads();

  if (iteration >= maxIterations) {
    lastTextResponse +=
      `\n\n⚠️ Reached step limit (${maxIterations}). ` +
      `Task may be incomplete — review changes and continue manually if needed.`;
  }

  // Record session outcome in episodic memory (success or failure)
  session.filesModified = filesModified;
  // providerUsed is typed as optional string on AgentSession
  session.providerUsed = provider.providerName;
  const sessionOutcome: AgentSession['outcome'] = lastTextResponse ? 'success' : 'failed';
  await memoryManager.recordSessionEnd(session, sessionOutcome).catch(() => {});

  // Upgrade 4: Remove checkpoint file on success — it served its purpose.
  // On failure we leave it in place so it can be inspected or replayed.
  if (sessionOutcome === 'success') {
    await checkpointManager.cleanup().catch(() => {});
  }

  // Auto-update AGENT_CONTEXT.md if new services/libs were added (breaking structural change)
  if (executionMode === 'implement' && filesModified.length > 0) {
    await maybeUpdateAgentContext(repoAlias).catch(() => {});
  }

  return {
    text: lastTextResponse || '*(Agent completed without producing a text summary)*',
    filesModified,
    session,
  };
}
