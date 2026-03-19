import type { Provider } from "./types.js";
import { DeepSeekProvider } from "./deepseek.js";
import { GeminiProvider } from "./gemini.js";
import { GroqProvider } from "./groq.js";
import { ClaudeCLIProvider } from "./claude-cli.js";
import type { ExecutionMode } from "../classifier.js";

/**
 * Selects the best available provider based on task mode and estimated token count.
 *
 * Tier routing:
 *   T2 Gemini        — large context tasks (> 80K tokens) — 1M context window
 *   T3 Groq fast     — question / route (Llama 3.1 8B, ~1000 tok/s)
 *   T1 DeepSeek      — primary workhorse for implement/research
 *   T3 Groq smart    — fallback when DeepSeek unavailable (Llama 3.3 70B)
 *   T2 Gemini        — fallback when neither DeepSeek nor Groq available
 *   T4 Claude CLI    — last resort, always available via subscription
 */
export class ProviderRouter {
  static select(mode: ExecutionMode | "route", estimatedTokens = 0): Provider {
    // Non-personal / team setup: always use Claude CLI (subscription-based, no API keys)
    if (process.env.IS_OPEN_SOURCE_MODE !== "yes") {
      return new ClaudeCLIProvider();
    }

    const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    const hasGroq = Boolean(process.env.GROQ_API_KEY);

    // T2: Long-context tasks — Gemini (1M context window)
    if (estimatedTokens > 80_000 && hasGemini) {
      return new GeminiProvider();
    }

    // T3: Fast routing / simple questions — Groq Llama 8B
    if ((mode === "question" || mode === "route") && hasGroq) {
      return new GroqProvider("fast");
    }

    // T1: Primary workhorse for implement/research — DeepSeek
    if (hasDeepSeek) {
      return new DeepSeekProvider();
    }

    // T3 smart: Groq 70B as DeepSeek fallback (faster, no Gemini rate limits)
    if (hasGroq) {
      return new GroqProvider("smart");
    }

    // T2 fallback: Gemini when neither DeepSeek nor Groq available
    if (hasGemini) {
      return new GeminiProvider();
    }

    // T4: Claude CLI subprocess — uses subscription, no API key needed
    return new ClaudeCLIProvider();
  }

  /**
   * Select provider at a specific fallback tier.
   * Used by retry logic: attempt=0 → preferred, attempt=1 → next tier, etc.
   */
  static selectAtTier(tier: number): Provider {
    if (process.env.IS_OPEN_SOURCE_MODE !== "yes") {
      return new ClaudeCLIProvider();
    }

    const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
    const hasGemini = Boolean(process.env.GEMINI_API_KEY);
    const hasGroq = Boolean(process.env.GROQ_API_KEY);

    const available: Provider[] = [];
    if (hasDeepSeek) available.push(new DeepSeekProvider());
    if (hasGroq) available.push(new GroqProvider("smart"));
    if (hasGemini) available.push(new GeminiProvider());
    available.push(new ClaudeCLIProvider()); // always available

    return available[Math.min(tier, available.length - 1)];
  }
}
