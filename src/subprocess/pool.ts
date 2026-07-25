/**
 * Session-Keyed Subprocess Pool
 *
 * Keeps one resident, keepAlive ClaudeSubprocess per sessionId so repeat
 * callers on the same session skip the ~40-70s cold-spawn cost. Sessions are
 * never shared across keys — each sessionId gets its own process and its own
 * conversation, so isolation is per-caller, not global.
 *
 * A session is evicted (process killed, entry removed) after IDLE_TIMEOUT_MS
 * of no new turns, or immediately if the underlying process exits on its own
 * (crash, CLI-side timeout, etc.).
 */

import { ClaudeSubprocess } from "./manager.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface PooledSession {
  subprocess: ClaudeSubprocess;
  idleTimer: NodeJS.Timeout;
}

const sessions = new Map<string, PooledSession>();

function evict(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  sessions.delete(sessionId);
  entry.subprocess.kill();
}

function armIdleTimer(sessionId: string): NodeJS.Timeout {
  return setTimeout(() => evict(sessionId), IDLE_TIMEOUT_MS);
}

/**
 * Look up the pooled subprocess for a session, if one is alive.
 */
export function getSession(sessionId: string): ClaudeSubprocess | undefined {
  const entry = sessions.get(sessionId);
  if (!entry) return undefined;
  if (!entry.subprocess.isRunning()) {
    // Process died between requests (crash, hung-turn timeout) — drop the
    // stale entry so the caller spawns a fresh one.
    clearTimeout(entry.idleTimer);
    sessions.delete(sessionId);
    return undefined;
  }
  clearTimeout(entry.idleTimer);
  entry.idleTimer = armIdleTimer(sessionId);
  return entry.subprocess;
}

/**
 * Register a freshly spawned keepAlive subprocess under a sessionId.
 */
export function registerSession(sessionId: string, subprocess: ClaudeSubprocess): void {
  const existing = sessions.get(sessionId);
  if (existing) {
    clearTimeout(existing.idleTimer);
  }
  sessions.set(sessionId, { subprocess, idleTimer: armIdleTimer(sessionId) });
  // If the process exits on its own (crash, hung-turn timeout kill), drop it
  // from the pool so the next request for this session spawns fresh instead
  // of reusing a dead entry.
  subprocess.once("close", () => {
    const entry = sessions.get(sessionId);
    if (entry && entry.subprocess === subprocess) {
      clearTimeout(entry.idleTimer);
      sessions.delete(sessionId);
    }
  });
}
