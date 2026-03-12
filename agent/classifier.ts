import Anthropic from "@anthropic-ai/sdk";

const claude = new Anthropic();

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-4-20250514";

export type ExecutionMode = "question" | "research" | "implement";

export interface ClassificationResult {
  executionMode: ExecutionMode;
  repos: string[];
  primaryRepo: string | null;
  needsWebSearch: boolean;
  isRegistration: boolean;
  registrationAlias?: string;
  registrationPath?: string;
}

export async function classifyTask(
  userMessage: string,
  availableRepos: string[]
): Promise<ClassificationResult> {
  const res = await claude.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    system: [
      "You are a task classifier for a multi-repo engineering bot.",
      `Available repo aliases: ${availableRepos.join(", ")}`,
      "",
      "Classify the message into executionMode:",
      '  "question" — asking about code, architecture, or behavior (no code changes needed)',
      '  "research" — wants code analysis, explanation, or review (no code changes)',
      '  "implement" — wants code changes, features, bug fixes, or refactors',
      "",
      "isRegistration: true if user wants to register/add a new project repo.",
      "registrationAlias: new repo alias (only if isRegistration).",
      "registrationPath: filesystem path (only if isRegistration).",
      "repos: list ONLY aliases that appear in the available list. Empty array if none match.",
      "primaryRepo: the main repo, or null if unclear.",
      "",
      "Respond with ONLY valid JSON — no markdown, no backticks.",
      'Schema: {"executionMode":"...","repos":["..."],"primaryRepo":"...","needsWebSearch":false,"isRegistration":false}',
    ].join("\n"),
    messages: [{ role: "user", content: userMessage }],
  });

  try {
    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") throw new Error("no text");
    const raw = JSON.parse(textBlock.text) as ClassificationResult;
    raw.repos = (raw.repos ?? []).filter((r) => availableRepos.includes(r));
    if (raw.primaryRepo && !availableRepos.includes(raw.primaryRepo)) {
      raw.primaryRepo = raw.repos[0] ?? null;
    }
    return raw;
  } catch {
    return {
      executionMode: "implement",
      repos: [],
      primaryRepo: null,
      needsWebSearch: false,
      isRegistration: false,
    };
  }
}
