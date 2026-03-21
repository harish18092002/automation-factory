import fs from 'fs/promises';
import path from 'path';
import type { ProviderMessage } from './providers/types.js';

const CHECKPOINT_DIR = path.resolve('data/checkpoints');

export interface LoopCheckpoint {
  sessionId: string;
  iteration: number;
  savedAt: string;
  messages: ProviderMessage[];
  filesModified: string[];
  webSearchCount: number;
}

/**
 * Append-only JSONL checkpoint store for the agent loop.
 *
 * After each iteration the full message history is flushed to disk so that a
 * crashed or killed process can resume from where it left off rather than
 * restarting from scratch.
 *
 * File layout:  data/checkpoints/{sessionId}.jsonl
 * Each line is a self-contained LoopCheckpoint snapshot.  The latest line is
 * the authoritative resume point.
 *
 * Cleanup: call cleanup() on successful session completion so stale files do
 * not accumulate.  On failure the file is intentionally left for inspection or
 * future resume logic.
 */
export class CheckpointManager {
  private readonly filePath: string;

  constructor(private readonly sessionId: string) {
    this.filePath = path.join(CHECKPOINT_DIR, `${sessionId}.jsonl`);
  }

  /** Persist loop state after each iteration. Non-fatal — caller should .catch(() => {}). */
  async save(data: Omit<LoopCheckpoint, 'sessionId' | 'savedAt'>): Promise<void> {
    await fs.mkdir(CHECKPOINT_DIR, { recursive: true });
    const record: LoopCheckpoint = {
      sessionId: this.sessionId,
      savedAt: new Date().toISOString(),
      ...data,
    };
    await fs.appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
  }

  /**
   * Load the most recent checkpoint for this session.
   * Returns null if no checkpoint file exists (fresh session).
   */
  async loadLatest(): Promise<LoopCheckpoint | null> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      return JSON.parse(lines[lines.length - 1]) as LoopCheckpoint;
    } catch {
      return null; // file not found or corrupt — treat as fresh session
    }
  }

  /** Remove the checkpoint file after a successful session. */
  async cleanup(): Promise<void> {
    await fs.unlink(this.filePath).catch(() => {});
  }
}
