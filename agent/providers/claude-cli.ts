import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type {
  Provider,
  ProviderMessage,
  ProviderTool,
  ProviderChatOptions,
  NormalizedResponse,
} from './types.js';

/**
 * T4 Provider — Claude Code CLI subprocess
 * Uses the `claude` CLI tool with your Claude subscription (flat fee).
 * No API key required. Used as fallback when T1/T2/T3 fail.
 *
 * Limitation: runs an independent agentic session — does NOT replay
 * multi-turn history. Takes the last user message as the task.
 */
export class ClaudeCLIProvider implements Provider {
  readonly providerName = 'claude-cli';

  async chat(
    messages: ProviderMessage[],
    _tools: ProviderTool[],
    options: ProviderChatOptions
  ): Promise<NormalizedResponse> {
    // Extract last user message as the task prompt
    // content can be a string OR an array of content blocks (e.g. from tool result history)
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    let task = '';
    if (lastUser) {
      if (typeof lastUser.content === 'string') {
        task = lastUser.content;
      } else if (Array.isArray(lastUser.content)) {
        task = (lastUser.content as Array<{ type?: string; text?: string }>)
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n');
      }
    }
    if (!task) {
      return errorResponse(this.providerName, 'No user message to pass to Claude CLI');
    }

    // Write system prompt to a temp file so it doesn't pollute the CLI args
    const systemText = options.systemBlocks.map((b) => b.text).join('\n\n');
    const tmpDir = os.tmpdir();
    const systemFile = path.join(tmpDir, `agent-system-${Date.now()}.txt`);
    await fs.writeFile(systemFile, systemText, 'utf-8');

    try {
      const output = await runClaudeCLI(task, systemFile, options.maxTokens);
      return {
        text: output,
        toolCalls: [],
        stopReason: 'end_turn',
        inputTokens: 0,
        outputTokens: 0,
        providerName: this.providerName,
      };
    } finally {
      await fs.unlink(systemFile).catch(() => undefined);
    }
  }
}

async function runClaudeCLI(task: string, systemFile: string, maxTokens: number): Promise<string> {
  // Derive turn budget from token budget: implement (8096) → 12 turns, research (4096) → 8, question (2048) → 5
  const maxTurns = maxTokens >= 8000 ? 12 : maxTokens >= 4000 ? 8 : 5;

  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      task,
      '--output-format', 'text',
      '--system-prompt-file', systemFile,
      '--max-turns', String(maxTurns),
      // No --allowedTools restriction — let Claude CLI use its built-in file/search tools
    ];

    const proc = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim() || '*(no output)*');
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}. Is Claude Code installed?`));
    });
  });
}

function errorResponse(providerName: string, message: string): NormalizedResponse {
  return {
    text: `Error: ${message}`,
    toolCalls: [],
    stopReason: 'error',
    inputTokens: 0,
    outputTokens: 0,
    providerName,
  };
}
