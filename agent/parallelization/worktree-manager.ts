import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { getRepoConfig } from '../config.js';

const execAsync = promisify(exec);

// Worktrees are placed in a sibling directory next to the repo
const WORKTREE_SUFFIX = '-worktrees';

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  repoAlias: string;
  createdAt: string;
}

export class WorktreeManager {
  /**
   * Create a new git worktree with an isolated branch.
   * Returns the absolute path to the worktree directory.
   */
  async create(repoAlias: string, branchName: string): Promise<WorktreeInfo> {
    const config = await getRepoConfig();
    const repo = config.repos[repoAlias];
    if (!repo) throw new Error(`Unknown repo alias: ${repoAlias}`);

    // Place worktrees in a sibling directory: /path/to/repo-worktrees/branch-name
    const worktreeBase = `${repo.path}${WORKTREE_SUFFIX}`;
    await fs.mkdir(worktreeBase, { recursive: true });

    const safeBranch = branchName.replace(/\//g, '-');
    const worktreePath = path.join(worktreeBase, safeBranch);

    // Remove any leftover worktree directory at this path
    await this.forceRemovePath(worktreePath);

    // If the branch already exists (leftover from a previous crash), delete it first.
    // Without this, `git worktree add -b` always fails with "branch already exists".
    await execAsync(`git branch -D "${branchName}"`, { cwd: repo.path, timeout: 10_000 }).catch(() => undefined);

    // Also prune stale worktree references before adding
    await execAsync('git worktree prune', { cwd: repo.path, timeout: 10_000 }).catch(() => undefined);

    // Create new worktree with a new branch
    await execAsync(
      `git worktree add "${worktreePath}" -b "${branchName}"`,
      { cwd: repo.path, timeout: 30_000 }
    );

    return {
      worktreePath,
      branchName,
      repoAlias,
      createdAt: new Date().toISOString(),
    };
  }

  /** Remove a worktree (force — cleans up even with uncommitted changes) */
  async cleanup(worktreeInfo: WorktreeInfo): Promise<void> {
    const config = await getRepoConfig();
    const repo = config.repos[worktreeInfo.repoAlias];
    if (!repo) return;

    try {
      await execAsync(
        `git worktree remove ${worktreeInfo.worktreePath} --force`,
        { cwd: repo.path, timeout: 15_000 }
      );
    } catch {
      // If worktree remove fails, try direct directory removal
      await this.forceRemovePath(worktreeInfo.worktreePath);
    }

    // Also prune stale worktree references
    await execAsync('git worktree prune', { cwd: repo.path, timeout: 10_000 }).catch(() => undefined);
  }

  /** List all worktrees for a repo */
  async list(repoAlias: string): Promise<string[]> {
    const config = await getRepoConfig();
    const repo = config.repos[repoAlias];
    if (!repo) return [];

    try {
      const { stdout } = await execAsync('git worktree list --porcelain', { cwd: repo.path, timeout: 10_000 });
      return stdout
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const match = block.match(/^worktree (.+)/m);
          return match?.[1] ?? '';
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async forceRemovePath(dirPath: string): Promise<void> {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

export const worktreeManager = new WorktreeManager();
