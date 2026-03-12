import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import {
  toolDefinitions,
  readOnlyToolDefinitions,
  executeToolCall,
} from "./tools.js";
import { getRepoConfig } from "./config.js";
import { HAIKU_MODEL, SONNET_MODEL, type ExecutionMode } from "./classifier.js";

const client = new Anthropic();

// Iteration budgets per execution mode
const ITERATION_LIMITS: Record<ExecutionMode, number> = {
  question: 4,
  research: 6,
  implement: 12,
};

// Models per execution mode
const MODELS: Record<ExecutionMode, string> = {
  question: HAIKU_MODEL,
  research: SONNET_MODEL,
  implement: SONNET_MODEL,
};

// max_tokens per execution mode (smaller for Q&A, larger for implementation)
const MAX_TOKENS: Record<ExecutionMode, number> = {
  question: 2048,
  research: 4096,
  implement: 8096,
};

// Workflow instructions injected into system prompt per mode
const WORKFLOW_INSTRUCTIONS: Record<ExecutionMode, string> = {
  question: `## Response Instructions
Answer the user's question concisely. Use read tools only to look up information needed to answer.
Do NOT write files. Keep your final answer clear and direct.`,

  research: `## Response Instructions
Research the codebase and provide a thorough analysis. Use read tools freely.
Do NOT write files. End with a clear, structured summary of your findings.`,

  implement: `## Execution Workflow (follow strictly in order)
1. **EXPLORE** — Use search_files and read_file to understand the relevant code first. Find the entry points, existing patterns, and anything that affects your change.
2. **PLAN** — Before writing any file, state your implementation plan explicitly: list each file to modify and what change you'll make.
3. **IMPLEMENT** — Execute your plan: read each file fully before writing it, follow the repo's existing patterns and conventions.
4. **VERIFY** — Run the build/lint commands after all writes. Fix any TypeScript or lint errors.
5. **REPORT** — In your final response, list every file you created or modified with its relative path.`,
};

export type ProgressCallback = (update: string) => Promise<void>;

// Tool emoji for Slack progress updates
const TOOL_EMOJI: Record<string, string> = {
  read_file: "📂",
  read_file_section: "📖",
  write_file: "✍️",
  list_directory: "📁",
  search_files: "🔍",
  run_command: "⚡",
};

export async function buildSystemPromptBlocks(
  repoAlias: string,
  serviceHint?: string,
  executionMode: ExecutionMode = "implement"
): Promise<Anthropic.TextBlockParam[]> {
  const config = await getRepoConfig();
  const repo = config.repos[repoAlias];
  if (!repo) {
    throw new Error(
      `Repo not found: "${repoAlias}". Available: ${Object.keys(config.repos).join(", ")}`
    );
  }

  // Load AGENT_CONTEXT.md — this is the large static section we cache
  const contextPath = path.join(repo.path, "AGENT_CONTEXT.md");
  let repoContext: string;
  try {
    repoContext = await fs.readFile(contextPath, "utf-8");
  } catch {
    throw new Error(
      `AGENT_CONTEXT.md not found at ${contextPath}.\n` +
        `Run "register project ${repoAlias} at ${repo.path}" or create AGENT_CONTEXT.md manually.`
    );
  }

  // Optionally load service-level context
  let serviceContext = "";
  if (serviceHint) {
    const svcPath = path.join(repo.path, repo.srcDir, serviceHint, "SERVICE_CONTEXT.md");
    try {
      serviceContext = await fs.readFile(svcPath, "utf-8");
    } catch {
      // Optional — silently skip
    }
  }

  const toolNames =
    executionMode === "implement"
      ? "read_file, read_file_section, list_directory, search_files, write_file, run_command"
      : "read_file, read_file_section, list_directory, search_files";

  // Dynamic session block — NOT cached (changes per request)
  const sessionLines = [
    serviceContext ? `\n\n## Target Service Override Context\n${serviceContext}` : "",
    `\n\n---\n## Active Agent Session`,
    `- **Repo**: \`${repoAlias}\` at \`${repo.path}\``,
    `- **srcDir**: \`${repo.srcDir}/\``,
    `- **Runtime**: ${repo.runtime}`,
    `- **Build command**: \`${repo.buildScript}\``,
    `- **Lint command**: \`${repo.lintScript}\``,
    serviceHint
      ? `- **Target service**: \`${serviceHint}\` (at \`${repo.srcDir}/${serviceHint}/\`)`
      : "- **Target service**: not specified",
    `- **Available tools**: ${toolNames}`,
    "",
    "## Agent Rules",
    "1. Read before writing — always call read_file before write_file on existing files.",
    "2. Stay in scope — only modify target service unless task requires shared lib changes.",
    "3. Path aliases — use the repo's import aliases, never relative cross-lib imports.",
    "4. No secrets — never write API keys, tokens, or credentials into source files.",
    "5. Report all changes — list every file created/modified in final response.",
    "",
    WORKFLOW_INSTRUCTIONS[executionMode],
  ]
    .filter(Boolean)
    .join("\n");

  return [
    // Static AGENT_CONTEXT.md — mark as cacheable (>1024 tokens, stable per repo)
    {
      type: "text",
      text: repoContext,
      cache_control: { type: "ephemeral" },
    } as Anthropic.TextBlockParam & { cache_control: { type: "ephemeral" } },
    // Dynamic session info — not cached
    {
      type: "text",
      text: sessionLines,
    },
  ];
}

export async function runAgentLoop(
  repoAlias: string,
  userTask: string,
  serviceHint?: string,
  progressCallback?: ProgressCallback,
  executionMode: ExecutionMode = "implement"
): Promise<string> {
  const systemBlocks = await buildSystemPromptBlocks(repoAlias, serviceHint, executionMode);

  const activeTools =
    executionMode === "implement" ? toolDefinitions : readOnlyToolDefinitions;
  const model = MODELS[executionMode];
  const maxTokens = MAX_TOKENS[executionMode];
  const maxIterations = ITERATION_LIMITS[executionMode];

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userTask },
  ];

  let iteration = 0;
  let lastTextResponse = "";

  while (iteration < maxIterations) {
    iteration++;

    if (progressCallback && iteration > 1) {
      await progressCallback(`🔄 Step ${iteration}/${maxIterations}...`);
    }

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemBlocks as Anthropic.TextBlockParam[],
      tools: activeTools as Anthropic.Tool[],
      messages,
    });

    // Capture text blocks
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        lastTextResponse = block.text;
      }
    }

    if (response.stop_reason === "end_turn") break;

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        const emoji = TOOL_EMOJI[block.name] ?? "🔧";
        const inp = block.input as Record<string, string>;

        // Build short human-readable summary
        const inputSummary = (() => {
          if (["read_file", "write_file", "list_directory", "read_file_section"].includes(block.name)) {
            return `\`${inp.repo}/${inp.relative_path}\``;
          }
          if (block.name === "search_files") {
            return `\`${inp.pattern}\` in \`${inp.repo}/${inp.relative_path || "."}\``;
          }
          if (block.name === "run_command") {
            return `\`${inp.command}\`${inp.relative_cwd ? ` in \`${inp.relative_cwd}\`` : ""}`;
          }
          return JSON.stringify(inp).slice(0, 80);
        })();

        if (progressCallback) {
          await progressCallback(`${emoji} *${block.name}* ${inputSummary}`);
        }

        let result: unknown;
        try {
          result = await executeToolCall(block.name, block.input as Record<string, unknown>);
        } catch (err) {
          result = { success: false, error: `Tool execution error: ${String(err)}` };
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push(
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults }
      );
      continue;
    }

    // Unexpected stop reason
    break;
  }

  if (iteration >= maxIterations) {
    lastTextResponse +=
      `\n\n⚠️ Reached step limit (${maxIterations}). ` +
      `Task may be incomplete — review changes and continue manually if needed.`;
  }

  return lastTextResponse || "*(Agent completed without producing a text summary)*";
}
