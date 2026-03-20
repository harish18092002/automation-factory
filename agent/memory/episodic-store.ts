import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { EpisodicEvent } from '../types.js';

const DATA_DIR = path.resolve('data/episodic');

function monthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function logFile(repoAlias: string, mk?: string): string {
  return path.join(DATA_DIR, `${repoAlias}-${mk ?? monthKey()}.jsonl`);
}

/** Return the N most recent month keys (current month first) */
function recentMonthKeys(count = 3): string[] {
  const keys: string[] = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    const shifted = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(monthKey(shifted));
  }
  return keys;
}

export class EpisodicStore {
  /** Append a single event to the JSONL log */
  async append(event: EpisodicEvent): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(logFile(event.repoAlias, monthKey()), line, 'utf-8');
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

  /** Get all events for a specific session, searching across recent months */
  async getSession(sessionId: string, repoAlias: string): Promise<EpisodicEvent[]> {
    for (const mk of recentMonthKeys(3)) {
      const file = logFile(repoAlias, mk);
      try {
        const content = await fs.readFile(file, 'utf-8');
        const events = content
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line) as EpisodicEvent; } catch { return null; }
          })
          .filter((e): e is EpisodicEvent => e !== null && e.sessionId === sessionId);
        if (events.length > 0) return events;
      } catch { /* file may not exist for that month — continue */ }
    }
    return [];
  }

  /** Get the most recent N events for a repo, optionally filtered by type.
   *  Searches the current month first; if fewer than `limit` results are found,
   *  falls back to previous months (up to 3 months total). */
  async queryRecent(
    repoAlias: string,
    options: { limit?: number; eventTypes?: EpisodicEvent['eventType'][] } = {}
  ): Promise<EpisodicEvent[]> {
    const limit = options.limit ?? 20;
    const MAX_READ_BYTES = 10 * 1024;
    const allEvents: EpisodicEvent[] = [];

    for (const mk of recentMonthKeys(3)) {
      if (allEvents.length >= limit) break;
      const file = logFile(repoAlias, mk);

      let content: string;
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_READ_BYTES) {
          const fh = await fs.open(file, 'r');
          try {
            const buf = Buffer.alloc(MAX_READ_BYTES);
            await fh.read(buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
            content = buf.toString('utf-8');
          } finally {
            await fh.close();
          }
        } else {
          content = await fs.readFile(file, 'utf-8');
        }
      } catch {
        continue; // file doesn't exist for this month
      }

      const lines = content.split('\n').filter(Boolean);
      const monthEvents: EpisodicEvent[] = [];
      for (let i = lines.length - 1; i >= 0 && allEvents.length + monthEvents.length < limit; i--) {
        try {
          const e = JSON.parse(lines[i]) as EpisodicEvent;
          if (!options.eventTypes || options.eventTypes.includes(e.eventType)) {
            monthEvents.unshift(e);
          }
        } catch { /* skip malformed lines */ }
      }
      allEvents.unshift(...monthEvents);
    }

    return allEvents;
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
