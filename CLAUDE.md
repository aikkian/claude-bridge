# Claude Bridge

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
```

## Service Management

The proxy runs as a **systemd service** (`claude-bridge.service`) on port 3456. Deployed on Linux/AWS — this box does not use launchd.

**Unit file:** `/etc/systemd/system/claude-bridge.service`

**Logs:** journald — `journalctl -u claude-bridge -f`

### Restart the service

```bash
sudo systemctl restart claude-bridge
```

### Stop the service

```bash
sudo systemctl stop claude-bridge
```

### Start the service

```bash
sudo systemctl start claude-bridge
```

### Check status

```bash
systemctl status claude-bridge
```

## Environment variables

- `CLAUDE_BIN` - path/name of the Claude CLI executable to spawn (default: `claude` on `PATH`).

## Architecture

- `src/types/claude-cli.ts` - Claude CLI JSON streaming types and type guards
- `src/types/openai.ts` - OpenAI-compatible API types
- `src/adapter/openai-to-cli.ts` - Converts OpenAI requests to CLI input
- `src/adapter/cli-to-openai.ts` - Converts CLI output to OpenAI responses
- `src/subprocess/manager.ts` - Spawns and manages Claude CLI subprocesses
- `src/subprocess/pool.ts` - Session-keyed pool of resident (keepAlive) subprocesses
- `src/server/routes.ts` - Express route handlers (streaming + non-streaming)
- `src/server/standalone.js` - Server entry point

## Subprocess model: session-keyed pool

Each request maps to a session via the OpenAI `user` field. Requests are **not**
one-shot spawns by default — the proxy keeps one resident, `keepAlive: true`
`ClaudeSubprocess` alive per `sessionId` (`src/subprocess/pool.ts`) so repeat
calls on the same session skip the ~40-70s cold-spawn cost:

- First call for a session: cold spawn, full turn.
- Subsequent calls for the same session: reused warm process, only the latest
  user message is sent (`continueTurn()`) — the CLI process already holds
  prior turns in its own memory, so the full `messages` history is **not**
  replayed on top of it.
- Different sessions never share a process — isolation is per-`sessionId`.
- A session's process is evicted (killed) after 10 minutes of inactivity, or
  immediately if it exits on its own (crash, per-turn hung timeout).
- `--session-id` is **not** passed to the CLI (it requires a UUID and the CLI's
  own on-disk session resume isn't used — `--no-session-persistence` is always
  set). The pool's session key lives in memory in `pool.ts`, so any string
  works as a `user` value.

Callers that want isolated, stateless turns must use a unique `user` value
(or omit it) per logical conversation — reusing a `user` value across
unrelated conversations will carry over context.
