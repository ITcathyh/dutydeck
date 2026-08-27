# Dockmux MVP acceptance plan

Dockmux is a channel-independent workspace for operating local or remote coding agents. ACP is the preferred protocol and `acpx@0.13.0` is the owned runtime boundary. JSONL, pipe, and PTY are compatibility fallbacks.

## Acceptance criteria

1. Sessions implement `start`, `send`, `interrupt`, `pause`, `resume`, `stop`, and `restart`; interrupt preserves the session while stop terminates its process tree.
2. Runtime states include `created`, `starting`, `idle`, `thinking`, `running_tool`, `waiting_for_permission`, `interrupting`, `interrupted`, `completed`, `failed`, and `stopped`.
3. Agent configuration supports name, command, args, protocol, model, cwd, env, permission mode, and timeout. A capability probe chooses ACP, JSONL, pipe, then PTY.
4. Built-in definitions exist for Codex, Claude, Cursor, Pi, TraeX, a mock ACP agent, a custom ACP agent, JSONL fallback, and PTY fallback.
5. TraeX is an ACP agent reached through the pinned acpx custom-agent boundary. Its executable and ACP arguments are configurable; Dockmux does not embed TraeX-specific runtime logic.
6. All output is normalized to text, thinking, tool call, tool result, permission request, status, error, completed, or raw terminal events. Unparseable output is retained as raw terminal data.
7. Tool calls retain id, name, input, output, status, startedAt, and completedAt and correlate updates by id.
8. Fastify exposes the required session, event, SSE stream, permission, and agent endpoints. Routes only call the Dockmux runtime.
9. React UI includes sessions, agent/model/cwd setup, live Markdown, collapsible tools, permissions, errors, states, lifecycle controls, and raw terminal output.
10. SQLite persists AgentConfig, Machine, Project, Session, Task, Event, ToolCall, PermissionRequest, Error, and ChannelMapping exclusively through repository interfaces.
11. Full-trust permission mode is never the default.

## Acceptance tests (written before implementation)

The automated suite covers: mock ACP initialization and streaming; tool/result correlation; permission approve/reject; interrupt; process-tree cleanup on stop; a new run instance on restart; abnormal exit errors; ACP→JSONL and JSONL→PTY fallback; lossless raw PTY output; SSE reconnect with `Last-Event-ID`; SQLite save/restore; explicit unsupported pause/resume errors; safe default permissions; custom ACP configuration; built-in Codex/Claude/Cursor/Pi probes; and all twelve TraeX-specific cases in the supplied brief.

## Target directory structure

```text
apps/
  server/          Fastify API and SSE composition root
  web/             React, Vite, Tailwind, Zustand, TanStack Query
packages/
  agent-runtime/   Lifecycle/state machine and normalized event orchestration
  acp-client/      Pinned acpx process adapter
  transports/      Probe, JSONL/pipe/PTY process transports
  renderer/        Shared event rendering helpers
  storage/         Drizzle schema and repository implementations
  config/          Validated agent/application configuration
  shared/          Domain types, schemas, errors, and repository contracts
tests/fixtures/     Mock ACP, JSONL, and PTY agents
docs/              Acceptance plan and architecture notes
```

## Evidence required for completion

- `pnpm test` passes the acceptance suite.
- `pnpm typecheck` and `pnpm build` pass across the workspace.
- A server smoke test creates a session, receives an SSE event, and exercises a lifecycle action.
- README and `.env.example` document installation, acpx/TraeX configuration, commands, safety defaults, and fallback behavior.
