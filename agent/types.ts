import type { ExecutionMode } from './classifier.js';

// ── Agent Session ─────────────────────────────────────────────────────────────

export interface AgentSession {
  sessionId: string;
  repoAlias: string;
  taskDescription: string;
  executionMode: ExecutionMode;
  startedAt: string;         // ISO timestamp
  endedAt?: string;
  durationMs?: number;
  totalTokensUsed?: number;
  cachedTokensUsed?: number;
  outcome: 'success' | 'partial' | 'failed' | 'pending';
  worktreePath?: string;
  branchName?: string;
  filesModified: string[];
  buildPassed?: boolean;
  lintPassed?: boolean;
  testPassed?: boolean;
  providerUsed?: string;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export interface SubTask {
  id: string;
  parentTaskId: string;
  repoAlias: string;
  serviceHint?: string;
  description: string;
  executionMode: ExecutionMode;
  priority: number;           // 1 = highest
  dependencies: string[];     // SubTask IDs that must complete first
  isolatedWorktree: boolean;
  assignedWorkerId?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: WorkerResult;
}

export interface WorkerResult {
  workerId: string;
  subTaskId: string;
  success: boolean;
  output: string;
  filesModified: string[];
  verificationStatus?: VerificationStatus;
  tokensUsed: number;
  durationMs: number;
  error?: string;
}

export interface OrchestratorPlan {
  taskId: string;
  originalTask: string;
  repoAliases: string[];
  subTasks: SubTask[];
  strategy: 'parallel' | 'sequential' | 'hybrid';
  estimatedComplexity: 'low' | 'medium' | 'high';
}

// ── Memory ────────────────────────────────────────────────────────────────────

export interface EpisodicEvent {
  eventId: string;
  sessionId: string;
  repoAlias: string;
  timestamp: string;
  eventType: 'task_start' | 'tool_call' | 'tool_result' | 'iteration' | 'task_complete' | 'error';
  data: Record<string, unknown>;
  tokensAtEvent?: number;
}

export interface Skill {
  skillId: string;
  name: string;
  description: string;
  repoAlias: string | 'global';
  category: 'pattern' | 'workflow' | 'debug_strategy' | 'api_usage' | 'testing';
  prompt: string;
  triggerKeywords: string[];
  usageCount: number;
  successRate: number;        // 0.0–1.0
  lastUsed: string;
  validatedAt: string;
  validatedBy: 'auto' | 'human';
  sourceSession?: string;
  version: number;
}

export interface SemanticFact {
  factId: string;
  repoAlias: string;
  category: 'architecture' | 'pattern' | 'gotcha' | 'dependency' | 'api_contract';
  subject: string;
  content: string;
  confidence: number;         // 0.0–1.0
  observedAt: string;
  lastConfirmedAt: string;
  decayScore: number;         // 1.0 = fresh, approaches 0 with time
  sourceSessionId?: string;
}

export interface MemoryBundle {
  recentSessions: EpisodicEvent[];
  relevantSkills: Skill[];
  relevantFacts: SemanticFact[];
  memoryPromptFragment: string; // pre-formatted for system prompt injection
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface GraderResult {
  grader: 'schema' | 'build' | 'lint' | 'test' | 'custom';
  passed: boolean;
  score: number;              // 0.0–1.0
  feedback: string;
  details?: Record<string, unknown>;
  durationMs: number;
}

export interface VerificationStatus {
  overall: 'pass' | 'fail' | 'partial';
  graders: GraderResult[];
  attemptNumber: number;
  maxAttempts: number;
  feedbackForRetry?: string;
}

// ── Git Automation ────────────────────────────────────────────────────────────

export interface GitFlowResult {
  branchName: string;
  commitSha: string;
  pushedToRemote: boolean;
  mrUrl?: string;
  mrTitle?: string;
  mrDescription?: string;
  error?: string;
}

// ── Agent Loop Result ─────────────────────────────────────────────────────────

export interface AgentLoopResult {
  text: string;
  filesModified: string[];
  session: AgentSession;
}

// ── Token Optimization ────────────────────────────────────────────────────────

export interface TokenBudget {
  estimatedInputTokens: number;
  recommendedProvider: string;
  shouldUseWorktree: boolean;
  splitIntoSubtasks: boolean;
}
