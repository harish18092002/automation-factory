import fs from 'fs/promises';
import { exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { getRepoConfig } from './config.js';
import type { ProviderTool } from './providers/types.js';

const execAsync = promisify(exec);

// Directories excluded from directory listings
const EXCLUDED_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', '.nx', '.turbo', 'coverage',
]);

// Safety check — prevents reads/writes outside registered repos
async function assertPathSafe(targetPath: string): Promise<void> {
  const config = await getRepoConfig();
  const registeredPaths = Object.values(config.repos).map((r) => r.path);
  const resolved = path.resolve(targetPath);
  const isSafe = registeredPaths.some((p) => resolved.startsWith(path.resolve(p)));
  if (!isSafe) {
    throw new Error(
      `SAFETY BLOCK: Path "${resolved}" is outside all registered repos.\n` +
        `Registered repos: ${registeredPaths.join(', ')}`
    );
  }
}

async function getRepo(repoAlias: string) {
  const config = await getRepoConfig();
  const repo = config.repos[repoAlias];
  if (!repo) {
    const available = Object.keys(config.repos).join(', ');
    throw new Error(`Unknown repo alias: "${repoAlias}". Available: ${available}`);
  }
  return repo;
}

// ── Tool definitions (OpenAI function-calling format) ────────────────────────

export const readOnlyToolDefinitions: ProviderTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from a registered repository. Always read a file before writing to it.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias as registered (e.g. my-api, my-frontend, or any alias from repos.config.json)' },
          relative_path: { type: 'string', description: 'File path relative to repo root (e.g. "apps/gateway/src/main.ts")' },
        },
        required: ['repo', 'relative_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file_section',
      description: 'Read a specific line range from a file. More efficient than read_file when you only need part of a large file.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias' },
          relative_path: { type: 'string', description: 'File path relative to repo root' },
          start_line: { type: 'number', description: 'First line to read (1-indexed)' },
          end_line: { type: 'number', description: 'Last line to read (inclusive)' },
        },
        required: ['repo', 'relative_path', 'start_line', 'end_line'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders in a directory (excludes node_modules, dist, .git). Use "." for repo root.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias' },
          relative_path: { type: 'string', description: 'Directory path relative to repo root. Use "." for the repo root.' },
        },
        required: ['repo', 'relative_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a pattern across files in a repo using grep. Returns matching lines with file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias' },
          pattern: { type: 'string', description: 'Search pattern (regex supported)' },
          relative_path: { type: 'string', description: 'Directory or file to search in, relative to repo root. Use "." to search entire repo.' },
          file_glob: { type: 'string', description: 'Optional glob to filter files (e.g. "*.ts"). Defaults to all text files.' },
        },
        required: ['repo', 'pattern', 'relative_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Show git status of a repo (modified, staged, untracked files).',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Show git diff of uncommitted changes. Use staged=true to see staged changes only.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias' },
          staged: { type: 'boolean', description: 'If true, show staged diff only. Defaults to unstaged.' },
          relative_path: { type: 'string', description: 'Optional path to scope the diff.' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for documentation, library APIs, error messages, or technical information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (be specific — include library name, version, error message)' },
          max_results: { type: 'number', description: 'Max results to return (1-5, default 3)' },
        },
        required: ['query'],
      },
    },
  },
];

export const writeToolDefinitions: ProviderTool[] = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or create a file in a registered repository. Always call read_file first if the file may already exist.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias' },
          relative_path: { type: 'string', description: 'File path relative to repo root' },
          content: { type: 'string', description: 'Full file content to write' },
        },
        required: ['repo', 'relative_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in a repo directory. Use for build, lint, test commands. Times out after 120 seconds.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Repo alias' },
          command: { type: 'string', description: 'Shell command (e.g. "nx build gateway", "bun typecheck.ts")' },
          relative_cwd: { type: 'string', description: 'Optional subdirectory to run from. Defaults to repo root.' },
        },
        required: ['repo', 'command'],
      },
    },
  },
];
// git_create_branch and git_commit are intentionally NOT in the agent tool list.
// The system handles ALL git operations (branch, commit, push, PR/MR) automatically
// via gitAutomation.runFlow() after the agent loop completes.
// Giving the LLM these tools causes it to hallucinate remote URLs and bypass runFlow().

/** Question-mode tools — no web_search (repo questions only need file reads) */
export const questionToolDefinitions: ProviderTool[] = readOnlyToolDefinitions.filter(
  (t) => t.function.name !== 'web_search'
);

/** All tools — for implement mode */
export const toolDefinitions: ProviderTool[] = [...readOnlyToolDefinitions, ...writeToolDefinitions];

export interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}

export async function executeToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined
): Promise<ToolResult> {
  // Guard against missing input
  if (!input) {
    return { success: false, error: 'Tool input is undefined' };
  }

  // ── web_search ─────────────────────────────────────────────────────────────
  if (toolName === 'web_search') {
    return executeWebSearch(input.query as string, (input.max_results as number) ?? 3);
  }

  const repo = await getRepo(input.repo as string);

  // ── read_file ─────────────────────────────────────────────────────────────
  if (toolName === 'read_file') {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return { success: true, content, path: fullPath, size: content.length };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: `File not found: ${fullPath}` };
      }
      throw err;
    }
  }

  // ── read_file_section ─────────────────────────────────────────────────────
  if (toolName === 'read_file_section') {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const start = Math.max(1, input.start_line as number) - 1;
      const end = Math.min(lines.length, input.end_line as number);
      const section = lines
        .slice(start, end)
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join('\n');
      return { success: true, content: section, path: fullPath, lines_returned: end - start, total_lines: lines.length };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: `File not found: ${fullPath}` };
      }
      throw err;
    }
  }

  // ── list_directory ────────────────────────────────────────────────────────
  if (toolName === 'list_directory') {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const filtered = entries
        .filter((e) => !EXCLUDED_DIRS.has(e.name))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { success: true, path: fullPath, entries: filtered, count: filtered.length };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: false, error: `Directory not found: ${fullPath}` };
      }
      throw err;
    }
  }

  // ── search_files ──────────────────────────────────────────────────────────
  if (toolName === 'search_files') {
    const searchDir = path.join(repo.path, (input.relative_path as string) || '.');
    await assertPathSafe(searchDir);

    const pattern = (input.pattern as string).replace(/'/g, "'\\''");
    const fileGlob = input.file_glob as string | undefined;
    const includeFlag = fileGlob
      ? `--include='${fileGlob}'`
      : "--include='*.ts' --include='*.js' --include='*.json' --include='*.md'";
    const cmd = `grep -rn -E ${includeFlag} --max-count=3 '${pattern}' '${searchDir}' 2>/dev/null | head -60`;

    try {
      const { stdout } = await execAsync(cmd, { timeout: 15_000 });
      const matches = stdout.trim();
      if (!matches) return { success: true, matches: [], message: 'No matches found' };

      const lines = matches.split('\n').slice(0, 50);
      const results = lines.map((line) => {
        const colonIdx = line.indexOf(':');
        const secondColon = line.indexOf(':', colonIdx + 1);
        if (colonIdx === -1 || secondColon === -1) return { raw: line };
        const file = line.slice(0, colonIdx).replace(repo.path + '/', '');
        const lineNum = line.slice(colonIdx + 1, secondColon);
        const content = line.slice(secondColon + 1).trim();
        return { file, line: parseInt(lineNum, 10), content };
      });
      return { success: true, matches: results, count: results.length };
    } catch {
      return { success: true, matches: [], message: 'Search returned no results' };
    }
  }

  // ── git_status ────────────────────────────────────────────────────────────
  if (toolName === 'git_status') {
    try {
      const { stdout } = await execAsync('git status --short', { cwd: repo.path, timeout: 10_000 });
      return { success: true, status: stdout.trim() || 'Clean working tree', cwd: repo.path };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }

  // ── git_diff ──────────────────────────────────────────────────────────────
  if (toolName === 'git_diff') {
    const staged = (input.staged as boolean) ?? false;
    const scopePath = input.relative_path ? ` -- ${input.relative_path as string}` : '';
    const cmd = `git diff${staged ? ' --staged' : ''}${scopePath}`;
    try {
      const { stdout } = await execAsync(cmd, { cwd: repo.path, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
      return { success: true, diff: stdout.trim() || 'No changes', staged };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }

  // ── write_file ────────────────────────────────────────────────────────────
  if (toolName === 'write_file') {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.content as string, 'utf-8');
    return { success: true, path: fullPath, message: `Written ${(input.content as string).length} bytes to ${input.relative_path}` };
  }

  // ── run_command ───────────────────────────────────────────────────────────
  if (toolName === 'run_command') {
    const rawCwd = input.relative_cwd
      ? path.join(repo.path, input.relative_cwd as string)
      : repo.path;
    // Resolve to an absolute path before execution and safety check
    const cwd = path.resolve(rawCwd);
    await assertPathSafe(cwd);

    const dangerous = ['rm -rf', 'git push --force', 'drop table', 'DROP TABLE', 'format c:'];
    for (const d of dangerous) {
      if ((input.command as string).toLowerCase().includes(d.toLowerCase())) {
        return { success: false, error: `BLOCKED: Command contains dangerous pattern "${d}".` };
      }
    }

    try {
      const { stdout, stderr } = await execAsync(input.command as string, { cwd, timeout: 120_000, maxBuffer: 5 * 1024 * 1024 });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), cwd };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { success: false, error: e.message, stdout: e.stdout?.trim() ?? '', stderr: e.stderr?.trim() ?? '' };
    }
  }

  // ── git_create_branch ─────────────────────────────────────────────────────
  if (toolName === 'git_create_branch') {
    const branch = input.branch_name as string;
    try {
      await execAsync(`git checkout -b "${branch}"`, { cwd: repo.path, timeout: 10_000 });
      return { success: true, branch, message: `Created and switched to branch: ${branch}` };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }

  // ── git_commit ────────────────────────────────────────────────────────────
  if (toolName === 'git_commit') {
    // Split files and quote each path individually to handle spaces in paths
    const fileList = (input.files as string).trim().split(/\s+/).filter(Boolean);
    const quotedFiles = fileList.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    const message = (input.message as string).replace(/'/g, "'\\''");
    try {
      // Stage only specified files (never git add -A)
      await execAsync(`git add -- ${quotedFiles}`, { cwd: repo.path, timeout: 15_000 });
      const { stdout } = await execAsync(`git commit -m '${message}'`, { cwd: repo.path, timeout: 30_000 });
      return { success: true, output: stdout.trim(), files: fileList, message: input.message };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }

  throw new Error(`Unknown tool: "${toolName}"`);
}

// ── Web search implementation ─────────────────────────────────────────────────

async function executeWebSearch(query: string, maxResults: number): Promise<ToolResult> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;

  if (tavilyKey) {
    return tavilySearch(query, Math.min(maxResults, 5), tavilyKey);
  }

  if (braveKey) {
    return braveSearch(query, Math.min(maxResults, 5), braveKey);
  }

  return {
    success: false,
    error: 'Web search not configured. Set TAVILY_API_KEY or BRAVE_API_KEY in .env to enable.',
  };
}

async function tavilySearch(query: string, maxResults: number, apiKey: string): Promise<ToolResult> {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: maxResults }),
    });
    if (!response.ok) return { success: false, error: `Tavily API error: ${response.status}` };
    const data = await response.json() as { results: Array<{ title: string; url: string; content: string }> };
    const results = (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content?.slice(0, 400) }));
    return { success: true, results, query, provider: 'tavily' };
  } catch (err) {
    return { success: false, error: `Tavily search failed: ${String(err)}` };
  }
}

async function braveSearch(query: string, maxResults: number, apiKey: string): Promise<ToolResult> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const response = await fetch(url, { headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' } });
    if (!response.ok) return { success: false, error: `Brave API error: ${response.status}` };
    const data = await response.json() as { web?: { results: Array<{ title: string; url: string; description: string }> } };
    const results = (data.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description?.slice(0, 400) }));
    return { success: true, results, query, provider: 'brave' };
  } catch (err) {
    return { success: false, error: `Brave search failed: ${String(err)}` };
  }
}
