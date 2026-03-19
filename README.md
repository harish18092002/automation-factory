# automation-factories — Autonomous Engineering Bot

A Slack bot that autonomously researches, plans, implements, verifies, and commits code changes across multiple repositories — directly from a natural language message.

---

## Table of Contents

1. [What It Does](#1-what-it-does)
2. [Quick Start](#2-quick-start)
3. [Environment Variables](#3-environment-variables)
4. [Provider Architecture — Which Model for What](#4-provider-architecture--which-model-for-what)
5. [Full System Flow — Slack Message to Response](#5-full-system-flow--slack-message-to-response)
6. [Adding a New Project (`/add-dir`)](#6-adding-a-new-project-add-dir)
7. [The Confirm Flow (Plan → Approve → Implement)](#7-the-confirm-flow-plan--approve--implement)
8. [Agent Loop Internals](#8-agent-loop-internals)
9. [Available Tools](#9-available-tools)
10. [Memory System](#10-memory-system)
11. [Verify & Retry Loop](#11-verify--retry-loop)
12. [Git Automation & MR Generation](#12-git-automation--mr-generation)
13. [Directory Structure](#13-directory-structure)
14. [AGENT_CONTEXT.md — The Source of Truth](#14-agent_contextmd--the-source-of-truth)
15. [Example: End-to-End Walk-through](#15-example-end-to-end-walk-through)

---

## 1. What It Does

You send a message in Slack. The bot:

1. Classifies your intent (question / research / implement)
2. Identifies which repo and service you mean
3. Researches the codebase to build a plan
4. Shows you the plan and waits for your approval
5. Implements the change (reads files → writes files → runs build/lint)
6. Retries automatically if build or lint fails (up to 3 attempts)
7. Commits and pushes to a new branch, posts the MR link
8. Learns from every session to improve future runs

**Supported Slack inputs:**
```
"What does payment-service do in services?"
"Explain how datecs-acquiring is structured"
"Add a GET /health endpoint to merchant-service in services"
"Fix the null-check bug in terminal datecs-acquiring"
/add-dir /Users/me/code/myapp
register project myapp at /Users/me/code/myapp
```

---

## 2. Quick Start

### Prerequisites
- Node.js 18+ or Bun
- Claude Code CLI installed (`claude` command available)
- Slack app with Socket Mode enabled

### Install & Run

```bash
npm install
cp .env.example .env
# Fill in your .env values
npm run dev        # development (tsx watch)
npm start          # production
```

### Slack App Setup
1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** (Settings → Socket Mode)
3. Generate an **App-Level Token** with `connections:write` scope → `SLACK_APP_TOKEN`
4. Add **Bot Token Scopes**: `chat:write`, `channels:history`, `groups:history`, `im:history`
5. Enable **Interactivity** (for Approve/Cancel/Add-Context buttons) → set any Request URL
6. Install to workspace → copy **Bot User OAuth Token** → `SLACK_BOT_TOKEN`
7. Invite bot to channel: `/invite @automation-factories`

---

## 3. Environment Variables

```bash
# ── Required ───────────────────────────────────────────────────────────────
SLACK_BOT_TOKEN=xoxb-...         # Bot user OAuth token
SLACK_APP_TOKEN=xapp-...         # App-level token (connections:write)

# ── Mode ───────────────────────────────────────────────────────────────────
IS_PERSONAL=yes                  # yes → use API providers (Groq/DeepSeek/Gemini)
                                 # no  → Claude CLI only (team setup, no API keys)

# ── AI Providers (only required when IS_PERSONAL=yes) ──────────────────────
DEEPSEEK_API_KEY=sk-...          # T1 — Primary workhorse  ($0.28/$0.42 per M tokens)
GEMINI_API_KEY=AIza-...          # T2 — Long context (1M)  ($0.30/$2.50 per M tokens)
GROQ_API_KEY=gsk-...             # T3 — Fast routing        ($0.05/$0.08 per M, 14k req/day free)

# ── Optional ───────────────────────────────────────────────────────────────
GEMINI_MODEL=gemini-2.0-flash    # Override Gemini model (default: gemini-2.0-flash)
TAVILY_API_KEY=tvly-...          # Web search (recommended)
BRAVE_API_KEY=BSA-...            # Web search fallback
```

### Minimum setup options

| Setup | Required vars |
|---|---|
| Personal (recommended) | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `IS_PERSONAL=yes`, at least one of `GROQ_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` |
| Team (no API keys) | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `IS_PERSONAL=no` (Claude CLI used for everything) |

---

## 4. Provider Architecture — Which Model for What

### The 4 Tiers

| Tier | Provider | Model | Cost | Best For |
|------|----------|-------|------|----------|
| **T1** | DeepSeek | `deepseek-chat` | $0.28 / $0.42 per M | implement + research (primary workhorse) |
| **T2** | Gemini | `gemini-2.0-flash` (configurable) | $0.30 / $2.50 per M | large context tasks (>80K tokens) |
| **T3** | Groq | `llama-3.1-8b-instant` (fast) or `llama-3.3-70b-versatile` (smart) | $0.05 / $0.08 per M | routing, classification, question answering |
| **T4** | Claude CLI | Claude via `claude` subprocess | flat subscription | fallback (always available) |

### Routing Decision Tree

```
IS_PERSONAL !== 'yes'
  └─► Claude CLI (team mode — no API keys needed)

IS_PERSONAL = 'yes'
  ├─ context > 80K tokens AND hasGemini
  │    └─► Gemini T2 (1M context window)
  │
  ├─ mode = question OR route AND hasGroq
  │    └─► Groq T3 fast — llama-3.1-8b-instant (~1000 tok/s)
  │
  ├─ hasDeepSeek
  │    └─► DeepSeek T1 (best cost/quality for coding)
  │
  ├─ hasGroq
  │    └─► Groq T3 smart — llama-3.3-70b-versatile (fallback)
  │
  ├─ hasGemini
  │    └─► Gemini T2 (last resort API provider)
  │
  └─► Claude CLI T4 (always available)
```

### Fallback Chain on Error

If the selected provider fails (rate limit 429, server error 503, network timeout, or function call error 400), the agent automatically cascades:

```
Primary fails → Tier 1 → Tier 2 → Claude CLI
```

Each fallback step is reported to Slack:
```
⚠️ Provider `gemini` error (Error: 429 status code), falling back to next tier...
⚠️ Tier 1 (groq) also failed, trying next...
```

### Where Each Provider is Used

| Operation | Personal Mode | Non-Personal Mode |
|---|---|---|
| Task classification | Groq fast (8B) | Claude CLI |
| Intent parsing | Groq fast (8B) or DeepSeek | Direct classifier (no LLM call) |
| Question answering | Groq fast (8B) | Claude CLI |
| Research / planning | Groq smart (70B) or DeepSeek | Claude CLI |
| Implementation | DeepSeek T1 → Groq smart fallback | Claude CLI |
| Large context (>80K tokens) | Gemini T2 | Claude CLI |

---

## 5. Full System Flow — Slack Message to Response

### Every message goes through these phases:

```
User message
    │
    ▼
[1] Special command check
    ├─ /add-dir /path → Project Registration Flow
    └─ register project <alias> at /path → Registration Flow

    │ (normal message)
    ▼
[2] Task Classification          (Groq 8B / Claude CLI)
    → executionMode: question | research | implement
    → repos: ["services", ...]
    → needsWebSearch: true | false

    ▼
[3] Intent Parsing               (Groq 8B / DeepSeek)
    → repo (validated against registry)
    → service (validated against repo's service list)
    → taskType: feature | bugfix | refactor | question | ...
    → fullTask: VERBATIM user message

    ▼
[4] Post confirmation to Slack thread
    ✅ Implementation / Research / Question
    • Repo, Service, Type, Task

    ▼
[5] Memory Lookup (non-blocking)
    → recent similar sessions (episodic)
    → relevant skills (learned patterns)
    → repo facts (semantic knowledge)

    ▼
[6] Provider Selection
    → based on mode + estimated context tokens

    ▼
[7] Mode-specific execution
    │
    ├─ question ──────────────────────────────────────────────────────┐
    │   └─ Agent loop (5 iterations max, 2048 tokens)                 │
    │       DISCOVER → LOCATE → READ → ANSWER                        │
    │       Post answer to Slack                                     │
    │                                                                │
    ├─ research ──────────────────────────────────────────────────────┤
    │   └─ Agent loop (8 iterations max, 4096 tokens)                │
    │       DISCOVER → LOCATE → READ → ANALYSE → SUMMARISE          │
    │       Post analysis to Slack                                   │
    │                                                                │
    └─ implement ─────────────────────────────────────────────────────┤
        │                                                            │
        ├─ Planning phase (research mode, 8 iterations)              │
        │   └─ "Analyze codebase, produce plan, don't write files"   │
        │                                                            │
        ├─ Show plan in Slack with 3 buttons:                        │
        │   ✅ Approve & Implement                                    │
        │   💬 Add Extra Context → modal → re-plan                   │
        │   ❌ Cancel                                                 │
        │                                                            │
        └─ On Approve: Implementation phase (12 iterations max)      │
            DISCOVER → EXPLORE → PLAN → IMPLEMENT → VERIFY → REPORT │
            ↓                                                        │
           Verify (build/lint/test)                                  │
            ├─ Pass → Git commit + push + MR link                    │
            └─ Fail → Re-run with error feedback (up to 3 attempts)  │
                                                                     │
[8] Memory Recording ────────────────────────────────────────────────┘
    → episodic: log session start/end, files modified, outcome
    → structural: if new services detected, update AGENT_CONTEXT.md
    → learning: extract patterns → skills registry (async hooks)
```

---

## 6. Adding a New Project (`/add-dir`)

### Usage
```
/add-dir /absolute/path/to/project
```

The alias is automatically derived from the directory name:
- `/Users/me/code/my-services` → alias = `my-services`

To use a custom alias, use the longer form:
```
register project myalias at /absolute/path/to/project
```

### What Happens

**Step 1 — Structural Detection** (`agent/project-detector.ts`)
```
Checks:
  bun.lockb / bun.lock?     → runtime = "bun" (else "node")
  package.json?             → extract name, detect nx/bun build system
  nest-cli.json?            → framework = "nestjs"
  tsconfig.base.json?       → detect lib scope (@my-org/lib or myorg:lib style)
  apps/ directory exists?   → srcDir = "apps" (else "src")
  libs/ directory exists?   → enumerate shared libs

Produces config entry:
  { path, runtime, buildSystem, srcDir, services[], sharedLibs[],
    sharedLibScope, buildScript, lintScript, testScript }
```

**Step 2 — Scaffold AGENT_CONTEXT.md**
- Written to `{repoPath}/AGENT_CONTEXT.md` if not already present
- Contains `<<CONFIRM>>` placeholders for service descriptions, ports, etc.

**Step 3 — Register in `agent/repos.config.json`**
- Available immediately for all future Slack requests

**Step 4 — Deep Analysis** (only for `/add-dir`, only if no existing context)
- Runs a full agent loop in implement mode with task:
  > "Read README, package.json, service entry points, and rewrite AGENT_CONTEXT.md replacing all <<CONFIRM>> placeholders with real information"
- Agent reads actual code and fills in:
  - What the repo/each service actually does
  - Real ports (if found in config/main.ts)
  - Coding patterns, shared lib usage
- Writes updated AGENT_CONTEXT.md to repo root

**Step 5 — Report to Slack**
```
✅ Project registered: `my-services`
• runtime=bun, framework=nestjs, services=12, sharedLibs=5
• Path: /Users/me/code/my-services
• AGENT_CONTEXT.md: generated — running deep analysis...
...
✅ Deep analysis complete — AGENT_CONTEXT.md is ready. Ask questions!
```

---

## 7. The Confirm Flow (Plan → Approve → Implement)

Every implement task goes through a two-phase flow — the agent never writes code without your approval.

### Phase 1: Planning (read-only research)

The agent runs in `research` mode with this injected task:
```
PLANNING PHASE — analyze the codebase only. Do NOT write any files yet.
Task: <your original message>
Target service: <service>

Produce a structured plan:
1. Understanding — what does this require?
2. Files to modify — each file path + what change
3. Files to create — any new files
4. Risks / dependencies — things that could break
```

### Phase 2: Plan posted with 3 buttons

```
📋 Implementation Plan

1. Understanding: This task requires...
2. Files to modify:
   - apps/customer-service/src/customers.controller.ts — add PUT /customers/:id
   - libs/customers/src/lib/customers.service.ts — add updateCustomer() method
3. Files to create:
   - apps/customer-service/src/dto/update-customer.dto.ts
4. Risks: The customers lib uses a repository pattern...

[✅ Approve & Implement]  [💬 Add Extra Context]  [❌ Cancel]
```

### Button Actions

**✅ Approve & Implement**
- Runs full agent loop (implement mode, 12 iterations)
- Posts progress to thread as it works
- Verifies build/lint, commits, pushes, posts MR link

**💬 Add Extra Context**
- Opens a Slack modal dialog
- You type what's missing or wrong with the plan
  - _"The update route should also validate the email field"_
  - _"Don't create a new DTO, reuse the existing CreateCustomerDto"_
- On submit: appends `## Additional Context (from user)\n{your text}` to the task
- Re-runs the planning phase with updated context
- Shows a new plan with buttons — repeat until satisfied

**❌ Cancel**
- Posts exactly one "🚫 Task cancelled." (duplicate clicks silently ignored)
- Removes task from memory — cannot be un-cancelled

### Pending Task Expiry

Tasks are stored in an in-memory Map. If the bot restarts while a task is pending, the buttons will no longer work (the stored state is lost). Re-send your message to start fresh.

---

## 8. Agent Loop Internals

### Core Algorithm

```typescript
function runAgentLoop(repo, task, service, mode):
  memory = queryMemory(repo, task)           // episodic + semantic + skills
  systemBlocks = buildSystemPrompt(...)      // AGENT_CONTEXT.md + memory + session info
  provider = ProviderRouter.select(mode, estimatedTokens)
  messages = [{ role: 'user', content: task }]
  filesAlreadyRead = new Set()

  for iteration in 1..maxIterations[mode]:
    response = provider.chat(messages, tools, { maxTokens, systemBlocks })

    if response.stopReason === 'end_turn':
      break

    if response.stopReason === 'tool_use':
      for each toolCall:

        // DEDUP: prevent infinite re-read loops
        if toolCall is read_file AND already in filesAlreadyRead:
          return { error: "Already read this file. Use content from earlier." }

        execute toolCall safely
        track write_file → filesModified[]
        batch read_file → Slack message (every 5 reads)
        post non-read tools → Slack immediately

        append toolCall + result to messages

  record session in episodic memory
  if filesModified and mode=implement:
    check for new services/libs → update AGENT_CONTEXT.md

  return lastTextResponse
```

### Iteration Limits and Token Budgets

| Mode | Max Iterations | Max Output Tokens | Purpose |
|------|---------------|-------------------|---------|
| question | 5 | 2,048 | Quick answers |
| research | 8 | 4,096 | Analysis, planning |
| implement | 12 | 8,096 | Full implementation |

### Workflow Instructions (injected into system prompt per mode)

**Question mode:**
1. DISCOVER — `list_directory(".")` to see structure
2. LOCATE — `search_files` for relevant files
3. READ — `read_file` target files
4. ANSWER — based only on what you read, no hallucination

**Research mode:**
1. DISCOVER — `list_directory` on root + target service dir
2. LOCATE — `search_files`, try multiple keywords if first fails
3. READ — entry point, module file, 2–3 key implementation files
4. ANALYSE — architecture, structure, dependencies
5. SUMMARISE — purpose, key files, patterns

**Implement mode:**
1. DISCOVER — `list_directory` on root + target service
2. EXPLORE — read entry points, find existing similar implementations
3. PLAN — state plan explicitly before writing any file
4. IMPLEMENT — follow repo patterns, read before write
5. VERIFY — run build + lint, fix all errors
6. REPORT — list every file modified/created

### Slack Progress Streaming

Every tool call is streamed to the Slack thread:

| Tool | Behavior |
|------|----------|
| `read_file` | Batched: accumulated, posted as "📂 Reading files (N): ..." every 5 reads |
| `list_directory` | Posted immediately: `📁 list_directory services/.` |
| `search_files` | Posted immediately: `🔍 search_files \`customer update\` in services/apps` |
| `write_file` | Posted immediately: `✍️ write_file services/apps/customer-service/src/...` |
| `run_command` | Posted immediately: `⚡ run_command \`npm run build\`` |
| `git_*` | Posted immediately: `🌱 git_create_branch services` |

---

## 9. Available Tools

All tools require a `repo` alias and paths relative to the repo root. All paths are validated against registered repos (no path traversal outside registered directories).

| Tool | Modes | Description |
|------|-------|-------------|
| `read_file` | Q/R/I | Read full file content |
| `read_file_section` | Q/R/I | Read specific line range (efficient for large files) |
| `list_directory` | Q/R/I | List directory contents (excludes node_modules, dist, .git, .nx, .turbo, coverage) |
| `search_files` | Q/R/I | Regex grep across repo (max 60 results, 3 per file) |
| `git_status` | Q/R/I | Show modified files (`git status --short`) |
| `git_diff` | Q/R/I | Show uncommitted changes |
| `web_search` | R/I | Search web (Tavily → Brave fallback, max 3 per session) |
| `write_file` | I only | Create or overwrite a file (creates parent dirs automatically) |
| `run_command` | I only | Execute shell command (120s timeout, 5MB buffer) |
| `git_create_branch` | I only | Create and checkout a new branch |
| `git_commit` | I only | Stage specific files and commit (never `git add -A`) |

Q = question, R = research, I = implement

### Safety Blocks

`run_command` blocks these patterns regardless of mode:
```
rm -rf     git push --force    git push -f
DROP TABLE DROP DATABASE        truncate
format c:  del /f /s /q        :(){ :|:& };:
```

`git_commit` only stages files explicitly listed by the agent — never does `git add -A`.

---

## 10. Memory System

Three independent persistent memory layers, all stored in `data/`:

### Episodic Memory (`data/episodic/{repo}-{YYYY-MM}.jsonl`)

Records every agent session as a stream of events:
- `task_start` — description, mode
- `tool_call` — which tool, what input
- `task_complete` — outcome, files modified, duration, tokens used, provider

**Used for:** Injecting recent successful sessions into system prompt.
**Format:** JSONL, one event per line, rotated monthly.

### Semantic Memory (`data/semantic/{repo}-facts.json`)

Structured facts about a repo with time-decay:
```json
{
  "factId": "uuid",
  "category": "gotcha",
  "subject": "mutation endpoints",
  "content": "Require API key in Authorization header, not query param",
  "confidence": 0.9,
  "decayScore": 0.87
}
```

Categories: `architecture` | `pattern` | `gotcha` | `dependency` | `api_contract`

Facts are ranked by `decayScore × confidence`. Decay score multiplied by 0.95 every 30 days — old, unconfirmed facts fade out.

### Skill Registry (`data/skills/{repo}-skills.json`)

Validated, generalizable patterns extracted from successful sessions:
```json
{
  "name": "NestJS retry decorator pattern",
  "category": "pattern",
  "prompt": "When adding retry logic in NestJS, use @Retry() decorator from @nestjs/common with exponential backoff options",
  "triggerKeywords": ["retry", "exponential", "backoff", "resilience"],
  "successRate": 0.87,
  "usageCount": 12
}
```

Skills are matched by keyword overlap against the current task description. Only skills with high success rates are injected. Success rate tracked as rolling average: `0.8 × oldRate + 0.2 × (success ? 1 : 0)`.

### Memory Fragment Injection

Before each agent loop, memory is queried and formatted as:
```
## Memory: Learned Patterns
- When adding retry logic to NestJS services, use @Retry() decorator...

## Memory: Known Facts About This Repo
- [gotcha] mutation endpoints require API key in Authorization header
- [dependency] PaymentService depends on external StripeAPI v2

## Memory: Recent Similar Sessions
- Session: 1d4a2c | Task: add health endpoint | Outcome: success | Files: main.ts
```

This block is injected into the system prompt before each run. If memory is unavailable (first run, corrupted data), it silently degrades and continues without it.

---

## 11. Verify & Retry Loop

After every implement session, the output is automatically verified:

```
Agent writes code
    ↓
Run graders sequentially:
    Lint  → npm run lint  (or repo's lintScript)
    Build → npm run build (or repo's buildScript)
    Test  → npm test      (if configured)
    ↓
All pass? → Commit + push + MR link
    ↓
Any fail? → Extract error output
    ↓
Inject error into system prompt:
    ## ⚠️ Previous Attempt Failed — Fix These Issues
    [LINT] Line 45: 'foo' is declared but never used
    [BUILD] Type 'string' is not assignable to 'number' at ...
    ↓
Re-run agent loop (attempt 2)
    ↓
Re-verify
    ↓
Still fail? → Attempt 3 (final)
    ↓
Post result regardless — partial success or failure
```

The agent sees the exact error output from each failed attempt and is instructed to fix those specific issues.

---

## 12. Git Automation & MR Generation

After successful verification (`agent/git/`):

1. **Branch creation** (done early in implement phase):
   ```
   feat/add-health-endpoint-2026-03-18
   fix/null-check-payment-service-2026-03-18
   refactor/extract-shared-retry-logic-2026-03-18
   ```
   Prefix derived from `taskType` (feature → `feat/`, bugfix → `fix/`, etc.)

2. **Stage only modified files:**
   ```bash
   git add -- "apps/merchant-service/src/health.controller.ts"
   ```
   Never `git add -A`. Files tracked from `write_file` calls during the session.

3. **Commit with conventional format:**
   ```
   feat(merchant-service): add GET /health endpoint with uptime and version
   ```

4. **Push and generate MR URL:**
   - GitHub: `https://github.com/org/repo/compare/main...feat/...?expand=1`
   - GitLab: `https://git.host/org/repo/-/merge_requests/new?source_branch=...`

5. **Post to Slack thread:**
   ```
   ✅ Task Complete
   ...
   💬 Create MR: https://github.com/...
   ```

---

## 13. Directory Structure

```
automation/
│
├── bot/
│   └── index.ts                    Slack Socket Mode listener. Intent parsing,
│                                   registration commands, confirm flow, action handlers.
│
├── agent/
│   ├── loop.ts                     Core multi-turn agent loop. Builds system prompt,
│   │                               selects provider, executes tool calls, streams
│   │                               progress, handles dedup + memory recording.
│   │
│   ├── tools.ts                    13 tool implementations: read_file, write_file,
│   │                               list_directory, search_files, run_command, git_*,
│   │                               web_search. All with safety validation.
│   │
│   ├── classifier.ts               Groq/Claude classification: question/research/implement.
│   ├── config.ts                   Repo registry: load/save repos.config.json.
│   ├── project-detector.ts         Auto-detect runtime, services, libs, build system.
│   ├── types.ts                    Shared TypeScript interfaces.
│   │
│   ├── providers/
│   │   ├── types.ts                Provider interface + NormalizedResponse type.
│   │   ├── deepseek.ts             T1: DeepSeek V3.2 via OpenAI-compat API.
│   │   ├── gemini.ts               T2: Google Gemini via OpenAI-compat API.
│   │   ├── groq.ts                 T3: Groq (8B fast / 70B smart) via OpenAI API.
│   │   ├── claude-cli.ts           T4: Spawns `claude` CLI subprocess.
│   │   └── router.ts               IS_PERSONAL gate + tier routing logic.
│   │
│   ├── memory/
│   │   ├── memory-manager.ts       Unified query interface + session recording.
│   │   ├── episodic-store.ts       JSONL session event log (monthly rotation).
│   │   ├── semantic-store.ts       JSON facts with time-decay scoring.
│   │   └── skill-registry.ts       JSON skill patterns with success rate tracking.
│   │
│   ├── verification/
│   │   ├── graders.ts              Build/lint/test/schema graders.
│   │   ├── verifier.ts             Runs graders sequentially, collects feedback.
│   │   └── retry-loop.ts           Pass@3 retry: re-runs agent with error injection.
│   │
│   ├── git/
│   │   ├── git-automation.ts       Branch/commit/push workflow.
│   │   └── mr-generator.ts         LLM-generated commit messages and MR descriptions.
│   │
│   ├── learning/
│   │   ├── pattern-extractor.ts    Extract generalizable patterns from sessions.
│   │   ├── skill-writer.ts         Validate and register extracted patterns.
│   │   └── session-reviewer.ts     Entry point called by post-session hooks.
│   │
│   ├── orchestrator/               Multi-agent coordination (parallel workers)
│   │   ├── lead-orchestrator.ts    Decomposes task into sub-tasks.
│   │   ├── worker-pool.ts          Manages concurrent worker agents.
│   │   ├── context-builder.ts      Per-worker isolated context.
│   │   └── result-aggregator.ts    Merges parallel outputs.
│   │
│   └── parallelization/
│       ├── worktree-manager.ts     Git worktree lifecycle (isolated workspaces).
│       ├── parallel-runner.ts      Spawns multiple agents concurrently.
│       └── cascade-debugger.ts     3-strategy recovery for failed implementations.
│
├── data/                           Runtime data (gitignore this)
│   ├── episodic/                   {repo}-{YYYY-MM}.jsonl
│   ├── semantic/                   {repo}-facts.json
│   └── skills/                     {repo}-skills.json
│
├── .claude/hooks/
│   ├── post-session.sh             Triggers learning pipeline after sessions.
│   └── pre-session.sh              Pre-session setup.
│
├── agent/repos.config.json         Auto-maintained repo registry (created on first /add-dir)
├── .cspell.json                    Spell-checker config (technical terms)
├── .env.example                    Environment variable documentation
├── package.json
└── tsconfig.json
```

---

## 14. AGENT_CONTEXT.md — The Source of Truth

Every registered repo must have an `AGENT_CONTEXT.md` at its root. This is the most important file for agent quality — it's injected as the first block of every system prompt.

### Minimum required structure

```markdown
# my-services — Claude Agent Context

## Quick Reference
- **Services**: `apps/` — 15 services
- **Shared libs**: `libs/` — scope: `@company`
- **Build**: `npm run build`
- **Lint**: `npm run lint`
- **Runtime**: node

## Purpose
Microservices monorepo for the payments platform. Handles card processing,
merchant management, and customer accounts via NestJS services.

## Absolute Path
/Users/me/code/my-services

## Services
| Service | Port | Responsibility |
|---|---|---|
| gateway | 3000 | API entry point, auth, rate limiting |
| merchant-service | 3001 | Merchant CRUD, onboarding |
| payment-service | 3002 | Card processing, refunds |

## Shared Libraries
```typescript
import { ... } from '@company/<lib-name>';
// Available libs: customers, payments, common, auth
```

## Coding Conventions
- **Entry point**: `apps/<service>/src/main.ts`
- **Imports**: Always use `@company/` path aliases — never relative cross-lib imports
- **Build**: `npm run build` after all changes
- **Lint**: `npm run lint` before finishing

## What Claude Must ALWAYS Do
1. Read the service entry point before modifying any service
2. Use `@company/` path aliases — never relative imports into `libs/`
3. Run build and lint after code changes
4. Read files before writing to existing files
```

### Auto-generation

When you run `/add-dir /path`, the agent:
1. Generates a scaffold with `<<CONFIRM>>` placeholders
2. Immediately runs a deep analysis to replace all placeholders with real content
3. If a AGENT_CONTEXT.md already exists, it is kept as-is (assumed to be manually curated)

### Auto-update on breaking structural changes

After each successful implement session, the agent checks if new services or libraries were added (by comparing `list_directory` output against the stored config). If detected, a dated change note is appended:

```markdown
## Auto-Detected Structural Changes (2026-03-18)
- **New services**: notification-service, audit-service
> Auto-detected breaking structural change — review Services table above.
```

---

## 15. Example: End-to-End Walk-through

**User sends in Slack:**
```
Add a PUT /customers/:id route to customer-service in services
```

**What happens in the background:**

```
[~200ms]  Classification (Groq 8B)
           → executionMode: "implement", primaryRepo: "services"

[~300ms]  Intent parsing (Groq 8B)
           → repo: "services", service: "customer-service"
           → taskType: "feature", description: "add-customer-update-route"

[Slack]   Post confirmation message to thread
           ✅ ⚙️ Implementation
           • Repo: services
           • Service: customer-service
           • Type: feature

[Memory]  Query episodic, semantic, skills for "services" + "customer update"
           → Found skill: "NestJS route pattern uses @Put(':id') decorator"
           → Found fact: "customer-service delegates persistence to customers lib"

[Provider] Select: Groq 70B (IS_PERSONAL=yes, no DeepSeek available)

[Planning] Agent loop — research mode, 8 iterations max
  Iteration 1:
    → list_directory(services, ".")             → sees apps/, libs/
    → list_directory(services, "apps")          → sees customer-service, ...
  Iteration 2:
    → list_directory(services, "apps/customer-service/src/app/customers")
    → read_file(services, "apps/customer-service/src/app/customers/customers.controller.ts")
  Iteration 3:
    → read_file(services, "libs/customers/src/lib/customers.service.ts")
    → search_files(services, "updateCustomer", "libs/customers")
  → PLAN produced

[Slack]   Post plan with buttons:
           📋 Implementation Plan
           1. Understanding: Add PUT /customers/:id using existing customers lib pattern
           2. Files to modify: customers.controller.ts, customers.service.ts
           3. Files to create: update-customer.dto.ts
           4. Risks: customers lib uses repository pattern via customer.repository.ts

           [✅ Approve & Implement] [💬 Add Extra Context] [❌ Cancel]

[User clicks ✅ Approve & Implement]

[Impl]    Agent loop — implement mode, 12 iterations max
  Iteration 1:
    → git_create_branch(services, "feat/add-customer-update-route-2026-03-18")
    → read_file(services, "apps/customer-service/src/app/customers/customers.controller.ts")
    → read_file(services, "libs/customers/src/lib/customers.service.ts")
  Iteration 2:
    → read_file(services, "libs/customers/src/lib/customer.repository.ts")
    → search_files(services, "UpdateCustomerDto", "libs/customers")
  Iteration 3:
    → write_file(services, "apps/customer-service/src/dto/update-customer.dto.ts")
    → write_file(services, "apps/customer-service/src/app/customers/customers.controller.ts")
    → write_file(services, "libs/customers/src/lib/customers.service.ts")
  Iteration 4:
    → run_command(services, "npm run build")    → ✓ success
    → run_command(services, "npm run lint")     → ✓ success

[Verify]  Lint: ✓   Build: ✓   → proceed to commit

[Git]     git add -- "apps/customer-service/src/dto/update-customer.dto.ts"
                                "apps/customer-service/src/.../customers.controller.ts"
                                "libs/customers/src/lib/customers.service.ts"
          git commit -m "feat(customer-service): add PUT /customers/:id update route"
          git push origin feat/add-customer-update-route-2026-03-18

[Memory]  recordSessionEnd: outcome=success, filesModified=[3 files], provider=groq
          maybeUpdateAgentContext: no new services detected, no update needed

[Slack]   ✅ Task Complete

           Added PUT /customers/:id route to customer-service.

           Files modified:
           - apps/customer-service/src/dto/update-customer.dto.ts (created)
           - apps/customer-service/src/app/customers/customers.controller.ts
           - libs/customers/src/lib/customers.service.ts

           ✓ Lint  ✓ Build

           ---
           📝 Next step: review changes, commit & push.
           💬 Create MR: https://github.com/company/services/compare/main...feat/...
```

Total time: ~2–4 minutes depending on codebase size and provider speed.

---

## Common Issues

| Issue | Cause | Fix |
|---|---|---|
| "Could not determine the target repo" | No repo alias found in message | Mention the alias explicitly: "in services, ..." |
| "Agent error: 404 status code" | Wrong Gemini model name | Set `GEMINI_MODEL=gemini-2.0-flash` in `.env` |
| "Reached max turns (1)" | Claude CLI in non-personal mode | Make sure `IS_PERSONAL` is set correctly in `.env` |
| Infinite read loop | Model re-reading same files | Fixed via dedup set — same file returns cached hint |
| 99 Slack messages | Old: every read posted individually | Fixed via batching — reads grouped per 5 |
| Plan buttons stop working after restart | Pending tasks stored in-memory | Re-send your message to create a new plan |
| `/add-dir` context is empty | AGENT_CONTEXT.md had <<CONFIRM>> placeholders | Delete the file and re-run `/add-dir` to trigger deep analysis |
