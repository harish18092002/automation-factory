import { exec } from 'child_process';
import { promisify } from 'util';
import type { GraderResult } from '../types.js';

const execAsync = promisify(exec);

interface RepoConfig {
  path: string;
  buildScript: string;
  lintScript: string;
  testScript?: string;
}

async function runScript(
  command: string,
  cwd: string,
  timeoutMs = 120_000
): Promise<{ passed: boolean; output: string; durationMs: number }> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { passed: true, output: `${stdout}\n${stderr}`.trim(), durationMs: Date.now() - start };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`.trim();
    return { passed: false, output, durationMs: Date.now() - start };
  }
}

export class BuildGrader {
  static async grade(repo: RepoConfig): Promise<GraderResult> {
    const { passed, output, durationMs } = await runScript(repo.buildScript, repo.path, 180_000);
    return {
      grader: 'build',
      passed,
      score: passed ? 1.0 : 0.0,
      feedback: passed
        ? 'Build passed'
        : `Build failed:\n${extractRelevantLines(output, ['error', 'Error', 'ERROR']).slice(0, 1000)}`,
      details: { output: output.slice(0, 2000) },
      durationMs,
    };
  }
}

export class LintGrader {
  static async grade(repo: RepoConfig): Promise<GraderResult> {
    const { passed, output, durationMs } = await runScript(repo.lintScript, repo.path, 60_000);
    return {
      grader: 'lint',
      passed,
      score: passed ? 1.0 : 0.0,
      feedback: passed
        ? 'Lint passed'
        : `Lint failed:\n${extractRelevantLines(output, ['error', 'warning', 'Error']).slice(0, 1000)}`,
      details: { output: output.slice(0, 2000) },
      durationMs,
    };
  }
}

export class TestGrader {
  static async grade(
    repo: RepoConfig,
    affectedServices: string[] = []
  ): Promise<GraderResult> {
    if (!repo.testScript) {
      return {
        grader: 'test',
        passed: true,
        score: 1.0,
        feedback: 'No test script configured — skipped',
        durationMs: 0,
      };
    }

    // Scope the test command to affected services if provided
    let command = repo.testScript;
    if (affectedServices.length > 0) {
      // For NX repos, add --projects flag
      if (command.includes('nx ')) {
        const projects = affectedServices.join(',');
        command = `${command} --projects=${projects}`;
      }
    }

    const { passed, output, durationMs } = await runScript(command, repo.path, 180_000);
    const failedTests = passed ? 0 : countTestFailures(output);

    return {
      grader: 'test',
      passed,
      score: passed ? 1.0 : 0.0,
      feedback: passed
        ? 'All tests passed'
        : `Tests failed (${failedTests} failures):\n${extractRelevantLines(output, ['FAIL', 'fail', '✗', '×']).slice(0, 1000)}`,
      details: { output: output.slice(0, 2000), failedTests },
      durationMs,
    };
  }
}

export class SchemaGrader {
  /** Validates that a tool output has the expected structure */
  static grade(output: unknown): GraderResult {
    const start = Date.now();
    if (output === null || output === undefined) {
      return { grader: 'schema', passed: false, score: 0, feedback: 'Output is null/undefined', durationMs: Date.now() - start };
    }
    if (typeof output !== 'object') {
      return { grader: 'schema', passed: false, score: 0, feedback: `Expected object, got ${typeof output}`, durationMs: Date.now() - start };
    }
    const obj = output as Record<string, unknown>;
    if (typeof obj.success !== 'boolean') {
      return { grader: 'schema', passed: false, score: 0.5, feedback: 'Missing "success" boolean field', durationMs: Date.now() - start };
    }
    return { grader: 'schema', passed: true, score: 1.0, feedback: 'Schema valid', durationMs: Date.now() - start };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRelevantLines(output: string, keywords: string[]): string {
  return output
    .split('\n')
    .filter((line) => keywords.some((kw) => line.includes(kw)))
    .slice(0, 20)
    .join('\n');
}

function countTestFailures(output: string): number {
  const match = output.match(/(\d+)\s+(?:failed|failures?)/i);
  return match ? parseInt(match[1], 10) : 1;
}
