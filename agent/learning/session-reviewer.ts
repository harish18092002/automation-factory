import { patternExtractor } from './pattern-extractor.js';
import { skillWriter } from './skill-writer.js';
import { semanticStore } from '../memory/semantic-store.js';
import { episodicStore } from '../memory/episodic-store.js';

/**
 * Post-session analysis pipeline.
 * Called asynchronously after every agent session (via hook or direct call).
 *
 * - Successful implement sessions → extract + register skills
 * - Failed sessions → log error event for future analysis
 * - All sessions → apply memory decay to keep knowledge fresh
 */
export class SessionReviewer {
  async review(
    sessionId: string,
    repoAlias: string,
    outcome: 'success' | 'partial' | 'failed'
  ): Promise<void> {
    console.log(`[session-reviewer] Reviewing session ${sessionId.slice(0, 8)} (${outcome})`);

    try {
      // 1. Continuous learning — extract patterns from successful implement sessions
      if (outcome === 'success') {
        const patterns = await patternExtractor.extract(sessionId, repoAlias);
        if (patterns.length > 0) {
          const registered = await skillWriter.validateAndRegister(patterns, sessionId, repoAlias);
          console.log(`[session-reviewer] Registered ${registered.length} new skill(s) from session`);
        }
      }

      // 2. Log error analysis for failed sessions
      if (outcome === 'failed') {
        const events = await episodicStore.getSession(sessionId, repoAlias);
        const errors = events.filter((e) => e.eventType === 'error');
        if (errors.length > 0) {
          console.log(`[session-reviewer] Session had ${errors.length} error event(s) — logged for analysis`);
        }
      }

      // 3. Apply memory decay to semantic facts (keeps knowledge fresh)
      await semanticStore.applyDecay(repoAlias).catch(() => undefined);
    } catch (err) {
      // Non-critical — don't let learning failures affect the user
      console.error(`[session-reviewer] Error during review: ${String(err)}`);
    }
  }
}

/**
 * CLI entry point — called by the post-session hook script.
 * Usage: npx tsx agent/learning/session-reviewer.ts <sessionId> <repoAlias> <outcome>
 */
if (process.argv[1] && process.argv[1].includes('session-reviewer')) {
  const [, , sessionId, repoAlias, outcome] = process.argv;
  if (sessionId && repoAlias && outcome) {
    const reviewer = new SessionReviewer();
    reviewer
      .review(sessionId, repoAlias, outcome as 'success' | 'partial' | 'failed')
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  }
}

export const sessionReviewer = new SessionReviewer();
