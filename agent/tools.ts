import fs from 'fs/promises';
import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import repoConfig from './repos.config.json';

const execAsync = promisify(exec);

type RepoKey = keyof typeof repoConfig.repos;

// Safety check — prevents reads/writes outside registered repos
function assertPathSafe(targetPath: string): void {
  const registeredPaths = Object.values(repoConfig.repos).map((r) => r.path);
  const resolved = path.resolve(targetPath);
  const isSafe = registeredPaths.some((p) => resolved.startsWith(path.resolve(p)));
  if (!isSafe) {
    throw new Error(
      `SAFETY BLOCK: Path "${resolved}" is outside all registered repos.\n` +
        `Registered repos: ${registeredPaths.join(', ')}`
    );
  }
}

function getRepo(repoAlias: string) {
  const repo = (repoConfig.repos as Record<string, (typeof repoConfig.repos)[RepoKey]>)[repoAlias];
  if (!repo) {
    throw new Error(
      `Unknown repo alias: "${repoAlias}". Available: ${Object.keys(repoConfig.repos).join(', ')}`
    );
  }
  return repo;
}

// Directories filtered from list_directory results
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', '.next', '.nx', '.turbo', 'coverage']);

export const toolDefinitions = [
  {
    name: 'read_file',
    description:
      'Read a file from a registered repository. Always read a file before writing to it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: {
          type: 'string',
          description: `Repo alias. One of: ${Object.keys(repoConfig.repos).join(', ')}`,
        },
        relative_path: {
          type: 'string',
          description: 'File path relative to the repo root (e.g. "apps/gateway/src/main.ts")',
        },
      },
      required: ['repo', 'relative_path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write or create a file in a registered repository. Always read_file first if the file may already exist.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string' },
        relative_path: {
          type: 'string',
          description: 'File path relative to the repo root',
        },
        content: {
          type: 'string',
          description: 'Full file content to write',
        },
      },
      required: ['repo', 'relative_path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List files and folders in a directory, excluding node_modules, dist, and .git. Use "." for the repo root.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string' },
        relative_path: {
          type: 'string',
          description: 'Directory path relative to repo root. Use "." for the repo root.',
        },
      },
      required: ['repo', 'relative_path'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command within a registered repo directory. Use for build, lint, test, and git commands. Commands time out after 120 seconds.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repo: { type: 'string' },
        command: {
          type: 'string',
          description: 'Shell command to run (e.g. "nx build gateway" or "bun ./scripts/check/typecheck.ts")',
        },
        relative_cwd: {
          type: 'string',
          description:
            'Optional subdirectory within the repo to run the command from (e.g. "apps/gateway"). Defaults to repo root.',
        },
      },
      required: ['repo', 'command'],
    },
  },
];

export interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}

export async function executeToolCall(
  toolName: string,
  input: Record<string, string>
): Promise<ToolResult> {
  const repo = getRepo(input.repo);

  // ── read_file ──────────────────────────────────────────────────────────────
  if (toolName === 'read_file') {
    const fullPath = path.join(repo.path, input.relative_path);
    assertPathSafe(fullPath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return { success: true, content, path: fullPath, size: content.length };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { success: false, error: `File not found: ${fullPath}` };
      }
      throw err;
    }
  }

  // ── write_file ─────────────────────────────────────────────────────────────
  if (toolName === 'write_file') {
    const fullPath = path.join(repo.path, input.relative_path);
    assertPathSafe(fullPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.content, 'utf-8');
    return {
      success: true,
      path: fullPath,
      message: `Written ${input.content.length} bytes to ${input.relative_path}`,
    };
  }

  // ── list_directory ─────────────────────────────────────────────────────────
  if (toolName === 'list_directory') {
    const fullPath = path.join(repo.path, input.relative_path);
    assertPathSafe(fullPath);
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(fullPath, { withFileTypes: true });
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return { success: false, error: `Directory not found: ${fullPath}` };
      }
      throw err;
    }
    const filtered = entries
      .filter((e) => !EXCLUDED_DIRS.has(e.name))
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
      }))
      .sort((a, b) => {
        // dirs first, then files
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { success: true, path: fullPath, entries: filtered, count: filtered.length };
  }

  // ── run_command ────────────────────────────────────────────────────────────
  if (toolName === 'run_command') {
    const cwd = input.relative_cwd
      ? path.join(repo.path, input.relative_cwd)
      : repo.path;
    assertPathSafe(cwd);

    // Block dangerous commands
    const dangerous = ['rm -rf', 'git push --force', 'drop table', 'DROP TABLE', 'format c:'];
    for (const d of dangerous) {
      if (input.command.toLowerCase().includes(d.toLowerCase())) {
        return {
          success: false,
          error: `BLOCKED: Command contains dangerous pattern "${d}". Confirm with the user before running.`,
        };
      }
    }

    try {
      const { stdout, stderr } = await execAsync(input.command, {
        cwd,
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024, // 5 MB
      });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), cwd };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message: string };
      return {
        success: false,
        error: error.message,
        stdout: error.stdout?.trim() ?? '',
        stderr: error.stderr?.trim() ?? '',
      };
    }
  }

  throw new Error(`Unknown tool: "${toolName}". Available tools: read_file, write_file, list_directory, run_command`);
}
