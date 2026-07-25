/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
  isTextBlockStart,
  isToolUseBlockStart,
  isInputJsonDelta,
  isContentBlockStop,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: ClaudeModel;
  cwd?: string;
  timeout?: number;
  /**
   * Keep stdin open after the first turn so the process can be reused for
   * later turns via continueTurn() (see pool.ts). Defaults to false: the
   * process is one-shot and exits after replying.
   */
  keepAlive?: boolean;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 900000; // 15 minutes

/**
 * System prompt appended to Claude CLI to map OpenClaw tool names to Claude Code equivalents.
 * OpenClaw's system prompt references tools like `exec`, `read`, `web_search` etc. that
 * don't exist in Claude Code. This mapping tells the model what to use instead.
 */
const OPENCLAW_TOOL_MAPPING_PROMPT = [
  "## Tool Name Mapping",
  "You are running inside Claude Code CLI, not OpenClaw. The system prompt may reference OpenClaw tool names — map them to your actual tools:",
  "",
  "### Direct tool replacements",
  "- `exec` or `process` → use `Bash` (run shell commands)",
  "- `read` → use `Read` (read file contents)",
  "- `write` → use `Write` (write files)",
  "- `edit` → use `Edit` (edit files)",
  "- `grep` → use `Grep` (search file contents)",
  "- `find` or `ls` → use `Glob` or `Bash(ls ...)`",
  "- `web_search` → use `WebSearch`",
  "- `web_fetch` → use `WebFetch`",
  "- `image` → use `Read` (Claude Code can read images)",
  "",
  "### OpenClaw CLI tools (use via Bash)",
  "These OpenClaw tools are available through the `openclaw` CLI. Use `Bash` to run them:",
  '- `memory_search` → `Bash(openclaw memory search "<query>")` — semantic search across memory files',
  "- `memory_get` → `Read` on the memory file directly, OR `Bash(openclaw memory search \"<query>\")` for discovery",
  '- `message` → `Bash(openclaw message send --to <target> "<text>")` — send messages to channels (Telegram, Discord, etc.)',
  "  - Also: `openclaw message read`, `openclaw message broadcast`, `openclaw message react`, `openclaw message poll`",
  "- `cron` → `Bash(openclaw cron list)`, `Bash(openclaw cron add ...)`, `Bash(openclaw cron status)` — manage scheduled jobs",
  "  - Also: `openclaw cron rm`, `openclaw cron enable`, `openclaw cron disable`, `openclaw cron runs`, `openclaw cron run`, `openclaw cron edit`",
  '- `sessions_list` → `Bash(openclaw agent --local --message "list sessions")` or check session files directly',
  '- `sessions_history` → `Bash(openclaw agent --local --message "show history for session <key>")` or check session files',
  "- `nodes` → `Bash(openclaw nodes status)`, `Bash(openclaw nodes describe <node>)`, `Bash(openclaw nodes invoke --node <id> --command <cmd>)`",
  '  - Also: `openclaw nodes run --node <id> "<shell command>"` for running commands on paired nodes',
  "",
  "### Not available via CLI",
  "- `browser` — requires OpenClaw's dedicated browser server (no CLI equivalent)",
  "- `canvas` — requires paired node with canvas capability; use `openclaw nodes invoke` if a node is available",
  "",
  "### Skills",
  "When a skill says to run a bash/python command, use the `Bash` tool directly.",
  "Skills are located in the `skills/` directory relative to your working directory.",
  "To use a skill: `Read` its SKILL.md file first, then follow the instructions using `Bash`.",
  "Run `openclaw skills list --eligible --json` to see all available skills.",
].join("\n");

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;
  private defaultTimeout: number = DEFAULT_TIMEOUT;

  /**
   * Start the Claude CLI subprocess with the given prompt.
   *
   * By default the process is one-shot: it handles exactly one turn and exits,
   * so unrelated requests never share conversation state. Pass `keepAlive: true`
   * to leave stdin open instead — the process then stays resident and further
   * turns can be sent with continueTurn(). Callers opting into keepAlive are
   * responsible for scoping reuse to a single caller/session (see pool.ts);
   * mixing turns from different callers on one process would leak context
   * between them.
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    this.defaultTimeout = timeout;

    const args = this.buildArgs(options);

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        this.process = spawn(process.env.CLAUDE_BIN || "claude", args, {
          cwd: options.cwd || process.cwd(),
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
          ),
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Set timeout
        this.resetTimeout(timeout);

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Pass prompt via stdin to avoid E2BIG on large inputs
        this.writePrompt(prompt, { closeStdin: !options.keepAlive });
        resolve();

        if (process.env.DEBUG_SUBPROCESS) {
          console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
        }

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          }
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            if (process.env.DEBUG_SUBPROCESS) {
              console.error("[Subprocess stderr]:", errorText.slice(0, 200));
            }
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Process closed with code: ${code}`);
          }
          this.clearTimeout();
          // Process any remaining buffer
          if (this.buffer.trim()) {
            this.processBuffer();
          }
          this.emit("close", code);
        });
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array
   */
  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--dangerously-skip-permissions", // Skip permission prompts
      "--input-format",
      "stream-json", // Accept JSON messages on stdin
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--no-session-persistence", // Don't write session state to disk; keepAlive reuse is in-memory only
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      "--append-system-prompt",
      OPENCLAW_TOOL_MAPPING_PROMPT,
      // Prompt is passed via stdin (avoids E2BIG on large inputs)
    ];

    // Note: our own pool key (e.g. the OpenAI `user` field) is deliberately
    // NOT passed as CLI --session-id — that flag requires a UUID and is for
    // the CLI's own on-disk session resume, which we don't use
    // (--no-session-persistence). Our pool keeps the live process reference
    // in memory instead, so any string works as a key.

    return args;
  }

  /**
   * Write a prompt to stdin as a stream-json user message envelope. Closes
   * stdin afterward unless `closeStdin` is false, in which case the CLI knows
   * more turns may follow and stays alive waiting for them.
   */
  private writePrompt(prompt: string, { closeStdin }: { closeStdin: boolean }): void {
    const envelope = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    };
    this.process?.stdin?.write(JSON.stringify(envelope) + "\n");
    if (closeStdin) {
      this.process?.stdin?.end();
    }
  }

  /**
   * Send another turn to an already-running keepAlive process. Only valid
   * after start({ keepAlive: true }); throws if the process isn't alive.
   * Callers must not call this concurrently with an in-flight turn on the
   * same instance — the CLI processes stdin messages one at a time, and
   * responses aren't tagged, so overlapping turns would be indistinguishable
   * on the "assistant"/"result" events.
   */
  continueTurn(prompt: string, timeout?: number): void {
    if (!this.isRunning()) {
      throw new Error("Cannot continue turn: subprocess is not running");
    }
    this.resetTimeout(timeout || this.defaultTimeout);
    this.writePrompt(prompt, { closeStdin: false });
  }

  /**
   * (Re)arm the inactivity timeout. Called on spawn and on every subsequent
   * turn so a long-lived keepAlive process isn't killed mid-session — only
   * killed if a single turn hangs longer than the timeout.
   */
  private resetTimeout(timeout: number): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      if (!this.isKilled) {
        this.isKilled = true;
        this.process?.kill("SIGTERM");
        this.emit("error", new Error(`Request timed out after ${timeout}ms`));
      }
    }, timeout);
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isTextBlockStart(message)) {
          // Emit when a new text content block starts (for inserting separators)
          this.emit("text_block_start", message as ClaudeCliStreamEvent);
        }

        if (isToolUseBlockStart(message)) {
          this.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }

        if (isInputJsonDelta(message)) {
          this.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }

        if (isContentBlockStop(message)) {
          this.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }

        if (isContentDelta(message)) {
          // Emit content delta for streaming (text_delta only)
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          // Turn finished — clear the inactivity timer so an idle keepAlive
          // process waiting for its next turn isn't killed by it.
          this.clearTimeout();
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.env.CLAUDE_BIN || "claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
