import fs from "fs/promises";
import { exec } from "child_process";
import path from "path";
import { promisify } from "util";
import { getRepoConfig } from "./config.js";

const execAsync = promisify(exec);

// Directories excluded from directory listings
const EXCLUDED_DIRS = new Set([
  "node_modules", "dist", ".git", ".next", ".nx", ".turbo", "coverage",
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
        `Registered repos: ${registeredPaths.join(", ")}`
    );
  }
}

async function getRepo(repoAlias: string) {
  const config = await getRepoConfig();
  const repo = config.repos[repoAlias];
  if (!repo) {
    const available = Object.keys(config.repos).join(", ");
    throw new Error(`Unknown repo alias: "${repoAlias}". Available: ${available}`);
  }
  return repo;
}

// ── Tool definitions ─────────────────────────────────────────────────────────
// NOTE: repo descriptions are intentionally generic here so the tool works
// with dynamically registered repos. The system prompt always lists available
// repos explicitly.

export const readOnlyToolDefinitions = [
  {
    name: "read_file",
    description:
      "Read a file from a registered repository. Always read a file before writing to it.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: {
          type: "string",
          description: "Repo alias (e.g. services, terminal, swells, or any registered alias)",
        },
        relative_path: {
          type: "string",
          description: 'File path relative to repo root (e.g. "apps/gateway/src/main.ts")',
        },
      },
      required: ["repo", "relative_path"],
    },
  },
  {
    name: "read_file_section",
    description:
      "Read a specific line range from a file. More efficient than read_file when you only need part of a large file.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo alias" },
        relative_path: { type: "string", description: "File path relative to repo root" },
        start_line: { type: "number", description: "First line to read (1-indexed)" },
        end_line: { type: "number", description: "Last line to read (inclusive)" },
      },
      required: ["repo", "relative_path", "start_line", "end_line"],
    },
  },
  {
    name: "list_directory",
    description:
      'List files and folders in a directory (excludes node_modules, dist, .git). Use "." for repo root.',
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo alias" },
        relative_path: {
          type: "string",
          description: 'Directory path relative to repo root. Use "." for the repo root.',
        },
      },
      required: ["repo", "relative_path"],
    },
  },
  {
    name: "search_files",
    description:
      "Search for a pattern across files in a repo using grep. Returns matching lines with file paths and line numbers. Much more efficient than reading files one by one.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo alias" },
        pattern: {
          type: "string",
          description: "Search pattern (regex supported, e.g. 'class PaymentService' or 'import.*ocean')",
        },
        relative_path: {
          type: "string",
          description:
            'Directory or file to search in, relative to repo root. Use "." to search entire repo.',
        },
        file_glob: {
          type: "string",
          description:
            'Optional glob to filter files (e.g. "*.ts", "*.json"). Defaults to all files.',
        },
      },
      required: ["repo", "pattern", "relative_path"],
    },
  },
];

export const writeToolDefinitions = [
  {
    name: "write_file",
    description:
      "Write or create a file in a registered repository. Always call read_file first if the file may already exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo alias" },
        relative_path: {
          type: "string",
          description: "File path relative to repo root",
        },
        content: {
          type: "string",
          description: "Full file content to write",
        },
      },
      required: ["repo", "relative_path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in a repo directory. Use for build, lint, test, and git status. Commands time out after 120 seconds.",
    input_schema: {
      type: "object" as const,
      properties: {
        repo: { type: "string", description: "Repo alias" },
        command: {
          type: "string",
          description:
            'Shell command (e.g. "nx build gateway", "bun ./scripts/check/typecheck.ts")',
        },
        relative_cwd: {
          type: "string",
          description:
            'Optional subdirectory to run from (e.g. "apps/gateway"). Defaults to repo root.',
        },
      },
      required: ["repo", "command"],
    },
  },
];

/** All tools — for implement mode */
export const toolDefinitions = [...readOnlyToolDefinitions, ...writeToolDefinitions];

export interface ToolResult {
  success: boolean;
  [key: string]: unknown;
}

export async function executeToolCall(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const repo = await getRepo(input.repo as string);

  // ── read_file ─────────────────────────────────────────────────────────────
  if (toolName === "read_file") {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      return { success: true, content, path: fullPath, size: content.length };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { success: false, error: `File not found: ${fullPath}` };
      }
      throw err;
    }
  }

  // ── read_file_section ─────────────────────────────────────────────────────
  if (toolName === "read_file_section") {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(1, input.start_line as number) - 1;
      const end = Math.min(lines.length, input.end_line as number);
      const section = lines
        .slice(start, end)
        .map((line, i) => `${start + i + 1}: ${line}`)
        .join("\n");
      return {
        success: true,
        content: section,
        path: fullPath,
        lines_returned: end - start,
        total_lines: lines.length,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { success: false, error: `File not found: ${fullPath}` };
      }
      throw err;
    }
  }

  // ── list_directory ────────────────────────────────────────────────────────
  if (toolName === "list_directory") {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const filtered = entries
        .filter((e) => !EXCLUDED_DIRS.has(e.name))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { success: true, path: fullPath, entries: filtered, count: filtered.length };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { success: false, error: `Directory not found: ${fullPath}` };
      }
      throw err;
    }
  }

  // ── search_files ──────────────────────────────────────────────────────────
  if (toolName === "search_files") {
    const searchDir = path.join(repo.path, (input.relative_path as string) || ".");
    await assertPathSafe(searchDir);

    const pattern = (input.pattern as string).replace(/'/g, "'\\''");
    const fileGlob = input.file_glob as string | undefined;

    // Build grep command — use -E for extended regex, -r recursive, -n line numbers
    const includeFlag = fileGlob ? `--include='${fileGlob}'` : "--include='*.ts' --include='*.js' --include='*.json' --include='*.md'";
    const cmd = `grep -rn -E ${includeFlag} --max-count=3 '${pattern}' '${searchDir}' 2>/dev/null | head -60`;

    try {
      const { stdout } = await execAsync(cmd, { timeout: 15_000 });
      const matches = stdout.trim();
      if (!matches) {
        return { success: true, matches: [], message: "No matches found" };
      }

      // Parse grep output: "filepath:linenum:content"
      const lines = matches.split("\n").slice(0, 50);
      const results = lines.map((line) => {
        const colonIdx = line.indexOf(":");
        const secondColon = line.indexOf(":", colonIdx + 1);
        if (colonIdx === -1 || secondColon === -1) return { raw: line };
        const file = line.slice(0, colonIdx).replace(repo.path + "/", "");
        const lineNum = line.slice(colonIdx + 1, secondColon);
        const content = line.slice(secondColon + 1).trim();
        return { file, line: parseInt(lineNum, 10), content };
      });

      return { success: true, matches: results, count: results.length };
    } catch {
      return { success: true, matches: [], message: "Search returned no results" };
    }
  }

  // ── write_file ────────────────────────────────────────────────────────────
  if (toolName === "write_file") {
    const fullPath = path.join(repo.path, input.relative_path as string);
    await assertPathSafe(fullPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, input.content as string, "utf-8");
    return {
      success: true,
      path: fullPath,
      message: `Written ${(input.content as string).length} bytes to ${input.relative_path}`,
    };
  }

  // ── run_command ───────────────────────────────────────────────────────────
  if (toolName === "run_command") {
    const cwd = input.relative_cwd
      ? path.join(repo.path, input.relative_cwd as string)
      : repo.path;
    await assertPathSafe(cwd);

    const dangerous = ["rm -rf", "git push --force", "drop table", "DROP TABLE", "format c:"];
    for (const d of dangerous) {
      if ((input.command as string).toLowerCase().includes(d.toLowerCase())) {
        return {
          success: false,
          error: `BLOCKED: Command contains dangerous pattern "${d}". Confirm with the user before running.`,
        };
      }
    }

    try {
      const { stdout, stderr } = await execAsync(input.command as string, {
        cwd,
        timeout: 120_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return { success: true, stdout: stdout.trim(), stderr: stderr.trim(), cwd };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return {
        success: false,
        error: e.message,
        stdout: e.stdout?.trim() ?? "",
        stderr: e.stderr?.trim() ?? "",
      };
    }
  }

  throw new Error(
    `Unknown tool: "${toolName}". Available: read_file, read_file_section, list_directory, search_files, write_file, run_command`
  );
}
