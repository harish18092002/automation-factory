import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { SemanticFact } from '../types.js';

const DATA_DIR = path.resolve('data/semantic');
const DECAY_RATE = 0.95;       // Multiply decayScore by this every 30 days
const DECAY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

// Per-repo write mutex — prevents concurrent reads and writes corrupting the JSON file
const writeLocks = new Map<string, Promise<void>>();
function withWriteLock<T>(repoAlias: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(repoAlias) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  writeLocks.set(repoAlias, next);
  return prev.then(fn).finally(resolve) as Promise<T>;
}

function factFile(repoAlias: string): string {
  return path.join(DATA_DIR, `${repoAlias}-facts.json`);
}

async function loadFacts(repoAlias: string): Promise<SemanticFact[]> {
  try {
    const content = await fs.readFile(factFile(repoAlias), 'utf-8');
    return JSON.parse(content) as SemanticFact[];
  } catch {
    return [];
  }
}

async function saveFacts(repoAlias: string, facts: SemanticFact[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(factFile(repoAlias), JSON.stringify(facts, null, 2), 'utf-8');
}

export class SemanticStore {
  /** Get facts for a repo, optionally filtered by category */
  async getFacts(
    repoAlias: string,
    category?: SemanticFact['category']
  ): Promise<SemanticFact[]> {
    const facts = await loadFacts(repoAlias);
    const filtered = category ? facts.filter((f) => f.category === category) : facts;
    // Return sorted by decayScore × confidence (freshest + most confident first)
    return filtered.sort((a, b) => b.decayScore * b.confidence - a.decayScore * a.confidence);
  }

  /** Upsert a fact (update existing by subject + category, or insert new) */
  async upsert(
    fact: Omit<SemanticFact, 'factId' | 'decayScore' | 'observedAt' | 'lastConfirmedAt'>
  ): Promise<SemanticFact> {
    return withWriteLock(fact.repoAlias, async () => {
      const facts = await loadFacts(fact.repoAlias);
      const existing = facts.find(
        (f) => f.subject.toLowerCase() === fact.subject.toLowerCase() && f.category === fact.category
      );

      const now = new Date().toISOString();

      if (existing) {
        existing.content = fact.content;
        existing.confidence = fact.confidence;
        existing.lastConfirmedAt = now;
        existing.decayScore = 1.0;
        if (fact.sourceSessionId) existing.sourceSessionId = fact.sourceSessionId;
        await saveFacts(fact.repoAlias, facts);
        return existing;
      }

      const newFact: SemanticFact = {
        ...fact,
        factId: randomUUID(),
        decayScore: 1.0,
        observedAt: now,
        lastConfirmedAt: now,
      };
      facts.push(newFact);
      await saveFacts(fact.repoAlias, facts);
      return newFact;
    });
  }

  /**
   * Apply time-based decay to all facts in a repo.
   * Should be called periodically (e.g., nightly cron).
   */
  async applyDecay(repoAlias: string): Promise<void> {
    return withWriteLock(repoAlias, async () => {
      const facts = await loadFacts(repoAlias);
      if (facts.length === 0) return;

      const now = Date.now();
      let changed = false;

      for (const fact of facts) {
        const lastConfirmed = new Date(fact.lastConfirmedAt ?? fact.observedAt).getTime();
        const periodsElapsed = (now - lastConfirmed) / DECAY_PERIOD_MS;
        if (periodsElapsed > 0.1) {
          fact.decayScore = Math.max(0.01, fact.decayScore * Math.pow(DECAY_RATE, periodsElapsed));
          changed = true;
        }
      }

      if (changed) await saveFacts(repoAlias, facts);
    });
  }

  /** Remove facts below a minimum decay threshold */
  async prune(repoAlias: string, minDecayScore = 0.05): Promise<number> {
    return withWriteLock(repoAlias, async () => {
      const facts = await loadFacts(repoAlias);
      const pruned = facts.filter((f) => f.decayScore >= minDecayScore);
      if (pruned.length < facts.length) {
        await saveFacts(repoAlias, pruned);
      }
      return facts.length - pruned.length;
    });
  }
}

export const semanticStore = new SemanticStore();
