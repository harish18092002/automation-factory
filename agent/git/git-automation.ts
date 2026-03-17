import { exec } from 'child_process';
import { promisify } from 'util';
import type { GitFlowResult, AgentSession } from '../types.js';
import { MRGenerator } from './mr-generator.js';

const execAsync = promisify(exec);

interface RepoLike {
  path: string;
  gitRemote?: string;
  org?: string;
  host?: string;
}

/** Build a safe branch name from a task description */
export function buildBranchName(executionMode: string, taskDescription: string): string {
  const prefix = executionMode === 'implement' ? 'feat' : executionMode;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = taskDescription
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${prefix}/${slug}-${today}`;
}

export class GitAutomation {
  /** Create a new branch in a repo */
  async createBranch(repoPath: string, branchName: string): Promise<void> {
    await execAsync(`git checkout -b "${branchName}"`, { cwd: repoPath, timeout: 10_000 });
  }

  /** Stage specific files and create a commit */
  async commitChanges(
    repoPath: string,
    filesModified: string[],
    message: string
  ): Promise<string> {
    if (filesModified.length === 0) throw new Error('No files to commit');

    // Quote each path individually to handle spaces in file paths
    const quotedPaths = filesModified.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ');
    await execAsync(`git add -- ${quotedPaths}`, { cwd: repoPath, timeout: 15_000 });

    const safeMessage = message.replace(/'/g, "'\\''");
    const { stdout } = await execAsync(
      `git commit -m '${safeMessage}\n\nCo-Authored-By: Agentic Factory <noreply@agent>'`,
      { cwd: repoPath, timeout: 30_000 }
    );

    // Extract commit SHA from output (e.g., "[feat/xxx abc1234] message")
    const shaMatch = stdout.match(/\[.*?\s+([a-f0-9]{7,})\]/);
    return shaMatch?.[1] ?? 'unknown';
  }

  /** Push a branch to origin */
  async push(repoPath: string, branchName: string): Promise<boolean> {
    try {
      await execAsync(`git push origin ${branchName}`, {
        cwd: repoPath,
        timeout: 60_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Full git flow: create branch → commit changes → push → return MR URL.
   * Called after a successful implement session.
   */
  async runFlow(
    repo: RepoLike,
    session: AgentSession,
    filesModified: string[]
  ): Promise<GitFlowResult> {
    if (filesModified.length === 0) {
      return {
        branchName: '',
        commitSha: '',
        pushedToRemote: false,
        error: 'No files were modified — skipping git flow',
      };
    }

    const branchName = buildBranchName(session.executionMode, session.taskDescription);

    try {
      // 1. Create branch
      await this.createBranch(repo.path, branchName);

      // 2. Generate commit message
      const commitMessage = await MRGenerator.buildCommitMessage(
        session.taskDescription,
        filesModified
      );

      // 3. Commit
      const commitSha = await this.commitChanges(repo.path, filesModified, commitMessage);

      // 4. Push
      const pushedToRemote = await this.push(repo.path, branchName);

      // 5. Build MR URL
      const mrUrl = pushedToRemote
        ? buildMRUrl(repo, branchName)
        : undefined;

      return { branchName, commitSha, pushedToRemote, mrUrl };
    } catch (err) {
      return {
        branchName,
        commitSha: '',
        pushedToRemote: false,
        error: String(err),
      };
    }
  }
}

/** Build the MR/PR URL from the remote configuration */
function buildMRUrl(repo: RepoLike, branchName: string): string | undefined {
  if (!repo.gitRemote) return undefined;

  // GitLab pattern: https://gitlab.host/org/repo/-/merge_requests/new?source_branch=...
  if (repo.host?.includes('gitlab') || repo.gitRemote.includes('gitlab') || repo.host?.includes('git.')) {
    const remote = repo.gitRemote.replace(/\.git$/, '');
    return `${remote}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branchName)}`;
  }

  // GitHub pattern: https://github.com/org/repo/compare/branch?expand=1
  if (repo.gitRemote.includes('github.com')) {
    const remote = repo.gitRemote.replace(/\.git$/, '');
    return `${remote}/compare/${encodeURIComponent(branchName)}?expand=1`;
  }

  return undefined;
}

export const gitAutomation = new GitAutomation();
