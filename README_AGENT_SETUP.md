# automation-factories — Setup Guide

Slack-based AI coding agent that autonomously handles engineering tasks across multiple repos.
Supports multi-provider LLM routing (DeepSeek, Gemini, Groq, Claude CLI).

---

## Prerequisites

- Node.js >= 20
- A Slack workspace where you have admin rights
- At least one of: Anthropic API key, DeepSeek API key, Groq API key, Gemini API key
  (or just `CLAUDE_CLI` mode if you have Claude Code installed)

---

## Step 1 — Create the Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From Scratch**
2. Name it `automation-factories` (or anything you like), select your workspace
3. In the left sidebar → **Socket Mode** → enable it
   - Generate an **App-Level Token** with scope `connections:write`
   - Copy the token (starts with `xapp-`) → this is `SLACK_APP_TOKEN`

4. In the left sidebar → **OAuth & Permissions** → scroll to **Bot Token Scopes**, add:
   - `chat:write`
   - `im:history`
   - `channels:history`
   - `groups:history`
   - `mpim:history`

5. In the left sidebar → **Event Subscriptions** → enable it
   - Under **Subscribe to bot events**, add: `message.channels`, `message.im`, `message.groups`

6. In the left sidebar → **Interactive Components** → enable it
   - (Required for Approve / Cancel / Add Context buttons)

7. In the left sidebar → **Install App** → **Install to Workspace** → Authorize
   - Copy the **Bot User OAuth Token** (starts with `xoxb-`) → this is `SLACK_BOT_TOKEN`

---

## Step 2 — Configure Environment

```bash
cd /path/to/automation-factories
cp .env.example .env
```

Edit `.env` with your keys:

```env
# Slack (required)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# LLM providers — set IS_OPEN_SOURCE_MODE=yes to use these, or leave unset to use Claude CLI only
IS_OPEN_SOURCE_MODE=yes
ANTHROPIC_API_KEY=sk-ant-...
DEEPSEEK_API_KEY=sk-...
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...

# Optional: web search for research tasks
TAVILY_API_KEY=tvly-...
```

If `IS_OPEN_SOURCE_MODE=no` (or unset), the bot routes all tasks through Claude CLI (your local
Claude Code installation). No API keys required — uses your Claude subscription.

---

## Step 3 — Install Dependencies

```bash
npm install
```

---

## Step 4 — Register Your Repos

The bot needs to know about your repos before it can work on them. There are two ways:

### Option A — Auto-register via Slack (recommended)

Send this message to the bot in Slack:

```
/add-dir /path/to/your/repo
```

The bot will:

1. Detect the project type (NestJS, Next.js, Express, Bun, etc.)
2. Scan services and shared libs
3. Generate an `AGENT_CONTEXT.md` in the repo root
4. Register it with an auto-derived alias

### Option B — Manual registration

```
register project my-api at /path/to/your/repo
```

Then create `AGENT_CONTEXT.md` manually using the template at
`agent/AGENT_CONTEXT_TEMPLATE.md`. Copy it to your repo root and fill in all sections.

---

## Step 5 — Start the Bot

```bash
npm run dev
```

You should see:

```
⚡ automation-factories bot is running (Socket Mode)
📦 Registered repos: my-api, my-frontend
```

Invite the bot to a Slack channel: `/invite @automation-factories`

---

## Step 6 — Using the Bot

Send messages in any channel where the bot is present:

```
In the my-api repo, add a new GET /health endpoint to the user-service
that returns { status: "ok", timestamp: <ISO date> }
```

```
Fix the null-check bug in my-api auth-service — the token can be
undefined when the session expires mid-request
```

```
Refactor my-api payment-service to extract the validation logic
into a separate validatePayload() function
```

The bot will:

1. Parse the intent (repo, service, task type)
2. Show what it understood — confirm before executing
3. Stream live tool-call updates into the Slack thread
4. Research → Plan → show Approve / Add Context / Cancel buttons
5. On approval: write the code, run build to verify, commit, push a branch
6. Post the PR/MR URL

---

## Git Workflow (Auto)

After the agent finishes implementing:

1. Creates branch: `agent/<service>-<short-description>-<timestamp>`
2. `git add -A && git commit`
3. `git push origin <branch>`
4. Posts the PR/MR creation URL in Slack

---

## Project Structure

```
automation-factories/
├── agent/
│   ├── repos.config.json          # Your repo registry (gitignored — personal)
│   ├── repos.config.example.json  # Template — copy and edit to create yours
│   ├── AGENT_CONTEXT_TEMPLATE.md  # Template for writing AGENT_CONTEXT.md per repo
│   ├── config.ts                  # Config loader + repo registry API
│   ├── loop.ts                    # Multi-turn agent loop
│   ├── tools.ts                   # Tool definitions + executor
│   ├── classifier.ts              # Intent classifier (question/research/implement)
│   ├── providers/                 # LLM providers (Claude, DeepSeek, Gemini, Groq)
│   ├── memory/                    # Episodic + semantic + skill memory
│   └── learning/                  # Post-session pattern extraction
├── bot/
│   └── index.ts                   # Slack bot (Socket Mode, @slack/bolt)
├── data/                          # Runtime data (gitignored)
│   ├── episodic/                  # Session logs (JSONL)
│   ├── semantic/                  # Learned facts per repo (JSON)
│   └── skills/                    # Learned patterns per repo (JSON)
├── .env.example                   # Environment variable template
├── package.json
└── tsconfig.json
```

---

## Provider Routing

| Condition                         | Provider Used                            |
| --------------------------------- | ---------------------------------------- |
| `IS_OPEN_SOURCE_MODE=no` or unset | Claude CLI (your subscription)           |
| Quick question/routing            | Groq `llama-3.1-8b-instant` (ultra-fast) |
| Research / implement              | DeepSeek `deepseek-chat`                 |
| DeepSeek unavailable              | Groq `llama-3.3-70b-versatile`           |
| Context > 80K tokens              | Gemini `gemini-2.0-flash`                |
| All API providers fail            | Claude CLI fallback                      |
