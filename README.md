# Claude Bridge For Agent Proxy

**Use your existing Claude subscription (Pro, Max, Team, or Enterprise) with any OpenAI-compatible client — no separate API costs!**

This proxy wraps the Claude Code CLI as a subprocess and exposes an OpenAI-compatible HTTP API, allowing tools like OpenClaw, Hermes, Continue.dev, or any OpenAI-compatible client to use your Claude subscription instead of paying per-API-call.

## Why This Exists

| Approach | Cost | Limitation |
|----------|------|------------|
| Claude API | ~$15/M input, ~$75/M output tokens | Pay per use |
| Claude subscription (Pro/Max/Team/Enterprise) | Flat monthly fee | OAuth blocked for third-party API use |
| **This Proxy** | $0 extra (uses your subscription) | Routes through CLI |

Anthropic blocks OAuth tokens from being used directly with third-party API clients. However, the Claude Code CLI *can* use OAuth tokens. This proxy bridges that gap by wrapping the CLI and exposing a standard API.

## How It Works

```
Your App (OpenClaw, Continue.dev, etc.)
         ↓
    HTTP Request (OpenAI format)
         ↓
   Claude Bridge (this project)
         ↓
   Claude Code CLI (subprocess)
         ↓
   OAuth Token (from your Claude subscription)
         ↓
   Anthropic API
         ↓
   Response → OpenAI format → Your App
```

## Features

- **OpenAI-compatible API** — Works with any client that supports OpenAI's API format, including agents like OpenClaw and Hermes
- **Streaming support** — Real-time token streaming via Server-Sent Events
- **Multiple models** — Claude Opus, Sonnet, and Haiku with flexible model aliases
- **OpenClaw integration** — Automatic tool name mapping and system prompt adaptation
- **Content block handling** — Proper text block separators for multi-block responses
- **Session management** — Maintains conversation context via session IDs
- **Auto-start service** — Optional LaunchAgent for macOS
- **Zero configuration** — Uses existing Claude CLI authentication
- **Secure by design** — Uses `spawn()` to prevent shell injection

## What's Different from the Original

- **OpenClaw tool mapping** — Maps OpenClaw tool names (`exec`, `read`, `web_search`, etc.) to Claude Code equivalents (`Bash`, `Read`, `WebSearch`)
- **System prompt stripping** — Removes OpenClaw-specific tooling sections that confuse the CLI
- **Content block support** — Handles `input_text` content blocks and multi-block text separators
- **Tool call types** — Full OpenAI tool call type definitions for streaming and non-streaming
- **Improved streaming** — Better SSE handling with connection confirmation and client disconnect detection

## Prerequisites

1. **A Claude subscription** (Pro, Max, Team, or Enterprise) — [Subscribe here](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Installation

```bash
# Clone the repository
git clone https://github.com/aikkian/claude-bridge.git
cd claude-bridge

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Start the server

```bash
npm start
# or
node dist/server/standalone.js
```

The server runs at `http://localhost:3456` by default. Pass a custom port as an argument:

```bash
node dist/server/standalone.js 8080
```

### Test it

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion (non-streaming)
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Chat completion (streaming)
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |

## Available Models

| Model ID | Alias | CLI Model |
|----------|-------|-----------|
| `claude-opus-5` | `opus` | Claude Opus |
| `claude-sonnet-5` | `sonnet` | Claude Sonnet |
| `claude-haiku-4-5` | `haiku` | Claude Haiku |
| `claude-opus-4` | `opus` | Claude Opus |
| `claude-sonnet-4` | `sonnet` | Claude Sonnet |
| `claude-haiku-4` | `haiku` | Claude Haiku |

All model IDs also accept a `claude-code-cli/` prefix (e.g., `claude-code-cli/claude-opus-5`). Unknown models default to Opus.

## Configuration with Popular Tools

### OpenClaw

OpenClaw works with this proxy out of the box. The proxy automatically maps OpenClaw tool names to Claude Code equivalents and strips conflicting tooling sections from system prompts.

### Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com) works with Claude Bridge as a custom OpenAI-compatible provider. Add to `~/.hermes/config.yaml`:

```yaml
custom_providers:
  - name: claude-bridge
    base_url: http://localhost:3456/v1
    api_key: not-needed
    api_mode: openai
    default_model: claude-sonnet-5
    models:
      - claude-opus-5
      - claude-sonnet-5
      - claude-haiku-4-5
      - claude-opus-4
      - claude-sonnet-4
      - claude-haiku-4
```

Then select the provider in Hermes via `hermes model` or set it as the default provider. Model names appear in the picker and can be switched mid-session with `/model`.

⚠️ **One caveat:** the proxy exposes models via `GET /v1/models`, but Hermes only shows models from the static `models:` block in `config.yaml` — keep that list in sync with what the proxy serves (run `curl http://localhost:3456/v1/models` to check).

### Continue.dev

Add to your Continue config:

```json
{
  "models": [{
    "title": "Claude",
    "provider": "openai",
    "model": "claude-sonnet-5",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Generic OpenAI Client (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="claude-sonnet-5",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Auto-Start on macOS

The proxy can run as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

```bash
# Start the service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy

# Stop
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy

# Check status
launchctl list com.openclaw.claude-max-proxy
```

## Architecture

```
src/
├── types/
│   ├── claude-cli.ts      # Claude CLI JSON streaming types + type guards
│   └── openai.ts          # OpenAI API types (including tool calls)
├── adapter/
│   ├── openai-to-cli.ts   # Convert OpenAI requests → CLI format
│   └── cli-to-openai.ts   # Convert CLI responses → OpenAI format
├── subprocess/
│   └── manager.ts         # Claude CLI subprocess + OpenClaw tool mapping
├── session/
│   └── manager.ts         # Session ID mapping
├── server/
│   ├── index.ts           # Express server setup
│   ├── routes.ts          # API route handlers
│   └── standalone.ts      # Entry point
└── index.ts               # Package exports
```

## Security

- Uses Node.js `spawn()` instead of shell execution to prevent injection attacks
- No API keys stored or transmitted by this proxy
- All authentication handled by Claude CLI's secure keychain storage
- Prompts passed as CLI arguments, not through shell interpretation

## Troubleshooting

### "Claude CLI not found"

Install and authenticate the CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

### Streaming returns immediately with no content

Ensure you're using `-N` flag with curl (disables buffering):
```bash
curl -N -X POST http://localhost:3456/v1/chat/completions ...
```

### Server won't start

Check that the Claude CLI is in your PATH:
```bash
which claude
```

## Contributing

Contributions welcome! Please submit PRs with tests.

## License

MIT

## Acknowledgments

- Built for use with [OpenClaw](https://openclaw.com)
- Powered by [Claude Code CLI](https://github.com/anthropics/claude-code)
