import { VerificationPipeline } from './verifier.js';
import type { VerificationStatus } from '../types.js';

interface RetryOptions {
  maxAttempts?: number;
  runBuild?: boolean;
  runLint?: boolean;
  runTests?: boolean;
  affectedServices?: string[];
}

interface RepoConfig {
  path: string;
  buildScript: string;
  lintScript: string;
  testScript?: string;
}

type AgentLoopFn = (feedbackFromPreviousAttempt?: string) => Promise<string>;

/**
 * Pass@k retry loop: run the agent, verify the result, retry with feedback on failure.
 *
 * Each failed attempt injects structured verification feedback into the next
 * agent invocation via the feedbackFromPreviousAttempt parameter.
 */
export async function runWithVerification(
  agentLoopFn: AgentLoopFn,
  repo: RepoConfig,
  options: RetryOptions = {}
): Promise<{ result: string; verificationStatus: VerificationStatus; attempts: number }> {
  const { maxAttempts = 3, ...verifierOptions } = options;

  let attempt = 0;
  let lastResult = '';
  let lastStatus: VerificationStatus | null = null;
  let feedback: string | undefined;

  while (attempt < maxAttempts) {
    attempt++;

    // Run the agent (inject failure feedback on retries)
    lastResult = await agentLoopFn(feedback);

    // Verify
    lastStatus = await VerificationPipeline.run(
      repo,
      verifierOptions,
      attempt,
      maxAttempts
    );

    if (lastStatus.overall === 'pass') break;

    // Prepare feedback for next attempt
    feedback = lastStatus.feedbackForRetry;

    if (attempt < maxAttempts) {
      console.log(`[retry-loop] Attempt ${attempt}/${maxAttempts} failed (${lastStatus.overall}). Retrying with feedback...`);
    }
  }

  return {
    result: lastResult,
    verificationStatus: lastStatus ?? {
      overall: 'fail',
      graders: [],
      attemptNumber: attempt,
      maxAttempts,
    },
    attempts: attempt,
  };
}
