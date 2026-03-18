import fs from 'fs/promises';
import path from 'path';
import { toolDefinitions, readOnlyToolDefinitions, questionToolDefinitions, executeToolCall } from './tools.js';
import { getRepoConfig, addRepo } from './config.js';
import { type ExecutionMode } from './classifier.js';
import { ProviderRouter } from './providers/router.js';
import type { ProviderMessage, ProviderSystemBlock, ProviderTool } from './providers/types.js';
import { memoryManager } from './memory/memory-manager.js';
import type { AgentSession } from './types.js';
import { detectProject } from './project-detector.js';

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
      ? 'read_file, read_file_section, list_directory, search_files, write_file, run_command, git_status, git_diff, git_create_branch, git_commit, web_search'
      : executionMode === 'question'
      ? 'read_file, read_file_section, list_directory, search_files, git_status, git_diff'
      : 'read_file, read_file_section, list_directory, search_files, git_status, git_diff, web_search';

  // Dynamic session block — changes per request, never cache
  const sessionLines = [
    serviceContext ? `\n\n## Target Service Override Context\n${serviceContext}` : '',
    `\n\n---\n## Active Agent Session`,
    `- **Repo**: \`${repoAlias}\` at \`${repo.path}\``,
    `- **srcDir**: \`${repo.srcDir}/\``,
    `- **Runtime**: ${repo.runtime}`,
    `- **Build command**: \`${repo.buildScript}\``,
    `- **Lint command**: \`${repo.lintScript}\``,
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
): Promise<string> {
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

    // Call provider with cascading fallback through all tiers on error
    const chatOptions = { maxTokens, systemBlocks, repoPaths };
    let response = await provider.chat(messages, activeTools, chatOptions).catch(
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

  // Auto-update AGENT_CONTEXT.md if new services/libs were added (breaking structural change)
  if (executionMode === 'implement' && filesModified.length > 0) {
    await maybeUpdateAgentContext(repoAlias).catch(() => {});
  }

  return lastTextResponse || '*(Agent completed without producing a text summary)*';
}
