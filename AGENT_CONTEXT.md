# automation — Claude Agent Context
## Quick Reference
- **Services**: `src/` — 2 services
- **Shared libs**: `libs/` — scope: `@automation`
- **Build**: `npm run build`
- **Lint**: `npm run lint`
- **Runtime**: node (always use `node` commands)
## Purpose
This repository is for automating tasks.
## Absolute Path
/Users/harishanantharaj/Desktop/coding/automation
## Services (2 total)
| Service | Port | Responsibility |
|---|---|---|
| service1 | 3000 | Handles user requests |
| service2 | 3001 | Handles admin requests |
## Shared Libraries
```typescript
import { ... } from '@automation/<lib-name>';
// Available libs: 
```
## Coding Conventions
- **Entry point**: `src/<service>/src/main.ts`
- **Imports**: Always use `@automation` path aliases — never relative cross-lib imports
- **Build**: `npm run build` after changes
- **Lint**: `npm run lint` before finishing
## What Claude Must ALWAYS Do
1. Read the service entry point before modifying any service
2. Use `@automation` path aliases — never relative imports into `libs/`
3. Run build and lint after code changes to verify no TypeScript errors
4. Read files before writing to existing files