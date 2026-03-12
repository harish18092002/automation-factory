import { App } from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";
import { runAgentLoop } from "../agent/loop.js";
import { getRepoConfig, getRepoAliases, addRepo } from "../agent/config.js";
import { classifyTask } from "../agent/classifier.js";
import { detectProject } from "../agent/project-detector.js";
import type { ExecutionMode } from "../agent/classifier.js";

// ── Env validation ─────────────────────────────────────────────────────────
const REQUIRED_ENV = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "ANTHROPIC_API_KEY"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// ── Slack App (Socket Mode — no public URL required) ───────────────────────
const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  socketMode: true,
});

const claude = new Anthropic();
// Use haiku for intent parsing — fast and cheap
const INTENT_MODEL = "claude-haiku-4-5-20251001";

// ── Intent types ───────────────────────────────────────────────────────────
interface ParsedIntent {
  /** Primary repo alias */
  repo: string;
  /** All repos involved (for multi-repo tasks) */
  repos: string[];
  service: string | null;
  taskType: "feature" | "bugfix" | "refactor" | "test" | "question" | "research" | "other";
  executionMode: ExecutionMode;
  /** Short kebab-case label for branch names */
  description: string;
  /** Full task instruction forwarded to agent loop */
  fullTask: string;
  needsWebSearch: boolean;
}

// ── Direct alias matcher ───────────────────────────────────────────────────
// Check if a repo alias appears verbatim in the message (word boundary match).
// This handles "in terminal", "terminal repo", "the swells project", etc.
// We do this BEFORE any LLM call because LLMs can confuse repo aliases with
// same-named services (e.g. "terminal" alias vs "terminal-admin" service in services repo).
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
  classifiedRepos: string[]
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

  const res = await claude.messages.create({
    model: INTENT_MODEL,
    max_tokens: 400,
    system: [
      "You are a strict intent-parsing assistant for a multi-repo engineering bot.",
      "",
      "Available repos:",
      repoSummary,
      repoInstruction,
      "",
      "Extract a JSON object. Respond with ONLY valid JSON — no markdown, no backticks.",
      "Schema:",
      "{",
      '  "repo": string,           // primary repo alias (must match exactly), or null if unclear',
      '  "repos": string[],        // ALL repo aliases involved (can be multiple for cross-repo tasks)',
      '  "service": string|null,   // service name within the primary repo, or null',
      '  "taskType": "feature"|"bugfix"|"refactor"|"test"|"question"|"research"|"other",',
      '  "description": string,    // max 50 chars, kebab-case, suitable for a git branch name',
      '  "fullTask": string,       // complete task instruction for the AI agent',
      '  "needsWebSearch": boolean // true if task needs external documentation or API reference',
      "}",
    ].join("\n"),
    messages: [{ role: "user", content: userMessage }],
  });

  try {
    const content = res.content as Array<{ type: string; text?: string }>;
    const textBlock = content.find((b) => b.type === "text");
    if (!textBlock?.text) return null;

    const raw = JSON.parse(textBlock.text) as Omit<ParsedIntent, "executionMode">;

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
    raw.repos = (raw.repos ?? [raw.repo]).filter((r) => repoAliases.includes(r));
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

  // ── Registration command ─────────────────────────────────────────────────
  const regMatch = msgText.match(REGISTRATION_RE);
  if (regMatch) {
    const [, alias, repoPath] = regMatch;
    await say({ text: `🔎 Detecting project at \`${repoPath}\`...`, thread_ts: threadTs });
    try {
      const detected = await detectProject(alias, repoPath);
      // Write AGENT_CONTEXT.md to the repo
      const fs = await import("fs/promises");
      const path = await import("path");
      const contextPath = path.join(repoPath, "AGENT_CONTEXT.md");
      const existingContext = await fs.readFile(contextPath, "utf-8").catch(() => null);
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

  // ── Normal flow ──────────────────────────────────────────────────────────
  await say({ text: "🔍 Parsing your request...", thread_ts: threadTs });

  // Step 1: Classify task (haiku, ~100ms, very cheap)
  const repoAliases = await getRepoAliases();
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
    intent = await parseIntent(msgText, classification.executionMode, classification.repos);
  } catch (err) {
    await say({ text: `❌ Intent parsing failed: ${String(err)}`, thread_ts: threadTs });
    return;
  }

  if (!intent) {
    const aliases = await getRepoAliases();
    await say({
      text: [
        "❌ Could not determine the target repo from your message.",
        "",
        `*Available repos:* \`${aliases.join("`, `")}\``,
        "",
        "*Example requests:*",
        "• _\"In the services repo, add a health endpoint to merchant-service\"_",
        "• _\"What does payment-isolate do in swells?\"_",
        "• _\"Fix the null-check bug in terminal datecs-acquiring\"_",
        "• _\"register project myapp at /path/to/myapp\"_",
      ].join("\n"),
      thread_ts: threadTs,
    });
    return;
  }

  // ── Mode-specific UI labels ──────────────────────────────────────────────
  const modeLabel: Record<ExecutionMode, string> = {
    question: "❓ Quick question",
    research: "🔬 Research",
    implement: "⚙️ Implementation",
  };

  const isMultiRepo = intent.repos.length > 1;

  await say({
    text: [
      `✅ *${modeLabel[intent.executionMode]}*`,
      `• Repo: \`${intent.repo}\`${isMultiRepo ? ` + ${intent.repos.filter((r) => r !== intent.repo).map((r) => `\`${r}\``).join(", ")}` : ""}`,
      `• Service: \`${intent.service ?? "repo-wide"}\``,
      `• Type: \`${intent.taskType}\``,
      "",
      `📋 *Task:* ${intent.fullTask}`,
      "",
      intent.executionMode === "question"
        ? "⚡ Answering..."
        : intent.executionMode === "research"
        ? "🔬 Researching codebase..."
        : "⚙️ Starting agent (explore → plan → implement)...",
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
    let agentResult: string;
    try {
      agentResult = await runAgentLoop(
        intent.repo,
        intent.fullTask,
        intent.service ?? undefined,
        progressCallback,
        intent.executionMode
      );
    } catch (err) {
      await say({ text: `❌ *Agent error*: ${String(err)}`, thread_ts: threadTs });
      return;
    }

    await say({
      text: [
        intent.executionMode === "question" ? "💬 *Answer*" : "✅ *Task Complete*",
        "",
        agentResult,
        intent.executionMode === "implement"
          ? "\n---\n📝 *Next step (manual for now)*: review the changes, then commit & push."
          : "",
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
    `🔀 *Multi-repo task* — running on ${intent.repos.map((r) => `\`${r}\``).join(" → ")}`
  );

  const results: Array<{ repo: string; result: string; error?: string }> = [];
  for (const repoAlias of intent.repos) {
    await progressCallback(`\n📦 *Working on \`${repoAlias}\`...*`);
    try {
      const result = await runAgentLoop(
        repoAlias,
        intent.fullTask,
        repoAlias === intent.repo ? (intent.service ?? undefined) : undefined,
        progressCallback,
        intent.executionMode
      );
      results.push({ repo: repoAlias, result });
    } catch (err) {
      results.push({ repo: repoAlias, result: "", error: String(err) });
    }
  }

  const summary = results
    .map(({ repo, result, error }) =>
      error
        ? `### \`${repo}\`\n❌ Error: ${error}`
        : `### \`${repo}\`\n${result}`
    )
    .join("\n\n---\n\n");

  await say({
    text: [
      "✅ *Multi-repo Task Complete*",
      "",
      summary,
      "",
      "---",
      "📝 *Next step (manual for now)*: review changes in each repo, then commit & push.",
    ].join("\n"),
    thread_ts: threadTs,
    mrkdwn: true,
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
(async () => {
  await app.start();
  const aliases = await getRepoAliases();
  console.log("⚡ Claude Agent Bot is running (Socket Mode)");
  console.log(`📦 Registered repos: ${aliases.join(", ")}`);
  console.log("🧠 Models: haiku (intent/classify) + sonnet (agent)");
  console.log("📡 Git host: git.surfboard.se (GitLab — Phase 2 will auto-push branches)");
  console.log("");
  console.log("📖 Usage:");
  console.log('  Ask questions: "What does payment-isolate do in swells?"');
  console.log('  Implement:     "Add a health endpoint to ocean-server in swells"');
  console.log('  Register:      "register project myapp at /path/to/repo"');
})();
