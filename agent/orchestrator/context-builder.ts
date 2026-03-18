import fs from 'fs/promises';
import path from 'path';
import { getRepoConfig } from '../config.js';
import type { SubTask, MemoryBundle } from '../types.js';
import type { ProviderSystemBlock } from '../providers/types.js';
import type { ExecutionMode } from '../classifier.js';

const WORKFLOW_INSTRUCTIONS: Record<ExecutionMode, string> = {
  question: `## Response Instructions\nAnswer concisely using read tools only. Do NOT write files.`,
  research: `## Response Instructions\nResearch the codebase thoroughly. Do NOT write files. End with a structured summary.`,
  implement: `## Execution Workflow\n1. EXPLORE — search/read relevant code\n2. PLAN — state your plan explicitly\n3. IMPLEMENT — read before writing, follow repo patterns\n4. VERIFY — run build/lint after writes\n5. REPORT — list all modified files`,
};

/**
 * Builds the isolated system prompt blocks for a worker agent.
 * Each worker gets only the context relevant to its specific subtask.
 * Solves the "context problem": workers share knowledge without sharing token budgets.
 */
export class ContextBuilder {
  async buildForSubTask(
    subTask: SubTask,
    memoryBundle: MemoryBundle,
    options: {
      totalSubTasks?: number;
      completedDependencySummaries?: string[];
      maxMemoryTokens?: number;
    } = {}
  ): Promise<ProviderSystemBlock[]> {
    const config = await getRepoConfig();
    const repo = config.repos[subTask.repoAlias];
    if (!repo) throw new Error(`Unknown repo: ${subTask.repoAlias}`);

    const maxMemoryTokens = options.maxMemoryTokens ?? 2000;

    // ── Block 1: AGENT_CONTEXT.md (cacheable — large, stable) ────────────────
    const contextPath = path.join(repo.path, 'AGENT_CONTEXT.md');
    let repoContext: string;
    try {
      repoContext = await fs.readFile(contextPath, 'utf-8');
    } catch {
      repoContext = `# ${subTask.repoAlias}\nNo AGENT_CONTEXT.md found.`;
    }

    // ── Block 2: Memory fragment (cacheable if large enough) ─────────────────
    const { skillsText, factsText } = buildMemoryBlocks(
      memoryBundle,
      subTask.description,
      maxMemoryTokens
    );

    // ── Block 3: Dynamic subtask context (never cache) ────────────────────────
    const toolNames = subTask.executionMode === 'implement'
      ? 'read_file, read_file_section, list_directory, search_files, write_file, run_command, git_status, git_diff, git_create_branch, git_commit, web_search'
      : 'read_file, read_file_section, list_directory, search_files, git_status, git_diff, web_search';

    const sessionLines = [
      `## Active Agent Session`,
      `- **Repo**: \`${subTask.repoAlias}\` at \`${repo.path}\``,
      `- **srcDir**: \`${repo.srcDir}/\``,
      `- **Runtime**: ${repo.runtime}`,
      `- **Build**: \`${repo.buildScript}\` | **Lint**: \`${repo.lintScript}\``,
      subTask.serviceHint
        ? `- **Target service**: \`${subTask.serviceHint}\``
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
      WORKFLOW_INSTRUCTIONS[subTask.executionMode],
    ];

    // Add subtask context if part of a multi-task plan
    if (options.totalSubTasks && options.totalSubTasks > 1) {
      sessionLines.push(
        '',
        `## SubTask Context`,
        `You are working on subtask \`${subTask.id}\` (priority ${subTask.priority}) as part of a ${options.totalSubTasks}-task plan.`,
        `Your specific responsibility: ${subTask.description}`
      );
    }

    // Add dependency summaries if available
    if (options.completedDependencySummaries && options.completedDependencySummaries.length > 0) {
      sessionLines.push(
        '',
        '## Completed Dependencies',
        ...options.completedDependencySummaries.map((s, i) => `${i + 1}. ${s}`)
      );
    }

    const blocks: ProviderSystemBlock[] = [
      // Block 1: Large static context — cache
      { text: repoContext, cache: true },
    ];

    // Block 2: Memory (cache only if substantial)
    const memoryText = [skillsText, factsText].filter(Boolean).join('\n\n');
    if (memoryText.length > 100) {
      blocks.push({ text: memoryText, cache: true });
    }

    // Block 3: Dynamic session — never cache
    blocks.push({ text: sessionLines.join('\n'), cache: false });

    return blocks;
  }
}

function buildMemoryBlocks(
  bundle: MemoryBundle,
  _taskDescription: string,
  maxTokensBudget: number
): { skillsText: string; factsText: string } {
  const tokenBudgetPerSection = Math.floor(maxTokensBudget / 2);

  let skillsText = '';
  if (bundle.relevantSkills.length > 0) {
    const lines = ['## Memory: Learned Patterns'];
    let budget = tokenBudgetPerSection;
    for (const skill of bundle.relevantSkills) {
      const line = `- ${skill.prompt}`;
      const approxTokens = line.length / 4;
      if (budget - approxTokens < 0) break;
      lines.push(line);
      budget -= approxTokens;
    }
    if (lines.length > 1) skillsText = lines.join('\n');
  }

  let factsText = '';
  if (bundle.relevantFacts.length > 0) {
    const lines = ['## Memory: Known Facts'];
    let budget = tokenBudgetPerSection;
    for (const fact of bundle.relevantFacts) {
      const line = `- [${fact.category}] ${fact.subject}: ${fact.content}`;
      const approxTokens = line.length / 4;
      if (budget - approxTokens < 0) break;
      lines.push(line);
      budget -= approxTokens;
    }
    if (lines.length > 1) factsText = lines.join('\n');
  }

  return { skillsText, factsText };
}

export const contextBuilder = new ContextBuilder();
