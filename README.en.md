# Dutydeck

Claude Code terminal sessions use OSC 7501 signals for busy, approval and completion detection, with automatic screen detection fallback and recovery when valid signals resume. A native terminal bound to the current input and written after the latest busy signal, including in a turn recovered after daemon restart, or a resolved approval hook can release stale busy status after a lost signal.

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
- **Group participation**: four levels (mention only / no @ inside owned topics / selective / eager); natural-language schedules in groups and private chats (say "every 15 minutes, check whether this topic has a conclusion"; the Agent posts a card saying what, when and where, and it starts after you click 启用, no command needed); Leader-Worker collaboration.
  - Confirmation cards preserve the task text and its line breaks instead of clipping it to 200 characters. If the confirmation card cannot be delivered, the schedule stays saved and disabled. The Agent receives its ID and recovery instructions: retry with the same parameters in the current turn to resend the card, or have the user send `/schedule enable <ID>` in the current chat.
- **Open PRs and follow up**: `/pr [title]` in Lark, or "Open PR" in the Web task's "Results inspector"; confirm first, then Dutydeck pushes a new `dutydeck/` branch, opens the PR and follows up on CI failures and review comments. Needs a CI plugin that can create PRs (the bundled `plugins/github`).
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

Lark task cards hide the Agent name by default. Enable the Agent name switch under the bot’s access and advanced settings to show a short name badge after the status (for example, `Completed` `CCFlash`), without parenthesized host details. You can also enable it with `dutydeck settings bot set <appId> showAgentName=true`, or set it to `false` to hide it.

### 1. Task lifecycle

1. **Dispatch**: DM the bot, or `@bot task` in a group.
2. **Receipt**: the bot reacts with `👌` on your message and removes it after the progress card arrives. When progress cards are hidden, `👌` stays until the task returns its result or completion reaction. A check mark is added when the turn finishes; a cross mark when it fails or is interrupted (not when you cancel).
3. **Approval**: the card starts with a one-line summary (e.g. "Run command: pnpm test"). Buttons: "Allow once", "Allow this command for the session" (initiator only, non-high-risk commands only), "Reject". An unhandled card gets a reminder after 30 minutes (the task keeps waiting) and is auto-rejected after 24 hours.
4. **Questions**: tap an option, or quote the card and reply with your answer. The full question and all options are shown when they fit; otherwise a full-text attachment is sent and the card is clearly marked as an excerpt. Dutydeck does not publish the answerable Lark card until attachment delivery succeeds; delivery resumes after recovery. Answered or expired cards retain the content originally displayed. Approval cards remain redacted; raw commands are not uploaded as full-text attachments.
5. **Result**: the result card shows the change summary, verification result and long attachments, plus a "View changes" link when the turn changed files. A `需要你：…` (action needed) line after the conclusion appears in a separate highlighted block with a bold label. Turn completion, pending decisions and verification results are labeled separately; a completed turn does not imply passed verification.

**Attachments and delivery.** Markdown and structured images in cards share a deduplicated limit of 4 images. Only real Markdown image syntax with a valid Lark `img_key` is read; code examples and ordinary image URLs do not trigger downloads.

Lark files fall back to Range downloads with the same bot identity only after an explicit platform size-limit response. Files stream to disk in chunks of at most 32 MB, with a **512 MiB local per-file limit** chosen by Dutydeck, not a Lark platform limit. Images do not use Range. Permission and restricted-message errors are not bypassed; failed, cancelled or timed-out downloads do not give the Agent partial files. The existing request deadline still applies (15 seconds by default); slow large files may need to be provided as smaller files.

Progress and result writes recheck task and turn ownership after rate-limit waits and before retries, so stopped or replaced turns stop writing. Requests already sent cannot be revoked. A final result explicitly rejected by content audit stops unchanged retries and attempts a fixed notice without the rejected body. A delivered notice does not mark the result delivered, and the body is not resent as an attachment to bypass audit.

The first result delivery time is saved before sending. Unknown deliveries are automatically retried only within one hour of that first attempt, including across restarts. After that, resending stops; check the original topic and the Web execution record. Confirmed receipts remain recoverable. This does not guarantee exactly-once remote effects.

**Early final delivery and custom cards.** An Agent in the active Lark turn can use `dutydeck agent --turn "$TURN" group send 'complete answer' --final`. Default `--delivery publish` sends to the original reply location. `--delivery reply-agent` only relays the summary to the bot that handed over the task; `--delivery both` publishes and relays. Relay requires a resolvable original bot still in the group, checked before publication. Content, card, mode and targets are fixed on first submission; retries must match. If publication succeeded but relay failed, only relay is retried; completion and restart recovery do not send another confirmed result.

A custom card is a static Card 2.0 **body**, without `schema`, `header` or `config`. For example, `/path/body.json`:

```json
{"elements":[{"tag":"markdown","content":"**Result**: complete"},{"tag":"hr"}]}
```

```bash
dutydeck agent --turn "$TURN" group send 'searchable summary' --final --card-file /path/body.json --delivery both
```

The summary is required but need not repeat all card data. Bodies are limited to 28,000 bytes and allowlisted static text, images, layouts and tables; interactive components, callbacks, `element_id` and script URLs are rejected. Lark still validates specific styles. Relay-only mode accepts a summary without a publication card. The host retains status, original routing, task/turn checks and completion handling; a rejected custom body is not replaced with another result. Legacy `dutydeck group send` supports the same options. These commands require session tool credentials and the host-provided `--turn` for this execution. Missing, stale or mismatched credentials are rejected. `$TURN` in examples denotes that credential.

**Unknown outcomes.** After a restart or disconnect a turn may have an unknown result. The original Lark topic gets a card with "Run again / Mark done / Mark failed" and a details link. The initiator and admins can act; "Run again" needs a second click within 60 seconds. The Web session page has the same three actions. Who did what and when is shown on the card and recorded in the execution ledger. Tasks older than 24 hours get no Lark card and can only be handled on the Web. API: `GET /api/sessions/:id/unknown-tasks`, `POST /api/sessions/:id/unknown-tasks/:taskId` with `{target, action, allowDuplicateEffects?}`.

**Notification tiers** (bot settings, effective only when the group-card @ switch is on):

| Tier | Includes | @ | Urgent push |
|---|---|---|---|
| Needs you | approvals, questions, unknown outcomes, recovery reminders | initiator / approvers (`notifyMentionAction`, default `true`) | yes, after the threshold |
| Done | result cards, pre-start failures | initiator (`notifyMentionDone`, default `true`) | no |
| Info | progress, receipts, queueing | none | no |

`notifyQuietHours` (e.g. `22:00-08:00`, daemon local time): during quiet hours the "Done" tier does not @; "Needs you" still @s and its urgent push is deferred to the end of the window. Scheduled-task results never @.

### 2. Commands

You don't have to remember these: tell the bot what you want ("redo this with codex", "show the status", "open this group to everyone") and the Agent runs the matching command for you. For read-only commands the Agent tells you the result in its answer instead of posting a card; commands that change something post a confirm card first and run after you click 确认. Stopping a task, approving a tool call and answering the Agent's question stay with you: use the card buttons or just say "停" / "可以".

Matches `/help` (6 per page by default; plugin commands are listed on the last page).

| Command | Example | Description |
|---|---|---|
| `/help` | `/help 2` | List available commands |
| `/new` | `/new -- Optimize login latency` | End the current context; with a task, also start a new session and dispatch it. Options: `--agent`, `--cwd`, `--workspace shared\|worktree`, `--model`, `--effort` |
| `/new --handoff` | `/new --handoff keep going -- Add retry tests` | Carry over the previous result, git state and a note. Text after `--handoff` up to `--` is the note; the task goes after `--`. Without `--` only the handoff happens |
| `/resume [session-id]` | `/resume`; `/resume list` | Restore the latest closed conversation in this topic. List shows up to 5 closed conversations you can resume, with closing time, Agent and first task; their original requester must be verified. The current conversation ends as with /new; archived conversations and other scopes are excluded |
| `/fork [task]` | `/fork Check another implementation` | Open a parallel topic with context. The original conversation and queue keep running. Supports /new launch options; git repositories default to an independent worktree |
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

You can also ask the Agent in plain language. It uses `dutydeck agent --turn "$TURN" session resume [--id ID]` or `dutydeck agent --turn "$TURN" session fork [--task TASK]`, then posts a confirmation card before making changes. Failed restoration explains the reason and suggests `/new --handoff`. When restoring a task that has not yet started, launch options are re-checked against the requester's current permissions before creating the session.

Only the requester of the source conversation’s first task can fork it. The fork inherits the actual Agent, model and reasoning effort; permissions follow the bot’s current settings. Claude Code terminal mode copies durable context with `--resume ID --fork-session`; Codex terminal mode uses `fork ID`. ACP, other Agents, switching Agents, or a source without durable context use the existing handoff of recent results, git status and a note. Native forks include git status as well. Codex uses handoff when explicitly sharing the same directory, so copied records cannot be mistaken for the source later. A worktree starts from committed code and excludes the original conversation’s uncommitted edits; the first message says so. The receipt links to the new topic. A private chat that shares one conversation cannot fork; first switch its bot setting to one topic per message.

When bare `/new` actually ends a worktree session and a valid Web address is configured, its receipt links to that old session's authenticated workbench with the workspace panel open. Preview and explicit cleanup confirmation are still required; busy or dirty worktrees are refused. Opening the link does not clean the directory or dissolve the group. `/stop` only stops the task and does not add this cleanup link.

**Plan first (`/plan <task>`).** The agent only investigates and produces a plan. On the card you can approve (runs in the same session with the bot's normal permission mode), request changes (on the card or by quoting it), or cancel. During planning, Dutydeck blocks tool calls that write files or run commands, plus common write commands in the shell. It is not a sandbox and cannot stop a deliberately crafted shell command, so don't have the agent read untrusted content while planning. Supported for Claude ACP and Claude terminal mode; other agents (e.g. codex) say they cannot plan first; terminal sessions that predate the feature need `/new`. Approve/revise/cancel need the same permission as interrupting a task (initiator or admin). Reminder after 30 minutes, closed after 24 hours; a newer task invalidates an old plan card. The Web composer has a "plan first" switch and an "execution plan awaiting approval" panel (Lark-initiated plans are read-only there).

**Open a PR and follow up (`/pr [title]`).** Also available as "Open PR" in the Web task's "Results inspector".

- **Confirm, then push.** A confirmation card (Lark) or dialog (Web) lists the files and line counts to commit, the files that are excluded and why, local commits, source and target branches, and the title/body summary. Only after someone with permission confirms does it push; the proposal expires after 30 minutes. Lark uses the same permission as interrupt/retry (initiator or admin); the Web endpoints require the session's interrupt permission. Repeated or concurrent confirms push once and open one PR.
- **Where it pushes.** Only a new `dutydeck/<topic>-<8-char id>` branch, never with force, without switching branches or touching your checkout (HEAD, index and working files stay unchanged). It pushes with your local git credentials, so the machine must be able to `git push` to `origin`. If the remote already has that branch name it refuses.
- **Which files.** Only files that some turn of this session changed and that were not changed again afterwards (this relies on the per-turn diff records). The rest are listed as excluded ("not changed by this session", or "changed by this session, then changed again, cannot confirm"). If those files change between the proposal and the confirmation, nothing is pushed; start again.
- **Unpushed local commits** on HEAD that are not in `origin/<target>` go into the PR branch as ancestors (not rewritten) and are listed; without an `origin/<target>` tracking branch you get a warning that it cannot tell whether they are already on the target. With more than 50 unpushed local commits `/pr` refuses (the list would be incomplete): squash them first.
- **Oversized untracked files** (over 20 MiB each, 50 MiB total, or more than 2000 files): `/pr` and auto follow-up name the file or reason instead of skipping silently; add those files and build dirs to `.gitignore` and retry.
- **Follow-up** every 2 minutes (PR state, CI of the current head, new comments). CI failures: up to 3 rounds, stop when the same error appears twice or a round changes more than 10 files / 300 lines. Review comments: up to 5 rounds, 10 comments per round. **Only comments from personal accounts of the repo owner, members or collaborators** (GitHub `author_association` OWNER, MEMBER or COLLABORATOR, not a Bot) go to the agent automatically; anyone else, and bots such as coverage bots, only get a "needs your decision" card naming the author and role, and are handled only when you tap "Apply comment" (they do not use a round). The github plugin's token must be able to read organization membership (e.g. a fine-grained PAT needs organization Members read access); otherwise comments from members whose membership is private are treated as outside comments and only get a card. For automatic ones the agent marks each as handled (replied on the PR) or needs-a-human (a card with "Apply comment" / "Ignore"). Comments by Dutydeck itself (marker `<!-- dutydeck -->`) are skipped and no comment is handled twice. Fixes are fast-forward pushes to the same branch; if someone else pushed to it, follow-up stops. Follow-up stops when the PR is merged or closed, or when you click "Stop following" on the Web. The agent edits the working tree and is told not to commit, push or switch branches; Dutydeck commits that turn's changes onto the PR head. If you edit files the PR touches in the workspace, follow-up stops. If a fix round touches a file that already differed from the PR branch before the round (it holds uncommitted changes that don't belong to the PR, e.g. a local edit excluded at confirmation), nothing is pushed: follow-up stops and lists the files for a human. Fixes only push files already in the PR: if a round changes any other file (including new files, or files changed by another topic or your editor during the round), nothing is pushed and follow-up stops listing those files; if they belong in the PR, commit and push them to the PR branch yourself.
- **No CI plugin installed**: `/pr` says "Open PR is not configured" with install steps; the Web shows no button, only that hint.

### 3. Group participation

Participation level (when the bot answers without an @; it never changes permissions): mention only / no @ inside topics it owns / `selective` / `eager`. Underlying fields: `mentionPolicy` and group participation `off|observe|selective|eager` (`observe` only listens and builds background; set it with `dutydeck settings group set <chatId> participation=observe`). New bots default `mentionPolicy` to `topic`. In a group with several bots (the group's subscribed alert sources don't count) and no responder, un-@ messages are not answered, except ones that call the bot by name, reply to it, or sit in a topic it owns; @ the bot that should answer and say 「你负责接话」 ("you take the replies") and confirm, or pick the responder in the Web group settings; a late release announcement does not clear a newer responder claim. A responder can be set in single-bot groups too; a `selective` responder without a scope also answers requests for help that don't name anyone and need a bot (e.g. 「有人知道今天的发布单在哪看吗」, "does anyone know where today's release ticket is?"); small talk, questions between members, @ to others and progress updates are still left alone. A role scope (Web "Bot management" → "负责范围" / scope, or `dutydeck settings bot set <appId> roleScope=...`; applies to every group the bot is in) lets a `selective` bot judge and answer un-@ messages within that scope regardless of the responder; bots with overlapping scopes may all answer. A `selective` bot without a scope that is not the responder, in a group with several humans, does not answer general questions and plain alerts that don't address it. In `eager` mode and in single-human groups, setting a scope also switches the bot to judging by scope, so it answers fewer messages. When the bot stays silent, @ it and ask 「刚才为什么没回」 ("why didn't you reply") for the reason and how to change it; `/status` shows the participation level, responder and scope. Mention-once flow: inside a topic you don't need to @ again; if you forgot to @, send a lone `@bot` within 10 minutes to claim the previous message. Leader-Worker needs group tools; with a terminal-mode Leader both the bot and the agent must be `full-trust`.

**Alert triage** (built-in scenario pack `alarm`, see [Built-in plugins](#builtin-plugins)). @ the bot and say 「告警来了先帮我看看」 ("look at alerts first when they come") or 「告警来了先帮我初筛，只看 P0」 ("triage alerts first, P0 only"); it posts a confirmation card naming the source bot (by default the bot that posted most in the group recently), levels, dedupe window and hourly cap. Whoever confirms becomes the requester, and triage tasks run in their name. Say 「关闭告警初筛」 ("turn off alert triage") and confirm to turn it off; the settings are kept. Once on, alerts from the source bot skip the participation decision: the bot opens a topic under the alert and starts a triage task. The same alert is analysed once per dedupe window, alerts over the hourly cap are skipped, and asking 「刚才为什么没回」 under a skipped alert gives the reason. In multi-bot groups only the responder triages. `/status` shows the subscription and today's analysed and skipped counts. When you @ the bot quoting an alert card and it has handled the same alert rule in this group before, the earlier conclusion goes to the agent as reference material and the process card shows a 「📎 date 同一告警规则：…」 line. The Web group settings list each pack's parameters (sources, levels, dedupe window, hourly cap); a pack must be confirmed in the group once before it can be changed from the Web or with `dutydeck settings group set <chatId> scenarios=...`. In multi-bot groups, a topic opened under an alert from the source bot does not count as another bot's topic, so un-@ follow-ups in it go through the participation decision as usual. Before deciding, the bot reads the topic's replies (50 per page, at most 4 pages) and stays out if another bot (other than the source bot and itself) has already posted there, if the topic runs past 4 pages, or if reading fails. Two bots deciding at almost the same moment may both answer; only one answering is not guaranteed.

**Team FAQ** (scenario pack `team-faq` in `plugins/team-faq`, installed separately). When a human in the group asks about a configured service or process, the bot uses the runbooks to decide whether to answer and, if it does, answers from them and cites the source; installation and parameters are in [the plugin README](plugins/team-faq/README.md). It works only at the `selective` and `eager` levels; messages that @ the bot or reply to it are handled as usual. A keyword match only hands the message to the participation decision model together with runbook excerpts; the model stays silent on discussion between colleagues, questions someone has already answered and questions the runbooks don't cover. If reading the runbooks times out or fails, or nothing was read while some files could not be read, the message is decided as if the pack were off, `/status` counts it as 「取材料失败」 (context failed), and "why no reply" gives the reason. `/status` shows the keywords, runbooks and today's answered, skipped and context-failed counts.

“Busy message triage” (`busyTriage`) is off by default in bot settings. Enable it there or with `dutydeck settings bot set <App ID> busyTriage=true`. When off, ordinary messages received during a turn keep queuing as before. When on, the host answers progress questions with the stage, latest step, elapsed time, queue size and pending approvals. Extra requirements are injected into the active turn when the ACP Agent supports steering; terminal Agents keep queuing them. Bot control requests use the same validation and permissions as `dutydeck agent`: reads reply immediately, changes require a confirmation card before execution. A short sentence identifies the interpretation. Card delivery failures, stop requests, uncertainty, errors and the 15-second timeout fall back to queuing without interrupting. Control phrases, slash commands, replies to pending cards, and bot or automation messages keep their existing routes.

Triage uses the group decision Agent/model (`decisionAgentId` / `decisionModel`), falling back to the memory Agent/model and then the default Agent/model. Choose a cheap, fast model in those decision settings. The classifier handles Agent view/control commands as well as requests such as “check CI every day at 9 am” and “use codex by default”. Schedule requests immediately receive an enable card while the draft stays disabled. Bot settings immediately receive an admin confirmation card and are not saved before approval. Both cards reply to the current message using its sender’s identity, without waiting in the task queue. Progress elapsed time is shown in seconds, minutes and seconds, or hours and minutes.

### 4. Bot setup

**Web (recommended)**: on the first screen click "Bind Lark Bot" (later "Manage Lark Bot"), choose "Add bot" in the dialog, then "One-click create Lark bot", enter a name and click "Create bot". It reuses the local Lark login (or asks for a QR scan), creates the app, configures scopes and events, publishes and stores the secret. Then pick the default Agent and workspace and enable listening.

**CLI**:
```bash
dutydeck lark create "Dev Assistant" --agent ccflash --listen          # default: ask
dutydeck lark create "Dev Assistant" --agent <terminal agent id> --full-trust --listen   # required if the agent can't do Lark approvals
printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxx --lark-app-secret-fd 0 --agent claude --yes
```

Agents that support Lark per-action approval: ACP agents (based on a successful ACP protocol handshake, independent of optional model enumeration metadata), and Claude Code / Seed / Relay in terminal mode (via a PermissionRequest hook). Other terminal CLIs can only run `full-trust`.

**Route Agents by weight.** In bot settings, enter positive “Agent 分流权重” values for participating Agents; leave a field blank to exclude it, or clear all fields to disable routing. For example, Codex 30 and ccflash 70 select Agents for new primary Lark sessions with roughly 30% / 70% probability; short runs need not match the ratio exactly. Existing sessions keep their Agent when weights change or routing is disabled. A fixed group Agent, `/new --agent`, or explicit model/effort takes priority. The bot's default model and effort apply only to its default Agent; other Agents use their own defaults. Memory and group decisions are unaffected. Every candidate must support the chosen approval mode, and enforced risk control checks and installs hooks for all candidates. The CLI edits the same setting:

```bash
dutydeck settings bot set cli_xxx 'defaultAgentWeights=[{"agentId":"codex","weight":30},{"agentId":"ccflash","weight":70}]'
dutydeck settings bot set cli_xxx 'defaultAgentWeights=[]' # Disable routing
```

**Fallback Agent.** Select “兜底 Agent” in bot defaults or the setup wizard, or use the CLI:

```bash
dutydeck settings bot set cli_xxx defaultAgentId=ccflash fallbackAgentId=codex
dutydeck settings bot set cli_xxx 'fallbackAgentId=' # Disable fallback
```

A request switches at most once when the primary cannot start, is signed out, has invalid credentials, or reports a recognized rate limit, exhausted quota, or unavailable upstream. Switching requires no answer, reasoning, tool call, or approval request in the current turn. Ordinary task failures, cancellation, permission denial, and unknown outcomes are never replayed. Other queued or running work prevents switching. The fallback uses its own default model and effort with the bot's approval and risk controls; enforced mode checks and installs its hook too. Cards explain the switch. A new session receives recent completed results as background; full native history does not transfer between Agents. Existing fallback sessions remain sticky, while new conversations try the primary again. Explicit `/new --agent`, model, or effort settings disable automatic fallback.

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

- **Navigation**: Workbench highlights decisions, recovery and active work; All tasks provides search and project filters without hiding the current task in the sidebar; Automation manages real task schedules. Warm light and dark themes share status meanings. The sidebar can be collapsed and resized.
- **Drafts**: task text, file / Skill references, send mode and plan-first selection are stored per instance and task in this browser and survive task switches, settings and refresh. If browser storage is unavailable, they remain in memory for the current page only. Failed sends retain the draft; a successful acknowledgment clears only the submitted revision, preserving edits made while sending. Messages are never automatically replayed. The new-task form also survives closing, including a created session whose first message failed to send; this creation draft lasts only for the current page and is cleared by refresh.
- **Task views**: Conversation, Changes, and Terminal for PTY connections only. The Results inspector contains changes, verification evidence, PRs and delivery records, with execution environment and task automation folded below. Turn completion, verification and PR status are separate facts.
- **Reading state**: reading position, follow-latest state, and activity / tool expansion choices are stored per instance and task in the current tab's `sessionStorage`, including across task switches, settings and refresh. Theme, sidebar layout, task tab and inspector preferences stay in this browser. None of these preferences or drafts sync across devices.
- **Settings scope**: personal interface, current task, bot / group, and instance access are labeled separately. Advanced model and reasoning settings stay collapsed during creation; Web tasks still default to an independent Git worktree, and full trust still needs explicit confirmation.
- **Shared Agent model settings drafts** require confirmation before switching settings sections, closing or navigating away; browser refresh and page exit prompt while edits remain unsaved. Canceling departure or a failed save preserves the inputs; leaving is disabled during saving. Drafts stay in page memory, and API keys are never written to browser storage.
- **Terminal connection status** distinguishes initialization, connecting and connected while waiting for output. Empty snapshots are valid. A handshake taking more than 10 seconds triggers automatic reconnection while retaining the received screen; read-only terminals never send input or remote resize requests.

- **Task board**: Awaiting action / In progress / Completed / Archived; queueing and interrupt. **Terminal playback exists only for terminal-mode (`pty-cli`) agents**, 5000 lines at most. The delivery panel lists per-turn changes. The current task title and summary use loaded execution records and are not overwritten by a lagging task-list refresh; a late send acknowledgment does not overwrite loaded completion results. Selecting the current task again preserves unsent input. Directory, Agent and other configuration controls, along with close and cancel controls, are disabled while task creation or scheduled-task preparation is submitting. Refreshing the Agent list keeps closing disabled. After creation fails, configuration can be changed before retrying; if the first instruction fails to send, retrying reuses the created session.
- **Read-only task details from Lark cards** show the source topic, group or private chat, and original initiator, with links back to known topics or chats. Unrecorded topics and missing historical origin records are marked explicitly; unavailable names fall back to known IDs.
- Interrupting a task cancels its pending questions, including requests still being validated, and rejects late answers. Idle sessions can still ask questions normally.
- **Native background tasks** show their count and lifecycle separately. When the main round has ended, the status says so while background tasks continue; late notices are not new answers.
- **Session streams** recover from silent stalls. A background tab releases its connection after 60 seconds; returning to the foreground reconnects and reconciles events, tasks and sessions. Observed buffered streams are exempt from silence detection. No new setting is needed.
- `/sessions/<session ID>?panel=workspace` opens the existing workspace panel, including archived sessions, through the usual login gate. Opening it does not preview or execute cleanup.
- **Automatic verification gate**: Lark tasks only, after a command is configured. Web manual verification is available from the Results inspector. Result states: passed, failed, expired, not verified.
- **View changes on the phone**: the result-card link is valid for 14 days and shows only that turn. Only turns in a git repo run through the runtime are recorded. When a regular file and a symlink are swapped, the diff remains associated with the correct file. With too many un-ignored untracked files (over 20 MiB each, 50 MiB total, or 2000 files) no diff is recorded and the log says why, so add large files and build dirs to `.gitignore`. Line comments: signed-in Web users send them straight to the agent; people with only the share link create a confirmation card in the Lark topic, and someone with permission must tap "Hand to agent". Comment drafts added or edited during submission are kept. `dutydeck auth share-key rotate` invalidates all issued links.
- **Session insight analyzer**: built into the npm package and built automatically with the server. It runs locally in an isolated child process using Dutydeck's current Node.js runtime; no Go compiler, external analyzer binary, or separate engine build is required. Source development uses the workspace's `tsx` loader. Metrics now use version `v2`: old snapshots remain readable, and different metric versions are excluded from shared deltas and group totals; reanalyze to align versions. A native user input for Codex is counted only once; inherited history from forks is excluded from independent session totals; and amounts and timestamps for priced entries are preserved in insights and exports. Refreshing generates a corrected snapshot while existing snapshots remain unchanged. Insight refresh does not change task usage or billing records.
- **Usage and cost**: tabs "Cost", "Detail", "Session insight". Monthly USD caps per bot or group (`dutydeck settings usage set-cap <usd> --app <appId> [--chat <chatId>]`). The built-in price table covers OpenAI and Claude models (longest-prefix match; unmatched models are "unpriced"); override it entirely with `DUTYDECK_USAGE_PRICING_JSON`. Terminal-mode Claude usage is estimated from the transcript (subagent usage from `<session>/subagents/`); Codex and Traex terminal modes report none. "Partial usage unknown, caps may be inaccurate" appears on the cap card, in rejection notes and in alerts when a turn's usage cannot be read (unreadable subagent files, a turn recovered after a daemon restart, unpriced models). Not included: US-only inference 1.1x, fast mode, Batch, 1-hour cache writes, Haiku 5.5 tiers. These are estimates, not a bill. APIs: `GET /api/usage/report`, `GET /api/usage/tasks` (params `from`, `to`, `model`, `agentId`, `appId`, `origin`; tasks also `limit`, `offset`; dates in daemon local time; installation admin only).
- **Experimental features**: the "Groups & permissions" draft page, the import drafts in scheduled tasks and the "migration & advanced drafts" in settings only store drafts and do nothing at runtime, so they are hidden. Turn on Settings → Experimental → "Show experimental features" (stored in this browser only).


**Scheduled Agent tasks.** In Web → Automation, choose New scheduled task, an Agent, workspace and permissions. Saving creates an idle session without sending the prompt; enable the saved schedule to start automatic execution. The list shows its source task, rule, timezone, next run and latest result, with an explicit bounded task-page range rather than an instance-wide aggregate. Before enabling, review the full instruction, directory, rule and actual saved delivery destination: the owning Web task, or the Lark bot, chat and reply message / topic ID. Choose Confirm enable to submit. Older instances that omit this destination, or destinations that cannot be verified, cannot be confirmed. Disabling retains the plan and history; running tasks continue. Existing tasks can add schedules under Results inspector → Task automation and keep their directory, model, permissions and context. Supports once, daily, weekly, intervals and five-field cron in an IANA timezone. The runtime checks once per minute, catches up at most once after downtime, and keeps one unfinished execution per schedule, including results awaiting reconciliation.

For the cron day-of-month and day-of-week fields, if either starts with `*` (including `*/n`), both must match; otherwise either may match. For example, `0 9 */2 * 1` runs at 09:00 only on Mondays that fall on an odd day of the month. One-time schedules reject invalid calendar dates or times, such as February 30. Historical invalid schedules remain readable and editable but are disabled until corrected and enabled again.

```bash
# New idle session; shared workspace by default, or --workspace worktree
dutydeck schedule create --agent codex --cwd /path/to/project --name Daily --prompt 'Review changes and summarize' --cron '0 9 * * 1-5' --timezone UTC
# Existing session: --session ses_xxx --every 30 (minutes), or --at 2026-12-01T09:00
dutydeck schedule list
dutydeck schedule show schedule_xxx --session ses_xxx
dutydeck schedule enable schedule_xxx --session ses_xxx
dutydeck schedule update schedule_xxx --session ses_xxx --prompt 'Review builds and summarize'
dutydeck schedule disable schedule_xxx --session ses_xxx
dutydeck schedule run schedule_xxx --session ses_xxx --idempotency-key daily-check-1
dutydeck schedule history schedule_xxx --session ses_xxx
dutydeck schedule delete schedule_xxx --session ses_xxx
```

Run now also works while paused. It bypasses the clock, keeps conditions and permissions, and leaves the next scheduled time unchanged. Reuse `--idempotency-key` when retrying a manual request: the same key returns the original execution. Deletion prevents future triggers and invalidates work not yet submitted; submitted tasks finish, and their history/results remain available. `history` returns the latest 1000 occurrences of that plan, newest first; specify `--session` for deleted plan history. `show --session` reads its retained definition. CLI output is JSON. Use `--input '<JSON>'` or `--file plan.json` for complete create input or an update patch (including `condition` and `dstPolicy`), and `--expected-revision` to reject concurrent edits. Runtime targeting with `--instance`, `--url` and `--database` follows `dutydeck settings`. If saving fails or its response is lost after a new session is created, the CLI reports its ID. Inspect `list --session <id>` first, then retry with that `--session` only if the schedule is absent.

Scheduled tasks keep the selected permission posture; `ask` can wait for human approval, so choose permissions explicitly for unattended work. Each runtime database owns its schedules and execution history and permits one runtime executor. Switch instances to reach the Web or bot runtime that owns the task.

After reaching the user's stopping condition, a recurring task can request disabling its own schedule with `dutydeck agent --turn "$TURN" schedule stop-self`. No schedule ID is accepted. Only the active host-triggered scheduled occurrence qualifies; manual runs and one-off schedules cannot use it. The host waits for successful execution and confirmed result delivery, then rechecks the original actor and that the schedule is still the same version before disabling it and retaining history. Failure, unknown delivery, revoked permission or a user edit prevents self-disabling.

---

## Agent Configuration & Permissions <a id="agent-config"></a>

The built-in Codex ACP agent gives an explicit `CODEX_PATH` priority for discovery, version detection and launch, including executables outside `PATH`. Without that override, each new execution process resolves Codex from the Dutydeck process `PATH`, using the user's login and configuration. New processes use user-installed upgrades automatically. If the user-installed or explicitly configured Codex is missing, startup fails instead of using the ACP adapter's cached version.

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

`timeout` is in seconds (default `600`) and must convert to an integer from 1 to 2147483647 milliseconds (`0.001`–`2147483.647` seconds). Fallback CLI model discovery uses the Agent's configured direct CLI executable, cleaned child `env` and `cwd`, passing only supported global options (with separate option/value arguments). Other launch arguments, equals forms, or wrapper commands skip fallback discovery and retain the configured default model without substituting a host command.

#### Terminal task status and recovery

Once Claude Code logs show support for a full-turn completion marker (`turn_duration`), split answers wait for that marker, retaining later text, Stop-hook continuation and late errors from the same turn. Older formats without the marker retain their compatibility completion path.

When Codex switches log files within the same native session, Dutydeck verifies ownership, drains complete records from the old file and continues from the new one. Copied history is not delivered again, and files belonging to another session are rejected.

Codex and TraeX native recovery uses only records confirmed to belong to the current session. If inherited context cannot establish ownership, recovery is refused to avoid resuming another session. After an idle Codex session is released, the next turn resumes its verified native context.

Codex and TraeX terminal tasks settle from success, failure or cancellation events bound to the current native turn. A partial answer does not override a later failure; cancellation is recorded as an interruption. A recovering Codex turn without text output still ends with the confirmed cancellation or error when the corresponding input is verified. TraeX reads session metadata containing large model catalogs so final answers arrive and tasks complete. Recovery drains the old log segment before reading the next segment for the same session. New canonical records retain progress, input receipts and final answers while deduplicating mirrored records.

TraeX uses the full terminal viewport to distinguish busy and ready states, including layouts with keyboard controls on a separate footer row; status text quoted in output or drafts is not treated as an active footer. Codex accepts `›` / `»` input prompts without treating trust or update menus as ready. Ordinary Cursor input sends one Enter, preserving multiline input and normal task queueing without a second empty-input control action. Empty input prompts for Claude Code, Seed, and Relay are recognized as idle so recovery operations for unconfirmed tasks can proceed. Up to two custom `statusLine` rows between the empty composer and permission mode footer are supported, including the first message after resuming a session.

When a direct child explicitly started by the current Codex parent turn reports quota exhaustion or rate limiting, Web and Lark progress records show a fixed diagnostic without the upstream error body. The parent continues; Dutydeck does not automatically retry or switch accounts because of this diagnostic. Observation is bounded and best effort; children started before recovery are not reported retroactively. This diagnostic is not enabled for TraeX.

Claude background Agent, Bash and Monitor tasks are counted by native task ID. The main turn may complete after an explicit answer when the CLI is no longer waiting for a child result; background tasks continue. Legacy pending counters and an explicit Waiting screen retain wait-and-merge behavior. Late notices keep their original input identity instead of becoming the next turn's answer. Restart rebuilds background state; non-persistent Monitors expire at the CLI deadline, and `/clear` only reconciles stop notices for known tasks. Successful Write/Edit operations in the known project memory directory preserve the same-turn answer and postscript in the final result; business files and Bash commands do not trigger this rule.

An exact Codex model-capacity failure without a business tool or permission call can retry automatically at most twice, after 30 and 90 seconds, each with a separate recorded execution attempt. Stop and new input cancel unsubmitted retries. Each submission rechecks the original requester's current permissions; restart retains deadlines and cancellation state. Unknown submission or completion is never automatically replayed. HTTP 429, quota, authentication and generic server errors are excluded. Multi-step work waits for this verified automatic retry chain and advances after success; unrelated manual reruns are not adopted as its result.

For a recognized Codex model-migration menu, Dutydeck selects only “Use existing model” and waits for the composer again. An unclear highlighted row or menu remains for manual handling. Terminal capture sockets support long and non-ASCII temporary-directory paths.

### 2. Permission modes

Lark bots can use `ask`, `approve-reads` and `full-trust`. `deny-all` is not available for Lark bots.

| Mode | Behavior |
|---|---|
| `ask` | Writes and commands wait for approval. **Default for new bots** when the chosen Agent supports Lark approval |
| `approve-reads` | Reads and searches pass; writes and commands need approval; network access is not a read. ACP and Claude terminal mode |
| `deny-all` | Rejects every privileged action; not for Lark bots |
| `full-trust` | No confirmation. The only option when the Agent cannot do Lark approval; needs an explicit confirmation |

`lark create` defaults to `ask` and refuses unsupported Agents without `--full-trust`; the Web wizard defaults to `ask` when the Agent supports approval, else `full-trust`.

Lark email admission and identity lookups cache confirmed invalid, cross-app or invisible-user failures for up to 60 seconds per client, so a permission repair may take that long to be retried. Bot configuration refreshes or credential changes clear the cache. Successful identities, rate limits, server errors, network errors and timeouts are not cached; subsequent lookups still check for revoked access.

### 3. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | Listen address |
| `DUTYDECK_PORT` | `4310` | Web/API port |
| `DUTYDECK_AUTH` | `true` | Require authentication for non-local access (`false` disables; on a non-loopback address the server refuses to start unless `--unsafe-no-auth`) |
| `DUTYDECK_DEFAULT_CWD` | start dir | Default workspace |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | SQLite file |
| `DUTYDECK_AGENTS_JSON` | `[]` | Custom agents |
| `DUTYDECK_CLEANUP_INTERVAL_MS` | `300000` | Cleanup interval: integer milliseconds from 1 to 2147483647 |
| `DUTYDECK_DRIVER_IDLE_TIMEOUT_MS` | `21600000` | Nonnegative idle-terminal release threshold in milliseconds; `0` disables it; the periodic timer's 32-bit limit does not apply |
| `DUTYDECK_USAGE_PRICING_JSON` | built-in table | Override usage prices |
| `DUTYDECK_DEPLOY_WINDOW` | any time | Allowed `dutydeck deploy` windows, e.g. `10:00-11:00,16:00-17:00` (Asia/Shanghai) |
| `LARK_APP_ID`, `LARK_APP_SECRET` | - | Fallback for `dutydeck lark send`-style commands only. Bots configured by `dutydeck setup` keep the secret in the bot configuration |

CI tokens and webhook secrets are **no longer environment variables**; see Plugins.

---

## Plugins <a id="plugins"></a>

A plugin adds commands, agents, skills, external triggers, hooks, CI providers, controlled result tools and scenario packs. The core has no platform-specific code; GitHub and Codebase CI support and alert triage are plugins.

```text
my-plugin/
├── .dutydeck-plugin/plugin.json   manifest (required, strictly validated)
├── commands/*.md                  slash commands ($ARGUMENTS template)
├── agents/*.json                  agent definitions (same shape as one DUTYDECK_AGENTS_JSON entry)
├── skills/                        skills directory
├── triggers/<id>.json             external triggers
├── hooks/hooks.json               hooks
├── scenarios/*.json               scenario packs
└── index.mjs                      providers entry (CI providers, scenario pack providers, in-process hooks)
```

`plugin.json` fields: `name` (kebab-case, ≤ 64), `version`, `description`, `commands` / `agents` / `skills` / `triggers` (directories), `hooks` (file), `providers` (ESM entry, no default), `scenarios` (directory, default `scenarios/`), `userConfig` (`{ <snake_case key>: { description, sensitive? } }`). Paths must stay inside the plugin. Provider module loading and registration share a 15-second deadline; a timeout skips that plugin and ignores later registrations.

**Trust.** `agents`, `hooks:<event>` and `providers` execute code or commands and must be confirmed at install (non-interactive installs need `--yes`). The daemon loads only enabled plugins whose required capabilities are all confirmed. `plugin update` re-confirms only newly added capabilities. npm sources are packed with `--ignore-scripts`.

**Scopes** (`--scope`): `global` (default), `bot:<appId>` (only that bot's sessions; not effective in Web sessions, which have no bot), `workspace:<absolute path>` (sessions whose cwd is under it). Triggers check this scope too: the bot workspace before starting a new session, or the actual cwd of a reused session. Both the scope root and target directory are resolved through symlinks and compared by real path; aliases pointing inside the scope are allowed. A missing, unresolvable or out-of-scope directory prevents session creation and dispatch. Agents are always merged globally.

**Built-in plugins** <a id="builtin-plugins"></a>. Plugins shipped with Dutydeck live in `builtin-plugins/` (`dist/builtin-plugins` once packaged) and load before installed plugins. There is one today: `alarm`, which provides alert triage and same-alert-rule correlation (group usage is under Group participation). Built-in plugins need no trust confirmation, are always enabled with `global` scope, cannot be uninstalled, and show as 「内置」 (built-in) in `plugin list`. An external plugin with the same name is refused at install, and one already installed is not loaded (`plugin list` and `doctor` say so). A scenario pack in an external plugin that reuses a built-in pack id is skipped; the rest of that plugin still loads.

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

`plugin validate` also checks scenario packs (format, template variables, regexes, parameters) and reports file and field; `install` and `update` do not fail on scenario pack problems but list the packs that will not load and why.

Sources: a local directory, `git+https://…`, `git@…`, `file://…` (`#ref` pins a branch, tag or commit; git sources are pinned by SHA), or `npm:name@version`. Changes take effect after `dutydeck restart`. When multiple processes modify different plugins concurrently, each successful change is preserved. Each `plugin update` from a local directory copies it again and reports an update with a restart reminder, even if its version is unchanged. Data lives under `plugins/` next to the database (`plugins.lock.json`, installed copies, `.data/<name>/`, 0600 `.trigger-tokens.json` and `.config.json`).

### Controlled plugin results

A trusted `providers` plugin registers exports through `api.registerResultTool({ name, description, inputSchema, execute })`. `inputSchema.parse(input)` validates arguments; `execute(input, { invocationId, requester, signal })` returns `Promise<{ files: Array<{ name: string, data: Uint8Array }> }>`. Tools return names and bytes without filesystem paths, recipients or a model-visible body. The host stores bytes and sends a fixed viewing notice. The model receives only `deliveryId`, `status` and `fileCount`; `delivered` confirms the notice, not a download or overall task completion.

The opt-in [private-export example](examples/plugins/private-export/README.md) uses `.dutydeck-plugin/plugin.json`, with `providers` pointing to `providers.mjs`. Install from a source checkout; the private endpoint `<source_url>/<reportId>` supplies report bytes:

```bash
dutydeck plugin install ./examples/plugins/private-export
# Supply the private source URL on stdin; report bodies stay out of Agent arguments
dutydeck plugin config private-export source_url --value-fd 0
dutydeck restart
```

Set the bot's existing `webBaseUrl` to the HTTPS Web instance sharing its database, for example `dutydeck settings bot set cli_xxx webBaseUrl=https://dutydeck.example`. Enable web login in the **same Feishu/Lark application** and allow exactly `<webBaseUrl>/api/plugin-results/oauth/callback` as an OAuth redirect. The callback comes from saved configuration, not the request Host. No settings key or panel is added. See the [official web-login setup](https://open.feishu.cn/solutions/detail/qrcode?lang=zh-CN); user `open_id` is [scoped to each application](https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction).

Within an active human Lark request, use the current prompt's mandatory turn (`$TURN` represents that value):

```bash
dutydeck plugin-tool list --turn "$TURN"
dutydeck plugin-tool call private-export/export-report --json '{"reportId":"weekly"}' --call-id weekly-export-1 --turn "$TURN"
```

Retries keep the same call ID and arguments. Missing or stale turns and the same ID with different arguments are rejected. Scheduled, automated, bot-originated, Web installation-admin and unverified-human requests cannot export.

The original requester must sign in through the original bot application to open the receipt. A separate browser session lasts 30 minutes. Installation tokens, ordinary Web login, share tokens and Agent capabilities grant no download access; forwarding the URL does not authorize another person. Every download rechecks the original task and actor's current permissions. Confirmed revocation, cancellation or interruption denies access and deletes result bytes. Unresolved task state stays pending until reconciliation or expiry; unknown execution is not repeated.

Fixed limits: 8 files/call, 10 MiB/file, 32 MiB/call; 128 MiB of unexpired results/requester and 1 GiB globally; 1 concurrent execution/requester and 4 globally; 60-second execution timeout with late output discarded. Results become unavailable after 24 hours; cleanup deletes bytes but retains small idempotency records. Expired calls are not rerun automatically. Files always download as `application/octet-stream` attachments, never inline HTML/SVG.

Notices use the original task location, the same provider UUID and durable confirmed receipts. Unconfirmed sends retry only within one hour of the first attempt, then remain unknown without resending. Notice failure never reruns the plugin. OAuth requests only the application's login identity, without `offline_access` or business-resource scopes. Access tokens are used briefly in the backend for `user_info`, never persisted or refreshed.

These guarantees cover the controlled host API path. Trusted plugins run as in-process JavaScript; this cannot prevent a malicious trusted plugin printing secrets or another process with the same OS UID reading host files. Instances with separate databases must use the Web address holding the result; there is no cross-instance proxy. Real Feishu OAuth/redirect configuration and production connectivity are **unverified** by this isolated validation and require operator setup and verification.

### External triggers

`POST /api/plugins/<plugin>/triggers/<id>`, no Web login, authenticated by the trigger's own `token` header or `hmac-sha256` of the raw body. Responses: `202 {sessionId, taskId}`, `200 {duplicate:true}`, `400` not JSON, `401` bad token/signature, `404` unknown trigger or disabled plugin, `413` body over 1 MiB, `429` over `maxConcurrent` (default 4, 1 to 32), `502` delivery failed (the dedupe record is revoked, so retry). Dedupe lasts 24 hours and survives restarts. Template values in the prompt are wrapped as untrusted data; templates cannot read auth headers, `authorization` or `cookie`. See `examples/plugins/hello`:

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

**Hooks.** Each hook has `command` (string via `/bin/sh -c`, or an argv array; cwd is the plugin root), required `timeout` (100 to 600000 ms), `onFailure` (`ignore` default, or `block`) and optional `matcher` regex. stdin gets `{ event, plugin, botAppId?, chatId?, sessionId?, taskId?, cwd?, payload }`. Exit 0 allows (stdout may be JSON with `decision` allow/deny/ask, `reason`, `additionalContext`, `updatedPrompt`); exit 2 blocks with stderr as the reason; other non-zero exits or timeouts are non-blocking errors (blocking with `onFailure: block`). The process group is killed on timeout. Hook processes inherit the daemon's whole environment (which may contain the Lark App Secret and tokens) plus `DUTYDECK_PLUGIN_NAME`, `DUTYDECK_PLUGIN_ROOT`, `DUTYDECK_PLUGIN_DATA`, `DUTYDECK_PLUGIN_CONFIG_<KEY>`, `DUTYDECK_HOOK_EVENT`. Events: `task.received` (deny rejects the task), `task.beforeRun` (deny, `additionalContext`, `updatedPrompt`), `permission.request` (allow/deny decide instead of a human), `task.completed`, `verification.completed`, `notify` (deny suppresses CI notices and trigger results). Group collaboration's decision, response-generation and memory sessions also pass through `task.received` and `task.beforeRun` with their bot's `botAppId`, so `bot:<appId>` hooks apply to them (memory sessions carry no `chatId`); for these sessions `task.beforeRun` honours only `deny`, and `additionalContext` / `updatedPrompt` are ignored with a warning in the log; `permission.request` also honours only `deny`, and an `allow` (from a plugin of any scope) is ignored with a warning, leaving the request to the normal approval flow. When these sessions settle, `task.completed` (and `verification.completed` where applicable) also carry `botAppId` and reach `bot:<appId>` hooks; tell them apart by `payload.source` (`lark-decision`, `lark-response`, `lark-memory`).

**CI providers.** `/ci`, auto follow-up, Web "wait for CI", the scheduled-task condition and `POST /api/hooks/<provider id>` all go through CI provider plugins. With none installed, Lark `/ci` says it is not configured and the Web shows "no CI plugin installed". A provider registers via `api.registerCiProvider` with `id`, `displayName`, `matchRepository`, `getPipelineStatus`, `getFailureLogs`, optional PR methods used by `/pr` (`createPullRequest`, `listReviewComments`, `postComment`, and `getPullRequest(repository, number)` returning `{ state: 'open'|'closed'|'merged', headSha? }`, which is how a merged or closed PR is noticed; without it only the webhook's merge_request event can stop follow-up, otherwise polling continues until the round limit or a manual stop) and an optional `webhook: { verify, parse }` (see `packages/shared/src/plugins.ts`). Each `CiReviewComment` returned by `listReviewComments` carries `trusted`, `isBot` and `authorAssociation`; **comments without `trusted: true` are never handled automatically**, they only produce a "needs your decision" card. The github plugin sets `trusted` when `author_association` is OWNER, MEMBER or COLLABORATOR and the author is not a Bot. The `id` returned by `postComment` must use the same format as the ids from `listReviewComments`, otherwise Dutydeck's own reply is treated as a new comment. Bundled (install from a source checkout; the npm package does not include them):

- `plugins/github`: Actions status and failure logs, PR create/state/comments (used by `/pr`), optional webhook `POST /api/hooks/github`. Config: `github.token` (optional for waiting on public repos; required to open PRs and post comments, with pull-requests read/write permission, plus Actions read for private repos), `github.webhook_secret` (optional; enables the webhook). Pushing uses your local git credentials, not this token.
- `plugins/codebase`: pipeline/MR webhook `POST /api/hooks/codebase`. Config: `codebase.webhook_secret`.

```bash
dutydeck plugin install ./plugins/github --yes
printf %s "$TOKEN" | dutydeck plugin config github token --value-fd 0
dutydeck restart
```

The scheduled-task condition is `ci_new_failure` (the old `github_new_failure` still reads and works). `GET /api/sessions/:id/automation/ci-providers` lists loaded providers. Auto-fix limits: 3 rounds per incident, stop when the same error fingerprint appears twice, commit SHA checked before pushing, no merge or force-push.

**Writing a scenario pack** <a id="scenario-packs"></a>. A scenario pack tells the bot how to handle one kind of group message, for example starting a triage task when a source bot posts an alert. Each pack is one JSON file in the plugin's `scenarios/` directory; `packages/shared/src/scenarios.ts` is the authoritative schema. Examples: `builtin-plugins/alarm` (`direct` mode with a correlation provider) and `plugins/team-faq` (`model` mode with a context provider). A pack declares parameters (`integer`, `string_list`, `bot_list`; confirmed when enabled in the group and editable on the Web), the trigger, the execution instruction, the phrases and confirmation-card text for turning it on and off in the group, a `/status` line, "why no reply" explanations and Web text. Pack ids are kebab-case, at most 32 characters. A pack `version` is semver: within the same major version, existing group bindings keep working and parameters the pack adds take the pack defaults; when the major version changes, existing bindings must be confirmed again in the group, and enable confirmation cards sent before the upgrade no longer work, so say it again.

- `direct` mode is triggered only by bot messages. A match skips the decision model; dedupe and the hourly cap decide whether to start a task, which runs in the name of the person who confirmed in the group, through the same path as an @ to the bot. The contract is enforced, and leaving something out only gets you the default, never "unlimited": only the source bots listed in the `bot_list` parameter named by `trigger.sourceBotsParam` (with `role: "source"`), never the bot itself (other `role: "source"` parameters only keep those bots from counting as bots that answer, and never trigger); a requester is required (enabling only happens through the in-group confirmation card; the Web can only edit a confirmed binding), so a `direct` pack must declare `phrases` with non-empty `enable` and `disable` or it fails validation; `trigger.filter.keywordsAnyParam` names a `string_list` parameter, and a message whose text contains none of its keywords is recorded as filtered and starts nothing (an empty list filters nothing); `trigger.filter` is `direct`-only, a `model` pack that declares it fails validation, and `model` packs select messages with `trigger.match`; `dedupe` is either the core `source_text_v1` (source plus text with links, numbers, long hex strings and whitespace removed, so changing times, values and instance ids still count as the same alert) or the pack's own provider, with a 1–168 hour dedupe window parameter and a 1–30 hourly cap parameter; in multi-bot groups only the responder acts; every outcome (started, filtered, duplicate, over the cap, not the responder, no requester, abstained on error) is recorded so "why no reply" can find it.
- `model` mode is triggered by human messages, only at the `selective` and `eager` levels; messages that @ the bot or reply to it don't go through packs. A match goes to the participation decision model with the pack's guidance and context. The guidance is part of the decision prompt and the provider's `context` is attached as untrusted material, at most `decisionChars` characters; when the decision is to answer, the reply or task gets the same context (at most `maxChars` characters) and `execution.instruction`, without calling the provider again. A matched pack counts as the bot's scope, so a `selective` bot without a scope that is not the responder can still answer such messages; the other side is that matched messages are judged by scope too, so the `eager` "answer by default" and the single-human-group default no longer apply to them directly, and role scope and scenario eligibility are evaluated independently: either can qualify the message. A scenario abstaining does not cancel eligibility from the role scope or a message clearly addressing the bot. With Team FAQ as the only basis, a keyword match without runbook coverage still goes unanswered; the guidance only says when to answer and cannot loosen the core rules. When several `model` packs match one message, only the first by pack id is used. Before replying or starting the task, the bot checks again that the pack is still on in the group and sends nothing if it was turned off. Enabling needs no requester, so it can be done directly from the Web or with `scenarios=`; the in-group phrases post a confirmation card with no parameters to fill in.

A pack may declare `topicOwnership: { "sourceTopics": "neutral" }` (used by `alarm`): in multi-bot groups a topic opened under a message from a source bot does not count as another bot's topic; the bot stays out only when another bot has already posted there or the topic cannot be read in full. This does not guarantee that only one bot answers.

Providers are registered in `register(api)` with `api.registerScenarioProvider(provider)`: `match` (extra matching or a dedupe key), `correlationKey` (the key for finding an earlier turn) and `context` (context for `model` mode). They are plugin code and are confirmed together with `providers`. Every call has a deadline (`match` 500 ms, 1 s in total for one correlation round, `context` 5 s by default and at most 15 s); late results are discarded. A pack whose provider is not registered is skipped.

Regexes in triggers and phrases allow only the `i`, `m`, `s`, `u` flags (the host adds `g` for capture-all) and at most 1000 characters of source. They run in an isolated host thread with a 200 ms limit per run, on at most the first 4000 characters of input. `validate` only warns about patterns that may backtrack catastrophically; safety comes from isolation and the timeout.

Text fields accept `{variable}` and one level of conditionals `{variable?when set:when empty}`, and each position allows a fixed set of variables: `execution.instruction` and `execution.intro` take `{source}` (the source bot's name; a `model` instruction takes none); `correlation.prompt` takes `{date}`; `correlation.cardLine` takes `{date}`, `{headline}`, `{url}`; `confirm.enableSummary`, `disableSummary` and `enabledResult` take `{summary}` and the parameters; `status.summary` takes the parameters; `explain.*` takes `{time}`, `{reason}`, `{snippet}`; `web.description` takes `{requesterId}` and the parameters. Titles, nouns, decision guidance, parameter labels and `reasons` are literal text. Message text and model output never go into an instruction position: the source message and the earlier conclusion follow the instruction as untrusted material, and the source bot's name has line breaks and bracket characters removed before it is inserted.

On errors a pack abstains rather than guessing. A pack that fails validation is skipped while the rest of the plugin loads, and `plugin list` and `doctor` show why; a pack whose provider is missing or whose id clashes is also skipped, with the reason in the daemon log. A regex or provider error or timeout at run time makes that pack abstain for that message; `direct` records an abstained outcome and starts nothing. For `model`, when the context provider times out, fails, returns a malformed result, or returns no material while `missing` is not empty, the message is decided again as if the pack were not there; the decision record keeps the reason, `/status` counts it as context failed, and "why no reply" explains it. When one message matches several `direct` packs, only the first by pack id is handled.

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
dutydeck settings bot set cli_xxx groupReplyMode=auto
dutydeck settings group set oc_xxx participation=selective
dutydeck settings group set oc_xxx 'scenarios={"alarm":{"enabled":true,"params":{"levels":["P0","P1"]}}}'
#   params lists only the keys to change; {"<pack id>":null} removes a binding; `group show` lists packs and params.
#   A direct pack must be confirmed in the group once first. alarm=<JSON> is a deprecated alias kept for one release.
dutydeck settings usage set-cap 50 --app cli_xxx       # monthly USD cap
dutydeck settings terminal-backend [tmux|herdr]

# Access
dutydeck auth password set [--generate]   # browser login password
dutydeck auth token [--rotate]            # token for CLI/scripts/API
dutydeck auth share-key rotate
```

`restart` first holds queued work. Successfully submitted `full-trust` tmux turns with verified recovery logs and original turn identity keep running in the same CLI process; the new service adopts the original turn without resending input. Other running tasks still drain, including ACP, plain PTY, Herdr, submissions in progress, missing recovery evidence, pending approvals and unauthorized high-risk gates. With systemd, preservation requires the current `KillMode=process`; other or unknown values use a full drain. Older services without recovery counts, failed drain requests and failed lease renewals also use a full drain. `--drain-timeout`, `--force` and automatic exclusion of the invoking Agent session retain their existing behavior. `deploy` continues to drain all running tasks.

The `codex` entry keeps ACP as its default. Select the separate `codex-cli` (Codex terminal) entry for terminal mode, for example with `dutydeck settings bot set <appId> defaultAgentId=codex-cli`, then start a new session. This changes neither existing sessions nor permissions. Only tmux tasks already authorized for `full-trust` and backed by complete recovery evidence can continue across a service restart. A first submission without a known transcript path still drains.

`GET /api/system/activity` keeps `runningTasks` as the total running count. Add `?restart=true` to verify recovery evidence and receive `restartBlockers` and `recoverableTasks`; no tasks are deducted unless queue claiming is held. `excludeSessionId` applies to all three counts.

Use `channel-bot` for the draft bots shown in the experimental “Groups & permissions” page. Its argument is the internal `id` returned by `list`, not the Lark App ID:

```bash
dutydeck settings channel-bot list
dutydeck settings channel-bot show <id>
dutydeck settings channel-bot set <id> credentialRef=<secret-ref-id> --expected-revision 3
dutydeck settings channel-bot set <id> credentialRef=null
```

Editable keys: `externalAppId`, `displayName`, `brand=feishu|lark`, `credentialRef`, and `state=staged|disabled`. Omitted keys keep their values; `credentialRef=null` clears the reference. Without `--expected-revision`, the command uses the revision just read; conflicting edits are rejected. Only draft metadata changes and listening remains disabled; use `settings bot` for bots already managed by the runtime. The same `--instance`, `--url`, and `--database` targeting options apply. Credential values are never returned.

Offline foundation group policy drafts in the experimental “Groups & permissions” page are managed with `group-binding`, following the same draft addressing, runtime protection, and optimistic concurrency (CAS) rules as `channel-bot`:

```bash
dutydeck settings group-binding list [--bot <internal-bot-id>]
dutydeck settings group-binding show <binding-id>
dutydeck settings group-binding add <binding-id> --bot <internal-bot-id> --chat <external-chat-id> [key=value...]
dutydeck settings group-binding set <binding-id> <key=value...> [--expected-revision N]
```

`add` creates a staged draft binding (initial `state=staged`; the `state` key cannot be passed on `add`), requiring the internal Channel Bot ID (`--bot`) and external chat ID (`--chat`), and never overwrites an existing binding. Policy override fields align with the GroupBinding API and UI, including `routingOverride`, `groupToolsOverride`, `rolePolicyOverride`, `reviewReasons`, `oncall`, and others; `set` can update these fields and supports setting `state=staged|disabled|needs_review|archived` (never `active`). Omitted keys retain their existing values; without `--expected-revision`, the command defaults to the revision just read and rejects conflicting concurrent edits. These commands manage offline experimental drafts only and do not activate runtime policies or apply migrations; live bots continue to be managed via `dutydeck settings group`.

Examples:
```bash
# Create a staged offline policy draft with oncall enabled
dutydeck settings group-binding add draft-group --bot draft-bot --chat oc_example oncall=true

# Update routing and group tools overrides using CAS revision checking
dutydeck settings group-binding set draft-group 'routingOverride={"groupReplyMode":{"mode":"set","value":"chat-topic"},"mentionPolicy":{"mode":"set","value":"topic"}}' 'groupToolsOverride={"read":"deny","discover":"deny","send":"deny"}' --expected-revision 1
```

Automatic bot welcomes are enabled by default. Set `welcomeEnabled=false` to suppress group-join and first-DM welcomes immediately after saving; user message handling continues. For group replies only when mentioned, also set `mentionPolicy=always` and `defaultGroupParticipation=off`.

```bash
dutydeck settings bot set cli_xxx welcomeEnabled=false
```

Lark applications can register multiple HTTP event handlers. Matching handlers run sequentially in array order. Supported events are card clicks (`card.action.trigger`) and incoming messages (`im.message.receive_v1`):

```bash
dutydeck settings bot set cli_xxx 'eventHandlers=[{"id":"observer","eventTypes":["card.action.trigger"],"url":"https://receiver.example/events","token":"<observer-token>"},{"id":"buttons","eventTypes":["card.action.trigger"],"owner":"sample-service","legacyActions":["ack"],"url":"http://127.0.0.1:14432/events","token":"<receiver-token>"}]'
dutydeck settings bot set cli_xxx 'eventHandlers=[{"id":"messages","eventTypes":["im.message.receive_v1"],"url":"https://receiver.example/messages","token":"<receiver-token>"}]'
dutydeck settings bot set cli_xxx eventHandlers=null  # disable; [] also clears the list
```

Each entry requires a unique, stable `id` (1–64 letters, digits, dots, underscores or hyphens), nonempty `eventTypes`, `url`, and `token`. Optional card `owner` matches `action.value.owner`; `legacyActions` matches only ownerless old cards and cannot contain built-in Dutydeck actions. Without either filter, an entry matches all external cards. Message handlers receive every message event delivered by the application's subscriptions, before chat allowlists or group access checks; receivers authorize their own business actions. Any entry containing the message event type must omit card filters. An entry without filters may list both event types.

Dutydeck sends a `POST` with `Authorization: Bearer <token>` and `Content-Type: application/json`:

```json
{"version":1,"app_id":"<trusted connection App ID>","handler_id":"buttons","event_type":"card.action.trigger","event":{"event_id":"<platform event ID>","operator":{},"context":{},"action":{}}}
```

`event` preserves the complete SDK event, including event_id, operator, context, action, token, and message content; the example shows only selected fields. Card callbacks first normalize flat or `{event,header}` envelopes, object or JSON-string action values, and behavior values when explicit value is absent. Form results appear in `action.value.form_value`. Operator and chat/message identity come only from event fields, never similarly named fields inside value. Top-level `app_id` comes from the trusted connection configuration, and `handler_id` comes from the registration. Receivers return HTTP 200 or 202 with the same `event_id` and an explicit `decision`:

```json
{"event_id":"<same event ID>","decision":"continue"}
{"event_id":"<same event ID>","decision":"stop","toast":{"type":"success","content":"Accepted."}}
```

Only `continue` invokes the next matching handler. When all handlers continue, Dutydeck runs its existing built-in handling and authorization. `stop` ends propagation immediately, also suppressing message welcome cards. HTTP 202 means the propagation decision is established, not that business processing is complete. Optional toast types are `success`, `info`, `warning`, and `error`, with nonempty string content; only a card's stop toast reaches the user. Receivers performing side effects must persist acceptance before acknowledging, deduplicate by `app_id + handler_id + event_id`, and return the original decision for duplicates.

The entire external chain shares a 2-second budget, including requests and response bodies. Errors, timeouts, redirects, or invalid receipts stop later handlers and built-ins. Cards show an error or an unconfirmed-outcome warning; message failures are thrown to the SDK. Dutydeck adds no background retries or persistent queue. Receivers must remain idempotent on platform redelivery. Built-in `task_id`, `taskId`, `dutydeck_*`, and legacy `dockmux_workflow` cards bypass external handlers completely, retaining existing authorization and deduplication. With card handlers enabled, mixed owner/built-in markers and external owners without a matching receiver are rejected. Registering only message handlers leaves card behavior unchanged.

Saving `eventHandlers` replaces the array; omitting it preserves existing registrations. Public API and CLI results omit tokens. For an existing stable id, omitting token preserves its credential during edits or reordering; new ids or changed URLs require an explicit token. URLs must use HTTPS or local HTTP (`127.0.0.1`, `localhost`, `[::1]`) without userinfo or fragments; redirects are prohibited. Corrupt stored registrations expose a safe `eventHandlersError` and prevent that bot's listener from starting. Original values are retained, and that bot requires an explicit valid replacement or null before other settings can be saved.

Existing `cardActionForwarding` is adapted internally into the same pipeline. Its request remains `{"version":1,"app_id":"<trusted App ID>","event":<complete SDK event>}`; persisted acceptance returns `202 {"status":"accepted","event_id":"<same event ID>"}`, and a duplicate returns `200 {"status":"duplicate","event_id":"<same event ID>"}`. Both stop propagation. Legacy forwarding and nonempty `eventHandlers` cannot be enabled together. Once the receiver adds `decision:"stop"`, migrate atomically in one save:

```bash
dutydeck settings bot set cli_xxx cardActionForwarding=null 'eventHandlers=[{"id":"buttons","eventTypes":["card.action.trigger"],"owner":"sample-service","legacyActions":["ack"],"url":"http://127.0.0.1:14432/events","token":"<existing-receiver-token>"}]'
```

Old clients ignore the additional decision field. Corrupt legacy forwarding still exposes `cardActionForwardingError` and requires explicit repair or removal.

- **Deploy**: drain → switch `releases/current` → restart → health check. If the health check fails the service is stopped and rolled back only when the database schema is unchanged; an old database snapshot is never restored.
- **Cleanup**: after each successful deploy the newest 5 releases and deployment records (including database backups) are kept. `current`, its previous release and releases still referenced by running processes are always kept; cleanup failures only warn. Records from manual deployments (no `created_by: dutydeck deploy` in `manifest.json`) are left alone unless you pass `--include-unmarked`, and even then skipped when referenced by a process or modified within the last hour. `.partial` directories modified in the last hour are skipped too.
- **systemd service root and database resolution**: Direct systemd user unit entry is `node cli.js`. Management commands resolve the target database by prioritizing explicit `--database` in ExecStart, then unit `DUTYDECK_DATABASE_URL`, then the default `<cwd>/.dutydeck/dutydeck.db` (evaluating cwd from `--cwd` or `DUTYDECK_DEFAULT_CWD`); existing `start --foreground` templates and deployment runtime metadata retain priority.
- **Remote access**: Dutydeck listens on `127.0.0.1` by default. With `--host 0.0.0.0`, browsers log in with the password from `dutydeck auth password set`; CLI and API use the access token. Never use `--no-auth` on a reachable address.
- **Credential protection**: once a bot is open to others, it keeps group members from getting the agent to reveal local tokens, keys and agent session records. It follows the bot's risk control setting and only restricts senders outside the high-risk allowlist and other bots; people on the list work as before, including full-trust mode.
  - Guidance: the agent gets a rule not to read, copy, print or send credentials and agent session records (such as `~/.claude`, `~/.claude.json`, `~/.codex`), and to refuse in one sentence when asked.
  - Enforced: tool calls are also checked first. Reading or writing credential files and session records (such as `~/.codex/auth.json`, `~/.ssh` private keys, `.env`) or printing secret environment variables is blocked; the command does not run and the agent gets the reason. For Claude Code (terminal and ACP) and Codex terminal sessions in full-trust mode, the check is passed in the launch arguments of that agent process only; global config under `~/.claude` and `~/.codex` is not changed. Codex over ACP is checked by the workspace hook.
  - For Claude Code terminal agents (including custom agents whose adapter is `claude-code`, such as ccflash) and ACP Claude launched by Dutydeck, the same check also enforces the high-risk pattern, so enforced mode needs no workspace hook. A custom ACP Claude must launch with the released `dist/agents/claude-acp.mjs`; an old copy made elsewhere does not include the check.
  - In every mode, Lark cards, results and group tool messages replace common secret formats (such as `sk-ant-`, `ghp_`, JWTs) and secret values from the service and agent environments with `[REDACTED]`.

### Agent CLI (`dutydeck agent`)

Agents in Lark sessions use `dutydeck agent` for general operations. Every turn, the host supplies a complete command prefix bound to that execution: `<absolute path> agent --turn <credential>`, plus available capabilities. Reuse that prefix without looking up or guessing the current task. Examples below use `$TURN` for the host-provided credential. Controlled exports use the separate `plugin-tool` entry; see [Controlled plugin results](#controlled-plugin-results).

Unattended group-collaboration mandates using `ask` or an unset permission mode analyze frozen material without tool, Herdr or interactive-question instructions. Mandates explicitly using `approve-reads` / `full-trust` retain tool guidance. Missing material is reported with unfinished work; it cannot justify “nothing new.” The scheduler delivers the result.

The `adhdMode` output setting puts commands, paths or code first, groups lists, and makes progress and verification explicit. Lark result cards hide follow-up buttons and omit the verification placeholder when neither a verification command nor a suggestion is available. Structured ask cards contain only the question and choices. Cards omit the header and brand footer, and a single choice uses a primary button. Registration returns `deferred` and quietly ends the original turn (recorded as cancelled for durable confirmation), without an interruption result card or a retry of the original request; confirmation has no deadline and survives later messages and service restarts. Only the original requester or a currently listed high-risk approver may click. A click registers one input in the original session with the question, fixed operation context and selected options; its Lark cards, task navigation and queue previews use the original request title, falling back to “已确认” when unavailable, while the internal replay text remains unchanged; the agent must search for duplicates before writing. This deduplicates input registration per card, not external writes. Multi-question calls register only the first question. Archiving the original session, disabling listening or revoking the original request authority ends confirmation. Answered cards show the selected option, responder and time; terminated cards show one short status. Free-text asks, plan and permission cards retain their existing timeout and authorization boundaries. This mode adds no confirmation requirements and does not stop repairs after three attempts.

For every bot, static pending ask, approval and plan cards use non-streaming mode; content-generating process and result cards keep their existing streaming behavior. Workflow decisions and closing text are persisted before returning the callback response; cards close asynchronously about one second later. Failed closing logs a warning and retries at most five times across restarts. If the process exits before closing, startup reconciliation repairs the card.

- **Tool approval**: In `ask` / `approve-reads`, sessions with injected tool credentials automatically approve a single `dutydeck agent …` command using the exact session command prefix, in Claude Code / Seed / Relay terminal mode and ACP. The approval reason is recorded. Shell chaining, redirection and expansions still require approval; high-risk guards and write confirmation cards remain in effect. Other terminal CLIs do not support this exact approval.
- **Help**: `dutydeck agent --help` starts with a quick guide for the Agent; every subcommand's `--help` has a `Risk` line (`read`, `write-confirm` posts a confirm card, `write` takes effect at once) and examples. Help needs no service or credentials.
- **Output**: stdout carries exactly one JSON. Success is `{"ok":true,"data":...}`; failure is `{"ok":false,"error":{"code","message","hint"?,"params"?:[{"name","reason"}]}}` with a non-zero exit code. `params` names the wrong parameter, with allowed values in `reason` when there are any.
- **Read**: `status`, `agents`, `tasks [--page]`, `queue`, `schedules`, `ci`, plus the read commands under `group`, `history`, `memory`, `work` and `collaborate`. Results go back to the Agent without posting a card; permissions are the same as the turn's requester sending that command in the original topic.
- **Write**: `session new/resume/fork`, `retry`, `plan --task`, `schedule create/enable/disable`, `queue cancel/top`, `access grant/revoke --member`, `pr open`, `ci wait/fix/cancel` and `repair` post a confirm card under the turn's request message; after 确认 they run the same way as the matching slash command. `group send`, `memory add` and the like still take effect directly. Every write command accepts `--dry-run`, which returns what would happen, whether it needs confirmation and what the card says, without running anything or posting a card.
- **Task ownership**: reads, writes, final delivery and handoffs validate the execution-specific `--turn`. Missing credentials, old tasks and earlier attempts of the same task are rejected. Late requests cannot acquire a new task or requester. Help remains available offline.
- **Existing sessions after upgrading**: credential-free tool calls from old prompts are no longer accepted. Use the new command prefix supplied by the host for this turn; never reuse a previous turn’s prefix. Legacy group, history and memory commands accept a top-level credential, for example `dutydeck --agent-turn "$TURN" group self`.

---

`dutydeck agent --turn "$TURN" settings show` reads common bot settings. `dutydeck agent --turn "$TURN" settings set defaultAgentId=codex notifyQuietHours=22:00-08:00` sends a confirmation card and saves only after a bot admin confirms. Users can simply ask “use codex by default” or “mute notifications from 10 pm to 8 am”. The whitelist contains only `defaultAgentId`, `defaultModel`, `defaultReasoningEffort`, `p2pMode`, `groupReplyMode`, `notifyQuietHours`, `notifyMentionAction`, `notifyMentionDone`, and `busyTriage`. Permissions, allowlists and credentials are excluded. An empty quiet-hours value clears the window. Choosing "automatic" (or setting `groupReplyMode=auto`) clears an explicit override and restores default routing; omitted fields in an update patch keep their values. `show` returns bot defaults even when a group has overrides; a `null` group reply mode means no explicit setting and preserves legacy routing.

Confirmation requires bot settings management permission (`channel_bot.update`) in managed groups; high-risk operation permission alone is insufficient. Elsewhere, an explicit deployment member/email allowlist is required; an empty allowlist cannot confirm. Cards bind the configuration revision when proposed. A later Web edit makes an old card fail instead of overwriting newer settings.

## Upgrade Notes

- **Long conversations and live updates**: fixed automatic browser stream reconnection and reduced repeated work for long turns, history backfill and raw logs. History still fills automatically; raw logs remain fully viewable and copyable. No new setting is required.
- **Lark message handling**: receipt reactions start promptly while task preparation continues; late reactions are cleaned up after the task ends. A context timeout stops subsequent reads for that turn, preserving failure feedback and the material available to a retry. Concurrent authentication for the same bot is shared, while each request keeps its own deadline and retry budget.
- **Read indexes (v42)**: upgrades add indexes for sessions, usage events, automation and question state while retaining history. Persisted questions are read by ID; questions awaiting an answer remain immediately available. Older program versions reject the newer database schema after migration.
- **Terminal size**: resize requests accept positive integer rows and columns. Invalid requests return an error and leave the connection usable.
- **Work item recovery**: steps blocked by an unknown execution resume remaining work on the next scheduler pass after the recovery API verifies the original execution and confirms success. A confirmed failure allows an explicit step retry. Permissions and configuration are rechecked; completed steps are not rerun. Unknown results, cancelled work and review stop decisions remain blocked.
- **Work item history**: upgrades automatically build a scheduling index. Completed items with settled delivery no longer enter the per-second scan; history remains available and pending deliveries keep retrying.
- **Disconnect and stop recovery**: cross-instance live streams can reconnect after an upstream disconnect. Shutdown closes proxy connections and pending Lark listener connections. A failed terminal stop can be retried to release the process.
- **Background tasks**: blank answers no longer block later memory extraction; group notification limits use the complete hourly window; cron handles leap days across years and repeated daylight-saving times. Enabled recurring schedules with a missing next execution time are repaired automatically; completed one-time schedules are not rerun.
- **Web task state**: replaying missed events also refreshes task state, so the task list catches up with restored history.
- **Terminal backend settings**: selecting Herdr checks its version asynchronously, so the service can handle other requests while validation waits.
- **GitHub read limits**: PR issue and inline comments support pagination, with a shared limit of 100 pages and 8 MiB. Exceeding it fails the whole read instead of returning partial comments. Each JSON response is limited to 2 MiB and each log download to 8 MiB of actual bytes; oversized reads are cancelled. Oversized logs are omitted while failed job and step summaries remain available. Logs for up to 10 failed jobs are read concurrently; results keep job order and an individual log failure does not affect other logs.
- **CLI startup**: reduced startup overhead for local management commands such as `secret`.
- **CI env vars moved to plugins**: see the upgrade paragraph under Plugins.
- **Alert triage is now the built-in scenario pack `alarm`.** The group phrases, confirmation card, sources, levels, dedupe and hourly cap are unchanged; existing subscriptions are converted to `alarm` bindings during the upgrade, and confirmation cards sent before the upgrade still work. Three things change: the alert text in the triage prompt now follows the instruction as untrusted material; the earlier conclusion that correlation passes to the agent is untrusted material too; duplicate checks read only this pack's triage records, so a busy group no longer makes the same alert get triaged twice. The CLI uses `scenarios=`; `alarm=` is kept for one release.
- **The alert triage pack is now 1.1.0 and topics under alerts can take follow-ups.** In multi-bot groups a topic opened under an alert from the source bot used to count as another bot's topic, so un-@ follow-ups were never answered. It no longer does: the bot stays out only when another bot has already posted in the topic, or the topic runs past 4 pages or cannot be read. Two bots deciding at the same moment may both answer. Existing bindings keep working with the new version without being confirmed again.
- **`model` scenario packs now load.** They used to be rejected at load; see `plugins/team-faq` for an example.
- **After the database reaches v38, older versions cannot open it.** v38 stores group duties as per-pack bindings. Going back to an older version fails at start with `DATABASE_SCHEMA_TOO_NEW`. If something goes wrong, fix forward or restore the database snapshot taken before the deploy; every write after that snapshot is lost.
- **The enforced-mode workspace hook now checks credential access (v3).** Bots that already use enforced mode need the hook reinstalled ("Configure hook" in the Web settings, or `dutydeck settings bot install-hook <app-id>`) before the check covers Codex over ACP; until then, saving that bot's settings reports that the hook is not ready. Bots whose default agent is a Claude Code terminal agent (including custom ones such as ccflash) or ACP Claude launched by Dutydeck are not affected and can now turn on enforced mode directly.
- **Agent commands use `dutydeck agent`.** Each turn supplies a command prefix bound to that execution. Status, task and queue reads return to the Agent for its answer instead of posting a result card. See [Agent CLI](#agent-cli-dutydeck-agent) for the required turn binding and upgrading existing sessions.
- **Per-turn changes could be missed** when a file was edited within the same second as the last index write and kept the same size (affecting "View changes" and the `/pr` file list). Fixed.

---

## Known Limits <a id="known-limits"></a>

- **Allow rules in your local `~/.claude/settings.json` bypass Lark per-action approval.** Claude terminal sessions from Lark start in `default` mode, but `permissions.allow` rules still apply, and matching actions never produce an approval card. Clear those rules if you need strict per-action approval.
- **With `/plan`, pre-approved writes on the ACP side cannot be blocked.** Planning blocks writes by rejecting every permission request the agent sends. If Claude ACP has its own allow rules (e.g. in settings) or runs in bypass mode, those actions never ask Dutydeck. Don't pre-approve writes on the ACP side when you use `/plan`.
- **Credential protection matches rules; it is not isolation.** Rewriting a command (encoding, building the path, writing a script and running it) may get past it, and in full-trust mode senders outside the allowlist can still make the agent run any command as the local user. For bots open to others, use enforced mode or don't give them full trust.
- Explicit Cursor `pty-cli` sessions with raw-screen output only may show an answer in playback but still be recorded as failed because normalized final text is unavailable. This does not apply to the default ACP Cursor.
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

**Claude Code / CCFlash finished, but the Lark card reports missing tool results?** Older versions could interpret historical API request snapshots in CLI logs as current tool calls. After upgrading, these snapshots neither enter the execution timeline nor acknowledge the current prompt. Actual tool calls without results still cause a failure status.

---

## License

Dutydeck core code is licensed under open-source terms. See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for details.
