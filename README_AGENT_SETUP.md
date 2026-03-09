# Claude Agent Bot — Setup Guide

Slack-based AI coding agent powered by the Anthropic Claude API.
Reads and writes code across the three Surfboard engineering repos.

---

## Prerequisites

- Node.js >= 20 (or use `nvm use 24`)
- A Slack workspace where you have admin rights
- An Anthropic API key

---

## Step 1 — Create the Slack App

1. Go to https://api.slack.com/apps → **Create New App** → **From Scratch**
2. Name it `Claude Agent` (or anything you like), select your workspace
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

6. In the left sidebar → **Install App** → **Install to Workspace** → Authorize
   - Copy the **Bot User OAuth Token** (starts with `xoxb-`) → this is `SLACK_BOT_TOKEN`

---

## Step 2 — Configure Environment

```bash
cd /Users/harishanantharaj/Desktop/coding/automation
cp .env.example .env
```

Edit `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

---

## Step 3 — Install Dependencies

```bash
npm install
```

---

## Step 4 — Place AGENT_CONTEXT.md in Each Repo

The agent reads `AGENT_CONTEXT.md` from the root of each repo at runtime.
Open `agent/AGENT_CONTEXT_TEMPLATE.md` and copy the relevant block to each repo:

```bash
# For surfboard-surfpay (alias: services)
# Copy the block under "FOR REPO: services" into:
/Users/harishanantharaj/Downloads/surfboard/Surfboardproject/surfboard-surfpay/AGENT_CONTEXT.md

# For auth-gateway (alias: terminal)
# Copy the block under "FOR REPO: terminal" into:
/Users/harishanantharaj/Downloads/surfboard/Surfboardproject/auth-gateway/AGENT_CONTEXT.md

# For swells (alias: swells)
# Copy the block under "FOR REPO: swells" into:
/Users/harishanantharaj/Downloads/surfboard/Surfboardproject/swells/AGENT_CONTEXT.md
```

Review each file for `<<CONFIRM: ...>>` placeholders (listed at the bottom of this guide)
and fill them in with the correct values before running the bot.

---

## Step 5 — Start the Bot

```bash
npm run dev
```

You should see:

```
⚡ Claude Agent Bot is running (Socket Mode)
📦 Registered repos: services, terminal, swells
🤖 Model: claude-sonnet-4-20250514
📡 Git host: git.surfboard.se (GitLab — PRs must be opened manually)
```

Invite the bot to a Slack channel: `/invite @Claude Agent`

---

## Step 6 — Using the Bot

Send a message in any channel where the bot is present:

```
In the services repo, add a new GET /health endpoint to the merchant-service
that returns { status: "ok", timestamp: <ISO date> }
```

```
Fix the null-check bug in terminal repo datecs-acquiring — the
transaction ID can be undefined when the terminal disconnects mid-flow
```

```
Refactor swells payment-isolate to extract the order validation logic
into a separate validateOrder() function in the utils folder
```

The bot will:

1. Parse the intent (repo, service, task type)
2. Show you what it understood before starting
3. Stream live tool-call updates into the Slack thread
4. Write the code and run the build to verify
5. Commit the changes and push a branch to git.surfboard.se
6. Post the GitLab merge request URL for you to open

**Note on PRs**: The repos use GitLab at `git.surfboard.se`, not GitHub.
The `gh` CLI does not work here. The bot will push the branch and give you
the direct GitLab "Create MR" URL.

---

## Git Workflow (Auto)

After the agent finishes, the bot:

1. Creates branch: `agent/<service>-<description>-<timestamp>`
2. `git add -A && git commit`
3. `git push origin <branch>`
4. Posts the GitLab MR creation URL

You review and merge manually via git.surfboard.se.

---

## <<CONFIRM>> Placeholders to Resolve

These values were not found in any `.env.example` or environment file during the scan.
Fill them in your `AGENT_CONTEXT.md` files before using the bot on those services.

| Placeholder                                                      | Where                                                            | What to fill                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `<<CONFIRM: Redis host/port constructor args in services repo>>` | `agent/repos.config.json` + `surfboard-surfpay/AGENT_CONTEXT.md` | Actual env keys used to pass Redis host/port to `RedisStorage` constructor                |
| `<<CONFIRM: DATABASE_URL for Prisma in services>>`               | `surfboard-surfpay/AGENT_CONTEXT.md`                             | Prisma DB connection env key for Prisma-using services                                    |
| `<<CONFIRM: DATABASE_URL for Prisma in terminal>>`               | `auth-gateway/AGENT_CONTEXT.md`                                  | Prisma DB connection env key (check `prisma/` schema for `datasource`)                    |
| `<<CONFIRM: service ports in services repo>>`                    | `surfboard-surfpay/AGENT_CONTEXT.md`                             | Port for each of the 103 services — check `apps/<service>/src/main.ts`                    |
| `<<CONFIRM: service ports in terminal repo>>`                    | `auth-gateway/AGENT_CONTEXT.md`                                  | Port for each of the 16 services — check `apps/<service>/src/environments/environment.ts` |
| `<<CONFIRM: service ports in swells repo>>`                      | `swells/AGENT_CONTEXT.md`                                        | Port for each service — check `apps/<service>/src/environment.ts`                         |
| `<<CONFIRM: test script in swells>>`                             | `agent/repos.config.json`                                        | Swells has no `test` script in package.json — add one or remove from config               |
| `<<CONFIRM: swells/apps/app purpose>>`                           | `swells/AGENT_CONTEXT.md`                                        | What does `apps/app/` do? Read its `src/index.ts`                                         |

---

## Project Structure

```
automation/
├── agent/
│   ├── repos.config.json          # All repo metadata (paths, services, libs)
│   ├── AGENT_CONTEXT_TEMPLATE.md  # Template — copy blocks to each repo root
│   ├── tools.ts                   # Claude tool definitions + executor
│   └── loop.ts                    # Claude agentic loop (multi-turn)
├── bot/
│   └── index.ts                   # Slack bot (Socket Mode, @slack/bolt)
├── package.json
├── tsconfig.json
├── .env.example
└── README_AGENT_SETUP.md          # This file
```
