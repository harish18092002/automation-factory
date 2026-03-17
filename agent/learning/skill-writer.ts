import { skillRegistry } from '../memory/skill-registry.js';
import { patternExtractor } from './pattern-extractor.js';
import type { Skill } from '../types.js';

/**
 * Validates extracted patterns and writes them to the SkillRegistry.
 * Prevents duplicate skills and over-specific patterns.
 */
export class SkillWriter {
  async validateAndRegister(
    patterns: Awaited<ReturnType<typeof patternExtractor.extract>>,
    sessionId: string,
    repoAlias: string
  ): Promise<Skill[]> {
    const registered: Skill[] = [];

    for (const pattern of patterns) {
      // Validation 1: keywords must be non-empty
      if (!pattern.triggerKeywords || pattern.triggerKeywords.length === 0) continue;

      // Validation 2: prompt must be substantial (>20 chars)
      if (!pattern.prompt || pattern.prompt.length < 20) continue;

      // Validation 3: no file path specifics (too narrow to reuse)
      if (hasFilePathReferences(pattern.prompt)) {
        console.log(`[skill-writer] Skipping over-specific pattern: ${pattern.name}`);
        continue;
      }

      // Validation 4: duplicate check
      const isDup = await skillRegistry.isDuplicate(repoAlias, pattern.triggerKeywords);
      if (isDup) {
        console.log(`[skill-writer] Skipping duplicate pattern: ${pattern.name}`);
        continue;
      }

      // Register with initial neutral success rate
      const skill = await skillRegistry.addSkill({
        name: pattern.name,
        description: pattern.description,
        repoAlias,
        category: pattern.category,
        prompt: pattern.prompt,
        triggerKeywords: pattern.triggerKeywords,
        successRate: 0.5, // Neutral start — will improve with usage
        lastUsed: new Date().toISOString(),
        validatedAt: new Date().toISOString(),
        validatedBy: 'auto',
        sourceSession: sessionId,
      });

      console.log(`[skill-writer] Registered new skill: "${skill.name}" for repo "${repoAlias}"`);
      registered.push(skill);
    }

    return registered;
  }
}

/** Check if a prompt is too specific (contains file paths or variable names) */
function hasFilePathReferences(text: string): boolean {
  return /(?:\/[a-z][a-z0-9-]+){2,}|\.ts\b|\.js\b|apps\/|libs\/|src\//.test(text);
}

export const skillWriter = new SkillWriter();
