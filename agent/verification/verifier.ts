import { BuildGrader, LintGrader, TestGrader } from './graders.js';
import type { GraderResult, VerificationStatus } from '../types.js';

interface VerifierOptions {
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

export class VerificationPipeline {
  /**
   * Run the verification pipeline for a repo after an agent session.
   * Graders run sequentially (lint → build → test) to fail fast.
   */
  static async run(
    repo: RepoConfig,
    options: VerifierOptions = {},
    attemptNumber = 1,
    maxAttempts = 3
  ): Promise<VerificationStatus> {
    const { runBuild = true, runLint = true, runTests = false, affectedServices = [] } = options;

    const graders: GraderResult[] = [];

    // Lint (fast ~5s — run first)
    if (runLint) {
      const result = await LintGrader.grade(repo);
      graders.push(result);
      // Don't proceed to build if lint fails (saves time)
      if (!result.passed) {
        return buildStatus(graders, attemptNumber, maxAttempts, 'lint');
      }
    }

    // Build (~30-120s)
    if (runBuild) {
      const result = await BuildGrader.grade(repo);
      graders.push(result);
      if (!result.passed) {
        return buildStatus(graders, attemptNumber, maxAttempts, 'build');
      }
    }

    // Tests (only if explicitly requested — can be slow)
    if (runTests) {
      const result = await TestGrader.grade(repo, affectedServices);
      graders.push(result);
    }

    return buildStatus(graders, attemptNumber, maxAttempts);
  }
}

function buildStatus(
  graders: GraderResult[],
  attemptNumber: number,
  maxAttempts: number,
  failedAt?: string
): VerificationStatus {
  const failedGraders = graders.filter((g) => !g.passed);
  const overall = failedGraders.length === 0
    ? 'pass'
    : failedGraders.length === graders.length
    ? 'fail'
    : 'partial';

  let feedbackForRetry: string | undefined;
  if (overall !== 'pass') {
    const failFeedback = failedGraders
      .map((g) => `[${g.grader.toUpperCase()}] ${g.feedback}`)
      .join('\n\n');

    feedbackForRetry = [
      `## Previous Attempt ${attemptNumber} Failed (${failedAt ?? 'unknown stage'})`,
      '',
      failFeedback,
      '',
      'Please fix the above issues before finalising your changes.',
    ].join('\n');
  }

  return { overall, graders, attemptNumber, maxAttempts, feedbackForRetry };
}
