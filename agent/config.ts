import fs from "fs/promises";
import path from "path";

// In NodeNext/CommonJS mode (no "type":"module" in package.json),
// __dirname is available as a native CJS global — no import needed.
export const CONFIG_PATH = path.join(__dirname, "repos.config.json");

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
