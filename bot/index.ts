import { App, SocketModeReceiver } from "@slack/bolt";
import OpenAI from "openai";
import path from "path";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import "dotenv/config";

const execAsync = promisify(exec);
import { runAgentLoop } from "../agent/loop.js";
import { getRepoConfig, getRepoAliases, addRepo } from "../agent/config.js";
import { gitAutomation } from "../agent/git/git-automation.js";
import type { GitFlowResult, AgentSession } from "../agent/types.js";
import { classifyTask } from "../agent/classifier.js";
import { detectProject } from "../agent/project-detector.js";
import type { ExecutionMode } from "../agent/classifier.js";

// ── Env validation ─────────────────────────────────────────────────────────
// At least one AI provider key is required
const REQUIRED_ENV = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
if (
  !process.env.GROQ_API_KEY &&
  !process.env.DEEPSEEK_API_KEY &&
  !process.env.GEMINI_API_KEY
) {
  console.warn(
    "⚠️  No AI provider API keys found. Set GROQ_API_KEY, DEEPSEEK_API_KEY, or GEMINI_API_KEY. Falling back to Claude CLI.",
  );
}

// ── Pending tasks awaiting confirm (approve/cancel buttons) ────────────────
// TTL map: each entry has a cleanup timer to prevent indefinite accumulation
const PENDING_TASK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const pendingTaskTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTasks = new Map<
  string,
  { intent: ParsedIntent; channelId: string; threadTs: string }
>();

function storePendingTask(
  taskId: string,
  value: { intent: ParsedIntent; channelId: string; threadTs: string },
): void {
  pendingTasks.set(taskId, value);
  const timer = setTimeout(() => {
    pendingTasks.delete(taskId);
    pendingTaskTimers.delete(taskId);
  }, PENDING_TASK_TTL_MS);
  pendingTaskTimers.set(taskId, timer);
}

function consumePendingTask(
  taskId: string,
): { intent: ParsedIntent; channelId: string; threadTs: string } | undefined {
  const value = pendingTasks.get(taskId);
  if (value !== undefined) {
    pendingTasks.delete(taskId);
    const timer = pendingTaskTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      pendingTaskTimers.delete(taskId);
    }
  }
  return value;
}

// ── Pending MR gate (post-implementation, pre-push) ────────────────────────
// After the agent loop completes the user is shown a "Create MR / Reject" gate
// before any git push happens.  Same TTL + timer pattern as pendingTasks above.
interface PendingGitTask {
  intent: ParsedIntent;
  filesModified: string[];
  session: AgentSession;
  agentSummary: string;
  channelId: string;
  threadTs: string;
}

const PENDING_GIT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const pendingGitTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingGitTasks = new Map<string, PendingGitTask>();

function storePendingGitTask(gitTaskId: string, value: PendingGitTask): void {
  pendingGitTasks.set(gitTaskId, value);
  const timer = setTimeout(() => {
    pendingGitTasks.delete(gitTaskId);
    pendingGitTimers.delete(gitTaskId);
  }, PENDING_GIT_TTL_MS);
  pendingGitTimers.set(gitTaskId, timer);
}

function consumePendingGitTask(gitTaskId: string): PendingGitTask | undefined {
  const value = pendingGitTasks.get(gitTaskId);
  if (value !== undefined) {
    pendingGitTasks.delete(gitTaskId);
    const timer = pendingGitTimers.get(gitTaskId);
    if (timer) {
      clearTimeout(timer);
      pendingGitTimers.delete(gitTaskId);
    }
  }
  return value;
}

// ── Slack App (Socket Mode — no public URL required) ───────────────────────
// Create the receiver manually so we can increase the ping-pong timeout.
// The default 5 s clientPingTimeout causes rapid reconnect loops on higher-
// latency or occasionally lossy connections.  30 s is more tolerant.
const socketReceiver = new SocketModeReceiver({
  appToken: process.env.SLACK_APP_TOKEN!,
});
// Patch the timeout on the already-constructed SocketModeClient instance.
// This value is read each time a new WebSocket is opened (on connect / reconnect).
(
  socketReceiver.client as unknown as { clientPingTimeoutMS: number }
).clientPingTimeoutMS = 30_000;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  receiver: socketReceiver,
});

// Intent parsing uses Groq (fastest/cheapest) or DeepSeek as fallback.
// In non-personal mode (IS_OPEN_SOURCE_MODE !== 'yes') no API keys are used — returns no client
// so parseIntent falls back to classifier result and the agent loop uses Claude CLI.
function getIntentClient(): { client: OpenAI; model: string } {
  if (process.env.IS_OPEN_SOURCE_MODE !== "yes") {
    return {
      client: new OpenAI({
        apiKey: "placeholder",
        baseURL: "https://api.groq.com/openai/v1",
      }),
      model: "",
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      client: new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1",
      }),
      model: "llama-3.1-8b-instant",
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      client: new OpenAI({
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com",
      }),
      model: "deepseek-chat",
    };
  }
  return {
    client: new OpenAI({
      apiKey: "placeholder",
      baseURL: "https://api.groq.com/openai/v1",
    }),
    model: "",
  };
}

// ── Intent types ───────────────────────────────────────────────────────────
interface ParsedIntent {
  /** Primary repo alias */
  repo: string;
  /** All repos involved (for multi-repo tasks) */
  repos: string[];
  service: string | null;
  taskType:
    | "feature"
    | "bugfix"
    | "refactor"
    | "test"
    | "question"
    | "research"
    | "other";
  executionMode: ExecutionMode;
  /** Short kebab-case label for branch names */
  description: string;
  /** Full task instruction forwarded to agent loop */
  fullTask: string;
  needsWebSearch: boolean;
}

// ── Direct alias matcher ───────────────────────────────────────────────────
// Check if a repo alias appears verbatim in the message (word boundary match).
// This handles "in my-api", "my-api repo", "the my-frontend project", etc.
// We do this BEFORE any LLM call because LLMs can confuse repo aliases with
// same-named services (e.g. "auth" alias vs "auth-service" service name).
function findDirectAlias(message: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    // Escape special regex chars in alias, then match as a whole word
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(message)) {
      return alias;
    }
  }
  return null;
}

// ── Intent parser ──────────────────────────────────────────────────────────
// Uses direct alias matching first (fast, reliable), then LLM for everything else.
async function parseIntent(
  userMessage: string,
  executionMode: ExecutionMode,
  classifiedRepos: string[],
): Promise<ParsedIntent | null> {
  const config = await getRepoConfig();
  const repoAliases = Object.keys(config.repos);

  // Fast path: if the user named a repo alias explicitly, trust that over the LLM
  const directAlias = findDirectAlias(userMessage, repoAliases);

  // Determine the confirmed repo (direct match wins over classifier hint)
  const confirmedRepo = directAlias ?? classifiedRepos[0] ?? null;

  // Build compact repo summary for LLM context (1 line each — scales to 100+ repos)
  const repoSummary = repoAliases
    .map((alias) => {
      const r = config.repos[alias];
      const desc = r.description ?? `${r.type}, ${r.services.length} services`;
      return `  "${alias}": ${desc}`;
    })
    .join("\n");

  // If we already know the repo, anchor it firmly in the prompt so the LLM doesn't override it
  const repoInstruction = confirmedRepo
    ? `\nThe repo is CONFIRMED as "${confirmedRepo}". Set "repo" to "${confirmedRepo}" in your response.`
    : "\nIf you cannot determine the repo, set repo to null.";

  const { client: intentClient, model: intentModel } = getIntentClient();
  if (!intentModel) {
    // No provider available — return minimal intent if we have a confirmed repo
    if (confirmedRepo) {
      return {
        repo: confirmedRepo,
        repos: [confirmedRepo],
        service: null,
        taskType: "other",
        executionMode,
        description: "agent-task",
        fullTask: userMessage,
        needsWebSearch: false,
      };
    }
    return null;
  }

  const systemPrompt = [
    "You are a strict intent-parsing assistant for a multi-repo engineering bot.",
    "",
    "Available repos:",
    repoSummary,
    repoInstruction,
    "",
    "Extract a JSON object. Respond with ONLY valid JSON — no markdown, no backticks.",
    "IMPORTANT RULES:",
    "- taskType must match the user's actual intent. 'What does X do?' → 'question'. 'Explain X' → 'research'. Only use 'refactor'/'feature'/'bugfix' if the user explicitly asks to change code.",
    "- fullTask must be the user's original message VERBATIM. Do NOT rephrase, expand, or transform it.",
    "- needsWebSearch must be false for questions about repo code — the agent can read the repo files directly.",
    "",
    "Schema:",
    "{",
    '  "repo": string,           // primary repo alias (must match exactly), or null if unclear',
    '  "repos": string[],        // ALL repo aliases involved (can be multiple for cross-repo tasks)',
    '  "service": string|null,   // service name within the primary repo, or null',
    '  "taskType": "feature"|"bugfix"|"refactor"|"test"|"question"|"research"|"other",',
    '  "description": string,    // max 50 chars, kebab-case, suitable for a git branch name',
    '  "fullTask": string,       // VERBATIM copy of the user\'s message — do NOT rephrase or expand',
    '  "needsWebSearch": boolean // true ONLY if task needs external docs/APIs not in the repo',
    "}",
  ].join("\n");

  const res = await intentClient.chat.completions.create({
    model: intentModel,
    max_tokens: 400,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  try {
    const text = res.choices[0]?.message.content ?? "";
    const raw = JSON.parse(text) as Omit<ParsedIntent, "executionMode">;

    // If LLM ignored the confirmed repo, override it (handles LLM hallucination)
    if (confirmedRepo && (!raw.repo || !repoAliases.includes(raw.repo))) {
      raw.repo = confirmedRepo;
    }

    if (!raw.repo || !repoAliases.includes(raw.repo)) return null;

    // Validate service against the identified repo's service list
    if (raw.service) {
      const repoServices = config.repos[raw.repo]?.services ?? [];
      if (!repoServices.includes(raw.service)) raw.service = null;
    }

    // Validate all repos in the repos array
    raw.repos = (raw.repos ?? [raw.repo]).filter((r) =>
      repoAliases.includes(r),
    );
    if (!raw.repos.includes(raw.repo)) raw.repos.unshift(raw.repo);

    return { ...raw, executionMode };
  } catch {
    // JSON parse failed — if we have a confirmed repo, build a minimal intent
    if (confirmedRepo) {
      return {
        repo: confirmedRepo,
        repos: [confirmedRepo],
        service: null,
        taskType: "other",
        executionMode,
        description: "agent-task",
        fullTask: userMessage,
        needsWebSearch: false,
      };
    }
    return null;
  }
}

// ── Registration command detection ────────────────────────────────────────
// Matches: "register project <alias> at <path>" or "/add-project <alias> <path>"
const REGISTRATION_RE =
  /(?:register\s+project|\/add-project)\s+(\S+)\s+(?:at\s+)?(\/.+)/i;

// Matches: "/add-dir /absolute/path" — alias auto-derived from directory name
const ADD_DIR_RE = /\/add-dir\s+(\/\S+)/i;

// ── "List repos" command detection ────────────────────────────────────────
// Matches: "list your repos", "what projects do you have", "show me the projects", etc.
// Only fires when NO specific repo alias appears verbatim in the message.
const LIST_REPOS_RE =
  /\b(?:list|show|what|which|tell me)\b.{0,40}\b(?:repo|repos|project|projects|access|registered|available)\b/i;

// ── Unregistered repo name extractor ─────────────────────────────────────
// Extracts the repo name a user explicitly named (e.g. "my fairshare repo").
// Returns null if the name matches a known alias or is a common word.
function extractUnregisteredRepoMention(
  message: string,
  knownAliases: string[],
): string | null {
  // Common words that look like names but aren't repo aliases
  const STOP_WORDS = new Set([
    "my", "the", "our", "a", "an", "this", "that", "some", "any",
    "new", "old", "main", "master", "dev", "test", "staging", "prod",
    "project", "repo", "repository", "codebase", "code", "app",
    "service", "module", "branch", "commit", "change", "update",
  ]);
  const lowerAliases = knownAliases.map((a) => a.toLowerCase());

  // Patterns: "my fairshare repo", "in fairshare repo", "the fairshare project"
  const patterns = [
    /\bmy\s+([\w][\w-]*)\s+(?:repo|project|codebase|repository)\b/i,
    /\bin\s+(?:my\s+)?([\w][\w-]*)\s+(?:repo|project|codebase|repository)\b/i,
    /\bthe\s+([\w][\w-]*)\s+(?:repo|project|codebase|repository)\b/i,
    /\b([\w][\w-]*)\s+(?:repo|project|repository)\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const name = match[1].toLowerCase();
    if (STOP_WORDS.has(name)) continue;
    if (lowerAliases.includes(name)) continue; // known alias — fine
    return match[1]; // explicitly named but not registered
  }
  return null;
}

// ── Slack message handler ──────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.message(async ({ message, say, client: slackClient }: any) => {
  if (message.subtype) return;
  if (!message.text) return;
  // Only respond to top-level messages, not thread replies
  if (message.thread_ts && message.thread_ts !== message.ts) return;

  const threadTs: string = message.ts;
  const channelId: string = message.channel;
  const msgText: string = message.text as string;

  // ── /add-dir command ─────────────────────────────────────────────────────
  const addDirMatch = msgText.match(ADD_DIR_RE);
  if (addDirMatch) {
    const repoPath = addDirMatch[1].trim();
    const alias = path.basename(repoPath);
    await say({
      text: `🔎 Detecting project at \`${repoPath}\` (alias: \`${alias}\`)...`,
      thread_ts: threadTs,
    });
    try {
      const detected = await detectProject(alias, repoPath);
      const contextPath = path.join(repoPath, "AGENT_CONTEXT.md");
      const existingContext = await fs
        .readFile(contextPath, "utf-8")
        .catch(() => null);

      // Always write the scaffolded context first so the agent has a template to fill in
      if (!existingContext) {
        await fs.writeFile(contextPath, detected.agentContextMd, "utf-8");
      }
      await addRepo(alias, detected.configEntry);

      await say({
        text: [
          `✅ *Project registered: \`${alias}\`*`,
          `• ${detected.summary}`,
          `• Path: \`${repoPath}\``,
          existingContext
            ? "• AGENT_CONTEXT.md: already existed, kept as-is — skipping deep analysis"
            : "• AGENT_CONTEXT.md: scaffolded — running deep analysis to fill it in...",
        ].join("\n"),
        thread_ts: threadTs,
      });

      // If no existing context, run a deep analysis to replace <<CONFIRM>> placeholders
      if (!existingContext) {
        const progressCallback = async (update: string): Promise<void> => {
          await slackClient.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: update,
            mrkdwn: true,
          });
        };

        const analyzeTask = [
          `Analyze this repository and rewrite AGENT_CONTEXT.md at the repo root with accurate, real information.`,
          ``,
          `Follow these steps:`,
          `1. Read the current AGENT_CONTEXT.md to see the scaffold and <<CONFIRM>> placeholders`,
          `2. Read README.md (or any README file) at the repo root`,
          `3. Read package.json to understand dependencies, scripts, and project name`,
          `4. Call list_directory on the repo root and on the srcDir to see what services/apps exist`,
          `5. For each service/app found, read its entry point (main.ts / index.ts) and any README`,
          `6. Rewrite AGENT_CONTEXT.md replacing ALL <<CONFIRM>> placeholders with real information:`,
          `   - Purpose: what the repo actually does`,
          `   - Each service row: real port (if found in code) and real responsibility description`,
          `   - Coding conventions: based on actual patterns you observed`,
          ``,
          `Keep the existing markdown structure. Only replace <<CONFIRM>> text with real content.`,
          `Write the complete updated file using write_file.`,
        ].join("\n");

        try {
          await runAgentLoop(
            alias,
            analyzeTask,
            undefined,
            progressCallback,
            "implement",
          );
          await say({
            text: `✅ *Deep analysis complete for \`${alias}\`* — AGENT_CONTEXT.md is now ready. You can ask questions about this project.`,
            thread_ts: threadTs,
          });
        } catch (err) {
          await say({
            text: `⚠️ Deep analysis failed (${String(err)}). You can manually edit \`${contextPath}\` to fill in the <<CONFIRM>> placeholders.`,
            thread_ts: threadTs,
          });
        }
      } else {
        await say({
          text: `You can now ask questions about \`${alias}\` just like other repos.`,
          thread_ts: threadTs,
        });
      }
    } catch (err) {
      await say({
        text: `❌ Registration failed: ${String(err)}`,
        thread_ts: threadTs,
      });
    }
    return;
  }

  // ── Registration command ─────────────────────────────────────────────────
  const regMatch = msgText.match(REGISTRATION_RE);
  if (regMatch) {
    const [, alias, repoPath] = regMatch;
    await say({
      text: `🔎 Detecting project at \`${repoPath}\`...`,
      thread_ts: threadTs,
    });
    try {
      const detected = await detectProject(alias, repoPath);
      // Write AGENT_CONTEXT.md to the repo (use top-level fs and path imports)
      const contextPath = path.join(repoPath, "AGENT_CONTEXT.md");
      const existingContext = await fs
        .readFile(contextPath, "utf-8")
        .catch(() => null);
      if (!existingContext) {
        await fs.writeFile(contextPath, detected.agentContextMd, "utf-8");
      }
      // Register in config
      await addRepo(alias, detected.configEntry);
      await say({
        text: [
          `✅ *Project registered: \`${alias}\`*`,
          `• ${detected.summary}`,
          `• Path: \`${repoPath}\``,
          existingContext
            ? "• AGENT_CONTEXT.md: already existed, kept as-is"
            : "• AGENT_CONTEXT.md: generated — review and refine it",
          "",
          `You can now ask questions about \`${alias}\` just like other repos.`,
        ].join("\n"),
        thread_ts: threadTs,
      });
    } catch (err) {
      await say({
        text: `❌ Registration failed: ${String(err)}`,
        thread_ts: threadTs,
      });
    }
    return;
  }

  // ── "List repos" fast path ───────────────────────────────────────────────
  // Intercept before any LLM call. Only fires when no specific alias is in the message.
  const currentAliases = await getRepoAliases();
  const hasDirectAlias = currentAliases.some((alias) =>
    new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(msgText)
  );
  if (LIST_REPOS_RE.test(msgText) && !hasDirectAlias) {
    const config = await getRepoConfig();
    const repoLines = currentAliases.map((alias) => {
      const r = config.repos[alias];
      const serviceCount = r.services?.length ?? 0;
      const remote = r.gitRemote
        ? r.gitRemote.replace(/\.git$/, "").replace(/^git@([^:]+):/, "https://$1/")
        : "no remote";
      return `• \`${alias}\` — ${r.description ?? r.type}${serviceCount > 0 ? `, ${serviceCount} services` : ""}\n  Remote: ${remote}`;
    });
    await say({
      text: [
        `📦 *Registered repos (${currentAliases.length}):*`,
        "",
        repoLines.join("\n"),
        "",
        "_Register a new repo: `/add-dir /absolute/path/to/repo`_",
      ].join("\n"),
      thread_ts: threadTs,
      mrkdwn: true,
    });
    return;
  }

  // ── Normal flow ──────────────────────────────────────────────────────────
  await say({ text: "🔍 Parsing your request...", thread_ts: threadTs });

  // Step 1: Classify task (haiku, ~100ms, very cheap)
  const repoAliases = currentAliases;
  const classification = await classifyTask(msgText, repoAliases).catch(() => ({
    executionMode: "implement" as ExecutionMode,
    repos: [] as string[],
    primaryRepo: null as string | null,
    needsWebSearch: false,
    isRegistration: false,
  }));

  // Step 2: Parse full intent (haiku, ~200ms)
  let intent: ParsedIntent | null;
  try {
    intent = await parseIntent(
      msgText,
      classification.executionMode,
      classification.repos,
    );
  } catch (err) {
    await say({
      text: `❌ Intent parsing failed: ${String(err)}`,
      thread_ts: threadTs,
    });
    return;
  }

  // Check if user explicitly named a repo that is NOT registered — before giving up or guessing
  const unregisteredMention = extractUnregisteredRepoMention(msgText, repoAliases);
  if (unregisteredMention) {
    await say({
      text: [
        `❌ Repo \`${unregisteredMention}\` is not registered with this agent.`,
        "",
        `*Registered repos:* \`${repoAliases.join("`, `")}\``,
        "",
        `To add it: \`/add-dir /absolute/path/to/${unregisteredMention.toLowerCase()}\``,
      ].join("\n"),
      thread_ts: threadTs,
    });
    return;
  }

  if (!intent) {
    await say({
      text: [
        "❌ Could not determine the target repo from your message.",
        "",
        `*Registered repos:* \`${repoAliases.join("`, `")}\``,
        "",
        "*Example requests:*",
        '• _"In the my-api repo, add a GET /health endpoint to user-service"_',
        '• _"What does auth-service do in my-api?"_',
        '• _"Fix the null-check bug in my-api payment-service"_',
        '• _"/add-dir /path/to/your/repo"_',
      ].join("\n"),
      thread_ts: threadTs,
    });
    return;
  }

  // ── Mode-specific UI labels ──────────────────────────────────────────────
  const modeLabel: Record<string, string> = {
    question: "❓ Quick question",
    research: "🔬 Research",
    implement: "⚙️ Implementation",
  };
  // Normalise executionMode — classifier may return unexpected values
  const safeMode: ExecutionMode =
    intent.executionMode === "question" || intent.executionMode === "research"
      ? intent.executionMode
      : "implement";

  const isMultiRepo = intent.repos.length > 1;

  await say({
    text: [
      `✅ *${modeLabel[safeMode]}*`,
      `• Repo: \`${intent.repo}\`${
        isMultiRepo
          ? ` + ${intent.repos
              .filter((r) => r !== intent.repo)
              .map((r) => `\`${r}\``)
              .join(", ")}`
          : ""
      }`,
      `• Service: \`${intent.service ?? "repo-wide"}\``,
      `• Type: \`${intent.taskType}\``,
      "",
      `📋 *Task:* ${intent.fullTask}`,
      "",
      safeMode === "question"
        ? "⚡ Answering..."
        : safeMode === "research"
          ? "🔬 Researching codebase..."
          : "🔬 Analyzing codebase — will show plan for approval before making changes...",
    ].join("\n"),
    thread_ts: threadTs,
  });

  // ── Progress callback ────────────────────────────────────────────────────
  const progressCallback = async (update: string): Promise<void> => {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: update,
      mrkdwn: true,
    });
  };

  // ── Single-repo execution ────────────────────────────────────────────────
  if (!isMultiRepo) {
    // Implement mode: research → show plan → wait for approval → execute
    if (safeMode === "implement") {
      await runPlanAndConfirm(
        intent,
        channelId,
        threadTs,
        progressCallback,
        slackClient,
      );
      return;
    }

    // Question / Research: answer directly
    let agentResultText: string;
    try {
      const loopResult = await runAgentLoop(
        intent.repo,
        intent.fullTask,
        intent.service ?? undefined,
        progressCallback,
        safeMode,
      );
      agentResultText = loopResult.text;
    } catch (err) {
      await say({
        text: `❌ *Agent error*: ${String(err)}`,
        thread_ts: threadTs,
      });
      return;
    }

    await say({
      text: [
        safeMode === "question"
          ? "💬 *Answer*"
          : "✅ *Research Complete*",
        "",
        agentResultText,
      ]
        .filter(Boolean)
        .join("\n"),
      thread_ts: threadTs,
      mrkdwn: true,
    });
    return;
  }

  // ── Multi-repo execution (sequential, primary repo first) ─────────────────
  await progressCallback(
    `🔀 *Multi-repo task* — running on ${intent.repos.map((r) => `\`${r}\``).join(" → ")}`,
  );

  const results: Array<{ repo: string; result: string; error?: string }> = [];
  for (const repoAlias of intent.repos) {
    await progressCallback(`\n📦 *Working on \`${repoAlias}\`...*`);
    try {
      const loopResult = await runAgentLoop(
        repoAlias,
        intent.fullTask,
        repoAlias === intent.repo ? (intent.service ?? undefined) : undefined,
        progressCallback,
        safeMode,
      );
      results.push({ repo: repoAlias, result: loopResult.text });
    } catch (err) {
      results.push({ repo: repoAlias, result: "", error: String(err) });
    }
  }

  const summary = results
    .map(({ repo, result, error }) =>
      error
        ? `### \`${repo}\`\n❌ Error: ${error}`
        : `### \`${repo}\`\n${result}`,
    )
    .join("\n\n---\n\n");

  await say({
    text: [
      "✅ *Multi-repo Task Complete*",
      "",
      summary,
    ].join("\n"),
    thread_ts: threadTs,
    mrkdwn: true,
  });
});

// ── Git result formatter ───────────────────────────────────────────────────
function formatGitResult(r: GitFlowResult): string {
  if (r.error && !r.commitSha) {
    // No commit was made (e.g., no files modified or branch creation failed)
    return `---\n⚠️ *Git*: ${r.error}`;
  }

  const lines: string[] = ['---'];

  if (r.branchName) lines.push(`🌿 *Branch*: \`${r.branchName}\``);
  if (r.commitSha && r.commitSha !== '') lines.push(`📦 *Commit*: \`${r.commitSha}\``);

  if (r.pushedToRemote) {
    if (r.mrUrl) {
      const label = r.mrTitle ? `*${r.mrTitle}*` : 'Open PR/MR';
      lines.push(`🔗 *Pull Request*: <${r.mrUrl}|${label}>`);
    } else {
      lines.push('✅ Pushed to remote — create a PR manually');
    }
  } else if (r.commitSha) {
    // Committed locally but push failed
    lines.push(`💾 Committed locally (push failed: ${r.error ?? 'unknown'})`);
  }

  return lines.join('\n');
}

// ── Plan + Confirm flow ────────────────────────────────────────────────────
// Runs a read-only research pass, posts the plan with Approve/Cancel buttons,
// then waits for the user to approve before executing any writes.
async function runPlanAndConfirm(
  intent: ParsedIntent,
  channelId: string,
  threadTs: string,
  progressCallback: (update: string) => Promise<void>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slackClient: any,
): Promise<void> {
  const planTask = [
    `PLANNING PHASE — analyze the codebase only. Do NOT write any files yet.`,
    ``,
    `Task: ${intent.fullTask}`,
    `Target service: ${intent.service ?? "repo-wide"}`,
    ``,
    `Produce a structured implementation plan:`,
    `1. **Understanding**: What does this task require? (2-3 sentences)`,
    `2. **Files to modify**: Each file path + what change you'll make`,
    `3. **Files to create**: Any new files needed`,
    `4. **Risks / dependencies**: Anything that could break or needs attention`,
    ``,
    `Research the code, then return the plan. Do NOT write any files.`,
  ].join("\n");

  await progressCallback("🔬 Researching codebase to build a plan...");

  let plan: string;
  try {
    const planResult = await runAgentLoop(
      intent.repo,
      planTask,
      intent.service ?? undefined,
      progressCallback,
      "research",
    );
    plan = planResult.text;
  } catch (err) {
    await progressCallback(`❌ Planning failed: ${String(err)}`);
    return;
  }

  const taskId = randomUUID();
  storePendingTask(taskId, { intent, channelId, threadTs });

  // Slack block text has a 3000 char limit
  const planText =
    plan.length > 2800 ? plan.slice(0, 2800) + "\n…(truncated)" : plan;

  try {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "📋 Plan ready — approve to implement or cancel.",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `📋 *Implementation Plan*\n\n${planText}`,
          },
        },
        {
          type: "actions",
          block_id: `confirm_${taskId}`,
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "✅ Approve & Implement",
                emoji: true,
              },
              style: "primary",
              action_id: "approve_task",
              value: taskId,
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "💬 Add Extra Context",
                emoji: true,
              },
              action_id: "add_context",
              value: taskId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "❌ Cancel", emoji: true },
              style: "danger",
              action_id: "cancel_task",
              value: taskId,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error(
      `[${new Date().toISOString()}] Slack postMessage error (plan+confirm):`,
      String(err),
    );
  }
}

// ── Button action: Approve ─────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.action("approve_task", async ({ body, ack, client: slackClient }: any) => {
  await ack();
  const taskId = (body.actions as Array<{ value: string }>)[0]?.value;
  const pending = consumePendingTask(taskId);
  if (!pending) return; // already approved/cancelled (duplicate event from Slack)

  const { intent, channelId, threadTs } = pending;
  const progressCallback = async (update: string): Promise<void> => {
    try {
      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: update,
        mrkdwn: true,
      });
    } catch (e) {
      console.error(
        `[${new Date().toISOString()}] Slack postMessage error (progress):`,
        String(e),
      );
    }
  };

  await progressCallback("⚙️ Starting implementation...");
  try {
    const loopResult = await runAgentLoop(
      intent.repo,
      intent.fullTask,
      intent.service ?? undefined,
      progressCallback,
      "implement",
    );

    // Determine which files to commit:
    // priority = files the agent wrote; fallback = pre-staged files (manual `git add`)
    const config = await getRepoConfig();
    const repoEntry = config.repos[intent.repo];
    let filesToCommit = loopResult.filesModified;

    if (repoEntry && filesToCommit.length === 0) {
      const staged = await gitAutomation.getStagedFiles(repoEntry.path);
      if (staged.length > 0) filesToCommit = staged;
    }

    if (filesToCommit.length === 0 || !repoEntry) {
      // Nothing was written — post completion without a git gate
      try {
        await slackClient.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: ["✅ *Task Complete* _(no files modified)_", "", loopResult.text]
            .filter(Boolean)
            .join("\n"),
          mrkdwn: true,
        });
      } catch (e) {
        console.error(`[${new Date().toISOString()}] Slack postMessage error (no-op complete):`, String(e));
      }
      return;
    }

    // ── MR Gate: show what changed → let user decide before any push ─────────
    const gitTaskId = randomUUID();
    storePendingGitTask(gitTaskId, {
      intent,
      filesModified: filesToCommit,
      session: loopResult.session,
      agentSummary: loopResult.text,
      channelId,
      threadTs,
    });

    const fileList = filesToCommit
      .map((f) => `• \`${f.replace(/^[^/]+\//, "")}\``) // strip repo alias prefix
      .join("\n");

    const summaryPreview =
      loopResult.text.length > 600
        ? loopResult.text.slice(0, 600) + "\n…"
        : loopResult.text;

    try {
      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "✅ Implementation complete — review changes before pushing.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ *Implementation complete*\n\n${summaryPreview}`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Changed files (${filesToCommit.length}):*\n${fileList}`,
            },
          },
          {
            type: "actions",
            block_id: `mr_gate_${gitTaskId}`,
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "🚀 Create MR", emoji: true },
                style: "primary",
                action_id: "create_mr",
                value: gitTaskId,
              },
              {
                type: "button",
                text: { type: "plain_text", text: "❌ Reject Changes", emoji: true },
                style: "danger",
                action_id: "reject_changes",
                value: gitTaskId,
              },
            ],
          },
        ],
      });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Slack postMessage error (MR gate):`, String(e));
    }
  } catch (err) {
    try {
      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ *Agent error*: ${String(err)}`,
      });
    } catch (e) {
      console.error(
        `[${new Date().toISOString()}] Slack postMessage error (agent error):`,
        String(e),
      );
    }
  }
});

// ── Button action: Add Extra Context ──────────────────────────────────────
// Opens a Slack modal so the user can type missing/incorrect context,
// then re-runs the planning phase with the extra info appended.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.action("add_context", async ({ body, ack, client: slackClient }: any) => {
  await ack();
  const taskId = (body.actions as Array<{ value: string }>)[0]?.value;
  if (!pendingTasks.has(taskId)) return; // already handled

  await slackClient.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "add_context_modal",
      private_metadata: taskId,
      title: { type: "plain_text", text: "Add Extra Context" },
      submit: { type: "plain_text", text: "Re-analyze" },
      close: { type: "plain_text", text: "Dismiss" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "What's missing or incorrect in the plan? Your input will be added to the task and the agent will re-analyze.",
          },
        },
        {
          type: "input",
          block_id: "context_input",
          label: { type: "plain_text", text: "Additional context" },
          element: {
            type: "plain_text_input",
            action_id: "context_text",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "e.g. The update route should also validate the email field. The customer lib uses a repository pattern, not direct DB calls.",
            },
          },
        },
      ],
    },
  });
});

// ── Modal submission: re-run planning with extra context ───────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.view(
  "add_context_modal",
  async ({ body, ack, client: slackClient }: any) => {
    await ack();
    const taskId = body.view.private_metadata as string;
    const pending = consumePendingTask(taskId);
    if (!pending) return; // already handled

    const extraContext = (body.view.state.values.context_input?.context_text
      ?.value ?? "") as string;

    const { intent, channelId, threadTs } = pending;

    // Append extra context to the task so the agent uses it in re-analysis
    const updatedIntent: ParsedIntent = {
      ...intent,
      fullTask: `${intent.fullTask}\n\n## Additional Context (from user)\n${extraContext}`,
    };

    const progressCallback = async (update: string): Promise<void> => {
      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: update,
        mrkdwn: true,
      });
    };

    await progressCallback("🔄 Re-analyzing with additional context...");
    await runPlanAndConfirm(
      updatedIntent,
      channelId,
      threadTs,
      progressCallback,
      slackClient,
    );
  },
);

// ── Button action: Cancel ──────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.action("cancel_task", async ({ body, ack, client: slackClient }: any) => {
  await ack();
  const taskId = (body.actions as Array<{ value: string }>)[0]?.value;
  // Only post if the task was actually still pending (prevents duplicate messages on repeated clicks)
  const wasPending = consumePendingTask(taskId);
  if (!wasPending) return;
  try {
    await slackClient.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message?.thread_ts ?? body.message?.ts,
      text: "🚫 Task cancelled.",
    });
  } catch (e) {
    console.error(
      `[${new Date().toISOString()}] Slack postMessage error (cancel):`,
      String(e),
    );
  }
});

// ── Button action: Create MR ───────────────────────────────────────────────
// Triggered from the post-implementation MR gate.  Runs the full git flow:
// branch → commit → push → open PR/MR.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.action("create_mr", async ({ body, ack, client: slackClient }: any) => {
  await ack();
  const gitTaskId = (body.actions as Array<{ value: string }>)[0]?.value;
  const pending = consumePendingGitTask(gitTaskId);
  if (!pending) return; // duplicate event — already handled

  const { intent, filesModified, session, agentSummary, channelId, threadTs } = pending;

  const progressCallback = async (update: string): Promise<void> => {
    try {
      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: update,
        mrkdwn: true,
      });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Slack postMessage error (create_mr progress):`, String(e));
    }
  };

  await progressCallback("🔀 *Creating MR* — running git flow (branch → commit → push)...");

  try {
    const config = await getRepoConfig();
    const repoEntry = config.repos[intent.repo];
    if (!repoEntry) throw new Error(`Repo \`${intent.repo}\` not found in config`);

    const gitResult = await gitAutomation.runFlow(repoEntry, session, filesModified);
    const gitSection = formatGitResult(gitResult);

    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: ["✅ *MR Created*", "", agentSummary, "", gitSection]
        .filter(Boolean)
        .join("\n"),
      mrkdwn: true,
    });
  } catch (err) {
    try {
      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ *Git flow error*: ${String(err)}`,
        mrkdwn: true,
      });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Slack postMessage error (create_mr error):`, String(e));
    }
  }
});

// ── Button action: Reject Changes ─────────────────────────────────────────
// Discards the agent's file writes by restoring them to their HEAD state.
// Uses `git checkout HEAD -- <files>` (non-destructive: only touches the
// specific files the agent wrote, leaves everything else intact).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.action("reject_changes", async ({ body, ack, client: slackClient }: any) => {
  await ack();
  const gitTaskId = (body.actions as Array<{ value: string }>)[0]?.value;
  const pending = consumePendingGitTask(gitTaskId);
  if (!pending) return;

  const { intent, filesModified, channelId, threadTs } = pending;

  try {
    const config = await getRepoConfig();
    const repoEntry = config.repos[intent.repo];
    if (!repoEntry) throw new Error(`Repo \`${intent.repo}\` not found`);

    // Strip the "alias/" prefix to get repo-relative paths for git
    const repoPrefix = intent.repo + "/";
    const relativePaths = filesModified.map((f) =>
      f.startsWith(repoPrefix) ? f.slice(repoPrefix.length) : f,
    );

    // Restore each file to its HEAD state; new files (not tracked) are deleted
    for (const relPath of relativePaths) {
      const fullPath = `${repoEntry.path}/${relPath}`;
      try {
        // Try restoring tracked file first
        await execAsync(`git checkout HEAD -- "${relPath.replace(/"/g, '\\"')}"`, {
          cwd: repoEntry.path,
          timeout: 10_000,
        });
      } catch {
        // File wasn't tracked (newly created by agent) — remove it
        await fs.unlink(fullPath).catch(() => {});
      }
    }

    const fileList = relativePaths.map((f) => `• \`${f}\``).join("\n");
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: [
        "🗑️ *Changes rejected and discarded*",
        "",
        `The following files have been restored to their last committed state:`,
        fileList,
      ].join("\n"),
      mrkdwn: true,
    });
  } catch (err) {
    try {
      await slackClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `❌ *Reject failed*: ${String(err)}\nYou may need to run \`git checkout HEAD -- <files>\` manually.`,
        mrkdwn: true,
      });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Slack postMessage error (reject error):`, String(e));
    }
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
  console.log("🔌 Connecting to Slack (Socket Mode)...");

  // Add a timeout so a bad/expired token fails fast with a clear error
  // instead of hanging indefinitely.
  const CONNECT_TIMEOUT_MS = 30_000;
  await Promise.race([
    app.start(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(
          `Slack connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s.\n` +
          `Check that SLACK_BOT_TOKEN and SLACK_APP_TOKEN in your .env are valid and not expired.`
        )),
        CONNECT_TIMEOUT_MS
      )
    ),
  ]);

  const aliases = await getRepoAliases();
  const activeProviders = [
    process.env.DEEPSEEK_API_KEY && "DeepSeek (T1)",
    process.env.GEMINI_API_KEY && "Gemini Flash (T2)",
    process.env.GROQ_API_KEY && "Groq (T3)",
    "Claude CLI (T4 fallback)",
  ]
    .filter(Boolean)
    .join(", ");
  const gitStatus = [
    process.env.GITHUB_TOKEN && "GitHub PR (token set)",
    process.env.GITLAB_TOKEN && "GitLab MR (token set)",
    !process.env.GITHUB_TOKEN && !process.env.GITLAB_TOKEN && "URL-only (set GITHUB_TOKEN / GITLAB_TOKEN to enable auto PR/MR)",
  ].filter(Boolean).join(", ");

  console.log("⚡ Automation Factories Bot is running (Socket Mode)");
  console.log(`📦 Registered repos: ${aliases.join(", ")}`);
  console.log(`🤖 Providers: ${activeProviders}`);
  console.log(`🔀 Git: ${gitStatus}`);
  console.log("");
  console.log("📖 Usage:");
  console.log('  Ask questions: "What does auth-service do in my-api?"');
  console.log('  Implement:     "Add a health endpoint to user-service in my-api"');
  console.log('  Register:      "/add-dir /path/to/repo"');
})().catch((err) => {
  console.error("❌ Failed to start bot:", String(err));
  process.exit(1);
});
