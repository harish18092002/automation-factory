import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

// repos.config.json lives in the source agent/ dir and is never emitted to
// dist/, so a plain __dirname join breaks under the compiled build (dist/agent/
// resolves to a file that doesn't exist and the registry reads as empty).
// Anchor to the project root — the nearest package.json above __dirname —
// which is the same directory whether we run from agent/ or dist/agent/.
function projectRoot(): string {
  let dir = __dirname;
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) return __dirname;
    dir = parent;
  }
  return dir;
}

export const CONFIG_PATH = path.join(projectRoot(), "agent", "repos.config.json");

export interface RepoEntry {
  path: string;
  contextMd: string;
  type: string;
  runtime: string;
  buildSystem: string;
  srcDir: string;
  services: string[];
  sharedLibs: string[];
  sharedLibScope?: string;
  sharedLibScopes?: string[];
  envFile: string;
  gitRemote?: string;
  buildScript: string;
  lintScript: string;
  testScript: string;
  description?: string;
  [key: string]: unknown;
}

export interface RepoConfig {
  repos: Record<string, RepoEntry>;
}

export async function getRepoConfig(): Promise<RepoConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as RepoConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { repos: {} };
    }
    throw err;
  }
}

// Simple async mutex: serialise all writes via a promise chain lock to prevent race conditions
let writeLock: Promise<void> = Promise.resolve();

export async function addRepo(alias: string, entry: RepoEntry): Promise<void> {
  writeLock = writeLock.then(async () => {
    const config = await getRepoConfig();
    config.repos[alias] = entry;
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
  });
  return writeLock;
}

export async function getRepoAliases(): Promise<string[]> {
  const config = await getRepoConfig();
  return Object.keys(config.repos);
}
