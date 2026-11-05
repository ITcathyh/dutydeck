# Agent Configuration & Permissions <a id="agent-config"></a>

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/agents.md)

Dutydeck prefers terminal adapters for installed CLI agents, with `tmux` as the default backend for new sessions. When both terminal and ACP entries share an ID, the terminal entry wins. Agents without an available terminal adapter or executable are still discovered through ACP (Agent Client Protocol). Existing Herdr settings, session protocols and permissions are preserved. Explicit protocols, commands and permissions in `DUTYDECK_AGENTS_JSON` take priority.

The built-in CodeM (`codem`) terminal adapter uses explicit `--session` / `--resume` identifiers and never guesses the latest session. It requires the local `codem` command and adds `--yolo` for `full-trust` sessions.

The built-in Kimi (`kimi`) terminal adapter passes `--auto` (Never Ask) for `full-trust` sessions, both new and resumed, and no longer passes `--yolo`: in current Kimi Code `--yolo` only auto-approves regular tool calls, and risky actions still wait for a human. `--auto` requires Kimi Code 0.10.0 or later.

The built-in `codex` and `codex-cli` terminal entries and “Codex (ACP)” (`codex-acp`) give an explicit `CODEX_PATH` priority for discovery, version detection and launch, including executables outside `PATH`. Without that override, each new execution process resolves Codex from the Dutydeck process `PATH`, using the user's login and configuration. New processes use user-installed upgrades automatically. If the user-installed or explicitly configured Codex is missing, startup fails instead of using the ACP adapter's cached version.

Codex terminal Agents read `[profiles.<name>]` entries from `CODEX_HOME/config.toml` and expose those profiles in the Web new-session dialog. A selected profile applies to the new session only; leaving it empty keeps the Agent's default profile. The profile name is passed as a Codex CLI option rather than persisted in the Agent environment.

## 1. Custom agents (`DUTYDECK_AGENTS_JSON`)

```json
[
  {
    "id": "ccflash",
    "name": "CCFlash (Claude Code)",
    "protocol": "pty-cli",
    "adapterId": "claude-code",
    "command": "claude",
    "args": ["--settings", "/home/username/.claude/ccflash.settings.json"],
    "model": "claude-sonnet-5-5",
    "permissionMode": "ask"
  }
]
```

- Use an absolute path (or a `PATH` binary) for `command`, never a shell alias. **An agent whose command cannot be found is not registered**: `dutydeck doctor` fails and names it, and the daemon logs a warning. Invalid JSON errors name the `DUTYDECK_AGENTS_JSON` variable.
- With the default tmux backend, an Agent's `env.PATH` (including an empty string) becomes the Agent process `PATH` unchanged, and a bare `command` is resolved through it; registration still checks the Dutydeck service's own `PATH`. When overriding `PATH`, include the directory of `command` or use an absolute `command`; otherwise the Agent can be registered but fail to start.
- Claude Code / Seed / Relay terminal modes support Lark approval (`ask` and `approve-reads`). Other terminal CLIs need `full-trust`. Saving a default Agent change for an existing `ask` / `approve-reads` bot rejects an Agent without approval support and preserves the previous Agent and permissions. Permissions are never raised automatically. Existing incompatible configurations still fail to start with two fixes: `dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`, or switch to an ACP / Claude terminal agent.
- Claude terminal sessions started from Lark always use the `default` permission mode; defaults such as `auto` in your local `~/.claude` do not apply (but see [Known limits](troubleshooting.md#known-limits)).

`timeout` is in seconds (default `600`) and must convert to an integer from 1 to 2147483647 milliseconds (`0.001`–`2147483.647` seconds). Fallback CLI model discovery uses the Agent's configured direct CLI executable, cleaned child `env` and `cwd`, passing only supported global options (with separate option/value arguments). Other launch arguments, equals forms, or wrapper commands skip fallback discovery and retain the configured default model without substituting a host command.

### Terminal task status and recovery

Claude Code terminal sessions use OSC 7501 signals for busy, approval and completion detection, with automatic screen detection fallback and recovery when valid signals resume. A native terminal bound to the current input and written after the latest busy signal, including in a turn recovered after daemon restart, or a resolved approval hook can release stale busy status after a lost signal.

If an idle terminal-mode (`pty-cli`) CLI exits, the next task first verifies that the old process has exited and retires it, then rebuilds the terminal using the existing native session recovery rules. If safe recovery cannot be confirmed, the task fails before submission. Tasks with an unknown submitted result still require reconciliation and are never resent automatically.

On Unix, PTY teardown drains up to 1 MiB of remaining data before closing the reader, preserving UTF-8 decoding, pause/resume and data-before-exit ordering. Direct terminals and pane relays share this path. It has been checked on Linux / Node 22; macOS remains unverified, and Windows keeps its existing implementation.

Once Claude Code logs show support for a full-turn completion marker (`turn_duration`), split answers wait for that marker, retaining later text, Stop-hook continuation and late errors from the same turn. Older formats without the marker retain their compatibility completion path. Tool context produced by a Skill tool call is not mistaken for new user input; the final answer and task completion after a Skill call are delivered normally.

When Claude Code provides verifiable native PID state on Linux, Dutydeck follows the same verified process across `/clear`, `/resume` or `/branch`, switches collection sources and persists the new recovery identity. Existing history in the new file is not delivered again. A source switch during an active turn leaves an unknown outcome for the existing manual reconciliation flow; input is never automatically resent. Empty or metadata-only files are not cold-resume targets, and do not cause a fallback to the pre-switch context. Older CLIs missing process-birth identity fields, and macOS, retain the existing marker-based ownership path without native-switch guarantees.

On Linux, collection stays on the existing marker path when native PID state is missing or temporarily unverifiable; in that case, or when the latest conversation identity is not confirmed in the database, automatic idle cleanup and normal service shutdown preserve the original terminal. Only an idle `full-trust` tmux terminal with complete ownership evidence and no unresolved tasks, pending approvals or background tasks can be adopted automatically; other cases remain blocked for manual confirmation.

After automatic idle cleanup closes a terminal, Dutydeck waits up to 10 seconds to prove that the original processes have exited (the status relay wrapping a Claude terminal now exits together with Claude). If exit still cannot be proven, the service log records a warning and messages sent to that session fail immediately with a stop-blocked error (`DRIVER_STOP_UNVERIFIED`) instead of sitting in the queue. A background recheck runs after 45 seconds, then at doubling intervals up to every 30 minutes; once exit is proven the session reopens on its own, without a restart or manual retirement. If the first recheck still fails, the session gets one notice (Lark sessions in the original topic). A terminal whose native session can never be confirmed (for example one stuck at a startup prompt) is retired anyway, with a warning, once it has been idle 18 hours past the release threshold; native records stay on disk and only the process ends. At startup, a session whose saved working directory is gone (for example a deleted worktree) is skipped and the reason is recorded in the log and the session; other sessions recover normally.

When Codex switches log files within the same native session, Dutydeck verifies ownership, drains complete records from the old file and continues from the new one. Copied history is not delivered again, and files belonging to another session are rejected.

Codex and TraeX native recovery uses only records confirmed to belong to the current session. If inherited context cannot establish ownership, recovery is refused to avoid resuming another session. After an idle Codex session is released, the next turn resumes its verified native context.

Codex and TraeX terminal tasks settle from success, failure or cancellation events bound to the current native turn. A partial answer does not override a later failure; cancellation is recorded as an interruption. A recovering Codex turn without text output still ends with the confirmed cancellation or error when the corresponding input is verified. TraeX reads session metadata containing large model catalogs so final answers arrive and tasks complete. Recovery drains the old log segment before reading the next segment for the same session. New canonical records retain progress, input receipts and final answers while deduplicating mirrored records.

TraeX uses the full terminal viewport to distinguish busy and ready states, including layouts with keyboard controls on a separate footer row; status text quoted in output or drafts is not treated as an active footer. Codex accepts `›` / `»` input prompts and the 0.164.0 footer showing only the model and remaining weekly quota, without treating trust or update menus as ready. Ordinary Cursor input sends one Enter, preserving multiline input and normal task queueing without a second empty-input control action. Empty input prompts for Claude Code, Seed, and Relay are recognized as idle so recovery operations for unconfirmed tasks can proceed. Up to two custom `statusLine` rows between the empty composer and permission mode footer are supported, including the first message after resuming a session.

When a direct child explicitly started by the current Codex parent turn reports quota exhaustion or rate limiting, Web and Lark progress records show a fixed diagnostic without the upstream error body. The parent continues; Dutydeck does not automatically retry or switch accounts because of this diagnostic. Observation is bounded and best effort; children started before recovery are not reported retroactively. This diagnostic is not enabled for TraeX.

Claude background Agent, Bash and Monitor tasks are counted by native task ID. The main turn may complete after an explicit answer when the CLI is no longer waiting for a child result; background tasks continue. Legacy pending counters and an explicit Waiting screen retain wait-and-merge behavior. Late notices keep their original input identity instead of becoming the next turn's answer. Restart rebuilds background state; non-persistent Monitors expire at the CLI deadline, and after `/clear` the old log is used only to reconcile stop notices for known background tasks. Successful Write/Edit operations in the known project memory directory preserve the same-turn answer and postscript in the final result; business files and Bash commands do not trigger this rule.

An exact Codex model-capacity failure without a business tool or permission call can retry automatically at most twice, after 30 and 90 seconds, each with a separate recorded execution attempt. Stop and new input cancel unsubmitted retries. Each submission rechecks the original requester's current permissions; restart retains deadlines and cancellation state. Unknown submission or completion is never automatically replayed. HTTP 429, quota, authentication and generic server errors are excluded. Multi-step work waits for this verified automatic retry chain and advances after success; unrelated manual reruns are not adopted as its result.

For a recognized Codex model-migration menu, Dutydeck selects only “Use existing model” and waits for the composer again. An unclear highlighted row or menu remains for manual handling. Terminal capture sockets support long and non-ASCII temporary-directory paths.

## 2. Permission modes

Lark bots can use `ask`, `approve-reads` and `full-trust`. `deny-all` is not available for Lark bots.

| Mode | Behavior |
|---|---|
| `ask` | Writes and commands wait for approval. **Default for new bots** when the chosen Agent supports Lark approval |
| `approve-reads` | Reads and searches pass; writes and commands need approval; network access is not a read. ACP and Claude terminal mode |
| `deny-all` | Rejects every privileged action; not for Lark bots |
| `full-trust` | No confirmation. The only option when the Agent cannot do Lark approval; needs an explicit confirmation |

For Codex ACP, every non-full-trust native turn, including restored sessions, uses `untrusted` approval, user review and a read-only sandbox. Writes and privileged commands reach Dutydeck approval instead of Codex ACP auto-review. Codex can still allow reads its native policy considers safe, so every read-only action is not guaranteed to produce an approval request; `approve-reads` also allows explicitly declared reads and searches. Explicit `full-trust` uses native full access. These child-only settings do not change global Codex configuration.

`lark create` defaults to `ask` and refuses unsupported Agents without `--full-trust`; the Web wizard defaults to `ask` when the Agent supports approval, else `full-trust`.

Lark email admission and identity lookups cache confirmed invalid, cross-app or invisible-user failures for up to 60 seconds per client, so a permission repair may take that long to be retried. Bot configuration refreshes or credential changes clear the cache. Successful identities, rate limits, server errors, network errors and timeouts are not cached; subsequent lookups still check for revoked access.

## 3. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | Listen address |
| `DUTYDECK_PORT` | `4310` | Web/API port |
| `DUTYDECK_AUTH` | `true` | Require authentication for non-local access (`false` disables; on a non-loopback address the server refuses to start unless `--unsafe-no-auth`) |
| `DUTYDECK_DEFAULT_CWD` | start dir | Default workspace |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | SQLite file |
| `DUTYDECK_AGENTS_JSON` | `[]` | Custom agents |
| `DUTYDECK_CLEANUP_INTERVAL_MS` | `300000` | Cleanup interval: integer milliseconds from 1 to 2147483647 |
| `DUTYDECK_DRIVER_IDLE_TIMEOUT_MS` | `21600000` | Nonnegative idle-terminal release threshold in milliseconds; `0` disables it; the periodic timer's 32-bit limit does not apply; sessions whose native background tasks are still running are not released |
| `DUTYDECK_USAGE_PRICING_JSON` | built-in table | Override usage prices |
| `DUTYDECK_DEPLOY_WINDOW` | any time | Allowed `dutydeck deploy` windows, e.g. `10:00-11:00,16:00-17:00` (Asia/Shanghai) |
| `LARK_APP_ID`, `LARK_APP_SECRET` | - | Fallback for `dutydeck lark send`-style commands only. Bots configured by `dutydeck setup` keep the secret in the bot configuration |

CI tokens and webhook secrets are **no longer environment variables**; see Plugins.
