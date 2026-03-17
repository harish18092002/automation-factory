import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { EpisodicEvent } from '../types.js';

const DATA_DIR = path.resolve('data/episodic');

function monthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function logFile(repoAlias: string): string {
  return path.join(DATA_DIR, `${repoAlias}-${monthKey()}.jsonl`);
}

export class EpisodicStore {
  /** Append a single event to the JSONL log */
  async append(event: EpisodicEvent): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(logFile(event.repoAlias), line, 'utf-8');
  }

  /** Create and log a new event, returning its ID */
  async log(
    sessionId: string,
    repoAlias: string,
    eventType: EpisodicEvent['eventType'],
    data: Record<string, unknown>,
    tokensAtEvent?: number
  ): Promise<string> {
    const event: EpisodicEvent = {
      eventId: randomUUID(),
      sessionId,
      repoAlias,
      timestamp: new Date().toISOString(),
      eventType,
      data,
      tokensAtEvent,
    };
    await this.append(event);
    return event.eventId;
  }

  /** Get all events for a specific session */
  async getSession(sessionId: string, repoAlias: string): Promise<EpisodicEvent[]> {
    const file = logFile(repoAlias);
    try {
      const content = await fs.readFile(file, 'utf-8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line) as EpisodicEvent; } catch { return null; }
        })
        .filter((e): e is EpisodicEvent => e !== null && e.sessionId === sessionId);
    } catch {
      return [];
    }
  }

  /** Get the most recent N events for a repo, optionally filtered by type */
  async queryRecent(
    repoAlias: string,
    options: { limit?: number; eventTypes?: EpisodicEvent['eventType'][] } = {}
  ): Promise<EpisodicEvent[]> {
    const limit = options.limit ?? 20;
    const file = logFile(repoAlias);

    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      // Read from the end to get most recent
      const events: EpisodicEvent[] = [];
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        try {
          const e = JSON.parse(lines[i]) as EpisodicEvent;
          if (!options.eventTypes || options.eventTypes.includes(e.eventType)) {
            events.unshift(e);
          }
        } catch { /* skip malformed */ }
      }
      return events;
    } catch {
      return [];
    }
  }

  /** Build a compact summary string for a session (for memory injection) */
  async summarizeSession(sessionId: string, repoAlias: string): Promise<string> {
    const events = await this.getSession(sessionId, repoAlias);
    if (events.length === 0) return '';

    const start = events.find((e) => e.eventType === 'task_start');
    const complete = events.find((e) => e.eventType === 'task_complete');
    const toolCalls = events.filter((e) => e.eventType === 'tool_call');
    const errors = events.filter((e) => e.eventType === 'error');

    const task = (start?.data.taskDescription as string) ?? 'unknown task';
    const outcome = (complete?.data.outcome as string) ?? 'unknown';
    const filesModified = (complete?.data.filesModified as string[]) ?? [];
    const toolNames = [...new Set(toolCalls.map((e) => e.data.toolName as string))];

    return [
      `Session: ${sessionId.slice(0, 8)}`,
      `Task: ${task.slice(0, 100)}`,
      `Outcome: ${outcome}`,
      filesModified.length > 0 ? `Files: ${filesModified.join(', ')}` : '',
      toolNames.length > 0 ? `Tools used: ${toolNames.join(', ')}` : '',
      errors.length > 0 ? `Errors: ${errors.length}` : '',
    ].filter(Boolean).join(' | ');
  }
}

export const episodicStore = new EpisodicStore();
