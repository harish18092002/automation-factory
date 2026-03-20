import { randomUUID } from 'crypto';
import { episodicStore } from './episodic-store.js';
import { skillRegistry } from './skill-registry.js';
import { semanticStore } from './semantic-store.js';
import type { AgentSession, MemoryBundle, EpisodicEvent } from '../types.js';

export interface MemoryQuery {
  repoAlias: string;
  taskDescription: string;
  maxEpisodic?: number;
  maxSkills?: number;
  maxFacts?: number;
  minSkillSuccessRate?: number;
  minFactConfidence?: number;
}

export class MemoryManager {
  /**
   * Query all memory types and return a MemoryBundle with a pre-formatted
   * prompt fragment ready for injection into the system prompt.
   */
  async query(q: MemoryQuery): Promise<MemoryBundle> {
    const maxEpisodic = q.maxEpisodic ?? 2;
    const maxSkills = q.maxSkills ?? 5;
    const maxFacts = q.maxFacts ?? 8;

    // Extract keywords from task description for skill relevance scoring
    const keywords = q.taskDescription
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3);

    // Query all three memory types in parallel.
    // Each store is individually isolated — a failure in one does not kill the whole query.
    const [recentEvents, skills, facts] = await Promise.all([
      episodicStore.queryRecent(q.repoAlias, { limit: maxEpisodic * 5, eventTypes: ['task_complete'] }).catch((): EpisodicEvent[] => []),
      skillRegistry.getSkills(q.repoAlias, keywords).catch((): Awaited<ReturnType<typeof skillRegistry.getSkills>> => []),
      semanticStore.getFacts(q.repoAlias).catch((): Awaited<ReturnType<typeof semanticStore.getFacts>> => []),
    ]);

    // Filter and trim
    const filteredSkills = skills
      .filter((s) => !q.minSkillSuccessRate || s.successRate >= q.minSkillSuccessRate)
      .slice(0, maxSkills);

    const filteredFacts = facts
      .filter((f) => !q.minFactConfidence || f.confidence >= q.minFactConfidence)
      .slice(0, maxFacts);

    // Get unique session IDs from recent complete events
    const sessionIds = [...new Set(recentEvents.map((e) => e.sessionId))].slice(0, maxEpisodic);
    const sessionSummaries = await Promise.all(
      sessionIds.map((id) => episodicStore.summarizeSession(id, q.repoAlias).catch(() => ''))
    );
    const relevantSessions = recentEvents.filter((e) => sessionIds.includes(e.sessionId));

    // Build the memory prompt fragment
    const memoryPromptFragment = buildMemoryFragment(
      filteredSkills.map((s) => s.prompt),
      filteredFacts.map((f) => `[${f.category}] ${f.subject}: ${f.content}`),
      sessionSummaries.filter(Boolean)
    );

    return {
      recentSessions: relevantSessions,
      relevantSkills: filteredSkills,
      relevantFacts: filteredFacts,
      memoryPromptFragment,
    };
  }

  /** Record the start of a new session */
  async recordSessionStart(session: AgentSession): Promise<void> {
    await episodicStore.log(
      session.sessionId,
      session.repoAlias,
      'task_start',
      {
        taskDescription: session.taskDescription,
        executionMode: session.executionMode,
      }
    );
  }

  /** Record the completion of a session */
  async recordSessionEnd(
    session: AgentSession,
    outcome: AgentSession['outcome']
  ): Promise<void> {
    session.outcome = outcome;
    session.endedAt = new Date().toISOString();
    if (session.startedAt) {
      session.durationMs = Date.now() - new Date(session.startedAt).getTime();
    }

    await episodicStore.log(
      session.sessionId,
      session.repoAlias,
      'task_complete',
      {
        outcome,
        filesModified: session.filesModified,
        buildPassed: session.buildPassed,
        lintPassed: session.lintPassed,
        durationMs: session.durationMs,
        tokensUsed: session.totalTokensUsed,
        providerUsed: session.providerUsed,
      }
    );
  }

  /** Create a new session object */
  createSession(
    repoAlias: string,
    taskDescription: string,
    executionMode: AgentSession['executionMode']
  ): AgentSession {
    return {
      sessionId: randomUUID(),
      repoAlias,
      taskDescription,
      executionMode,
      startedAt: new Date().toISOString(),
      outcome: 'pending',
      filesModified: [],
    };
  }
}

function buildMemoryFragment(
  skillPrompts: string[],
  factLines: string[],
  sessionSummaries: string[]
): string {
  const parts: string[] = [];

  if (skillPrompts.length > 0) {
    parts.push('## Memory: Learned Patterns');
    skillPrompts.forEach((p) => parts.push(`- ${p}`));
  }

  if (factLines.length > 0) {
    parts.push('\n## Memory: Known Facts About This Repo');
    factLines.forEach((f) => parts.push(`- ${f}`));
  }

  if (sessionSummaries.length > 0) {
    parts.push('\n## Memory: Recent Similar Sessions');
    sessionSummaries.forEach((s) => parts.push(`- ${s}`));
  }

  return parts.join('\n');
}

/** Log a tool call event within a session */
export async function logToolCallEvent(
  sessionId: string,
  repoAlias: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<void> {
  await episodicStore.log(sessionId, repoAlias, 'tool_call', { toolName, input });
}

export const memoryManager = new MemoryManager();
