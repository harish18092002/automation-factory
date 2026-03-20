import { exec } from "child_process";
import { promisify } from "util";
import type { GitFlowResult, AgentSession } from "../types.js";
import { MRGenerator } from "./mr-generator.js";

const execAsync = promisify(exec);

// ── Remote URL parsing ─────────────────────────────────────────────────────

export interface ParsedRemote {
  /** 'github' | 'gitlab' | 'unknown' */
  host: "github" | "gitlab" | "unknown";
  /** e.g. https://github.com or https://git.surfboard.se */
  baseUrl: string;
  /** Owner/org path — may include subgroups for GitLab (e.g. surfboard/modules) */
  owner: string;
  /** Repo name without .git */
  repoName: string;
  /** Full HTTPS URL without .git suffix */
  fullHttpsUrl: string;
}

/**
 * Convert any git remote URL (SSH or HTTPS) to a ParsedRemote.
 *
 * Handles:
 *   git@github.com:org/repo.git
 *   git@git.surfboard.se:surfboard/modules/swells.git
 *   https://github.com/org/repo.git
 *   https://git.surfboard.se/org/sub/repo
 */
export function parseRemote(gitRemote: string): ParsedRemote | null {
  if (!gitRemote) return null;
  let url = gitRemote.trim();

  // Convert SSH → HTTPS: git@host:path → https://host/path
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    url = `https://${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    url = url.replace(/\.git$/, "");
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    const pathParts = parsed.pathname
      .replace(/^\//, "")
      .split("/")
      .filter(Boolean);
    if (pathParts.length < 2) return null;

    const repoName = pathParts[pathParts.length - 1];
    // For GitLab sub-groups: surfboard/modules/swells → owner = surfboard/modules
    const owner = pathParts.slice(0, -1).join("/");

    const host: ParsedRemote["host"] =
      hostname === "github.com"
        ? "github"
        : hostname.includes("gitlab") || hostname.startsWith("git.")
          ? "gitlab"
          : "unknown";

    return {
      host,
      baseUrl: `${parsed.protocol}//${hostname}`,
      owner,
      repoName,
      fullHttpsUrl: url,
    };
  } catch {
    return null;
  }
}

interface RepoLike {
  path: string;
  gitRemote?: string;
  org?: string;
  host?: string;
}

// ── Branch helpers ─────────────────────────────────────────────────────────

/** Build a safe branch name from a task description */
export function buildBranchName(
  executionMode: string,
  taskDescription: string,
): string {
  const prefix = executionMode === "implement" ? "feat" : executionMode;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${prefix}/${slug}-${today}`;
}

/** Get the default branch of the origin remote (main, master, develop, etc.) */
async function getDefaultBranch(repoPath: string): Promise<string> {
  // Try fast path: symbolic ref set by 'git remote set-head origin -a'
  try {
    const { stdout } = await execAsync(
      "git rev-parse --abbrev-ref origin/HEAD",
      { cwd: repoPath, timeout: 10_000 },
    );
    const branch = stdout.trim().replace(/^origin\//, "");
    if (branch && branch !== "HEAD") return branch;
  } catch {
    /* fall through */
  }

  // Slower path: parse 'git remote show origin'
  try {
    const { stdout } = await execAsync("git remote show origin", {
      cwd: repoPath,
      timeout: 15_000,
    });
    const match = stdout.match(/HEAD branch:\s+(\S+)/);
    if (match?.[1]) return match[1];
  } catch {
    /* fall through */
  }

  return "main";
}

// ── Push result ────────────────────────────────────────────────────────────

interface PushResult {
  success: boolean;
  reason?: "auth" | "network" | "conflict" | "unknown";
  stderr?: string;
}

// ── GitHub PR via API ──────────────────────────────────────────────────────

interface PRResult {
  url: string;
  number?: number;
  /** true = newly created, false = already existed */
  created: boolean;
}

/**
 * Create a GitHub Pull Request via the REST API.
 * Requires GITHUB_TOKEN env var.
 * Falls back gracefully to null (caller will use URL instead).
 */
async function createGitHubPR(
  parsed: ParsedRemote,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<PRResult | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;

  // GitHub API: owner must be a single segment (not nested), repo is last segment
  const apiOwner = parsed.owner.split("/").pop() ?? parsed.owner;
  const apiUrl = `https://api.github.com/repos/${apiOwner}/${parsed.repoName}/pulls`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: baseBranch,
        draft: false,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { html_url: string; number: number };
      return { url: data.html_url, number: data.number, created: true };
    }

    // 422 = validation error — likely the PR already exists
    if (res.status === 422) {
      const listUrl = `https://api.github.com/repos/${apiOwner}/${parsed.repoName}/pulls?head=${encodeURIComponent(`${apiOwner}:${branchName}`)}&state=open`;
      const listRes = await fetch(listUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (listRes.ok) {
        const prs = (await listRes.json()) as Array<{
          html_url: string;
          number: number;
        }>;
        if (prs.length > 0)
          return {
            url: prs[0].html_url,
            number: prs[0].number,
            created: false,
          };
      }
    }

    const errText = await res.text().catch(() => "");
    console.error(
      `[GitAutomation] GitHub PR creation failed: ${res.status} ${errText}`,
    );
    return null;
  } catch (err) {
    console.error("[GitAutomation] GitHub PR creation error:", err);
    return null;
  }
}

// ── GitLab MR via API ──────────────────────────────────────────────────────

/**
 * Create a GitLab Merge Request via the REST API.
 * Requires GITLAB_TOKEN_AUTOMATION env var.
 * Works with self-hosted instances (e.g. git.surfboard.se).
 * Falls back gracefully to null.
 */
async function createGitLabMR(
  parsed: ParsedRemote,
  branchName: string,
  baseBranch: string,
  title: string,
  description: string,
): Promise<PRResult | null> {
  const token = process.env.GITLAB_TOKEN_AUTOMATION;
  if (!token) return null;

  // GitLab project path = owner/repo — may include sub-groups
  const projectPath = `${parsed.owner}/${parsed.repoName}`;
  const encodedPath = encodeURIComponent(projectPath);
  const apiUrl = `${parsed.baseUrl}/api/v4/projects/${encodedPath}/merge_requests`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_branch: branchName,
        target_branch: baseBranch,
        title,
        description,
        remove_source_branch: true,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { web_url: string; iid: number };
      return { url: data.web_url, number: data.iid, created: true };
    }

    // 409 = MR already exists for this branch
    if (res.status === 409) {
      const listUrl = `${parsed.baseUrl}/api/v4/projects/${encodedPath}/merge_requests?source_branch=${encodeURIComponent(branchName)}&state=opened`;
      const listRes = await fetch(listUrl, {
        headers: { "PRIVATE-TOKEN": token },
      });
      if (listRes.ok) {
        const mrs = (await listRes.json()) as Array<{
          web_url: string;
          iid: number;
        }>;
        if (mrs.length > 0)
          return { url: mrs[0].web_url, number: mrs[0].iid, created: false };
      }
    }

    const errText = await res.text().catch(() => "");
    console.error(
      `[GitAutomation] GitLab MR creation failed: ${res.status} ${errText}`,
    );
    return null;
  } catch (err) {
    console.error("[GitAutomation] GitLab MR creation error:", err);
    return null;
  }
}

// ── URL builder (no API key — opens web UI) ────────────────────────────────

function buildPRUrl(
  parsed: ParsedRemote,
  branchName: string,
  baseBranch: string,
): string {
  const encoded = encodeURIComponent(branchName);
  if (parsed.host === "github") {
    return `${parsed.fullHttpsUrl}/compare/${encodeURIComponent(baseBranch)}...${encoded}?expand=1`;
  }
  if (parsed.host === "gitlab") {
    return `${parsed.fullHttpsUrl}/-/merge_requests/new?merge_request[source_branch]=${encoded}&merge_request[target_branch]=${encodeURIComponent(baseBranch)}`;
  }
  return parsed.fullHttpsUrl;
}

// ── Human-readable push error ──────────────────────────────────────────────

function buildPushErrorMessage(
  result: PushResult,
  parsed: ParsedRemote,
): string {
  const repoDisplay = `${parsed.owner}/${parsed.repoName}`;
  if (result.reason === "auth") {
    if (parsed.host === "github") {
      return [
        `Push failed — authentication error.`,
        `Options:`,
        `  1. Set GITHUB_TOKEN env var (needs repo write scope)`,
        `  2. Fork ${parsed.fullHttpsUrl}, push to your fork, then open a PR`,
        `  3. Ask a maintainer for write access to \`${repoDisplay}\``,
      ].join("\n");
    }
    if (parsed.host === "gitlab") {
      return [
        `Push failed — authentication error.`,
        `Options:`,
        `  1. Set GITLAB_TOKEN_AUTOMATION env var (needs api/write_repository scope)`,
        `  2. Fork ${parsed.fullHttpsUrl}, push to your fork, then open an MR`,
        `  3. Ask a maintainer for Developer+ access to \`${repoDisplay}\``,
      ].join("\n");
    }
    return `Push failed — authentication error. Ensure you have write access to the remote.`;
  }
  if (result.reason === "conflict") {
    return `Push failed — remote has diverged. Run \`git pull --rebase origin main\` locally, then push again.`;
  }
  if (result.reason === "network") {
    return `Push failed — network error. Check your connection and VPN.`;
  }
  return `Push failed: ${result.stderr ?? "unknown error"}`;
}

// ── GitAutomation class ────────────────────────────────────────────────────

export class GitAutomation {
  /**
   * Get staged files (git diff --cached --name-only).
   * Used when the user has pre-staged changes and wants them committed + pushed.
   */
  async getStagedFiles(repoPath: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync('git diff --cached --name-only', {
        cwd: repoPath,
        timeout: 10_000,
      });
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Create a new branch.
   * If the branch already exists locally, append a short timestamp suffix
   * to make it unique instead of failing.
   */
  async createBranch(repoPath: string, branchName: string): Promise<string> {
    try {
      await execAsync(`git checkout -b "${branchName}"`, {
        cwd: repoPath,
        timeout: 10_000,
      });
      return branchName;
    } catch (err) {
      if (String(err).includes("already exists")) {
        const uniqueName = `${branchName}-${Date.now().toString(36)}`;
        await execAsync(`git checkout -b "${uniqueName}"`, {
          cwd: repoPath,
          timeout: 10_000,
        });
        return uniqueName;
      }
      throw err;
    }
  }

  /** Stage specific files and create a commit. Returns the short commit SHA. */
  async commitChanges(
    repoPath: string,
    filesModified: string[],
    message: string,
  ): Promise<string> {
    if (filesModified.length === 0) throw new Error("No files to commit");

    // Quote paths to handle spaces; escape embedded double-quotes
    const quotedPaths = filesModified
      .map((f) => `"${f.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
      .join(" ");
    await execAsync(`git add -- ${quotedPaths}`, {
      cwd: repoPath,
      timeout: 15_000,
    });

    // Escape message for use inside double-quotes (escape \, $, `, ")
    const safeMsg = message
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    const { stdout } = await execAsync(
      `git commit -m "${safeMsg}\n\nCo-Authored-By: Agentic Factory <noreply@agent>"`,
      { cwd: repoPath, timeout: 30_000 },
    );

    const shaMatch = stdout.match(/\[.*?\s+([a-f0-9]{7,})\]/);
    return shaMatch?.[1] ?? "unknown";
  }

  /** Push a branch to origin. Returns a typed result with failure reason. */
  async push(repoPath: string, branchName: string): Promise<PushResult> {
    try {
      await execAsync(`git push -u origin "${branchName}"`, {
        cwd: repoPath,
        timeout: 60_000,
      });
      return { success: true };
    } catch (err) {
      const msg = String(err).toLowerCase();
      if (
        msg.includes("permission denied") ||
        msg.includes("authentication failed") ||
        msg.includes("403") ||
        msg.includes("401") ||
        msg.includes("access denied") ||
        msg.includes("not authorized")
      ) {
        return { success: false, reason: "auth", stderr: String(err) };
      }
      if (
        msg.includes("rejected") ||
        msg.includes("non-fast-forward") ||
        msg.includes("conflict")
      ) {
        return { success: false, reason: "conflict", stderr: String(err) };
      }
      if (
        msg.includes("timeout") ||
        msg.includes("could not resolve") ||
        msg.includes("network") ||
        msg.includes("connection refused")
      ) {
        return { success: false, reason: "network", stderr: String(err) };
      }
      return { success: false, reason: "unknown", stderr: String(err) };
    }
  }

  /**
   * Full git flow after an implement session:
   *
   *   1. Create feature branch (unique name if already exists)
   *   2. Commit all modified files
   *   3. Push to origin
   *   4. Create PR/MR via API (if token set) — or fall back to a click-to-open URL
   *
   * Cases handled:
   *   - Own GitHub repo       → push + GitHub PR via API or URL
   *   - GitHub org repo       → push + GitHub PR via API or URL (needs write access)
   *   - GitLab (self-hosted)  → push + GitLab MR via API or URL
   *   - No remote configured  → local commit only
   *   - SSH remote            → converted to HTTPS for URLs
   *   - Branch already exists → unique suffix added automatically
   *   - Push auth failure     → actionable error with fork/token guidance
   *   - Push conflict         → actionable error with rebase guidance
   *   - No API token          → falls back to web-UI URL
   */
  async runFlow(
    repo: RepoLike,
    session: AgentSession,
    filesModified: string[],
  ): Promise<GitFlowResult> {
    if (filesModified.length === 0) {
      return {
        branchName: "",
        commitSha: "",
        pushedToRemote: false,
        error: "No files were modified — skipping git flow",
      };
    }

    const parsed = repo.gitRemote ? parseRemote(repo.gitRemote) : null;
    const rawBranchName = buildBranchName(
      session.executionMode,
      session.taskDescription,
    );

    try {
      // 1. Create branch (auto-resolves name collision)
      const branchName = await this.createBranch(repo.path, rawBranchName);

      // 2. Commit message
      const commitMessage = await MRGenerator.buildCommitMessage(
        session.taskDescription,
        filesModified,
      );

      // 3. Commit
      const commitSha = await this.commitChanges(
        repo.path,
        filesModified,
        commitMessage,
      );

      // No remote → local-only result
      if (!repo.gitRemote || !parsed) {
        return {
          branchName,
          commitSha,
          pushedToRemote: false,
          error: "No git remote configured — changes committed locally only",
        };
      }

      // 4. Push
      const pushResult = await this.push(repo.path, branchName);
      if (!pushResult.success) {
        return {
          branchName,
          commitSha,
          pushedToRemote: false,
          error: buildPushErrorMessage(pushResult, parsed),
        };
      }

      // 5. Default branch (for PR base)
      const baseBranch = await getDefaultBranch(repo.path);

      // 6. PR/MR content
      const mrContent = await MRGenerator.generate(
        session.taskDescription,
        filesModified,
      );
      const mrTitle = mrContent.title;
      const mrDescription = mrContent.description;

      // 7. Try API creation; fall back to URL
      let mrUrl: string | undefined;

      if (parsed.host === "github") {
        const prResult = await createGitHubPR(
          parsed,
          branchName,
          baseBranch,
          mrTitle,
          mrDescription,
        );
        mrUrl = prResult?.url ?? buildPRUrl(parsed, branchName, baseBranch);
      } else if (parsed.host === "gitlab") {
        const mrResult = await createGitLabMR(
          parsed,
          branchName,
          baseBranch,
          mrTitle,
          mrDescription,
        );
        mrUrl = mrResult?.url ?? buildPRUrl(parsed, branchName, baseBranch);
      } else {
        mrUrl = buildPRUrl(parsed, branchName, baseBranch);
      }

      return {
        branchName,
        commitSha,
        pushedToRemote: true,
        mrUrl,
        mrTitle,
        mrDescription,
      };
    } catch (err) {
      return {
        branchName: rawBranchName,
        commitSha: "",
        pushedToRemote: false,
        error: String(err),
      };
    }
  }
}

export const gitAutomation = new GitAutomation();
