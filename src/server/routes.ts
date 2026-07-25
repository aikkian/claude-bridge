/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { getSession, registerSession } from "../subprocess/pool.js";
import { openaiToCli, lastUserPrompt } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest, OpenAIToolCall } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);

    // Requests carrying a sessionId (OpenAI `user` field) reuse a resident,
    // keepAlive subprocess for that session so repeat callers skip the cold
    // spawn. Sessions are never shared across keys. Requests without a
    // sessionId fall back to a fresh, one-shot, fully isolated subprocess.
    let subprocess: ClaudeSubprocess;
    let isContinuation = false;
    if (cliInput.sessionId) {
      const existing = getSession(cliInput.sessionId);
      if (existing) {
        subprocess = existing;
        isContinuation = true;
        // The pooled process already holds prior turns in its own context —
        // replay only the newest user message, not the full history, or
        // context would be duplicated turn over turn.
        cliInput.prompt = lastUserPrompt(body.messages);
      } else {
        subprocess = new ClaudeSubprocess();
        registerSession(cliInput.sessionId, subprocess);
      }
    } else {
      subprocess = new ClaudeSubprocess();
    }

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId, isContinuation);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId, isContinuation);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Convert Claude tool_use ID to OpenAI-compatible call ID.
 * Claude uses "toolu_abc123", OpenAI uses "call_abc123".
 */
function toOpenAICallId(claudeId: string): string {
  return `call_${claudeId.replace("toolu_", "")}`;
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  isContinuation: boolean
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  // Without this, headers are buffered and client times out waiting
  res.flushHeaders();

  // Send initial comment to confirm connection is alive
  res.write(":ok\n\n");

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let lastModel = "claude-sonnet-4";
    let isComplete = false;
    let hasEmittedText = false;
    let toolCallIndex = 0;
    let inToolBlock = false;

    // subprocess is a one-shot instance for this request only, but remove
    // listeners on every exit path anyway so a lingering reference can't fire late.
    const cleanup = () => {
      res.removeListener("close", onClientClose);
      subprocess.removeListener("text_block_start", onTextBlockStart);
      subprocess.removeListener("content_delta", onContentDelta);
      subprocess.removeListener("assistant", onAssistant);
      subprocess.removeListener("result", onResult);
      subprocess.removeListener("error", onError);
      subprocess.removeListener("close", onClose);
    };
    const finish = () => {
      cleanup();
      resolve();
    };

    // Handle actual client disconnect (response stream closed)
    const onClientClose = () => {
      if (!isComplete && !isContinuation) {
        // Client disconnected before response completed - kill the one-shot
        // subprocess. Pooled/continuation subprocesses are left alive: they
        // belong to the session, not this single request, and the in-flight
        // turn may still be wanted by the next request on this session.
        subprocess.kill();
      }
      finish();
    };
    res.on("close", onClientClose);

    // When a new text content block starts after we've already emitted text,
    // insert a separator so text from different blocks doesn't run together
    const onTextBlockStart = () => {
      if (hasEmittedText && !res.writableEnded) {
        const sepChunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: "\n\n",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(sepChunk)}\n\n`);
      }
    };
    subprocess.on("text_block_start", onTextBlockStart);

    // Handle streaming content deltas
    const onContentDelta = (event: ClaudeCliStreamEvent) => {
      const delta = event.event.delta;
      const text = (delta?.type === "text_delta" && delta.text) || "";
      if (text && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: isFirst ? "assistant" : undefined,
              content: text,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
        hasEmittedText = true;
      }
    };
    subprocess.on("content_delta", onContentDelta);

    // DISABLED: Tool call forwarding causes an agentic loop — OpenClaw interprets
    // Claude Code's internal tool_use (Read, Bash, etc.) as calls it needs to
    // handle, triggering repeated requests. Claude Code handles tools internally
    // via --print mode; only the final text result should be forwarded.
    // TODO: Re-enable with a non-tool_calls display mechanism (e.g. inline text).
    //
    // subprocess.on("tool_use_start", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const block = event.event.content_block;
    //   if (block?.type !== "tool_use") return;
    //
    //   inToolBlock = true;
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         role: isFirst ? "assistant" : undefined,
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           id: toOpenAICallId(block.id),
    //           type: "function" as const,
    //           function: {
    //             name: block.name,
    //             arguments: "",
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    //   isFirst = false;
    // });
    //
    // subprocess.on("input_json_delta", (event: ClaudeCliStreamEvent) => {
    //   if (res.writableEnded) return;
    //   const delta = event.event.delta;
    //   if (delta?.type !== "input_json_delta") return;
    //
    //   const chunk = {
    //     id: `chatcmpl-${requestId}`,
    //     object: "chat.completion.chunk",
    //     created: Math.floor(Date.now() / 1000),
    //     model: lastModel,
    //     choices: [{
    //       index: 0,
    //       delta: {
    //         tool_calls: [{
    //           index: toolCallIndex,
    //           function: {
    //             arguments: delta.partial_json,
    //           },
    //         }],
    //       },
    //       finish_reason: null,
    //     }],
    //   };
    //   res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    // });
    //
    // subprocess.on("content_block_stop", () => {
    //   if (inToolBlock) {
    //     toolCallIndex++;
    //     inToolBlock = false;
    //   }
    // });

    // Handle final assistant message (for model name)
    const onAssistant = (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;
    };
    subprocess.on("assistant", onAssistant);

    const onResult = (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        // Send final done chunk with finish_reason and usage data
        const doneChunk = createDoneChunk(requestId, lastModel);
        if (result.usage) {
          doneChunk.usage = {
            prompt_tokens: result.usage.input_tokens || 0,
            completion_tokens: result.usage.output_tokens || 0,
            total_tokens:
              (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0),
          };
        }
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish();
    };
    subprocess.on("result", onResult);

    const onError = (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      finish();
    };
    subprocess.on("error", onError);

    const onClose = (code: number | null) => {
      // Subprocess exited - ensure response is closed
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          // Abnormal exit without result - send error
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      finish();
    };
    subprocess.on("close", onClose);

    // Start the subprocess, or send the next turn if reusing a pooled one
    if (isContinuation) {
      try {
        subprocess.continueTurn(cliInput.prompt);
      } catch (err) {
        console.error("[Streaming] continueTurn error:", err);
        cleanup();
        reject(err as Error);
      }
    } else {
      subprocess.start(cliInput.prompt, {
        model: cliInput.model,
        keepAlive: !!cliInput.sessionId,
      }).catch((err) => {
        console.error("[Streaming] Subprocess start error:", err);
        cleanup();
        reject(err);
      });
    }
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string,
  isContinuation: boolean
): Promise<void> {
  return new Promise((resolve) => {
    // DISABLED: see tool call forwarding comment in handleStreamingResponse
    // const accumulatedToolCalls: OpenAIToolCall[] = [];
    //
    // subprocess.on("assistant", (message: ClaudeCliAssistant) => {
    //   for (const block of message.message.content) {
    //     if (block.type === "tool_use") {
    //       accumulatedToolCalls.push({
    //         id: toOpenAICallId(block.id),
    //         type: "function",
    //         function: {
    //           name: block.name,
    //           arguments: JSON.stringify(block.input),
    //         },
    //       });
    //     }
    //   }
    // });

    // subprocess is a one-shot instance for this request only, but remove
    // listeners on every exit path anyway so a lingering reference can't fire late.
    const cleanup = () => {
      subprocess.removeListener("result", onResult);
      subprocess.removeListener("error", onError);
      subprocess.removeListener("close", onClose);
    };
    const finish = () => {
      cleanup();
      resolve();
    };

    const onResult = (result: ClaudeCliResult) => {
      res.json(cliResultToOpenai(result, requestId));
      finish();
    };
    subprocess.on("result", onResult);

    const onError = (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
      }
      finish();
    };
    subprocess.on("error", onError);

    const onClose = (code: number | null) => {
      // Fallback for when the process exits without sending a result
      // (e.g. crashed or was killed) instead of exiting cleanly after the reply.
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      finish();
    };
    subprocess.on("close", onClose);

    // Start the subprocess, or send the next turn if reusing a pooled one
    if (isContinuation) {
      try {
        subprocess.continueTurn(cliInput.prompt);
      } catch (error) {
        res.status(500).json({
          error: {
            message: error instanceof Error ? error.message : "Unknown error",
            type: "server_error",
            code: null,
          },
        });
        finish();
      }
    } else {
      subprocess
        .start(cliInput.prompt, {
          model: cliInput.model,
          keepAlive: !!cliInput.sessionId,
        })
        .catch((error) => {
          res.status(500).json({
            error: {
              message: error.message,
              type: "server_error",
              code: null,
            },
          });
          finish();
        });
    }
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  const now = Math.floor(Date.now() / 1000);
  const modelIds = [
    "claude-opus-4",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-haiku-4",
    "claude-haiku-4-5",
  ];
  res.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      owned_by: "anthropic",
      created: now,
    })),
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
