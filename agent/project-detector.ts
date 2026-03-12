import fs from "fs/promises";
import path from "path";
import type { RepoEntry } from "./config.js";

async function safeRead(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !["node_modules", "dist", ".git", ".nx", ".turbo", "coverage"].includes(e.name)
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface DetectionResult {
  configEntry: RepoEntry;
  agentContextMd: string;
  /** Human-readable summary of what was detected */
  summary: string;
}

export async function detectProject(
  alias: string,
  repoPath: string
): Promise<DetectionResult> {
  const absPath = path.resolve(repoPath);

  try {
    await fs.access(absPath);
  } catch {
    throw new Error(`Path does not exist or is not accessible: ${absPath}`);
  }

  // Detect runtime
  const hasBunLockb = !!(await safeRead(path.join(absPath, "bun.lockb")));
  const hasBunLock = !!(await safeRead(path.join(absPath, "bun.lock")));
  const runtime = hasBunLockb || hasBunLock ? "bun" : "node";

  // Parse package.json
  let pkgName = alias;
  let buildSystem = "npm";
  let buildScript = "npm run build";
  let lintScript = "npm run lint";
  let testScript = "npm test";

  const pkgRaw = await safeRead(path.join(absPath, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      if (typeof pkg.name === "string") pkgName = pkg.name;

      const allDeps = {
        ...(pkg.dependencies as Record<string, string> ?? {}),
        ...(pkg.devDependencies as Record<string, string> ?? {}),
      };

      if (allDeps.nx || allDeps["@nx/workspace"] || allDeps["@nx/core"]) {
        buildSystem = "nx";
        buildScript = "nx build";
        lintScript = "nx lint";
        testScript = "nx test";
      }

      if (runtime === "bun") {
        buildSystem = "bun";
        const scripts = pkg.scripts as Record<string, string> ?? {};
        buildScript = scripts.build
          ? "bun run build"
          : "bun ./scripts/build/build.ts";
        lintScript = scripts.lint
          ? "bun run lint"
          : "bun ./scripts/check/lint.ts";
        testScript = "bun test";
      }
    } catch {
      // ignore parse errors
    }
  }

  // Detect framework from nest-cli.json
  const hasNestCli = !!(await safeRead(path.join(absPath, "nest-cli.json")));
  const framework = hasNestCli ? "nestjs" : "unknown";

  // Detect lib scope from tsconfig.base.json
  let sharedLibScope: string = `@${alias}`;
  const tsconfigRaw = await safeRead(path.join(absPath, "tsconfig.base.json"));
  if (tsconfigRaw) {
    if (tsconfigRaw.includes("surfboard:")) {
      sharedLibScope = "surfboard";
    } else {
      const scopeMatch = tsconfigRaw.match(/"(@[^/"]+)\//);
      if (scopeMatch) sharedLibScope = scopeMatch[1];
    }
  }

  // Enumerate services and shared libs
  const topLevel = await listDirs(absPath);
  const srcDir = topLevel.includes("apps") ? "apps" : "src";
  const services = await listDirs(path.join(absPath, srcDir));
  const sharedLibs = await listDirs(path.join(absPath, "libs"));

  const configEntry: RepoEntry = {
    path: absPath,
    contextMd: "./AGENT_CONTEXT.md",
    type: `${runtime}-${framework}-monorepo`,
    runtime,
    buildSystem,
    srcDir,
    services,
    sharedLibs,
    sharedLibScope,
    envFile: ".env",
    gitRemote: `<<CONFIRM: git remote for ${alias}>>`,
    buildScript,
    lintScript,
    testScript,
    description: `${alias} (${pkgName}) — ${runtime} ${framework} monorepo with ${services.length} services`,
  };

  // Reuse existing AGENT_CONTEXT.md if present, otherwise scaffold
  const existingContext = await safeRead(path.join(absPath, "AGENT_CONTEXT.md"));
  const agentContextMd = existingContext ?? generateAgentContext(alias, configEntry);

  const summary = [
    `runtime=${runtime}`,
    `framework=${framework}`,
    `buildSystem=${buildSystem}`,
    `services=${services.length} (${services.slice(0, 3).join(", ")}${services.length > 3 ? "…" : ""})`,
    `sharedLibs=${sharedLibs.length}`,
    `libScope=${sharedLibScope}`,
    existingContext ? "AGENT_CONTEXT=reused" : "AGENT_CONTEXT=generated",
  ].join(", ");

  return { configEntry, agentContextMd, summary };
}

function generateAgentContext(alias: string, config: RepoEntry): string {
  const serviceRows = config.services
    .slice(0, 20)
    .map((s) => `| ${s} | <<CONFIRM>> | <<CONFIRM purpose>> |`)
    .join("\n");
  const moreNote =
    config.services.length > 20
      ? `\n| ... and ${config.services.length - 20} more | - | - |`
      : "";

  const importStyle =
    config.sharedLibScope === "surfboard"
      ? `import { ... } from 'surfboard:<lib-name>';`
      : `import { ... } from '${config.sharedLibScope}/<lib-name>';`;

  const entryFile = config.runtime === "bun" ? "index.ts" : "main.ts";

  return `# ${alias} — Claude Agent Context

## Quick Reference
- **Services**: \`${config.srcDir}/\` — ${config.services.length} services
- **Shared libs**: \`libs/\` — scope: \`${config.sharedLibScope}\`
- **Build**: \`${config.buildScript}\`
- **Lint**: \`${config.lintScript}\`
- **Runtime**: ${config.runtime} (always use \`${config.runtime}\` commands)

## Purpose
<<CONFIRM: describe the purpose of this repo>>

## Absolute Path
${config.path}

## Services (${config.services.length} total)
| Service | Port | Responsibility |
|---|---|---|
${serviceRows}${moreNote}

## Shared Libraries
\`\`\`typescript
${importStyle}
// Available libs: ${config.sharedLibs.join(", ")}
\`\`\`

## Coding Conventions
- **Entry point**: \`${config.srcDir}/<service>/src/${entryFile}\`
- **Imports**: Always use \`${config.sharedLibScope}\` path aliases — never relative cross-lib imports
- **Build**: \`${config.buildScript}\` after changes
- **Lint**: \`${config.lintScript}\` before finishing

## What Claude Must ALWAYS Do
1. Read the service entry point before modifying any service
2. Use \`${config.sharedLibScope}\` path aliases — never relative imports into \`libs/\`
3. Run build and lint after code changes to verify no TypeScript errors
4. Read files before writing to existing files
`;
}
