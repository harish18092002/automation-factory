# AGENT_CONTEXT.md — Template

Copy this file to the root of each repo you register and fill in the sections below.
The agent reads `AGENT_CONTEXT.md` from the repo root before every task.
More context = better results. Fill in as much as you can.

**Usage:**
1. Copy this file to `<your-repo>/AGENT_CONTEXT.md`
2. Fill in all sections — replace every `<!-- ... -->` placeholder
3. Run `/add-dir <path>` in Slack to register the repo with the bot

---

```markdown
# <repo-alias> — Claude Agent Context

## Purpose
<!-- 2-3 sentences: what does this repo do? What is its main responsibility? -->
<!-- Example: "NestJS/Nx monorepo for the payments platform. Contains all product services
including checkout, billing, and merchant management. The gateway service (port 8080) is
the main API entry point." -->

## Absolute Path on This Machine
<!-- The full filesystem path to this repo, e.g. /Users/yourname/projects/my-api -->

## Project Structure
<!-- ASCII tree of the top-level layout. Example:
my-api/
├── apps/                    # Microservices
│   ├── gateway/             # API gateway — port 8080
│   ├── auth-service/        # Authentication
│   └── user-service/        # User management
├── libs/                    # Shared libraries (scope: @my-org/*)
│   ├── logger/
│   ├── common-utils/
│   └── interfaces/
├── package.json
└── tsconfig.base.json
-->

## Services
<!-- Table of services with ports and responsibilities. Example:
| Service Name | Port | Key Responsibility |
|---|---|---|
| gateway | 8080 | API gateway — routes all HTTP traffic |
| auth-service | 3001 | JWT auth, login, token refresh |
| user-service | 3002 | User CRUD |
-->

## Shared Libraries (import paths)
<!-- How are shared libs imported? Example:
```typescript
import { Logger } from '@my-org/logger';
import { CommonUtils } from '@my-org/common-utils';
// Pattern: import { X } from '@my-org/<lib-name>'
```
-->

## Shared Infrastructure

### Database / ORM
<!-- What database? What ORM? What are the key env vars? Example:
- PostgreSQL via Prisma (`@prisma/client`)
- Schema: `prisma/schema.prisma`
- Connection env key: `DATABASE_URL`
- Run `npx prisma generate` after schema changes
-->

### Message Bus / Events
<!-- How do services communicate async? Example:
- Redis Streams via @my-org/publisher
- Services publish to named streams and listen via consumer groups
- Never use raw XADD/XREAD — always use Publisher lib
-->

### Cache
<!-- Redis? Memcached? Key env vars? -->

## Environment Variables
<!-- List the key env vars (names only, no values). Example:
- `DATABASE_URL` — Prisma DB connection string
- `REDIS_HOST` / `REDIS_PORT` — Redis connection
- `JWT_SECRET` — JWT signing key
- `PORT` — Service port
Check each service's `.env.example` or `src/environment.ts` for the full list.
-->

## Coding Conventions
<!-- Key patterns the agent must follow. Examples:
- Module structure: each service has `src/app/<service>.module.ts` as root
- Entry point: `apps/<service>/src/main.ts` → `bootstrap()`
- DTOs: `apps/<service>/src/app/dto/`
- Tests: `*.spec.ts` (Jest), e2e in `e2e/` directories
- Linting: ESLint + prettier
- Imports: always use `@my-org/<lib>` path aliases — never relative imports into libs/
-->

## Build & Lint Commands
<!-- What commands does the agent run to verify changes?
- Build: `nx build <service-name>` or `npm run build`
- Lint: `nx lint <service-name>` or `npm run lint`
- Test: `nx test <service-name>` or `npm test`
-->

## What Claude Must ALWAYS Do in This Repo
<!-- Non-negotiable rules. Examples:
1. Read the service's module file before making changes
2. Read the entry point (main.ts or index.ts) before modifying a service
3. Never modify shared libs without checking all importing services
4. Use path aliases — never relative cross-lib imports
5. Run build after changes to verify compilation
6. Run lint before committing
-->

## What Claude Must NEVER Do in This Repo
<!-- Hard constraints. Examples:
- Never log sensitive data (PII, card numbers, passwords)
- Never write API keys or secrets into source files
- Never use `console.log` in production code — use the logger lib
- Never bypass the ORM with raw SQL/Redis commands
-->
```
