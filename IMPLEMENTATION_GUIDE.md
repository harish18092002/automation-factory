# Agentic Factory — Deep Implementation Guide

Everything that happens internally from Slack message to git push, with full flow diagrams, real data examples, and module-by-module breakdowns.

---

## Table of Contents

1. [System Architecture Overview](#1-system-architecture-overview)
2. [Module Map](#2-module-map)
3. [Phase 1 — Message Ingestion & Classification](#3-phase-1--message-ingestion--classification)
4. [Phase 2 — Intent Parsing](#4-phase-2--intent-parsing)
5. [Phase 3 — Memory Loading](#5-phase-3--memory-loading)
6. [Phase 4 — Provider Routing](#6-phase-4--provider-routing)
7. [Phase 5 — The Agent Loop](#7-phase-5--the-agent-loop)
8. [Phase 6 — Tool Execution](#8-phase-6--tool-execution)
9. [Phase 7 — Verification Pipeline](#9-phase-7--verification-pipeline)
10. [Phase 8 — Git Automation](#10-phase-8--git-automation)
11. [Phase 9 — Learning System](#11-phase-9--learning-system)
12. [Multi-Repo Execution Path](#12-multi-repo-execution-path)
13. [Full End-to-End Example: Question](#13-full-end-to-end-example-question)
14. [Full End-to-End Example: Implementation](#14-full-end-to-end-example-implementation)
15. [Full End-to-End Example: Multi-Repo](#15-full-end-to-end-example-multi-repo)
16. [Data Structures Reference](#16-data-structures-reference)
17. [Error Handling & Fallback Chains](#17-error-handling--fallback-chains)

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SLACK (Socket Mode)                              │
│  User sends message in any channel the bot is invited to                │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │  WebSocket (no public URL needed)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         bot/index.ts                                     │
│  @slack/bolt App — receives events, coordinates all phases              │
│  Streams progress updates back to Slack thread as work happens          │
└───┬──────────────┬──────────────┬────────────────────────────────────────┘
    │              │              │
    ▼              ▼              ▼
[CLASSIFY]   [PARSE INTENT]  [ORCHESTRATE / EXECUTE]
classifier   bot/index.ts     agent/loop.ts
    .ts       parseIntent()    runAgentLoop()
    │              │              │
    │         (Groq/DeepSeek)     ▼
    │              │      ┌──────────────────┐
    │              │      │  ProviderRouter   │ selects best LLM
    │              │      │  groq / deepseek  │
    │              │      │  gemini / claude  │
    │              │      └────────┬─────────┘
    │              │               │
    │              │      ┌────────▼─────────┐
    │              │      │   Agent Loop     │ multi-turn tool calls
    │              │      │   loop.ts        │ up to 12 iterations
    │              │      └────────┬─────────┘
    │              │               │
    │              │      ┌────────▼─────────────────────────────┐
    │              │      │          Tool Execution               │
    │              │      │  read_file / write_file / search      │
    │              │      │  git_* / run_command / web_search     │
    │              │      └────────┬─────────────────────────────┘
    │              │               │
    │              │      ┌────────▼─────────┐
    │              │      │  Verification    │ lint → build → test
    │              │      │  (implement only)│ pass@k retry
    │              │      └────────┬─────────┘
    │              │               │
    │              │      ┌────────▼─────────┐
    │              │      │  Git Automation  │ branch → commit → push
    │              │      │  (implement only)│ → MR URL
    │              │      └────────┬─────────┘
    │              │               │
    └──────────────┴───────────────┘
                                │
                                ▼
                   ┌────────────────────┐
                   │  Memory System     │ learns from every session
                   │  episodic / skill  │ improves future sessions
                   │  semantic          │
                   └────────────────────┘
```

---

## 2. Module Map

Every file, what it does, and what it talks to:

```
automation/
│
├── bot/index.ts
│   ├── Receives Slack messages (WebSocket via @slack/bolt)
│   ├── Calls: classifier.ts → parseIntent() → runAgentLoop()
│   ├── Streams progress to Slack thread (postMessage per tool call)
│   └── Handles: registration commands, multi-repo fan-out
│
├── agent/
│   │
│   ├── classifier.ts          ← Phase 1
│   │   • Input:  raw Slack message + available repo aliases
│   │   • Output: { executionMode, repos, primaryRepo, needsWebSearch }
│   │   • Uses:   Groq llama-3.1-8b-instant (or DeepSeek fallback)
│   │
│   ├── loop.ts                ← Phase 5 (core)
│   │   • Input:  repoAlias + task + serviceHint + executionMode
│   │   • Output: final text response string
│   │   • Does:   builds system prompt, selects provider, runs tool loop
│   │   • Calls:  providers/router.ts, tools.ts, memory/memory-manager.ts
│   │
│   ├── tools.ts               ← Phase 6
│   │   • 11 tools as OpenAI function definitions
│   │   • executeToolCall() dispatcher
│   │   • Safety checks (path sandboxing, dangerous command blocking)
│   │
│   ├── config.ts
│   │   • Reads/writes agent/repos.config.json
│   │   • getRepoConfig(), getRepoAliases(), addRepo()
│   │
│   ├── types.ts
│   │   • All shared TypeScript interfaces
│   │   • AgentSession, SubTask, WorkerResult, MemoryBundle, etc.
│   │
│   ├── providers/
│   │   ├── types.ts           — Provider interface + NormalizedResponse
│   │   ├── router.ts          — Tier-based provider selection
│   │   ├── deepseek.ts        — T1: DeepSeek V3 (implement/research)
│   │   ├── gemini.ts          — T2: Gemini Flash (>80K token context)
│   │   ├── groq.ts            — T3: Groq Llama 8B (questions/routing)
│   │   └── claude-cli.ts      — T4: Claude Code CLI subprocess fallback
│   │
│   ├── memory/
│   │   ├── memory-manager.ts  — Unified query interface
│   │   ├── episodic-store.ts  — JSONL session event logs per repo/month
│   │   ├── skill-registry.ts  — JSON learned patterns per repo
│   │   └── semantic-store.ts  — JSON facts with time-decay per repo
│   │
│   ├── orchestrator/
│   │   ├── lead-orchestrator.ts — Decomposes multi-repo tasks into SubTasks
│   │   ├── worker-pool.ts       — Executes SubTasks with concurrency control
│   │   ├── context-builder.ts   — Builds per-worker isolated context
│   │   └── result-aggregator.ts — Merges N WorkerResults into one summary
│   │
│   ├── verification/
│   │   ├── graders.ts         — LintGrader, BuildGrader, TestGrader
│   │   ├── verifier.ts        — VerificationPipeline (lint → build → test)
│   │   └── retry-loop.ts      — pass@k: runs agent + verify, retry on fail
│   │
│   ├── parallelization/
│   │   ├── parallel-runner.ts  — p-limit based parallel worker execution
│   │   ├── worktree-manager.ts — git worktree create/cleanup per worker
│   │   └── cascade-debugger.ts — 3-strategy parallel debug recovery
│   │
│   ├── git/
│   │   ├── git-automation.ts  — branch → commit (specific files) → push
│   │   └── mr-generator.ts    — LLM-generated commit messages + MR URLs
│   │
│   └── learning/
│       ├── pattern-extractor.ts — Extracts generalizable patterns from sessions
│       ├── skill-writer.ts      — Validates + deduplicates + registers skills
│       └── session-reviewer.ts  — Orchestrates post-session learning pipeline
```

---

## 3. Phase 1 — Message Ingestion & Classification

### Entry Point: `bot/index.ts`

The Slack bot listens to all messages via WebSocket (Socket Mode — no public URL needed).

```typescript
app.message(async ({ message, say, client }) => {
  if (message.subtype) return;           // ignore edits, joins, etc.
  if (!message.text) return;             // ignore empty messages
  if (message.thread_ts !== message.ts) return;  // ignore replies (only top-level)
  // ...
});
```

### Registration Check

Before any AI call, a regex checks if this is a `register project` command:

```
/(?:register\s+project|\/add-project)\s+(\S+)\s+(?:at\s+)?(\/.+)/i
```

Examples that match:
- `register project swells at /Users/me/projects/swells`
- `/add-project myapp /home/user/myapp`

If matched → runs `detectProject()` → creates `AGENT_CONTEXT.md` → adds to `repos.config.json` → done.

### Classification: `classifier.ts`

Every non-registration message runs through classification first.

```
Input:  "What does payment-isolate do in swells?"
        availableRepos = ["services", "terminal", "swells"]

LLM call:
  model:           llama-3.1-8b-instant (Groq)
  temperature:     0  (deterministic)
  response_format: json_object  (strict JSON, no markdown)
  max_tokens:      300

Output JSON:
{
  "executionMode": "question",
  "repos": ["swells"],
  "primaryRepo": "swells",
  "needsWebSearch": false,
  "isRegistration": false
}
```

The three execution modes and what triggers each:

| Mode | Triggers | What happens next |
|------|----------|-------------------|
| `question` | "what does", "explain", "how does", "what is" | Groq runs, read-only tools, max 4 iterations |
| `research` | "analyze", "review", "understand the flow" | DeepSeek runs, read-only + web_search, max 6 iterations |
| `implement` | "add", "fix", "refactor", "create", "update" | DeepSeek runs, all 11 tools, max 12 iterations, verify+commit |

---

## 4. Phase 2 — Intent Parsing

### `parseIntent()` in `bot/index.ts`

After classification, a second LLM call extracts structured intent.

**Step 1 — Direct alias matching (before any LLM call):**

```typescript
function findDirectAlias(message: string, aliases: string[]): string | null {
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(message)) {
      return alias;
    }
  }
  return null;
}
```

This catches "in swells", "swells repo", "the swells project" without needing an LLM call for repo detection. The confirmed repo is anchored in the LLM prompt to prevent hallucination.

**Step 2 — LLM extracts the rest:**

```
Input:  "What does payment-isolate do in swells?"
        directAlias = "swells"  (found above)
        executionMode = "question"  (from classifier)

System prompt enforces:
  - fullTask = VERBATIM copy of user message (not rephrased)
  - taskType must match actual intent (question ≠ refactor)
  - needsWebSearch = false for repo questions

Output JSON:
{
  "repo": "swells",
  "repos": ["swells"],
  "service": "payment-isolate",
  "taskType": "question",
  "description": "what-does-payment-isolate-do",
  "fullTask": "What does payment-isolate do in swells?",
  "needsWebSearch": false
}
```

**Step 3 — Validation:**

```typescript
// If LLM ignored confirmed repo, override it
if (confirmedRepo && (!raw.repo || !repoAliases.includes(raw.repo))) {
  raw.repo = confirmedRepo;
}

// Validate service is in the repo's known service list
if (raw.service) {
  const repoServices = config.repos[raw.repo]?.services ?? [];
  if (!repoServices.includes(raw.service)) raw.service = null;
}
```

---

## 5. Phase 3 — Memory Loading

### `memoryManager.query()` in `memory/memory-manager.ts`

Before building the system prompt, the agent queries its persistent memory. All three stores are queried **in parallel**:

```typescript
const [recentEvents, skills, facts] = await Promise.all([
  episodicStore.queryRecent(repoAlias, { limit: 10, eventTypes: ['task_complete'] }),
  skillRegistry.getSkills(repoAlias, keywords),   // keyword-matched skills
  semanticStore.getFacts(repoAlias),               // all known facts (filtered by confidence)
]);
```

### Memory Store 1: Episodic (`data/episodic/swells-2026-03.jsonl`)

Every session event is appended as a JSON line:

```jsonl
{"eventId":"uuid-1","sessionId":"uuid-abc","repoAlias":"swells","timestamp":"2026-03-17T10:00:00Z","eventType":"task_start","data":{"taskDescription":"Add retry logic to payment-isolate","executionMode":"implement"}}
{"eventId":"uuid-2","sessionId":"uuid-abc","repoAlias":"swells","timestamp":"2026-03-17T10:00:01Z","eventType":"tool_call","data":{"toolName":"read_file","input":{"repo":"swells","relative_path":"apps/payment-isolate/src/index.ts"}}}
{"eventId":"uuid-3","sessionId":"uuid-abc","repoAlias":"swells","timestamp":"2026-03-17T10:03:42Z","eventType":"task_complete","data":{"outcome":"success","filesModified":["apps/payment-isolate/src/index.ts"],"buildPassed":true,"lintPassed":true,"durationMs":222000}}
```

Queried by session to build a compact summary:
```
Session: uuid-abc | Task: Add retry logic to payment-isolate | Outcome: success |
Files: apps/payment-isolate/src/index.ts | Tools used: read_file, write_file, run_command
```

### Memory Store 2: Skill Registry (`data/skills/swells-skills.json`)

Skills are learned patterns extracted from successful implement sessions:

```json
[
  {
    "id": "skill-001",
    "repoAlias": "swells",
    "prompt": "When adding retry logic to Elysia services, wrap the handler in a try-catch and use exponential backoff: await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100))",
    "tags": ["retry", "elysia", "error-handling"],
    "successRate": 0.92,
    "useCount": 12,
    "createdAt": "2026-03-10T08:00:00Z"
  }
]
```

Skills are matched by keyword overlap with the current task description.

### Memory Store 3: Semantic Facts (`data/semantic/swells-facts.json`)

Structured knowledge about the repo:

```json
[
  {
    "subject": "payment-isolate",
    "category": "architecture",
    "content": "Uses Elysia framework on Bun runtime. Entry point is apps/payment-isolate/src/index.ts. Connects to Redis via libs/ocean.",
    "confidence": 0.95,
    "lastUpdated": "2026-03-15T12:00:00Z",
    "decayFactor": 0.95
  }
]
```

Facts decay at `0.95 × confidence` every 30 days — stale facts get filtered out automatically.

### Memory Fragment Injection

The three stores are merged into a single text block injected into the system prompt:

```
## Memory: Learned Patterns
- When adding retry logic to Elysia services, wrap handler in try-catch...

## Memory: Known Facts About This Repo
- [architecture] payment-isolate: Uses Elysia on Bun. Entry point is apps/payment-isolate/src/index.ts.

## Memory: Recent Similar Sessions
- Session: uuid-abc | Task: Add retry logic... | Outcome: success | Files: apps/payment-isolate/src/index.ts
```

---

## 6. Phase 4 — Provider Routing

### `ProviderRouter.select()` in `providers/router.ts`

```
Input:  executionMode = "question"
        estimatedTokens = 1,766  (chars of all system blocks / 4)

Decision tree:
  estimatedTokens > 80,000 AND hasGemini?  → NO (1,766 < 80K)
  mode === "question" AND hasGroq?          → YES → GroqProvider
```

Full routing logic with all branches:

```
                    ┌─────────────────────────────┐
                    │  estimatedTokens > 80,000   │
                    │  AND Gemini available?       │
                    └──────────┬──────────────────┘
                     YES       │        NO
                     ▼         │        ▼
              GeminiProvider   │   mode === "question"
              (1M context)     │   OR "route"?
                               │   AND Groq available?
                               │        │
                               │  YES   │   NO
                               │   ▼    │    ▼
                               │  Groq  │  DeepSeek available?
                               │        │        │
                               │        │  YES   │   NO
                               │        │   ▼    │    ▼
                               │        │ Deep-  │  Gemini available?
                               │        │ Seek   │        │
                               │        │        │  YES   │   NO
                               │        │        │   ▼    │    ▼
                               │        │        │ Gemini │  Groq available?
                               │        │        │        │        │
                               │        │        │        │  YES   │   NO
                               │        │        │        │   ▼    │    ▼
                               │        │        │        │  Groq  │ Claude CLI
```

### Token Estimation

```typescript
function estimateTokens(blocks: ProviderSystemBlock[]): number {
  // Rule of thumb: ~4 chars per token
  return Math.ceil(blocks.reduce((acc, b) => acc + b.text.length, 0) / 4);
}
```

The system prompt has three blocks:
1. `AGENT_CONTEXT.md` contents (large, cached)
2. Memory fragment (medium, cached if non-empty)
3. Session info + workflow instructions (small, never cached)

---

## 7. Phase 5 — The Agent Loop

### `runAgentLoop()` in `agent/loop.ts`

This is the core of the system. It runs a multi-turn conversation between the LLM and the tool executor.

#### System Prompt Structure

Three blocks are assembled before the loop starts:

```
Block 1 (cached): AGENT_CONTEXT.md
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Swells — Agent Context
## Repo Overview
Bun monorepo with Elysia framework. Apps in apps/, shared libs in libs/.
## Services
- payment-isolate: handles payment isolation logic
- ocean-server: HTTP gateway
...

Block 2 (cached if present): Memory Fragment
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Memory: Learned Patterns
- When adding retry logic...

Block 3 (never cached): Session Info
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Active Agent Session
- Repo: `swells` at `/Users/me/projects/swells`
- Target service: `payment-isolate`
- Available tools: read_file, read_file_section, list_directory, search_files...

## Agent Rules
1. Read before writing — always call read_file before write_file
2. Stay in scope — only modify target service unless task requires shared lib changes
...

## Response Instructions    ← (for question mode)
Answer the user's question concisely. Use read tools only to look up information.
Do NOT write files. Keep your final answer clear and direct.
```

#### Iteration Budget by Mode

```typescript
const ITERATION_LIMITS = {
  question:   4,   // 4 tool calls max — answer quickly
  research:   6,   // 6 tool calls — deeper exploration allowed
  implement: 12,   // 12 tool calls — explore + plan + write + verify
};

const MAX_TOKENS = {
  question:  2048,
  research:  4096,
  implement: 8096,
};
```

#### Loop Internals

```
messages = [{ role: "user", content: "What does payment-isolate do in swells?" }]

━━━ Iteration 1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Provider call (Groq):
  Input:  system_blocks + messages
  Output: {
    stopReason: "tool_use",
    toolCalls: [{ id: "tc-1", name: "read_file", input: { repo: "swells", relative_path: "apps/payment-isolate/src/index.ts" } }]
  }

→ Add to messages:
  { role: "assistant", content: null, tool_calls: [{ id: "tc-1", function: { name: "read_file", arguments: '{"repo":"swells","relative_path":"apps/payment-isolate/src/index.ts"}' } }] }

→ Execute tool: read_file → returns file content (2,400 chars)

→ Add to messages:
  { role: "tool", tool_call_id: "tc-1", content: '{"success":true,"content":"import { Elysia } from...","path":"/Users/me/projects/swells/apps/payment-isolate/src/index.ts","size":2400}' }

━━━ Iteration 2 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Provider call (Groq):
  Input:  system_blocks + messages (now 3 messages long)
  Output: {
    stopReason: "tool_use",
    toolCalls: [{ id: "tc-2", name: "read_file", input: { repo: "swells", relative_path: "apps/payment-isolate/src/main.ts" } }]
  }

→ Add assistant + tool messages to history

━━━ Iteration 3 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Provider call (Groq):
  Input:  system_blocks + messages (5 messages long)
  Output: {
    stopReason: "end_turn",
    text: "**payment-isolate** is a service in the swells repo that..."
  }

→ Loop ends → return text
```

#### NormalizedResponse Format

All providers return the same shape — the loop never sees raw API responses:

```typescript
interface NormalizedResponse {
  text: string;                // assistant's text content (may be empty during tool use)
  toolCalls: [{                // requested tool calls (may be empty)
    id: string;                // unique call ID for correlation
    name: string;              // "read_file", "write_file", etc.
    input: Record<string, unknown>;  // parsed arguments
  }];
  stopReason: "end_turn"       // natural completion
            | "tool_use"       // wants to call tools
            | "max_tokens"     // hit output limit
            | "error";         // provider error
  inputTokens: number;
  outputTokens: number;
  providerName: string;        // "groq" | "deepseek" | "gemini" | "claude-cli"
}
```

---

## 8. Phase 6 — Tool Execution

### `executeToolCall()` in `agent/tools.ts`

All tool calls go through a single dispatcher function. Safety checks run before any file I/O:

```
Tool call received: { name: "read_file", input: { repo: "swells", relative_path: "apps/payment-isolate/src/index.ts" } }

Step 1: Resolve repo
  config.repos["swells"].path = "/Users/me/projects/swells"
  fullPath = "/Users/me/projects/swells/apps/payment-isolate/src/index.ts"

Step 2: assertPathSafe(fullPath)
  registeredPaths = ["/Users/me/projects/swells", "/Users/me/projects/services"]
  resolved.startsWith(registeredPath)?  YES → safe
  NO → throw "SAFETY BLOCK: Path outside all registered repos"

Step 3: fs.readFile(fullPath, "utf-8")
  returns: file content string

Step 4: Return ToolResult
  { success: true, content: "import { Elysia } from...", path: "...", size: 2400 }
```

### Tool Availability by Mode

```
question mode:   read_file, read_file_section, list_directory, search_files, git_status, git_diff
research mode:   read_file, read_file_section, list_directory, search_files, git_status, git_diff, web_search
implement mode:  ALL above + write_file, run_command, git_create_branch, git_commit
```

### All 11 Tools and Their Safety Controls

| Tool | Safety Control | What it does |
|------|---------------|-------------|
| `read_file` | Path must be inside registered repo | Reads entire file |
| `read_file_section` | Path must be inside registered repo | Reads specific line range |
| `list_directory` | Path must be inside registered repo; excludes node_modules, dist, .git | Lists directory entries |
| `search_files` | Path must be inside registered repo | grep -rn with regex, 50-result cap |
| `git_status` | Runs in repo's cwd | Shows modified/staged/untracked files |
| `git_diff` | Runs in repo's cwd | Shows uncommitted changes |
| `web_search` | Max 3 calls per session; not available in question mode | Searches via Tavily or Brave |
| `write_file` | Path must be inside registered repo; creates parent dirs | Writes full file content |
| `run_command` | Path must be inside registered repo; blocks rm -rf, git push --force, DROP TABLE | Runs shell command, 120s timeout |
| `git_create_branch` | Runs in repo's cwd | Creates + switches to new branch |
| `git_commit` | Runs in repo's cwd; stages ONLY specified files | Stages specific files + commits |

### Progress Streaming

Every tool call emits a Slack progress message before execution:

```typescript
const TOOL_EMOJI = {
  read_file: "📂",
  write_file: "✍️",
  search_files: "🔍",
  run_command: "⚡",
  web_search: "🌐",
  git_commit: "💾",
  // ...
};

// For read_file: "📂 *read_file* `swells/apps/payment-isolate/src/index.ts`"
// For search:    "🔍 *search_files* `^import.*from.*elysia` in `swells/apps/payment-isolate/src`"
```

---

## 9. Phase 7 — Verification Pipeline

Only runs for `implement` mode tasks.

### `VerificationPipeline.run()` in `verification/verifier.ts`

Graders run sequentially (fail-fast):

```
┌─────────────────────────────────────────────────────────┐
│  LintGrader.grade(repo)                                  │
│  Command: repo.lintScript (e.g. "bun lint")              │
│  Timeout: 60s                                            │
│  passed? ─── NO ──→ STOP, build feedbackForRetry string  │
│           │                                              │
│          YES                                             │
│           ▼                                              │
│  BuildGrader.grade(repo)                                 │
│  Command: repo.buildScript (e.g. "bun build")            │
│  Timeout: 120s                                           │
│  passed? ─── NO ──→ STOP, build feedbackForRetry string  │
│           │                                              │
│          YES                                             │
│           ▼                                              │
│  TestGrader.grade(repo)  (only if runTests: true)        │
│  Command: repo.testScript                                │
└─────────────────────────────────────────────────────────┘
```

### pass@k Retry Loop: `retry-loop.ts`

If verification fails, error feedback is injected into the next agent attempt:

```
Attempt 1:
  agent writes code
  → lint: FAIL
  → feedback: "[LINT] 'paymentHandler' is declared but never used (line 42). Unused import 'Redis' (line 3)."

Attempt 2:
  system prompt adds block:
  ┌──────────────────────────────────────────────────────────┐
  │ ## ⚠️ Previous Attempt Failed — Fix These Issues         │
  │ ## Previous Attempt 1 Failed (lint)                      │
  │                                                          │
  │ [LINT] 'paymentHandler' is declared but never used       │
  │ [LINT] Unused import 'Redis'                             │
  │                                                          │
  │ Please fix the above issues before finalising changes.   │
  └──────────────────────────────────────────────────────────┘
  agent reads files again, fixes the issues
  → lint: PASS
  → build: PASS
  → commit + push

Total attempts: 2
```

### VerificationStatus Object

```typescript
{
  overall: "pass" | "fail" | "partial",
  graders: [
    { grader: "lint",  passed: true,  durationMs: 4200,  output: "" },
    { grader: "build", passed: false, durationMs: 31000, output: "error TS2345: Argument of type..." },
  ],
  attemptNumber: 1,
  maxAttempts: 3,
  feedbackForRetry: "[BUILD] error TS2345: Argument of type 'string' is not assignable to 'number' at line 47"
}
```

---

## 10. Phase 8 — Git Automation

### `GitAutomation.runFlow()` in `git/git-automation.ts`

Runs after a successful verify-and-implement:

```
Input:
  repo.path       = "/Users/me/projects/swells"
  session.taskDescription = "Add retry logic to payment-isolate"
  filesModified   = ["apps/payment-isolate/src/index.ts", "apps/payment-isolate/src/utils/retry.ts"]

Step 1: Build branch name
  buildBranchName("implement", "Add retry logic to payment-isolate")
  → prefix = "feat"  (implement mode → feat prefix)
  → slug   = "add-retry-logic-to-payment-isolate"  (lowercase, special chars removed)
  → date   = "2026-03-17"
  → result = "feat/add-retry-logic-to-payment-isolate-2026-03-17"

Step 2: git checkout -b "feat/add-retry-logic-to-payment-isolate-2026-03-17"

Step 3: MRGenerator.buildCommitMessage()
  LLM call → "feat(payment-isolate): add retry logic with exponential backoff"
  (conventional commit format: type(scope): description)

Step 4: git add -- "apps/payment-isolate/src/index.ts" "apps/payment-isolate/src/utils/retry.ts"
  (ONLY the specified files — never git add -A)

Step 5: git commit -m "feat(payment-isolate): add retry logic with exponential backoff\n\nCo-Authored-By: Agentic Factory <noreply@agent>"

Step 6: git push origin feat/add-retry-logic-to-payment-isolate-2026-03-17

Step 7: Build MR URL
  GitLab: "https://git.company.com/org/swells/-/merge_requests/new?merge_request[source_branch]=feat%2Fadd-retry-logic-to-payment-isolate-2026-03-17"
  GitHub: "https://github.com/org/swells/compare/feat%2Fadd-retry-logic...?expand=1"

Output: GitFlowResult
{
  branchName: "feat/add-retry-logic-to-payment-isolate-2026-03-17",
  commitSha: "a3f2c91",
  pushedToRemote: true,
  mrUrl: "https://..."
}
```

---

## 11. Phase 9 — Learning System

### Post-Session Pipeline: `learning/session-reviewer.ts`

Called asynchronously after every session (via `.claude/hooks/post-session.sh`):

```bash
# .claude/hooks/post-session.sh
#!/bin/bash
npx tsx agent/learning/session-reviewer.ts "$SESSION_ID" "$REPO_ALIAS" "$OUTCOME"
```

### Pattern Extraction: `learning/pattern-extractor.ts`

For successful implement sessions:

```
Input: sessionId, repoAlias
  → load all events from episodic JSONL
  → filter: task_start, tool_call, task_complete events

Prompt to LLM:
  "Given this session transcript, extract 1-3 generalizable patterns
   that would be useful in future similar tasks on this repo.
   Rules: no file-specific paths, no one-off patterns, must be reusable."

Session transcript:
  Task: Add retry logic to payment-isolate
  Tools used: read_file (index.ts, main.ts), write_file (index.ts, utils/retry.ts)
  Outcome: success, lint+build passed

LLM output:
[
  {
    "pattern": "When adding retry logic to Elysia services, extract the retry helper to a utils/ file and import it — keeps handlers clean and allows reuse across services",
    "tags": ["retry", "elysia", "utils", "patterns"],
    "confidence": 0.85
  }
]
```

### Skill Validation: `learning/skill-writer.ts`

Before registering, patterns are validated:
- Not a duplicate (embedding similarity check against existing skills)
- Not too specific (contains absolute file paths, version numbers)
- Confidence >= 0.7

Validated skills are appended to `data/skills/{repo}-skills.json`.

### Memory Decay

Every 30 days, semantic facts lose 5% confidence:

```typescript
// semantic-store.ts
async applyDecay(repoAlias: string): Promise<void> {
  const facts = await this.getFacts(repoAlias);
  const now = Date.now();
  const updated = facts.map(fact => {
    const daysSince = (now - new Date(fact.lastUpdated).getTime()) / 86_400_000;
    if (daysSince >= 30) {
      fact.confidence *= fact.decayFactor;  // 0.95 by default
      fact.lastUpdated = new Date().toISOString();
    }
    return fact;
  }).filter(f => f.confidence > 0.3);  // prune very stale facts
  await this.saveFacts(repoAlias, updated);
}
```

---

## 12. Multi-Repo Execution Path

When `intent.repos.length > 1`, the bot uses the orchestrator instead of calling `runAgentLoop()` directly.

### Simple Multi-Repo (2 repos, bot/index.ts sequential fallback)

For straightforward cross-repo tasks without complex dependencies:

```
"Add RequestId header to all HTTP calls in services and terminal"

bot/index.ts:
  intent.repos = ["services", "terminal"]
  isMultiRepo = true

  → for each repo in sequence:
      runAgentLoop("services", fullTask, ...)
      runAgentLoop("terminal", fullTask, ...)

  Results posted to Slack as:
  ### `services`
  Modified: apps/gateway/src/http-client.ts, libs/shared/src/headers.ts

  ### `terminal`
  Modified: apps/terminal-gateway/src/outbound.ts
```

### Complex Multi-Repo (LeadOrchestrator)

For tasks that need decomposition and parallel execution:

```
LeadOrchestrator.plan():

  Input: originalTask, repoAliases = ["services", "terminal"], mode = "implement"

  LLM (DeepSeek) decomposition call:
  "Decompose this into subtasks. Cross-service in same repo = single subtask."

  Output plan:
  {
    strategy: "parallel",
    estimatedComplexity: "medium",
    subTasks: [
      {
        id: "st-1",
        repoAlias: "services",
        serviceHint: null,
        description: "Add RequestId header to all outbound HTTP calls in services repo",
        executionMode: "implement",
        priority: 1,
        dependencies: [],
        isolatedWorktree: true
      },
      {
        id: "st-2",
        repoAlias: "terminal",
        serviceHint: null,
        description: "Add RequestId header to all outbound HTTP calls in terminal repo",
        executionMode: "implement",
        priority: 1,
        dependencies: [],
        isolatedWorktree: true
      }
    ]
  }

LeadOrchestrator.execute() → WorkerPool.execute():

  Parallel execution (p-limit = 3):

  Worker A (swells-abc123):                Worker B (terminal-def456):
    git worktree add                          git worktree add
      ../services-wt/worker-abc                ../terminal-wt/worker-def
      -b worker/abc123-st-1                    -b worker/def456-st-2
    ↓                                        ↓
    runAgentLoop("services", ...)            runAgentLoop("terminal", ...)
    (isolated, no conflict with B)           (isolated, no conflict with A)
    ↓                                        ↓
    VerificationPipeline.run()               VerificationPipeline.run()
    ↓                                        ↓
    worktreeManager.cleanup()                worktreeManager.cleanup()

  Both complete in parallel (~same time as one repo task)

ResultAggregator.aggregate():
  Merges WorkerResult[] into unified summary
  Posts to Slack with per-repo status table
```

### Worktree Isolation

```typescript
// worktree-manager.ts
async create(repoAlias: string, branchName: string) {
  const repo = config.repos[repoAlias];
  const worktreePath = path.join(repo.path, '..', `${repoAlias}-worktrees`, branchName.replace(/\//g, '-'));

  await execAsync(
    `git worktree add "${worktreePath}" -b "${branchName}"`,
    { cwd: repo.path }
  );

  return { repoAlias, branchName, worktreePath };
}

async cleanup({ worktreePath, branchName, repoAlias }: WorktreeInfo) {
  const repo = config.repos[repoAlias];
  await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repo.path });
  // Branch is kept — pushed to remote by the agent before cleanup
}
```

---

## 13. Full End-to-End Example: Question

**User message:** `"What does payment-isolate do in swells?"`

```
t=0ms    Slack WebSocket event received
         message.text = "What does payment-isolate do in swells?"

t=1ms    Registration check: no match → continue

t=2ms    say({ text: "🔍 Parsing your request...", thread_ts: ts })
         → Slack shows "🔍 Parsing your request..."

t=50ms   classifier.ts → Groq (llama-3.1-8b-instant, json_object)
         Output: { executionMode: "question", repos: ["swells"], needsWebSearch: false }

t=120ms  parseIntent() → Groq
         directAlias found: "swells"
         Output: {
           repo: "swells", service: "payment-isolate",
           taskType: "question",
           fullTask: "What does payment-isolate do in swells?",
           needsWebSearch: false
         }

t=130ms  say({
           text: "✅ *❓ Quick question*\n• Repo: `swells`\n• Service: `payment-isolate`\n• Type: `question`\n\n📋 *Task:* What does payment-isolate do in swells?\n\n⚡ Answering...",
         })
         → Slack shows classified task info

t=131ms  runAgentLoop("swells", "What does payment-isolate do in swells?", "payment-isolate", cb, "question")

t=132ms  memoryManager.query({ repoAlias: "swells", taskDescription: "..." })
         → Parallel: episodicStore.queryRecent() + skillRegistry.getSkills() + semanticStore.getFacts()
         → Returns memoryFragment (skills + facts from prior sessions)

t=180ms  buildSystemPromptBlocks()
         → Read AGENT_CONTEXT.md from swells repo (cached)
         → estimatedTokens = 1,766

t=182ms  ProviderRouter.select("question", 1766) → GroqProvider

t=183ms  progressCallback("🤖 Using provider: *groq* (~1,766 ctx tokens)")
         → Slack: "🤖 Using provider: *groq* (~1,766 ctx tokens)"

t=184ms  messages = [{ role: "user", content: "What does payment-isolate do in swells?" }]

━━━ Loop Iteration 1 (of max 4) ━━━━━━━━━━━━━━━━━━━━━━━━

t=184ms  groq.chat(messages, questionToolDefinitions, { maxTokens: 2048, systemBlocks })
         → Groq API call

t=640ms  Response: stopReason="tool_use"
         toolCalls: [{ id: "tc-001", name: "read_file", input: { repo: "swells", relative_path: "apps/payment-isolate/src/index.ts" } }]

t=641ms  progressCallback("📂 *read_file* `swells/apps/payment-isolate/src/index.ts`")
         → Slack: "📂 *read_file* `swells/apps/payment-isolate/src/index.ts`"

t=642ms  executeToolCall("read_file", { repo: "swells", relative_path: "apps/payment-isolate/src/index.ts" })
         → assertPathSafe("/Users/me/projects/swells/apps/payment-isolate/src/index.ts") → OK
         → fs.readFile() → 2,847 chars of TypeScript
         → { success: true, content: "import { Elysia }...", size: 2847 }

t=648ms  messages now has 3 items: [user, assistant(tool_call), tool(result)]

━━━ Loop Iteration 2 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

t=648ms  groq.chat(messages, ...)  (context now includes index.ts content)

t=1080ms Response: stopReason="tool_use"
         toolCalls: [{ name: "list_directory", input: { repo: "swells", relative_path: "apps/payment-isolate/src" } }]

t=1081ms progressCallback + executeToolCall
         → lists 8 files in the service directory

━━━ Loop Iteration 3 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

t=1500ms groq.chat(messages, ...)  (context now includes directory listing)

t=1920ms Response: stopReason="end_turn"
         text: "**payment-isolate** is a microservice in the swells monorepo responsible for payment isolation logic. Here's what it does:\n\n1. **Entry point** (`apps/payment-isolate/src/index.ts`): Initializes an Elysia server on port 3004...\n\n2. **Core responsibility**: Isolates payment processing to prevent cross-contamination between payment methods..."

t=1921ms say({
           text: "💬 *Answer*\n\n**payment-isolate** is a microservice in the swells monorepo...",
           thread_ts: ts
         })
         → Slack shows the answer in the thread

Total time: ~2 seconds
Total tokens: ~2,100 input + ~400 output
Cost: ~$0.0001
```

---

## 14. Full End-to-End Example: Implementation

**User message:** `"In swells, add a GET /health endpoint to payment-isolate that returns { status: 'ok', uptime: <seconds> }"`

```
t=0ms    Classifier → { executionMode: "implement", repos: ["swells"] }
t=60ms   parseIntent → { repo: "swells", service: "payment-isolate", taskType: "feature" }
t=70ms   say("✅ *⚙️ Implementation*\n• Repo: swells\n• Service: payment-isolate\n⚙️ Starting agent (explore → plan → implement)...")

t=80ms   runAgentLoop("swells", fullTask, "payment-isolate", cb, "implement")
t=90ms   memoryManager.query() → loads memory fragment
t=120ms  ProviderRouter.select("implement", 1900) → DeepSeekProvider
t=121ms  progressCallback("🤖 Using provider: *deepseek* (~1,900 ctx tokens)")

━━━ EXPLORE phase ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Iter 1: DeepSeek → read_file(apps/payment-isolate/src/index.ts)
  → "📂 *read_file* `swells/apps/payment-isolate/src/index.ts`"
  → returns Elysia app setup, existing routes

Iter 2: DeepSeek → read_file(apps/payment-isolate/src/main.ts)
  → returns server startup, port configuration

Iter 3: DeepSeek → list_directory(apps/payment-isolate/src)
  → ["index.ts", "main.ts", "routes/", "types.ts"]

━━━ PLAN (text output) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Iter 4: DeepSeek → text (no tool call):
  "Implementation plan:
   1. Modify apps/payment-isolate/src/index.ts — add GET /health route to Elysia app
   2. Route returns { status: 'ok', uptime: process.uptime() }
   No new files needed."

━━━ IMPLEMENT phase ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Iter 5: DeepSeek → write_file(apps/payment-isolate/src/index.ts, newContent)
  → "✍️ *write_file* `swells/apps/payment-isolate/src/index.ts`"
  → assertPathSafe() → OK
  → fs.writeFile() → 2,950 chars written

━━━ VERIFY phase ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Iter 6: DeepSeek → run_command("bun lint", cwd: apps/payment-isolate)
  → "⚡ *run_command* `bun lint`"
  → exec("bun lint") → { stdout: "", stderr: "" }  ← PASS

Iter 7: DeepSeek → run_command("bun build")
  → exec("bun build") → { stdout: "Build complete", stderr: "" }  ← PASS

━━━ REPORT phase ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Iter 8: DeepSeek → end_turn
  text: "✅ Added GET /health endpoint to payment-isolate.\n\n**Modified:**\n- `apps/payment-isolate/src/index.ts` — added health route\n\n**Endpoint:**\n```\nGET /health → { status: 'ok', uptime: 42.3 }\n```\n\nLint: ✅  Build: ✅"

━━━ VERIFICATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VerificationPipeline.run(repo, { runLint: true, runBuild: true })
  → LintGrader: "bun lint" → PASS (4.2s)
  → BuildGrader: "bun build" → PASS (18s)
  → overall: "pass"

━━━ GIT FLOW ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GitAutomation.runFlow():
  → branchName = "feat/add-health-endpoint-to-payment-isolate-2026-03-17"
  → git checkout -b "feat/add-health-endpoint-to-payment-isolate-2026-03-17"
  → commitMessage = "feat(payment-isolate): add GET /health endpoint with uptime"
  → git add -- "apps/payment-isolate/src/index.ts"
  → git commit -m "feat(payment-isolate): add GET /health endpoint with uptime\n\nCo-Authored-By: Agentic Factory <noreply@agent>"
  → git push origin feat/add-health...
  → mrUrl = "https://gitlab.company.com/org/swells/-/merge_requests/new?merge_request[source_branch]=feat%2F..."

━━━ MEMORY RECORDING ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

episodicStore.log(sessionId, "swells", "task_complete", {
  outcome: "success",
  filesModified: ["apps/payment-isolate/src/index.ts"],
  buildPassed: true,
  lintPassed: true,
  durationMs: 47000,
  providerUsed: "deepseek"
})

━━━ SLACK FINAL RESPONSE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

say({
  text: "✅ *Task Complete*\n\n✅ Added GET /health endpoint...\n\n---\n📝 *Next step*: review the changes, then commit & push.\n\n🌿 Branch: `feat/add-health-endpoint...`\n🔗 MR: https://gitlab..."
})

Total time: ~50 seconds
Total tokens: ~6,800 input + ~1,200 output
Cost: ~$0.002
```

---

## 15. Full End-to-End Example: Multi-Repo

**User message:** `"Add structured logging to all HTTP handlers in services and terminal repos"`

```
Classifier:  { executionMode: "implement", repos: ["services", "terminal"] }
parseIntent: { repos: ["services", "terminal"], taskType: "feature" }

isMultiRepo = true

progressCallback("🔀 *Multi-repo task* — running on `services` → `terminal`")

Sequential execution (bot/index.ts simple path):

  ── Round 1: services ──────────────────────────────────
  progressCallback("📦 *Working on `services`...*")
  runAgentLoop("services", fullTask, undefined, cb, "implement")
    → DeepSeek explores, finds HTTP handlers, adds logging
    → Modifies: apps/gateway/src/http.ts, libs/logger/src/index.ts
    → Lint ✅  Build ✅
    → result: "Modified 2 files..."

  ── Round 2: terminal ──────────────────────────────────
  progressCallback("📦 *Working on `terminal`...*")
  runAgentLoop("terminal", fullTask, undefined, cb, "implement")
    → DeepSeek explores terminal's HTTP layer (different framework)
    → Modifies: apps/terminal-gateway/src/middleware/logger.ts
    → Lint ✅  Build ✅
    → result: "Modified 1 file..."

  ── Summary ────────────────────────────────────────────
  say({
    text: "✅ *Multi-repo Task Complete*\n\n### `services`\nModified 2 files...\n\n---\n\n### `terminal`\nModified 1 file..."
  })
```

---

## 16. Data Structures Reference

### `AgentSession`

```typescript
interface AgentSession {
  sessionId: string;            // UUID
  repoAlias: string;            // "swells"
  taskDescription: string;      // original user message
  executionMode: "question" | "research" | "implement";
  startedAt: string;            // ISO timestamp
  endedAt?: string;
  durationMs?: number;
  outcome: "pending" | "success" | "partial" | "failed";
  filesModified: string[];      // relative paths
  buildPassed?: boolean;
  lintPassed?: boolean;
  totalTokensUsed?: number;
  providerUsed?: string;
}
```

### `SubTask` (for multi-repo orchestration)

```typescript
interface SubTask {
  id: string;                   // "st-1"
  parentTaskId: string;         // orchestrator task UUID
  repoAlias: string;
  serviceHint?: string;
  description: string;          // task for this specific worker
  executionMode: ExecutionMode;
  priority: number;             // 1 = highest
  dependencies: string[];       // ["st-1"] means wait for st-1 first
  isolatedWorktree: boolean;    // true = run in git worktree
  status: "pending" | "running" | "complete" | "failed";
  result?: string;
}
```

### `WorkerResult`

```typescript
interface WorkerResult {
  workerId: string;
  subTaskId: string;
  success: boolean;
  output: string;               // agent's final text
  filesModified: string[];
  verificationStatus?: VerificationStatus;
  tokensUsed: number;
  durationMs: number;
  error?: string;
}
```

### `EpisodicEvent` (JSONL line)

```typescript
interface EpisodicEvent {
  eventId: string;              // UUID
  sessionId: string;            // links events to a session
  repoAlias: string;
  timestamp: string;            // ISO
  eventType: "task_start"
           | "task_complete"
           | "tool_call"
           | "error"
           | "retry";
  data: Record<string, unknown>; // event-specific payload
  tokensAtEvent?: number;
}
```

---

## 17. Error Handling & Fallback Chains

### Provider Fallback

```typescript
// loop.ts — automatic fallback on rate limit / server error
let response = await provider.chat(...).catch(async (err) => {
  if (/429|503|502|ECONNRESET|timeout|rate.?limit/i.test(String(err))) {
    const fallback = ProviderRouter.selectAtTier(1);  // next available tier
    return fallback.chat(...);
  }
  throw err;
});
```

Fallback tier order:
```
Primary fails → try tier 1 (next available provider)
  DeepSeek → Gemini → Groq → Claude CLI
  Gemini → Groq → Claude CLI
  Groq → DeepSeek → Gemini → Claude CLI
```

### Verification Retry

```
Attempt 1 failed:
  feedback = "[LINT] unused var at line 42\n[BUILD] TS2345 at line 87"
  → injected into next system prompt block
  → agent re-reads files and fixes errors

Attempt 2 failed:
  feedback = "[BUILD] TS2345 at line 87" (lint now passes)
  → injected into system prompt

Attempt 3: final attempt (pass or give up)
  If pass → commit + push
  If fail → post error to Slack for manual review
```

### Cascade Debug Recovery

When all retry attempts fail, three agents run in parallel with different strategies:

```
Strategy A (root-cause):
  "Analyze the full error trace and fix the root cause only.
   Do not change anything unrelated to the error."

Strategy B (minimal-change):
  "Apply the smallest possible fix to unblock the build.
   Comment out or stub anything that can't be fixed quickly."

Strategy C (alternative-impl):
  "Rewrite the failing section using a different approach.
   Avoid whatever pattern caused the original failure."

OutputProcessor selects best result:
  1. First one that passes verification
  2. If multiple pass: prefer smallest diff
  3. If none pass: return Strategy A result with error details
```

### Memory System Errors

Memory errors are always non-fatal:

```typescript
// loop.ts
try {
  const bundle = await memoryManager.query({ ... });
  memoryFragment = bundle.memoryPromptFragment || undefined;
} catch {
  // Memory unavailable (first run, data dir missing) — continue without it
}
```

```typescript
// session-reviewer.ts
try {
  // extract patterns, register skills, apply decay
} catch (err) {
  console.error(`[session-reviewer] Error: ${String(err)}`);
  // Non-critical — don't let learning failures affect the user
}
```

### Tool Errors

Every tool call is wrapped individually:

```typescript
let result: unknown;
try {
  result = await executeToolCall(toolCall.name, toolCall.input);
} catch (err) {
  result = { success: false, error: `Tool execution error: ${String(err)}` };
}
// The agent sees the error in the tool result and can decide how to proceed
```

The agent receives `{ success: false, error: "..." }` and typically tries an alternative path (different file path, different search pattern) rather than crashing.
