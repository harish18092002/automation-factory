// ── Provider-agnostic message types (OpenAI-compatible format) ───────────────

export interface ProviderSystemMessage {
  role: 'system';
  content: string;
}

export interface ProviderUserMessage {
  role: 'user';
  content: string;
}

export interface ProviderToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-encoded string
  };
}

export interface ProviderAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ProviderToolCall[];
}

export interface ProviderToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ProviderMessage =
  | ProviderSystemMessage
  | ProviderUserMessage
  | ProviderAssistantMessage
  | ProviderToolMessage;

// ── Tool definition (OpenAI function-calling format) ─────────────────────────

export interface ProviderToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ProviderTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ProviderToolParameter>;
      required?: string[];
    };
  };
}

// ── System prompt blocks (supports per-block caching) ────────────────────────

export interface ProviderSystemBlock {
  text: string;
  cache?: boolean; // hint: cache this block if provider supports it
}

// ── Normalised tool call extracted from provider response ────────────────────

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ── Normalised response from any provider ────────────────────────────────────

export interface NormalizedResponse {
  text: string;
  toolCalls: NormalizedToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  inputTokens: number;
  outputTokens: number;
  providerName: string;
}

// ── Chat options ──────────────────────────────────────────────────────────────

export interface ProviderChatOptions {
  maxTokens: number;
  systemBlocks: ProviderSystemBlock[];
  temperature?: number;
  /** Filesystem paths the Claude CLI subprocess should be granted access to via --add-dir */
  repoPaths?: string[];
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface Provider {
  readonly providerName: string;
  chat(
    messages: ProviderMessage[],
    tools: ProviderTool[],
    options: ProviderChatOptions
  ): Promise<NormalizedResponse>;
}
