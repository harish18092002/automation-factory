import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { toolDefinitions, executeToolCall } from './tools';
import repoConfig from './repos.config.json';

// Reads ANTHROPIC_API_KEY from environment automatically
const client = new Anthropic();

const MAX_ITERATIONS = 30;
const MODEL = 'claude-sonnet-4-20250514';

type RepoKey = keyof typeof repoConfig.repos;

export async function buildSystemPrompt(
  repoAlias: string,
  serviceHint?: string
): Promise<string> {
  const repo = (repoConfig.repos as Record<string, (typeof repoConfig.repos)[RepoKey]>)[repoAlias];
  if (!repo) {
    throw new Error(
      `Repo not found: "${repoAlias}". Available: ${Object.keys(repoConfig.repos).join(', ')}`
    );
  }

  // Load AGENT_CONTEXT.md from the repo root
  const contextPath = path.join(repo.path, 'AGENT_CONTEXT.md');
  let repoContext: string;
  try {
    repoContext = await fs.readFile(contextPath, 'utf-8');
  } catch {
    throw new Error(
      `AGENT_CONTEXT.md not found at ${contextPath}.\n` +
        `Please copy the relevant block from agent/AGENT_CONTEXT_TEMPLATE.md to ${contextPath} first.`
    );
  }

  // Optionally load a service-level context file
  let serviceContext = '';
  if (serviceHint) {
    const svcContextPath = path.join(repo.path, repo.srcDir, serviceHint, 'SERVICE_CONTEXT.md');
    try {
      serviceContext = await fs.readFile(svcContextPath, 'utf-8');
    } catch {
      // Service-level context is optional — silently skip if not found
    }
  }

  const sections: string[] = [
    repoContext,
    serviceContext
      ? `\n\n## Target Service Override Context\n${serviceContext}`
      : '',
    `\n\n---\n## Active Agent Session`,
    `- **Repo**: \`${repoAlias}\` at \`${repo.path}\``,
    `- **srcDir**: \`${repo.srcDir}/\``,
    `- **Runtime**: ${repo.runtime}`,
    `- **Build command**: \`${repo.buildScript}\``,
    serviceHint
      ? `- **Target service**: \`${serviceHint}\` (at \`${repo.srcDir}/${serviceHint}/\`)`
      : '- **Target service**: not specified — you may need to clarify with the user',
    '',
    '## Agent Rules (always follow)',
    '1. **Read before writing** — always call `read_file` before `write_file` on any existing file.',
    '2. **Stay in scope** — only modify files inside the target service unless the task explicitly requires shared lib changes. If shared lib changes are needed, state this clearly.',
    '3. **Verify compilation** — after all file writes, run the repo build/lint command to confirm no TypeScript errors.',
    '4. **Path aliases** — always use the repo\'s import path aliases (never relative cross-lib imports).',
    '5. **Report all changes** — in your final response, list every file you created or modified with its relative path.',
    '6. **No secrets** — never write API keys, tokens, or credentials into source files.',
    `7. **Available tools**: read_file, write_file, list_directory, run_command`,
  ];

  return sections.filter(Boolean).join('\n');
}

export type ProgressCallback = (update: string) => Promise<void>;

export async function runAgentLoop(
  repoAlias: string,
  userTask: string,
  serviceHint?: string,
  progressCallback?: ProgressCallback
): Promise<string> {
  const systemPrompt = await buildSystemPrompt(repoAlias, serviceHint);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userTask },
  ];

  let iteration = 0;
  let lastTextResponse = '';

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    if (progressCallback && iteration > 1) {
      await progressCallback(`🔄 Iteration ${iteration}/${MAX_ITERATIONS}...`);
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8096,
      system: systemPrompt,
      tools: toolDefinitions as Anthropic.Tool[],
      messages,
    });

    // Capture any text blocks
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        lastTextResponse = block.text;
      }
    }

    // Terminal condition
    if (response.stop_reason === 'end_turn') {
      break;
    }

    // Tool use loop
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const toolEmoji: Record<string, string> = {
          read_file: '📂',
          write_file: '✍️',
          list_directory: '📁',
          run_command: '⚡',
        };
        const emoji = toolEmoji[block.name] ?? '🔧';

        // Build a short human-readable summary of the tool call input
        const inputSummary = (() => {
          const inp = block.input as Record<string, string>;
          if (block.name === 'read_file' || block.name === 'write_file' || block.name === 'list_directory') {
            return `\`${inp.repo}/${inp.relative_path}\``;
          }
          if (block.name === 'run_command') {
            return `\`${inp.command}\`${inp.relative_cwd ? ` in \`${inp.relative_cwd}\`` : ''}`;
          }
          return JSON.stringify(inp).slice(0, 80);
        })();

        if (progressCallback) {
          await progressCallback(`${emoji} *${block.name}* ${inputSummary}`);
        }

        let result: unknown;
        try {
          result = await executeToolCall(
            block.name,
            block.input as Record<string, string>
          );
        } catch (err) {
          result = {
            success: false,
            error: `Tool execution error: ${String(err)}`,
          };
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      // Append assistant message + tool results to conversation
      messages.push(
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults }
      );

      continue;
    }

    // Unexpected stop reason — break to avoid infinite loop
    break;
  }

  if (iteration >= MAX_ITERATIONS) {
    lastTextResponse +=
      `\n\n⚠️ Agent reached the maximum iteration limit (${MAX_ITERATIONS}). ` +
      `The task may be incomplete. Review the changes made so far and continue manually if needed.`;
  }

  return lastTextResponse || '*(Agent completed without producing a text summary)*';
}
