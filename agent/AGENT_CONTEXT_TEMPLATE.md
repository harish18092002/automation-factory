# AGENT_CONTEXT.md Template Generator

This file contains one complete, ready-to-save AGENT_CONTEXT.md block per repo.
Copy each block to the correct absolute path shown in the heading.

---

### FOR REPO: services → save this as /Users/harishanantharaj/Downloads/surfboard/Surfboardproject/surfboard-surfpay/AGENT_CONTEXT.md

```markdown
# services (Surf Core) — Claude Agent Context

## Purpose
Core NestJS/Nx monorepo for the Surfboard platform. Contains all product services
including payments, KYC, merchant management, terminals, analytics, and more.
The `gateway` service (port 8080) is the main API gateway that proxies requests
to all downstream microservices via NestJS ClientsModule (TCP/Redis transport).

## Absolute Path on This Machine
/Users/harishanantharaj/Downloads/surfboard/Surfboardproject/surfboard-surfpay

## Project Structure
```
surfboard-surfpay/
├── apps/                    # 103 microservices (NestJS)
│   ├── gateway/             # Main API gateway — port 8080
│   ├── transaction-service/ # Payment transactions
│   ├── merchant-service/    # Merchant management
│   ├── stores/              # Store management
│   ├── control-unit-service/
│   ├── user-service/
│   ├── kyc-services/
│   ├── payments-service/
│   ├── settlement-service/
│   ├── [... 95 more services]
├── libs/                    # ~65 shared libraries (scope: @surf-core/*)
│   ├── redis-connection/    # Redis client (ioredis)
│   ├── ocean/               # Custom Redis-backed ORM
│   ├── token-service/       # JWT token management
│   ├── permission-registry/ # Permission validation
│   ├── entities/            # TypeORM entities
│   ├── typeorm-entities/    # Additional TypeORM entities
│   ├── interfaces/          # Shared TypeScript interfaces
│   ├── data-model/          # Shared data models
│   ├── logger/              # Logging utilities
│   ├── publisher/           # @jetit/publisher message broker wrapper
│   ├── slipstream-client/   # Cross-environment sync client
│   ├── surf-signal/         # Internal event signalling
│   ├── environment-secrets/ # Multi-cloud KMS secret management
│   ├── slack-alerts/        # Slack notification lib
│   └── [... 50 more libs]
├── package.json             # name: "services", NX monorepo
├── nx.json                  # NX build config (no nest-cli.json at root)
└── tsconfig.base.json       # Path aliases: @surf-core/* → libs/*/src/index.ts
```

## Services
| Service Name | Port | Key Responsibility |
|---|---|---|
| gateway | 8080 | API gateway — routes all external HTTP traffic to downstream services |
| transaction-service | <<CONFIRM>> | Payment transaction processing |
| merchant-service | <<CONFIRM>> | Merchant CRUD and management |
| stores | <<CONFIRM>> | Store/location management |
| control-unit-service | <<CONFIRM>> | POS control unit management |
| user-service | <<CONFIRM>> | User accounts and auth |
| kyc-services | <<CONFIRM>> | KYC verification flows |
| payments-service | <<CONFIRM>> | Payment processing orchestration |
| settlement-service | <<CONFIRM>> | Settlement and reconciliation |
| ocean-server | <<CONFIRM>> | Redis data sync server |
| [all others] | <<CONFIRM: read apps/<name>/src/main.ts>> | <<CONFIRM>> |

## Shared Libraries (import paths)
All shared libs use the `@surf-core/` scope:
```typescript
import { RedisStorage } from '@surf-core/redis-connection';
import { TokenService } from '@surf-core/token-service';
import { validatePermissions } from '@surf-core/permission-registry';
import { initializeOceanFromEnv, ocean } from '@surf-core/ocean';
import { getGatewayServerMsOptions } from '@surf-core/message-broker';
// ... pattern: import { X } from '@surf-core/<lib-name>'
```

## Shared Infrastructure

### Ocean — Redis Cache & Data Access Layer (`libs/ocean/`)
Ocean is the **primary data store** for all services in this repo. It is NOT a SQL ORM —
it is a fluent API that reads/writes domain entities directly into **Redis**.

- Import: `import { ocean, initializeOceanFromEnv } from '@surf-core/ocean'`
- Initialise at startup: `await initializeOceanFromEnv({ lStore: false, rStore: true })`
- Usage pattern: `ocean().<fluent-method>()` — returns Promises
  ```typescript
  // Example from gateway/src/main.ts:
  ocean().ifPaymentPageUrlHostExist(origin).then(isAllowed => { ... })
  ```
- All domain entities (Orders, Payments, Merchants, Stores, Terminals, Users, KYC, etc.)
  live in Redis via Ocean — **never bypass Ocean with raw Redis commands** unless
  Ocean doesn't expose the operation you need
- Ocean is backed by `libs/redis-connection/` (`RedisStorage` — ioredis wrapper)

### Publisher — Redis Streams Event System (`libs/publisher/`)
Publisher is the **inter-service event bus** backed by **Redis Streams** (not AMQP, not Kafka).

- Import: `import { Publisher, PublisherLite } from '@surf-core/publisher'`
- `Publisher` (`Streams` class): full-featured — consumer groups, circuit breaker,
  dead-letter queue (DLQ), content-based deduplication, Prometheus metrics
- `PublisherLite` (`StreamsLite` class): lightweight version for simple event publishing
- Additional helpers: `publishBatch`, `publishScheduledBatch`
- Types: `EventData`, `PublishData`, `IListenOptions`, `IStreamsConfig`, `TEventFilter`
- Services **publish** events to named streams and **listen** via consumer groups —
  this is how microservices communicate asynchronously (not via HTTP)
- Never use raw Redis XADD/XREAD — always go through `Publisher` / `PublisherLite`

### Other Infrastructure
- **ORM**: TypeORM (entities in `libs/typeorm-entities/`) AND Prisma (`@prisma/client`)
  — both present, usage varies per service
- **NestJS Microservices**: `ClientsModule` with TCP/Redis transport via `@surf-core/message-broker`
  (used by gateway to proxy requests to downstream services)
- **Redis connection env key**: `<<CONFIRM: RedisStorage takes host/port as constructor args — check each service's environment.ts for which env vars feed those>>>`

## Environment Variables (keys — no .env.example found, confirm per service)
Check each service's `src/environments/environment.ts` for the full list.
Common keys observed across services:
- `REDIS_HOST` / `REDIS_PORT` — Redis connection
- `JWT_SECRET` — JWT signing (<<CONFIRM: key name>>)
- `DATABASE_URL` — <<CONFIRM: Prisma services>>
- `ALLOWED_DOMAINS` — gateway CORS allowlist

## Coding Conventions (from code scan)
- **Module structure**: Each service has `src/app/<service>-app.module.ts` as root module
- **Entry point**: `apps/<service>/src/main.ts` → `bootstrap()` function
- **Gateway routing**: Routes defined as `@Injectable()` classes with `registerRoutes()` method,
  injected into `GatewayAppModule` constructor
- **DTOs**: Located in `apps/<service>/src/app/dto/` or `apps/<service>/src/app/<domain>/dto/`
  (<<CONFIRM: check specific service>>)
- **Tests**: `*.spec.ts` pattern (Jest), e2e in separate `e2e/` directories
- **Linting**: ESLint with `@typescript-eslint`, prettier
- **Imports**: Always use `@surf-core/<lib>` path aliases — never relative imports into libs/

## What Claude Must ALWAYS Do in This Repo
- Read `apps/<service>/src/app/<service>-app.module.ts` before making changes
- Read the service's `main.ts` to confirm port and bootstrap pattern
- Never modify `libs/` without checking all services that import that lib via tsconfig.base.json paths
- Follow the `registerRoutes()` pattern when adding gateway routes
- Use `@surf-core/` path aliases — never relative cross-lib imports
- Run `npx nx affected --target=build --base=HEAD~1 --parallel=5` after changes to verify
- Run `nx lint <service-name>` before committing
- Check `libs/permission-registry/` before adding new endpoints — permissions must be registered
```

---

### FOR REPO: terminal → save this as /Users/harishanantharaj/Downloads/surfboard/Surfboardproject/auth-gateway/AGENT_CONTEXT.md

```markdown
# terminal (Auth Gateway) — Claude Agent Context

## Purpose
PCI-scoped NestJS/Nx monorepo for payment terminal acquiring. Handles card-present
payment flows including Datecs, Nets, Fiserv, Bambora, and Apple TTP acquiring.
Contains HSM integrations (AWS, Google, Futurex), 3DS notifications, and online acquiring.
This is a security-sensitive PCI repo — treat all changes with extra care.

## Absolute Path on This Machine
/Users/harishanantharaj/Downloads/surfboard/Surfboardproject/auth-gateway

## Project Structure
```
auth-gateway/
├── apps/                    # 16 acquiring/terminal services (Fastify)
│   ├── datecs-acquiring/    # Datecs terminal acquiring
│   ├── online-acquiring/    # Online (card-not-present) acquiring
│   ├── nets-gateway/        # Nets acquiring gateway
│   ├── nets-mock-gateway/   # Nets mock for testing
│   ├── hsm-gateway/         # HSM cryptography gateway
│   ├── payment-command-engine/ # PCE — payment orchestration
│   ├── pce/                 # PCE variant
│   ├── agw-apple-ttp/       # Apple Tap-to-Pay
│   ├── datecs-capture/      # Datecs transaction capture
│   ├── gcloud-encrypt/      # Google Cloud KMS encryption
│   ├── threeds-notifications/ # 3DS webhook notifications
│   ├── transaction-autopsy/ # Transaction diagnostics
│   ├── transaction-helper/  # Transaction utilities
│   ├── tre/                 # Transaction routing engine
│   ├── ttp-acquiring/       # Tap-to-Pay acquiring
│   └── scheduler/           # Job scheduler
├── libs/                    # ~24 shared libraries (scopes: @terminal/*, @agw/*)
│   ├── db/                  # Redis registry + Prisma DB
│   ├── ocean/               # Redis-backed ORM (Ocean)
│   ├── logger/              # SurfboardLogger
│   ├── interface/           # Shared TS interfaces
│   ├── app-utils/           # Common utilities
│   ├── fiserv-acquiring/    # Fiserv integration
│   ├── bambora-acquiring/   # Bambora integration
│   ├── nets-acquiring/      # Nets integration
│   ├── card-tokenization/   # Card token management
│   ├── cof-tokenization/    # Credentials-on-file tokenization
│   ├── aws-hsm/             # AWS Payment Cryptography HSM
│   ├── futurex-hsm/         # Futurex HSM
│   ├── google-hsm/          # Google Cloud HSM
│   ├── connection-pool/     # Connection pooling
│   ├── slipstream-client/   # Cross-env sync
│   ├── surf-signal/         # Internal event signalling
│   └── [... more]
├── prisma/                  # Prisma schema(s)
├── scripts/                 # Build/deploy scripts
├── tools/                   # Nx workspace tools
├── package.json             # name: "terminal"
└── tsconfig.base.json       # Path aliases: @terminal/* and @agw/*
```

## Services
| Service Name | Port | Key Responsibility |
|---|---|---|
| datecs-acquiring | environment.port (<<CONFIRM>>) | Datecs POS terminal acquiring |
| online-acquiring | environment.port (<<CONFIRM>>) | Online card acquiring |
| nets-gateway | <<CONFIRM>> | Nets network acquiring |
| nets-mock-gateway | <<CONFIRM>> | Nets test/mock environment |
| hsm-gateway | <<CONFIRM>> | HSM cryptography operations |
| payment-command-engine | <<CONFIRM>> | Payment orchestration |
| pce | <<CONFIRM>> | PCE variant |
| agw-apple-ttp | <<CONFIRM>> | Apple Tap-to-Pay |
| datecs-capture | <<CONFIRM>> | Datecs capture flow |
| gcloud-encrypt | <<CONFIRM>> | GCP KMS encryption service |
| threeds-notifications | <<CONFIRM>> | 3DS webhook handler |
| transaction-autopsy | <<CONFIRM>> | Transaction diagnostics |
| transaction-helper | <<CONFIRM>> | Transaction utility service |
| tre | <<CONFIRM>> | Transaction routing engine |
| ttp-acquiring | <<CONFIRM>> | Tap-to-Pay acquiring |
| scheduler | <<CONFIRM>> | Job scheduling |

All ports are loaded from `apps/<service>/src/environments/environment.ts`.

## Shared Libraries (import paths)
```typescript
import { SurfboardLogger } from '@terminal/logger';
import { ocean } from '@terminal/ocean';
import { initialize } from '@terminal/app-utils';
// Fiserv/Bambora/Nets acquirer implementations
import { ... } from '@terminal/fiserv-acquiring';
import { ... } from '@terminal/bambora-acquiring';
import { ... } from '@terminal/nets-acquiring';
// HSM integrations
import { ... } from '@terminal/aws-hsm';
import { ... } from '@terminal/futurex-hsm';
import { ... } from '@terminal/google-hsm';
// AGW-scoped libs
import { ... } from '@agw/analytics';
import { ... } from '@agw/fiserv-acquiring';
// pattern: import { X } from '@terminal/<lib-name>'
```

## Shared Infrastructure

### Ocean — Redis Cache & Data Access Layer (`libs/ocean/`)
Ocean is the **primary runtime data store**. It stores all live transaction state,
terminal sessions, and payment data in **Redis** — not in a SQL database.

- Import: `import { ocean } from '@terminal/ocean'`
- The Ocean registry (`libs/db/src/lib/redis.registry.ts`) manages Redis connections.
  It reads these env keys:
  - `REDIS_HOST` (default: `localhost`)
  - `REDIS_PORT` (default: `6379`)
  - `REDIS_USERNAME`
  - `REDIS_PASSWORD`
  - `OCEAN_REDIS_TYPE` — controls cluster vs single-node mode
- Usage: fluent API — `ocean().<method>()` — writes/reads to Redis hashes and streams
- Never use raw Redis commands directly — always go through Ocean

### Publisher — Redis Streams Event System (`libs/` — check if present, or via `@terminal/surf-signal`)
In the terminal repo, inter-service events are communicated via:
- `@terminal/surf-signal` — internal event signalling (in-process or Redis-backed)
- Slipstream (`@terminal/slipstream-client`) — WebSocket-based cross-environment sync
- `<<CONFIRM: check if @terminal repos have a publisher lib matching the services repo pattern>>>`

### Other Infrastructure
- **ORM**: Prisma (`@prisma/client`) — schema in `prisma/` directory at repo root.
  Prisma is used for persistent relational data (audit logs, configuration records).
  Run `npx prisma generate` after schema changes.
- **Web framework**: Fastify v5 (`fastify` + `fastify-plugin`) — not NestJS
- **Server pattern**: Each service exports a Fastify `server` instance from `src/app/app.ts`,
  configured in `src/app/server.config.ts`, started in `src/main.ts`

## Environment Variables (keys — no .env.example found)
Check each service's `apps/<service>/src/environments/environment.ts`:
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`
- `OCEAN_REDIS_TYPE`
- Service-specific port: loaded via `environment.port`
- HSM keys: <<CONFIRM per service — AWS/GCP/Futurex credentials>>
- `<<CONFIRM: DATABASE_URL or equivalent for Prisma>>>`

## Coding Conventions (from code scan)
- **Entry point**: `apps/<service>/src/main.ts` → `bootstrap()` → `server.listen()`
- **Server factory**: `import { server } from './app/app'` (Fastify instance)
- **Init pattern**: `await initialize()` before `server.listen()` in main.ts
- **Config**: `import { configureServer } from './app/server.config'` (some services)
- **Logger**: `new SurfboardLogger('CONTEXT_NAME')` — always use lib logger, not console
- **Environment**: `import { environment } from './environments/environment'`
- **Tests**: Jest, `*.spec.ts` pattern
- **Build**: `nx build <service-name>` or `nx serve <service-name>`

## What Claude Must ALWAYS Do in This Repo
- This is PCI-scoped — never log card numbers, CVVs, or PAN data
- Read `apps/<service>/src/app/app.ts` (Fastify server) before adding routes
- Read `apps/<service>/src/environments/environment.ts` for all service config
- Use `SurfboardLogger` from `@terminal/logger` — never use `console.log` in production code
- Never modify `libs/db/` Redis registry without checking all importing services
- Run `nx build <service-name>` after changes to verify compilation
- Use `@terminal/` or `@agw/` path aliases — never relative cross-lib imports
- Prisma schema changes require `prisma generate` and a migration
```

---

### FOR REPO: swells → save this as /Users/harishanantharaj/Downloads/surfboard/Surfboardproject/swells/AGENT_CONTEXT.md

```markdown
# swells — Claude Agent Context

## Purpose
Bun-runtime monorepo for the next-generation Surfboard payment infrastructure.
Built to migrate services into a new distributed architecture with Redis-first
storage, event-driven communication via Slipstream (WebSocket pub-sub), and a
custom ORM (Ocean) backed by Redis. Uses Elysia.js as the web framework.
All services run on Bun (not Node.js).

## Absolute Path on This Machine
/Users/harishanantharaj/Downloads/surfboard/Surfboardproject/swells

## Project Structure
```
swells/
├── apps/                       # 10 Bun/Elysia services
│   ├── payment-isolate/        # Core payment processing (Redis-only, no DB)
│   ├── ocean-server/           # Data sync server (WebSocket)
│   ├── slipstream/             # WebSocket pub-sub message broker
│   ├── scheduler/              # Job scheduling
│   ├── agenda/                 # Task queue
│   ├── app/                    # <<CONFIRM: purpose>>
│   ├── archiver/               # Data archiving
│   ├── dispatcher/             # Event dispatch
│   ├── ocean-population-service/ # Ocean data population
│   └── ocean-server-e2e/       # E2E test harness for ocean-server
├── libs/                       # ~23 shared libraries (scope: surfboard:*)
│   ├── ocean/                  # Custom Redis ORM — hierarchical data modeling
│   ├── redis-connector/        # ioredis wrapper (env: REDIS_HOST, REDIS_PORT)
│   ├── slipstream-client/      # Slipstream messaging client
│   ├── environment-secrets/    # Multi-cloud KMS (AWS/Azure/GCP) secret management
│   ├── logger/                 # SQLite-based structured logger (buoy)
│   ├── surf-signal/            # Internal event signalling
│   ├── terminal-communicator/  # MQTT-based terminal communication
│   ├── terminal-protocol/      # Payment terminal protocol implementation
│   ├── swells-pa/              # Payment authorization utilities
│   ├── control-unit/           # POS control unit logic
│   ├── coastal-stream/         # Streaming utilities
│   ├── data-model/             # Shared data models
│   ├── model/                  # Additional models
│   ├── interfaces/             # Shared TypeScript interfaces
│   ├── type-utils/             # Type utility functions
│   ├── utils/                  # General utilities
│   ├── validator/              # Validation utilities
│   ├── slack-alerts/           # Slack notifications
│   ├── ocean-server-utils/     # Ocean server utilities
│   ├── ocean-types/            # Ocean ORM type definitions
│   ├── configuration-utils/    # Config management
│   ├── server/                 # Server utilities
│   └── buoy/                   # Logging infrastructure
├── scripts/                    # Bun build scripts
├── CLAUDE.md                   # Agent instructions (authoritative)
├── package.json                # name: "swells", type: "module"
└── tsconfig.base.json          # Path aliases: surfboard:* → libs/*/src/index.ts
```

## Services
| Service Name | Port | Key Responsibility |
|---|---|---|
| payment-isolate | APPLICATION_PORT (<<CONFIRM: from env secrets>>) | Core payment processing — orders, payments, transactions |
| ocean-server | <<CONFIRM>> | WebSocket data sync across environments |
| slipstream | <<CONFIRM>> | WebSocket pub-sub message broker |
| scheduler | <<CONFIRM>> | Cron/job scheduling |
| agenda | <<CONFIRM>> | Task queue management |
| app | <<CONFIRM>> | <<CONFIRM: read apps/app/src/index.ts>> |
| archiver | <<CONFIRM>> | Data archiving |
| dispatcher | <<CONFIRM>> | Event dispatching |
| ocean-population-service | <<CONFIRM>> | Ocean/Redis data population |
| ocean-server-e2e | N/A | E2E tests for ocean-server |

## Shared Libraries (import paths)
Swells uses two styles of path aliases:
```typescript
// surfboard: prefix (defined in tsconfig.base.json)
import { initializeOcean } from 'surfboard:ocean';
import { SwellsServer } from 'surfboard:swells-server';
import { getEnvironmentVariablesFromEncryptedSecrets } from 'surfboard:utils';
import { initializeBuoyLogger } from '@buoy-logger';        // @buoy-logger alias
import { TerminalCommunicator } from '@terminal-communicator'; // @terminal-communicator alias
import { initializeRedis } from 'surfboard:redis-connector';
// Short aliases
import { ... } from '@data-model';
import { ... } from '@type-utils';
import { ... } from '@validator';
import { ... } from '@slipstream-client';
import { ... } from '@slack-alerts';
```

## Shared Infrastructure

### Ocean — Redis Cache & Data Access Layer (`libs/ocean/`)
Ocean is the **sole primary data store** in swells. There is no SQL database for runtime
data — everything lives in Redis via Ocean.

- Import: `import { initializeOcean } from 'surfboard:ocean'`
- Initialise at startup before any service logic: `await initializeOcean()`
- Usage: hierarchical, fluent API — `ocean().<domain>.<method>()` — maps domain entities
  to Redis hashes, sets, and streams
- `libs/ocean-types/` — TypeScript types for all Ocean entities
- `libs/ocean-server-utils/` — utilities shared between ocean-server and other services
- Redis connection is managed by `libs/redis-connector/`:
  - `REDIS_HOST` (default: `localhost`)
  - `REDIS_PORT` (default: `6379`)
- **Never use raw Redis commands** — always use Ocean's fluent API. If Ocean doesn't
  expose the operation you need, add it to the Ocean lib rather than going raw.

### Slipstream — Cross-Environment Pub/Sub (`libs/slipstream-client/`, `apps/slipstream/`)
Slipstream is the **event/message bus** for swells — it replaces a traditional publisher
in this repo. It is WebSocket-based, not Redis Streams.

- Import: `import { ... } from '@slipstream-client'`  (tsconfig alias)
- The `apps/slipstream/` service is the broker — other services connect to it
- Message types:
  - `SK` (Set Key) — sync a key-value across environments
  - `SA` (Set Array) — sync an array across environments
  - `GK` / `GA` / `GW` — get operations
  - `CMD` — command execution (not implemented in payment-isolate)
  - `ACK` — acknowledgement
- Data flow: `payment-isolate` → writes to Redis → publishes SK/SA via Slipstream →
  other `payment-isolate` instances receive and apply the change

### Other Infrastructure
- **Logging**: SQLite-based structured logger via `libs/logger/` (buoy).
  Always initialise with `await initializeBuoyLogger()` before any service logic.
  Import alias: `@buoy-logger`
- **Secrets**: `libs/environment-secrets/` — multi-cloud KMS (AWS/Azure/GCP).
  Always call `getEnvironmentVariablesFromEncryptedSecrets()` at startup — never
  read `process.env` directly for secrets.
- **Web framework**: Elysia.js (`elysia`) — NOT Express/Fastify/NestJS
- **Runtime**: Bun (NOT Node.js) — all commands use `bun`, not `node` or `npm`

## Environment Variables (keys — no .env.example found)
Variables are managed via `libs/environment-secrets/` (encrypted, KMS-backed).
payment-isolate required vars (from `apps/payment-isolate/src/environment.ts`):
- `REDIS_HOST`, `REDIS_PORT`
- `DB_DIRECTORY` (logger SQLite)
- `BDK_FOR_REALM`, `BASE_URL`
- `APPLICATION_NAME`, `APPLICATION_ID`, `APPLICATION_PORT`, `INTERNAL_APPLICATION_PORT`
- `APPLICATION_PACKAGE_NAME`, `APPLICATION_VERSION`, `APPLICATION_BUILD_NUMBER`
- `APPLICATION_PRINT_LOGS`, `PI_URL`
- `IS_TEST_ENVIRONMENT` (optional), `ALERT_URL` (optional), `INTER_APP_JWT_SIGNING_KEY` (optional)

## Coding Conventions (from CLAUDE.md + code scan)
- **Runtime**: Always use `bun` — never `node`, `npm run`, `npx`
- **Entry point**: `apps/<service>/src/index.ts` (not main.ts in swells)
- **Error handling**: Two-track model (Result/Either pattern) — never throw raw errors
- **Graceful shutdown**: All services must implement shutdown handlers
- **Logging**: Use `SurfboardLogger` / buoy — always include request IDs
- **Imports**: Use tsconfig path aliases — never relative imports into libs/
- **Slipstream messages**: SK (set key), SA (set array), GK/GA/GW (get ops)
- **TypeScript**: Strict mode, comprehensive type definitions
- **Build**: `bun ./scripts/build/build.ts`
- **Lint**: `bun ./scripts/check/lint.ts`
- **Type check**: `bun ./scripts/check/typecheck.ts`

## What Claude Must ALWAYS Do in This Repo
- Read CLAUDE.md (exists at repo root) — it is authoritative
- Use Bun, not Node — all scripts run via `bun`
- Read `apps/<service>/src/index.ts` before modifying any service
- Use Ocean ORM for all data operations — never raw Redis commands unless Ocean doesn't support it
- Use `libs/environment-secrets/` for ALL secret access — never hardcode or read env directly
- Implement the two-track error handling model (Result/Either)
- Initialize logger with `initializeBuoyLogger()` before any service logic
- Run `bun ./scripts/check/typecheck.ts` and `bun ./scripts/check/lint.ts` after changes
- Never commit sensitive data — secrets are always KMS-encrypted
```
