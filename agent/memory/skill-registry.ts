import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Skill } from '../types.js';

const DATA_DIR = path.resolve('data/skills');

// In-memory cache with TTL to avoid re-reading from disk on every request
const cache = new Map<string, { skills: Skill[]; loadedAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

function skillFile(repoAlias: string): string {
  return path.join(DATA_DIR, `${repoAlias}-skills.json`);
}

async function loadSkills(repoAlias: string): Promise<Skill[]> {
  const cached = cache.get(repoAlias);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.skills;
  }

  try {
    const content = await fs.readFile(skillFile(repoAlias), 'utf-8');
    const skills = JSON.parse(content) as Skill[];
    cache.set(repoAlias, { skills, loadedAt: Date.now() });
    return skills;
  } catch {
    return [];
  }
}

async function saveSkills(repoAlias: string, skills: Skill[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(skillFile(repoAlias), JSON.stringify(skills, null, 2), 'utf-8');
  cache.set(repoAlias, { skills, loadedAt: Date.now() });
}

export class SkillRegistry {
  /** Get skills for a repo, optionally filtered by keyword overlap */
  async getSkills(repoAlias: string, keywords?: string[]): Promise<Skill[]> {
    const all = [
      ...await loadSkills(repoAlias),
      ...await loadSkills('global'),
    ];

    if (!keywords || keywords.length === 0) return all;

    // Score by keyword overlap
    const kwLower = keywords.map((k) => k.toLowerCase());
    return all
      .map((skill) => {
        const overlap = skill.triggerKeywords.filter((kw) =>
          kwLower.some((k) => kw.toLowerCase().includes(k) || k.includes(kw.toLowerCase()))
        ).length;
        return { skill, overlap };
      })
      .filter(({ overlap }) => overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || b.skill.successRate - a.skill.successRate)
      .map(({ skill }) => skill);
  }

  /** Get the top N skills by success rate */
  async getTopSkills(repoAlias: string, limit = 5): Promise<Skill[]> {
    const all = await loadSkills(repoAlias);
    return all
      .filter((s) => s.usageCount >= 2) // Only recommend skills with observed usage
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, limit);
  }

  /** Add a new skill */
  async addSkill(
    skill: Omit<Skill, 'skillId' | 'usageCount' | 'version'>
  ): Promise<Skill> {
    const skills = await loadSkills(skill.repoAlias);
    const newSkill: Skill = {
      ...skill,
      skillId: randomUUID(),
      usageCount: 0,
      version: 1,
    };
    skills.push(newSkill);
    await saveSkills(skill.repoAlias, skills);
    return newSkill;
  }

  /** Update an existing skill */
  async updateSkill(skillId: string, repoAlias: string, updates: Partial<Skill>): Promise<void> {
    const skills = await loadSkills(repoAlias);
    const idx = skills.findIndex((s) => s.skillId === skillId);
    if (idx === -1) return;
    skills[idx] = { ...skills[idx], ...updates };
    await saveSkills(repoAlias, skills);
  }

  /** Record a usage event (success or failure) — updates rolling success rate */
  async recordUsage(skillId: string, repoAlias: string, success: boolean): Promise<void> {
    const skills = await loadSkills(repoAlias);
    const skill = skills.find((s) => s.skillId === skillId);
    if (!skill) return;

    skill.usageCount++;
    skill.lastUsed = new Date().toISOString();
    // Rolling average weighted toward recent: new_rate = 0.8 * old + 0.2 * result
    skill.successRate = 0.8 * skill.successRate + 0.2 * (success ? 1 : 0);

    await saveSkills(repoAlias, skills);
  }

  /** Check if a skill with similar trigger keywords already exists (duplicate prevention) */
  async isDuplicate(repoAlias: string, triggerKeywords: string[]): Promise<boolean> {
    const existing = await loadSkills(repoAlias);
    const kwSet = new Set(triggerKeywords.map((k) => k.toLowerCase()));
    return existing.some((s) => {
      const existingKws = new Set(s.triggerKeywords.map((k) => k.toLowerCase()));
      const intersection = [...kwSet].filter((k) => existingKws.has(k));
      return intersection.length >= Math.min(2, kwSet.size); // ≥2 shared keywords = duplicate
    });
  }
}

export const skillRegistry = new SkillRegistry();
