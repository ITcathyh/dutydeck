# Dutydeck

<p align="center">
  <strong>Local-First AI Agent Engineering Workbench & Lark Bridge</strong><br>
  <em>Connect coding agents running on your machine (Claude Code, Codex, CLI) to Lark and a Web workbench</em>
</p>

<p align="center">
  <a href="#why-dutydeck">Why Dutydeck</a> •
  <a href="#key-highlights">Key Capabilities</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#lark-guide">Lark Bridge</a> •
  <a href="#web-console">Web Console</a> •
  <a href="#agent-config">Agent Config</a> •
  <a href="#plugins">Plugins</a> •
  <a href="#cli-reference">CLI Reference</a> •
  <a href="#known-limits">Known Limits</a> •
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> | <strong>English</strong>
</p>

---

## Overview

**Dutydeck** is a local-first workbench for developers and engineering teams.

A local daemon connects the coding agents on your machine or dev server (Claude Code, Codex, ACP-compliant agents, custom CLIs) to **Lark (Feishu)** and a **Web dashboard**. Send a message in Lark, the agent runs on your machine, and the result comes back to your phone as a card.

```text
┌───────────────────────── Interfaces ─────────────────────────┐
│  Lark (Mobile & Desktop)                Web Workbench         │
│  · Dispatch tasks from anywhere        · Task board           │
│  · Approve risky actions on the phone  · Terminal playback    │
│  · Cross-session memory & schedules    · Usage, per-turn diffs│
└──────────────────────────────┬───────────────────────────────┘
                               │ (WebSocket / SSE / Card 2.0)
┌──────────────────────────────▼───────────────────────────────┐
│                    Dutydeck Local Daemon                     │
│  · Task queuing, preemption & recovery · Permission gate     │
│  · Verification gate (Lark tasks)      · Memory extraction   │
│  · SQLite persistence                  · CI follow-up (plugin)│
└──────────────────────────────┬───────────────────────────────┘
                               │ (ACP Protocol / PTY Adapter)
┌──────────────────────────────▼───────────────────────────────┐
│                     Local Agent Engines                      │
│  · Claude Code (Native / CPA Gateway)  · ACP Agents (acpx)   │
│  · Custom CLI & PTY Adapters           · Optional Git Worktrees│
└──────────────────────────────────────────────────────────────┘
```

---

## Why Dutydeck <a id="why-dutydeck"></a>

| Scenario | Traditional Terminal CLI | With Dutydeck |
|---|---|---|
| **Mobile & async dispatch** | Tied to a terminal; disconnects kill the run | Dispatch from Lark; runs in the background; results come back as cards |
| **High-risk actions** | Either YOLO mode or constant prompts | "Allow once" / "Reject" buttons on the Lark card |
| **Dirty working tree** | Edits your current checkout | Optional **Git Worktree** from HEAD. Web sessions default to a worktree; Lark tasks default to the selected directory (see below) |
| **Quality verification** | Agent claims "tests passed" | **The server runs the verification command** and records exit code, duration and a code fingerprint (Lark tasks, after you configure a command) |
| **Team memory** | Context resets every session | **Persistent memory**, selective group participation, scheduled tasks |
| **CI babysitting** | Watch CI by hand, re-open the agent on failure | With a CI plugin installed, failures can wake the agent to fix within limits (see [Plugins](#plugins)) |

---

## Key Capabilities <a id="key-highlights"></a>

- **Lark bridge**: streaming progress cards; phone approvals ("Allow once / Allow this command for the session / Reject"); long output bundled as Markdown attachments; `adhdMode` for conclusion-first output; a "View changes" link on result cards for the diff of that turn, with line comments.
- **Git Worktree (optional)**: edits happen in a worktree derived from HEAD. Web defaults to a worktree, **Lark defaults to `shared`** (the selected directory). In Lark, use `/new --workspace worktree`.
- **Verification gate**: set a bot's `verificationCommand` (e.g. `pnpm test`); after a Lark task changes code, the server runs it on the host and records the result. On failure the output goes back to the agent for up to 2 repair rounds. Web sessions do not trigger it.
- **Memory**: **off by default** (`memoryEnabled` unset means on only when the default group participation is selective or eager). Private chats are independent. In groups all groups of one bot share a pool by default; set `groupMemoryScope=per-group` (Web "Group memory scope", or `dutydeck settings bot set <appId> groupMemoryScope=per-group`) to isolate groups. Switching does not migrate or delete anything.
- **Group participation**: four levels (mention only / no @ inside owned topics / selective / eager); natural-language scheduled mandates; Leader-Worker collaboration.
- **Open PRs and follow up**: `/pr [title]` in Lark, or "Open PR" in the Web session's "Workspace & automation" panel; confirm first, then Dutydeck pushes a new `dutydeck/` branch, opens the PR and follows up on CI failures and review comments. Needs a CI plugin that can create PRs (the bundled `plugins/github`).
- **CI follow-up**: provided by plugins only. This repo ships `plugins/github` and `plugins/codebase`.

---

## 3-Minute Quick Start <a id="quick-start"></a>

### 1. Prerequisites

- **Node.js** `>= 22.12.0`, **pnpm** `>= 11`
- An authenticated Agent CLI (Claude Code `claude`, Codex, or another ACP agent)

### 2. Install and set up

```bash
pnpm add -g @byted/dutydeck --registry=http://bnpm.byted.org
dutydeck setup
```

The wizard detects Agent CLIs, sets the default working directory and can bind a Lark bot. The default Agent and the App Secret are stored in the bot configuration (the same one the Web panel shows), not in `.env`; the secret is prompted with hidden input. When creating a bot interactively it asks whether to start listening now (default yes).

Non-interactive:

```bash
dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes

# Bind a Lark app; read the secret from a pipe, never from argv
printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxx --lark-app-secret-fd 0 --agent claude --listen --yes
```

`--agent <id>` sets the default Agent (must be a detected CLI), `--lark-app-secret-fd <fd>` reads the secret from a file descriptor, `--listen` also enables listening. A running service needs `dutydeck restart` to pick up the new bot configuration.

### 3. Start and check

```bash
dutydeck start
dutydeck doctor    # runs `--version` on each bot's default Agent (5s timeout, no model call); with no .env in the current directory it falls back to the directory in last-daemon-dir and says which one it read
dutydeck status
```

Web console: `http://127.0.0.1:4310` (no login for local requests).

### Development from source

```bash
git clone https://github.com/ITcathyh/dutydeck.git
cd dutydeck
pnpm install
cp .env.example .env
pnpm dev
```

Frontend `http://127.0.0.1:4311`, backend `http://127.0.0.1:4310`.

---

## Lark Bridge Guide <a id="lark-guide"></a>

### 1. Task lifecycle

1. **Dispatch**: DM the bot, or `@bot task` in a group.
2. **Receipt**: the bot reacts with `👌` on your message and sends a progress card. A check mark is added when the turn finishes; a cross mark when it fails or is interrupted (not when you cancel).
3. **Approval**: the card starts with a one-line summary (e.g. "Run command: pnpm test"). Buttons: "Allow once", "Allow this command for the session" (initiator only, non-high-risk commands only), "Reject". An unhandled card gets a reminder after 30 minutes (the task keeps waiting) and is auto-rejected after 24 hours.
4. **Questions**: tap an option, or quote the card and reply with your answer.
5. **Result**: the result card shows the change summary, verification result and long attachments, plus a "View changes" link when the turn changed files.

**Unknown outcomes.** After a restart or disconnect a turn may have an unknown result. The original Lark topic gets a card with "Run again / Mark done / Mark failed" and a details link. The initiator and admins can act; "Run again" needs a second click within 60 seconds. The Web session page has the same three actions. Who did what and when is shown on the card and recorded in the execution ledger. Tasks older than 24 hours get no Lark card and can only be handled on the Web. API: `GET /api/sessions/:id/unknown-tasks`, `POST /api/sessions/:id/unknown-tasks/:taskId` with `{target, action, allowDuplicateEffects?}`.

**Notification tiers** (bot settings, effective only when the group-card @ switch is on):

| Tier | Includes | @ | Urgent push |
|---|---|---|---|
| Needs you | approvals, questions, unknown outcomes, recovery reminders | initiator / approvers (`notifyMentionAction`, default `true`) | yes, after the threshold |
| Done | result cards, pre-start failures | initiator (`notifyMentionDone`, default `true`) | no |
| Info | progress, receipts, queueing | none | no |

`notifyQuietHours` (e.g. `22:00-08:00`, daemon local time): during quiet hours the "Done" tier does not @; "Needs you" still @s and its urgent push is deferred to the end of the window. Scheduled-task results never @.

### 2. Commands

Matches `/help` (6 per page by default; plugin commands are listed on the last page).

| Command | Example | Description |
|---|---|---|
| `/help` | `/help 2` | List available commands |
| `/new` | `/new -- Optimize login latency` | End the current context; with a task, also start a new session and dispatch it. Options: `--agent`, `--cwd`, `--workspace shared\|worktree`, `--model`, `--effort` |
| `/new --handoff` | `/new --handoff keep going -- Add retry tests` | Carry over the previous result, git state and a note. Text after `--handoff` up to `--` is the note; the task goes after `--`. Without `--` only the handoff happens |
| `/plan` | `/plan make auth stateless` | Plan first (read-only), run after approval on the card |
| `/pr` | `/pr fix login timeout` | Push this session's changes to a new `dutydeck/` branch and open a PR (confirmation card first), then follow up on CI and reviews. Needs a CI plugin that can open PRs |
| `/tasks` | `/tasks 2` | Pending tasks, progress and recent results |
| `/status` | `/status` | Agent, workspace, state, queued items and this month's usage |
| `/agents` | `/agents` | Available agents and the bot's default |
| `/approve`, `/reject` | quote the approval card and reply `/approve` | Same as the buttons. Cards no longer show an id, so use "quote the card + command" if buttons fail |
| `/answer` | quote the question card and reply with the answer | Also `/answer <question id> <answer>` |
| `/cancel` (alias `/stop`) | `/cancel` | Cancel the running or queued turn |
| `/retry` | `/retry` | Re-run the last failed or cancelled task |
| `/queue` | `/queue top 2` | List queued items; `cancel`, `top`, `steer` by number |
| `/steer` | `/steer skip migrations/` | Inject a message into the running turn (or queue it first and interrupt if the agent cannot take it) |
| `/remember`, `/memory`, `/forget` | `/remember Never push to master` | Save, list (`consolidate`, `ignore …`) and delete memories |
| `/schedule` | `/schedule every 30 check the build` | List/create/enable/disable schedules of this topic; `every` takes minutes; new ones start disabled |
| `/ci` | `/ci wait build.yml`, `/ci fix`, `/ci cancel <id>` | Wait for CI, hand failures to the agent, cancel a wait. Needs a CI plugin |
| `/work` | `/work research <goal>` | Goals, agent assignment, reusable workflows |
| `/grant`, `/revoke` | `/grant @member` | Open or close group chat permission |
| `/repair` | `/repair` | Diagnose and fill missing Lark app scopes, events and card callbacks (asks to confirm; never publishes) |

**Plan first (`/plan <task>`).** The agent only investigates and produces a plan. On the card you can approve (runs in the same session with the bot's normal permission mode), request changes (on the card or by quoting it), or cancel. During planning, Dutydeck blocks tool calls that write files or run commands, plus common write commands in the shell. It is not a sandbox and cannot stop a deliberately crafted shell command, so don't have the agent read untrusted content while planning. Supported for Claude ACP and Claude terminal mode; other agents (e.g. codex) say they cannot plan first; terminal sessions that predate the feature need `/new`. Approve/revise/cancel need the same permission as interrupting a task (initiator or admin). Reminder after 30 minutes, closed after 24 hours; a newer task invalidates an old plan card. The Web composer has a "plan first" switch and an "execution plan awaiting approval" panel (Lark-initiated plans are read-only there).

**Open a PR and follow up (`/pr [title]`).** Also available as "Open PR" in the Web session's "Workspace & automation" panel.

- **Confirm, then push.** A confirmation card (Lark) or dialog (Web) lists the files and line counts to commit, the files that are excluded and why, local commits, source and target branches, and the title/body summary. Only after someone with permission confirms does it push; the proposal expires after 30 minutes. Lark uses the same permission as interrupt/retry (initiator or admin); the Web endpoints require the session's interrupt permission. Repeated or concurrent confirms push once and open one PR.
- **Where it pushes.** Only a new `dutydeck/<topic>-<8-char id>` branch, never with force, without switching branches or touching your checkout (HEAD, index and working files stay unchanged). It pushes with your local git credentials, so the machine must be able to `git push` to `origin`. If the remote already has that branch name it refuses.
- **Which files.** Only files that some turn of this session changed and that were not changed again afterwards (this relies on the per-turn diff records). The rest are listed as excluded ("not changed by this session", or "changed by this session, then changed again, cannot confirm"). If those files change between the proposal and the confirmation, nothing is pushed; start again.
- **Unpushed local commits** on HEAD that are not in `origin/<target>` go into the PR branch as ancestors (not rewritten) and are listed; without an `origin/<target>` tracking branch you get a warning that it cannot tell whether they are already on the target. With more than 50 unpushed local commits `/pr` refuses (the list would be incomplete): squash them first.
- **Oversized untracked files** (over 20 MiB each, 50 MiB total, or more than 2000 files): `/pr` and auto follow-up name the file or reason instead of skipping silently; add those files and build dirs to `.gitignore` and retry.
- **Follow-up** every 2 minutes (PR state, CI of the current head, new comments). CI failures: up to 3 rounds, stop when the same error appears twice or a round changes more than 10 files / 300 lines. Review comments: up to 5 rounds, 10 comments per round. **Only comments from personal accounts of the repo owner, members or collaborators** (GitHub `author_association` OWNER, MEMBER or COLLABORATOR, not a Bot) go to the agent automatically; anyone else, and bots such as coverage bots, only get a "needs your decision" card naming the author and role, and are handled only when you tap "Apply comment" (they do not use a round). The github plugin's token must be able to read organization membership (e.g. a fine-grained PAT needs organization Members read access); otherwise comments from members whose membership is private are treated as outside comments and only get a card. For automatic ones the agent marks each as handled (replied on the PR) or needs-a-human (a card with "Apply comment" / "Ignore"). Comments by Dutydeck itself (marker `<!-- dutydeck -->`) are skipped and no comment is handled twice. Fixes are fast-forward pushes to the same branch; if someone else pushed to it, follow-up stops. Follow-up stops when the PR is merged or closed, or when you click "Stop following" on the Web. The agent edits the working tree and is told not to commit, push or switch branches; Dutydeck commits that turn's changes onto the PR head. If you edit files the PR touches in the workspace, follow-up stops. If a fix round touches a file that already differed from the PR branch before the round (it holds uncommitted changes that don't belong to the PR, e.g. a local edit excluded at confirmation), nothing is pushed: follow-up stops and lists the files for a human. Fixes only push files already in the PR: if a round changes any other file (including new files, or files changed by another topic or your editor during the round), nothing is pushed and follow-up stops listing those files; if they belong in the PR, commit and push them to the PR branch yourself.
- **No CI plugin installed**: `/pr` says "Open PR is not configured" with install steps; the Web shows no button, only that hint.

### 3. Group participation

Participation level (when the bot answers without an @; it never changes permissions): mention only / no @ inside topics it owns / `selective` / `eager`. Underlying fields: `mentionPolicy` and group participation `off|observe|selective|eager` (`observe` only listens and builds background; set it with `dutydeck settings group set <chatId> participation=observe`). New bots default `mentionPolicy` to `topic`. Mention-once flow: inside a topic you don't need to @ again; if you forgot to @, send a lone `@bot` within 10 minutes to claim the previous message. Leader-Worker needs group tools; with a terminal-mode Leader both the bot and the agent must be `full-trust`.

### 4. Bot setup

**Web (recommended)**: on the first screen click "Bind Lark Bot" (later "Manage Lark Bot"), choose "Add bot" in the dialog, then "One-click create Lark bot", enter a name and click "Create bot". It reuses the local Lark login (or asks for a QR scan), creates the app, configures scopes and events, publishes and stores the secret. Then pick the default Agent and workspace and enable listening.

**CLI**:
```bash
dutydeck lark create "Dev Assistant" --agent ccflash --listen          # default: ask
dutydeck lark create "Dev Assistant" --agent <terminal agent id> --full-trust --listen   # required if the agent can't do Lark approvals
printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxx --lark-app-secret-fd 0 --agent claude --yes
```

Agents that support Lark per-action approval: ACP agents, and Claude Code / Seed / Relay in terminal mode (via a PermissionRequest hook). Other terminal CLIs can only run `full-trust`.

**Claude Code gateway and API key.** In step 2 of bot registration, choose Claude Code, expand “模型服务配置” (model service settings), enter the gateway URL, auth mode and key, then save the model service settings before completing registration. Existing bots have the same panel beside their default Agent settings. Enter the gateway model ID in the bot's default model field. Built-in Claude Code and custom Agents with `adapterId: "claude"` or `"claude-code"` (such as ccflash) are supported. The gateway must implement the Anthropic Messages API.

```bash
printf %s "$MODEL_API_KEY" | dutydeck settings agent set claude --app cli_xxx baseUrl=https://gateway.example authMode=bearer --api-key-fd 0
dutydeck settings bot set cli_xxx defaultAgentId=claude defaultModel=your-model-id
dutydeck settings agent show claude --app cli_xxx
dutydeck settings agent set claude --app cli_xxx clearApiKey=true
```

`bearer` uses Authorization Bearer; `api-key` uses X-Api-Key. Settings are isolated per bot and Agent. Omitting `--app` changes shared Agent settings. A URL is activated only with a key in the same scope; clearing the bot key restores shared Agent / CLI connection settings. Keys live in private local secret files and are never returned by the API or CLI. The model uses the bot's `defaultModel`; an explicit session model takes priority, and other bots keep their own models. Gateway changes apply when the next Agent process starts; use `/new` to recreate a running session.


---

## Web Workbench <a id="web-console"></a>

- **Task board**: Awaiting action / In progress / Completed / Archived; queueing and interrupt. **Terminal playback exists only for terminal-mode (`pty-cli`) agents**, 5000 lines at most. The delivery panel lists per-turn changes.
- **Verification**: Lark tasks only, after a command is configured. Result states: passed, failed, expired, not verified.
- **View changes on the phone**: the result-card link is valid for 14 days and shows only that turn. Only turns in a git repo run through the runtime are recorded; with too many un-ignored untracked files (over 20 MiB each, 50 MiB total, or 2000 files) no diff is recorded and the log says why, so add large files and build dirs to `.gitignore`. Line comments: signed-in Web users send them straight to the agent; people with only the share link create a confirmation card in the Lark topic, and someone with permission must tap "Hand to agent". `dutydeck auth share-key rotate` invalidates all issued links.
- **Usage and cost**: tabs "Cost", "Detail", "Session insight". Monthly USD caps per bot or group (`dutydeck settings usage set-cap <usd> --app <appId> [--chat <chatId>]`). The built-in price table covers OpenAI and Claude models (longest-prefix match; unmatched models are "unpriced"); override it entirely with `DUTYDECK_USAGE_PRICING_JSON`. Terminal-mode Claude usage is estimated from the transcript (subagent usage from `<session>/subagents/`); Codex and Traex terminal modes report none. "Partial usage unknown, caps may be inaccurate" appears on the cap card, in rejection notes and in alerts when a turn's usage cannot be read (unreadable subagent files, a turn recovered after a daemon restart, unpriced models). Not included: US-only inference 1.1x, fast mode, Batch, 1-hour cache writes, Haiku 5.5 tiers. These are estimates, not a bill. APIs: `GET /api/usage/report`, `GET /api/usage/tasks` (params `from`, `to`, `model`, `agentId`, `appId`, `origin`; tasks also `limit`, `offset`; dates in daemon local time; installation admin only).
- **Experimental features**: the "Groups & permissions" draft page, the import drafts in scheduled tasks and the "migration & advanced drafts" in settings only store drafts and do nothing at runtime, so they are hidden. Turn on Settings → Experimental → "Show experimental features" (stored in this browser only).

---

## Agent Configuration & Permissions <a id="agent-config"></a>

### 1. Custom agents (`DUTYDECK_AGENTS_JSON`)

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
- Claude Code / Seed / Relay terminal modes support Lark approval (`ask` and `approve-reads`). Other terminal CLIs need `full-trust`; otherwise the session fails to start with two fixes: `dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`, or switch to an ACP / Claude terminal agent.
- Claude terminal sessions started from Lark always use the `default` permission mode; defaults such as `auto` in your local `~/.claude` do not apply (but see [Known limits](#known-limits)).

### 2. Permission modes

Lark bots can use `ask`, `approve-reads` and `full-trust`. `deny-all` is not available for Lark bots.

| Mode | Behavior |
|---|---|
| `ask` | Writes and commands wait for approval. **Default for new bots** when the chosen Agent supports Lark approval |
| `approve-reads` | Reads and searches pass; writes and commands need approval; network access is not a read. ACP and Claude terminal mode |
| `deny-all` | Rejects every privileged action; not for Lark bots |
| `full-trust` | No confirmation. The only option when the Agent cannot do Lark approval; needs an explicit confirmation |

`lark create` defaults to `ask` and refuses unsupported Agents without `--full-trust`; the Web wizard defaults to `ask` when the Agent supports approval, else `full-trust`.

### 3. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | Listen address |
| `DUTYDECK_PORT` | `4310` | Web/API port |
| `DUTYDECK_AUTH` | `true` | Require authentication for non-local access (`false` disables; on a non-loopback address the server refuses to start unless `--unsafe-no-auth`) |
| `DUTYDECK_DEFAULT_CWD` | start dir | Default workspace |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | SQLite file |
| `DUTYDECK_AGENTS_JSON` | `[]` | Custom agents |
| `DUTYDECK_USAGE_PRICING_JSON` | built-in table | Override usage prices |
| `DUTYDECK_DEPLOY_WINDOW` | any time | Allowed `dutydeck deploy` windows, e.g. `10:00-11:00,16:00-17:00` (Asia/Shanghai) |
| `LARK_APP_ID`, `LARK_APP_SECRET` | - | Fallback for `dutydeck lark send`-style commands only. Bots configured by `dutydeck setup` keep the secret in the bot configuration |

CI tokens and webhook secrets are **no longer environment variables**; see Plugins.

---

## Plugins <a id="plugins"></a>

A plugin adds commands, agents, skills, external triggers, hooks and CI providers. The core has no platform-specific code; GitHub and Codebase CI support are plugins.

```text
my-plugin/
├── .dutydeck-plugin/plugin.json   manifest (required, strictly validated)
├── commands/*.md                  slash commands ($ARGUMENTS template)
├── agents/*.json                  agent definitions (same shape as one DUTYDECK_AGENTS_JSON entry)
├── skills/                        skills directory
├── triggers/<id>.json             external triggers
├── hooks/hooks.json               hooks
└── index.mjs                      providers entry (CI providers, in-process hooks)
```

`plugin.json` fields: `name` (kebab-case, ≤ 64), `version`, `description`, `commands` / `agents` / `skills` / `triggers` (directories), `hooks` (file), `providers` (ESM entry, no default), `userConfig` (`{ <snake_case key>: { description, sensitive? } }`). Paths must stay inside the plugin.

**Trust.** `agents`, `hooks:<event>` and `providers` execute code or commands and must be confirmed at install (non-interactive installs need `--yes`). The daemon loads only enabled plugins whose required capabilities are all confirmed. `plugin update` re-confirms only newly added capabilities. npm sources are packed with `--ignore-scripts`.

**Scopes** (`--scope`): `global` (default), `bot:<appId>` (only that bot's sessions; not effective in Web sessions, which have no bot), `workspace:<absolute path>` (sessions whose cwd is under it). Agents are always merged globally.

**Commands.** `/<plugin>:<name>` always works; `/<name>` works if not ambiguous. Names that clash with built-ins are rejected, and agent-native names such as `compact`, `clear`, `init`, `review` only work as `/<plugin>:<name>`.

**CLI**

```bash
dutydeck plugin install <source> [--scope global|bot:<appId>|workspace:<path>] [--yes] [--json]
dutydeck plugin list | validate <dir> | init <name> [--dir <dir>]
dutydeck plugin config <plugin> <key> --value <v>                      # non-sensitive
printf %s "$SECRET" | dutydeck plugin config <plugin> <key> --value-fd 0   # sensitive values only via fd
dutydeck plugin trigger-token <plugin>/<trigger> [--rotate]
dutydeck plugin update [name] [--yes] | enable <name> | disable <name> | uninstall <name>
```

Sources: a local directory, `git+https://…`, `git@…`, `file://…` (`#ref` pins a branch, tag or commit; git sources are pinned by SHA), or `npm:name@version`. Changes take effect after `dutydeck restart`. Data lives under `plugins/` next to the database (`plugins.lock.json`, installed copies, `.data/<name>/`, 0600 `.trigger-tokens.json` and `.config.json`).

**Triggers.** `POST /api/plugins/<plugin>/triggers/<id>`, no Web login, authenticated by the trigger's own `token` header or `hmac-sha256` of the raw body. Responses: `202 {sessionId, taskId}`, `200 {duplicate:true}`, `400` not JSON, `401` bad token/signature, `404` unknown trigger or disabled plugin, `413` body over 1 MiB, `429` over `maxConcurrent` (default 4, 1 to 32), `502` delivery failed (the dedupe record is revoked, so retry). Dedupe lasts 24 hours and survives restarts. Template values in the prompt are wrapped as untrusted data; templates cannot read auth headers, `authorization` or `cookie`. See `examples/plugins/hello`:

```bash
dutydeck plugin install examples/plugins/hello --yes
dutydeck plugin config hello bot_app_id --value cli_xxx
dutydeck plugin config hello chat_id --value oc_xxx
dutydeck plugin trigger-token hello/ping
dutydeck restart
curl -X POST http://127.0.0.1:4310/api/plugins/hello/triggers/ping \
  -H 'content-type: application/json' -H "x-dutydeck-token: $TOKEN" \
  -d '{"id":"1","message":"hi"}'
```

**Hooks.** Each hook has `command` (string via `/bin/sh -c`, or an argv array; cwd is the plugin root), required `timeout` (100 to 600000 ms), `onFailure` (`ignore` default, or `block`) and optional `matcher` regex. stdin gets `{ event, plugin, botAppId?, chatId?, sessionId?, taskId?, cwd?, payload }`. Exit 0 allows (stdout may be JSON with `decision` allow/deny/ask, `reason`, `additionalContext`, `updatedPrompt`); exit 2 blocks with stderr as the reason; other non-zero exits or timeouts are non-blocking errors (blocking with `onFailure: block`). The process group is killed on timeout. Hook processes inherit the daemon's whole environment (which may contain the Lark App Secret and tokens) plus `DUTYDECK_PLUGIN_NAME`, `DUTYDECK_PLUGIN_ROOT`, `DUTYDECK_PLUGIN_DATA`, `DUTYDECK_PLUGIN_CONFIG_<KEY>`, `DUTYDECK_HOOK_EVENT`. Events: `task.received` (deny rejects the task), `task.beforeRun` (deny, `additionalContext`, `updatedPrompt`), `permission.request` (allow/deny decide instead of a human), `task.completed`, `verification.completed`, `notify` (deny suppresses CI notices and trigger results).

**CI providers.** `/ci`, auto follow-up, Web "wait for CI", the scheduled-task condition and `POST /api/hooks/<provider id>` all go through CI provider plugins. With none installed, Lark `/ci` says it is not configured and the Web shows "no CI plugin installed". A provider registers via `api.registerCiProvider` with `id`, `displayName`, `matchRepository`, `getPipelineStatus`, `getFailureLogs`, optional PR methods used by `/pr` (`createPullRequest`, `listReviewComments`, `postComment`, and `getPullRequest(repository, number)` returning `{ state: 'open'|'closed'|'merged', headSha? }`, which is how a merged or closed PR is noticed; without it only the webhook's merge_request event can stop follow-up, otherwise polling continues until the round limit or a manual stop) and an optional `webhook: { verify, parse }` (see `packages/shared/src/plugins.ts`). Each `CiReviewComment` returned by `listReviewComments` carries `trusted`, `isBot` and `authorAssociation`; **comments without `trusted: true` are never handled automatically**, they only produce a "needs your decision" card. The github plugin sets `trusted` when `author_association` is OWNER, MEMBER or COLLABORATOR and the author is not a Bot. The `id` returned by `postComment` must use the same format as the ids from `listReviewComments`, otherwise Dutydeck's own reply is treated as a new comment. Bundled (install from a source checkout; the npm package does not include them):

- `plugins/github`: Actions status and failure logs, PR create/state/comments (used by `/pr`), optional webhook `POST /api/hooks/github`. Config: `github.token` (optional for waiting on public repos; required to open PRs and post comments, with pull-requests read/write permission, plus Actions read for private repos), `github.webhook_secret` (optional; enables the webhook). Pushing uses your local git credentials, not this token.
- `plugins/codebase`: pipeline/MR webhook `POST /api/hooks/codebase`. Config: `codebase.webhook_secret`.

```bash
dutydeck plugin install ./plugins/github --yes
printf %s "$TOKEN" | dutydeck plugin config github token --value-fd 0
dutydeck restart
```

The scheduled-task condition is `ci_new_failure` (the old `github_new_failure` still reads and works). `GET /api/sessions/:id/automation/ci-providers` lists loaded providers. Auto-fix limits: 3 rounds per incident, stop when the same error fingerprint appears twice, commit SHA checked before pushing, no merge or force-push.

**Upgrading from env-based CI.** `DUTYDECK_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` and `DUTYDECK_CODEBASE_WEBHOOK_SECRET` no longer work. Install the plugin, set `github.token` / `github.webhook_secret` / `codebase.webhook_secret` with `--value-fd 0`, and `dutydeck restart`. Otherwise old waits and `github_new_failure` schedules stop working, the Web shows "no CI plugin installed", and `/api/hooks/codebase` returns 404. There is no automatic migration.

**Security.** Only install plugins you trust; agents, hooks and providers run on your machine. Hook processes inherit the daemon's environment. **Expose trigger URLs only over HTTPS or an internal network**: token/HMAC auth carries no timestamp, so a captured request can be replayed after the 24-hour dedupe window. Untrusted wrapping reduces prompt-injection risk but does not eliminate it; don't point an external trigger at a `full-trust` bot.

---

## CLI Reference <a id="cli-reference"></a>

```bash
# Daemon
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]
dutydeck status | restart | stop | update | doctor

# Immutable release deploy and cleanup
dutydeck deploy --source /path/to/checkout
dutydeck deploy prune --releases /path/to/releases --dry-run     # preview what would be deleted and the space freed
dutydeck deploy prune --releases /path/to/releases [--keep 5] [--include-unmarked]

# Autostart (Linux systemd --user / macOS launchd)
dutydeck autostart enable | status | disable

# Settings (everything the dashboard configures)
dutydeck settings bot show cli_xxx
dutydeck settings bot set cli_xxx adhdMode=true
dutydeck settings bot set cli_xxx notifyQuietHours=22:00-08:00
dutydeck settings group set oc_xxx participation=selective
dutydeck settings usage set-cap 50 --app cli_xxx       # monthly USD cap
dutydeck settings terminal-backend [tmux|herdr]

# Access
dutydeck auth password set [--generate]   # browser login password
dutydeck auth token [--rotate]            # token for CLI/scripts/API
dutydeck auth share-key rotate
```

Automatic bot welcomes are enabled by default. Set `welcomeEnabled=false` to suppress group-join and first-DM welcomes immediately after saving; user message handling continues. For group replies only when mentioned, also set `mentionPolicy=always` and `defaultGroupParticipation=off`.

```bash
dutydeck settings bot set cli_xxx welcomeEnabled=false
```

External Lark card buttons can be forwarded per bot directly to an HTTP receiver:

```bash
dutydeck settings bot set cli_xxx 'cardActionForwarding={"owner":"sample-service","url":"http://127.0.0.1:14432/cards","token":"<receiver-token>","legacyActions":["ack"]}'
dutydeck settings bot set cli_xxx cardActionForwarding=null  # disable
```

`action.value.owner` must match the configured owner. Optional `legacyActions` matches old cards without an owner and cannot contain built-in Dutydeck actions. Built-in `task_id`, `taskId`, `dutydeck_*`, and legacy `dockmux_workflow` markers keep their existing handling. When forwarding is enabled, callbacks with an unknown owner or a combination of owner and built-in markers are rejected. Bots without forwarding keep their original callback handling. Corrupt persisted forwarding appears as `cardActionForwardingError` in public configuration and prevents that bot from starting its listener. The original value is retained, and unrelated changes to that bot are rejected until an explicit valid replacement or `null` is saved through the CLI above; the listener can then be restarted. The token is persisted in bot configuration and omitted from public API and CLI output. URLs must use HTTPS or local HTTP (`127.0.0.1`, `localhost`, `[::1]`); redirects are prohibited.

Dutydeck sends a `POST` with `Authorization: Bearer <token>`, `Content-Type: application/json`, and `{"version":1,"app_id":"<trusted connection App ID>","event":<complete SDK card.action.trigger event>}`. Original fields including event_id, operator, context, action, and token are preserved. The receiver must persist the event before returning `202 {"status":"accepted","event_id":"<same event ID>"}`; a persisted duplicate returns `200 {"status":"duplicate","event_id":"<same event ID>"}`. These receipts show the Chinese “accepted” / “received” toast. The request has a 2-second deadline; a timeout reports an unconfirmed outcome. There are no background retries. The receiver owns persistent deduplication by event_id.

- **Deploy**: drain → switch `releases/current` → restart → health check. If the health check fails the service is stopped and rolled back only when the database schema is unchanged; an old database snapshot is never restored.
- **Cleanup**: after each successful deploy the newest 5 releases and deployment records (including database backups) are kept. `current`, its previous release and releases still referenced by running processes are always kept; cleanup failures only warn. Records from manual deployments (no `created_by: dutydeck deploy` in `manifest.json`) are left alone unless you pass `--include-unmarked`, and even then skipped when referenced by a process or modified within the last hour. `.partial` directories modified in the last hour are skipped too.
- **Remote access**: Dutydeck listens on `127.0.0.1` by default. With `--host 0.0.0.0`, browsers log in with the password from `dutydeck auth password set`; CLI and API use the access token. Never use `--no-auth` on a reachable address.

---

## Upgrade Notes

- **CI env vars moved to plugins**: see the upgrade paragraph under Plugins.
- **Per-turn changes could be missed** when a file was edited within the same second as the last index write and kept the same size (affecting "View changes" and the `/pr` file list). Fixed.

---

## Known Limits <a id="known-limits"></a>

- **Allow rules in your local `~/.claude/settings.json` bypass Lark per-action approval.** Claude terminal sessions from Lark start in `default` mode, but `permissions.allow` rules still apply, and matching actions never produce an approval card. Clear those rules if you need strict per-action approval.
- **With `/plan`, pre-approved writes on the ACP side cannot be blocked.** Planning blocks writes by rejecting every permission request the agent sends. If Claude ACP has its own allow rules (e.g. in settings) or runs in bypass mode, those actions never ask Dutydeck. Don't pre-approve writes on the ACP side when you use `/plan`.
- The verification gate only applies to Lark tasks and needs a command configured.
- Codex and Traex terminal modes report no usage, so caps don't apply to them; cost figures are estimates.
- Trigger auth has no timestamp (see Plugins → Security).
- Draft pages are hidden unless "experimental features" is turned on.

---

## FAQ <a id="faq"></a>

**The bot doesn't react in Lark?** Run `dutydeck doctor` (it checks the Lark listener and each default Agent's `--version`); make sure the app has the Bot capability and a long-connection event subscription (`im.message.receive_v1`); in groups, `@` the bot unless the topic is already owned (levels above "mention only").

**`Persisted key policy violation`?** ACPX persists session options and requires `snake_case` keys. Don't write uppercase env names into session options.

**A custom Agent is missing or its command is not found?** The daemon does not read your shell aliases, and an Agent whose `command` cannot be found is not registered. `dutydeck doctor` names it; use an absolute path in `DUTYDECK_AGENTS_JSON` and `dutydeck restart`.

**Session fails because of per-action approval?** The Agent can't do Lark approval (only ACP and Claude Code / Seed / Relay terminal modes can). Either `dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`, or switch to an ACP / Claude terminal Agent.

**Several bots on one machine?** Yes; each has its own workspace, Agent and Lark credentials.

---

## License

Dutydeck core code is licensed under open-source terms. See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for details.
