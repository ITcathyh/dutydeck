<a id="readme-top"></a>

<div align="center">

<img src="docs/assets/banner-en.svg" alt="Dutydeck: dispatch in Lark, agents work on your machine" width="100%">

<h3>Dispatch in Lark, agents work on your machine</h3>

<p>📱 Approve on your phone · ✅ Server-side verification · 👑 A Leader that plans and reviews · ♻️ Survives restarts</p>

![Node.js ≥ 22.12][node-shield] ![pnpm ≥ 11][pnpm-shield] ![tmux][tmux-shield] ![Lark Card 2.0][lark-shield] ![ACP compatible][acp-shield]

<a href="#whats-new"><b>What's&nbsp;New</b></a> • <a href="#quick-start"><b>Quick&nbsp;Start</b></a> • <a href="#features"><b>Features</b></a> • <a href="#leader"><b>Leader&nbsp;Mode</b></a> • <a href="#web"><b>Web&nbsp;Workbench</b></a> • <a href="#agents"><b>Supported&nbsp;Agents</b></a> • <a href="#docs"><b>Docs</b></a> • <a href="https://github.com/ITcathyh/dutydeck/issues"><b>Issues</b></a>

<sub><a href="README.md">简体中文</a> · English</sub>

</div>
<a href="docs/assets/promo-en.mp4"><img src="docs/assets/promo-en.webp" alt="Promo: dispatch a task with one Lark message, approve commands from your phone, let the server verify tests, and open this run's diff from the result card; plus schedules, restart safety, long-term memory and PR follow-up, with 30 terminal adapters and 21 ACP agents" width="100%"></a>

<p align="center"><sub><i>38-second promo · <a href="docs/assets/promo-en.mp4">HD MP4</a> · UI is illustrative and the task is a made-up example</i></sub></p>

<a id="install"></a>

```sh
git clone https://github.com/ITcathyh/dutydeck.git && cd dutydeck
# Install dependencies and build
pnpm install && pnpm build
# Pack an npm tarball, then install the global dutydeck command
pnpm --filter @byted/dutydeck pack --pack-destination "$PWD"
npm install -g ./byted-dutydeck-*.tgz
# Wizard: detects local agents, can bind a Lark bot
dutydeck setup
# Start the daemon and run a health check
dutydeck start && dutydeck doctor
```

Once `doctor` passes, open `http://127.0.0.1:4310`. Prerequisites and other install options: [Quick Start](#quick-start).

## 🔥 What's New <a id="whats-new"></a>

<sub>November 2026</sub>

| | New | What you get |
|:---:|---|---|
| 👑 | [**Leader mode**](#leader) | One agent plans the work, hands it to several Workers and reviews the result; only the calls that are truly yours reach you |
| 📱 | [**Workbench redesign**](docs/en/web-console.md) | Four destinations: Overview, Tasks, Inbox and Automation; on phones a bottom tab bar, and the result inspector becomes a bottom sheet |
| 🎯 | [**Schedules that follow through**](docs/en/web-console.md) | A completion condition and a deadline, so a plan stops itself once done; an optional pre-check command wakes the agent only when it passes |
| 🧷 | [**Workspace approval rules**](docs/en/agents.md#workspace-approval-rules) | Approve `pnpm test` or `git status` once, and the same directory allows it from then on, even after restarts |
| 🌙 | [**Background work panel**](docs/en/web-console.md) | Background tasks the agent starts itself sit above the timeline, so finished, failed and still-running work is easy to tell apart |
| ✍️ | [**Reply polish**](docs/en/lark.md#reply-wording-polish-off-by-default) | Optional: a second agent rewords the final answer before it is sent; if code, links or numbers change, the original goes out instead |
| 🩺 | [**Ops tooling**](docs/en/cli.md#logs) | `dutydeck logs` for recent logs, `doctor` flags risky exposure, and systemd socket activation queues connections during restarts |

## 💡 Why Dutydeck <a id="why"></a>

Most coding agents only run in a terminal: you have to sit at your desk and a dropped SSH session kills the run; let them run unattended and you worry about what they change or execute; when one says "tests pass", you can't tell whether it ran them. **Dutydeck is a daemon on your dev machine** that connects Claude Code, Codex and other agents to Lark and a web workbench.

| | Terminal CLI alone | With Dutydeck |
|---|---|---|
| **Dispatch** | <sub>Tied to your desk; SSH drops kill it</sub> | ✅ One Lark message, runs in background |
| **Risky actions** | <sub>YOLO mode, or constant prompts</sub> | ✅ Approve each action on your phone |
| **Quality** | <sub>Claims tests pass; maybe never ran</sub> | ✅ Server runs the verify command |
| **Workspace** | <sub>Edits your current branch</sub> | ✅ Optional separate worktree |
| **Teamwork** | <sub>One terminal, one agent; you split and chase the work</sub> | ✅ A Leader splits it across Workers and reviews before handing back |
| **Cost** | <sub>You find out what it cost afterwards</sub> | ✅ Monthly caps per bot or group |
| **Restarts** | <sub>Process stops, work is gone</sub> | ✅ Recoverable tasks are kept |

<p align="center">
  <img src="docs/assets/flow-en.svg" alt="Flow: Lark progress card → approval card (Allow once / Reject / Allow this command for the session / Allow this kind of command in this workspace; the last two depend on who started the turn, the command type and permissions) → the server runs pnpm test with exit code 0 → result card with 3 files changed and Verified" width="100%">
</p>

<p align="center"><sub>Dispatch → Approve → Server-side verification (up to 2 repair rounds on failure) → Result card<br>The "Allow for session" and "Allow in workspace" buttons depend on who started the turn, the command type and permissions</sub></p>

| [**30**](packages/cli-adapters/src/factory.ts) | [**21**](packages/acp-client/src/index.ts) | [**2 rounds**](docs/en/web-console.md) | [**14 days**](docs/en/web-console.md) | [**0 times**](docs/en/lark.md) | [**8**](docs/en/lark.md#leader-mode) |
|:---:|:---:|:---:|:---:|:---:|:---:|
| <sub>built-in terminal adapters</sub> | <sub>ACP agents in the acpx registry</sub> | <sub>max repair rounds after a failed check</sub> | <sub>lifetime of a mobile diff link</sub> | <sub>auto-resends of an unknown outcome</sub> | <sub>max Workers in Leader mode</sub> |

## ✨ Features <a id="features"></a>

<img src="docs/assets/demo-en.svg" alt="Demo: a teammate @-mentions the bot in a Lark group, approves pnpm test, and gets a verified result card; the right side shows the agent running on the dev box" width="100%">

<p align="center"><sub><i>Illustration: card fields follow the real Lark cards (labels translated from Chinese) and some buttons only appear under conditions; the task is a made-up example</i></sub></p>

<table>
<tr>
<td width="33%" valign="top">
📱 <b>Dispatch from Lark</b><br>
DM the bot or @ it in a group; progress cards update live. No commands needed: say "redo it with codex" and confirm.<br>
<sub>→ <a href="docs/en/lark.md">Lark bridge</a></sub>
</td>
<td width="33%" valign="top">
👑 <b>Leader mode</b> <img alt="NEW" src="https://img.shields.io/badge/NEW-FF5A5F?style=flat-square"><br>
A Leader plans, hands work to several Workers and reviews it; only the calls that are yours reach you.<br>
<sub>→ <a href="#leader">See below</a></sub>
</td>
<td width="33%" valign="top">
📝 <b>Plan first</b><br>
<code>/plan</code> researches without editing files; work starts once you approve the plan card (Claude).<br>
<sub>→ <a href="docs/en/lark.md">Lark bridge</a></sub>
</td>
</tr>
<tr>
<td valign="top">
🛡️ <b>Approve on your phone</b><br>
A card pops up before file writes and commands; common test commands can be remembered per workspace.<br>
<sub>→ <a href="docs/en/agents.md">Agents & permissions</a></sub>
</td>
<td valign="top">
✅ <b>Verification gate</b><br>
The server verifies Lark tasks; failures get up to 2 repair rounds.<br>
<sub>→ <a href="docs/en/web-console.md">Web workbench</a></sub>
</td>
<td valign="top">
🔍 <b>Review diffs on mobile</b><br>
The result card opens this turn's diff, with line comments.<br>
<sub>→ <a href="docs/en/web-console.md">Web workbench</a></sub>
</td>
</tr>
<tr>
<td valign="top">
🧭 <b>Steer and fork</b><br>
<code>/steer</code> slips a note into the running turn, <code>/fork</code> branches with context, <code>/resume</code> brings back a closed session.<br>
<sub>→ <a href="docs/en/lark.md#2-commands">Commands</a></sub>
</td>
<td valign="top">
🔁 <b>Open PRs and follow up</b><br>
<code>/pr</code> opens a PR once you confirm, then follows up on CI and review comments (GitHub plugin required).<br>
<sub>→ <a href="docs/en/lark.md">Lark bridge</a></sub>
</td>
<td valign="top">
⏰ <b>Schedules that follow through</b> <img alt="NEW" src="https://img.shields.io/badge/NEW-FF5A5F?style=flat-square"><br>
Say "check this PR every 30 minutes until it merges"; it starts once you enable it and stops itself when done.<br>
<sub>→ <a href="docs/en/features.md#key-highlights">Key capabilities</a></sub>
</td>
</tr>
<tr>
<td valign="top">
🧠 <b>Long-term memory</b><br>
<code>/remember</code> saves a fact, or let a background job extract them.<br>
<sub>→ <a href="docs/en/features.md#key-highlights">Key capabilities</a></sub>
</td>
<td valign="top">
♻️ <b>Survives restarts</b><br>
Turns with an unknown outcome are never re-sent; a card asks you.<br>
<sub>→ <a href="docs/en/lark.md">Lark bridge</a></sub>
</td>
<td valign="top">
📊 <b>Usage and cost</b><br>
Monthly caps per bot or group; costs and session analysis in the Web UI.<br>
<sub>→ <a href="docs/en/web-console.md">Web workbench</a></sub>
</td>
</tr>
<tr>
<td colspan="3" valign="top">
🔌 <b>Pluggable</b><br>
CI, code hosting, alert triage and other integrations ship as plugins, and you can write your own.<br>
<sub>→ <a href="docs/en/plugins.md">Plugins</a></sub>
</td>
</tr>
</table>

<details>
<summary><b>⌨️ The 10 Lark commands you'll use most</b> (or just say what you want)</summary>

| Command | What it does |
|---|---|
| `/new [--agent …] -- task` | Start a new session and dispatch; pick the agent, directory, worktree or model |
| `/plan task` | Research and propose a plan first; work starts after approval |
| `/steer text` | Slip a note into the turn that is running |
| `/fork [task]` | Branch into a new thread with context; the original keeps going |
| `/resume` | Bring back the thread's most recently closed session |
| `/pr [title]` | Open a PR after you confirm, then follow up on CI and reviews |
| `/schedule every 30 task` | Run every 30 minutes, starting once you enable it |
| `/remember text` | Save a long-term memory that every later turn gets |
| `/status` | Current agent, workspace, run state and this month's usage |
| `/cancel` | Cancel the running or queued turn |

Full list: [Commands](docs/en/lark.md#2-commands).

</details>

<div align="right"><sub><a href="#readme-top">↑ Back to top</a></sub></div>

## 👑 Leader Mode <a id="leader"></a>

One message, three roles in relay: the **front agent** talks to you; the **Leader** splits the work by your "Leader guide" and assigns it to **Workers** (up to 8). Worker questions and tool requests go to the Leader first, and work that fails review goes back for repair (up to 2 rounds). Only what is truly your call, such as a command that hits a high-risk rule, reaches you.

<p align="center">
  <img src="docs/assets/leader-en.svg" alt="Leader mode: you post a request in a group thread and the front agent hands it to the Leader; the Leader splits it into 3 steps per its guide and, after you click Start, assigns Workers A and B; the Leader answers Worker B's question from the guide, while a migration command that hits a high-risk rule is escalated to you; the Leader accepts the work and the result lands in the original thread" width="100%">
</p>

<p align="center"><sub><i>Illustration: in groups, the Leader's plan is dispatched only after you click Start; in DMs no click is needed. The task is a made-up example</i></sub></p>

- **Only your own words authorize**: your messages, your answers on cards and standing permissions written in the guide. The Leader's inferences and the front agent's summaries don't count.
- **Every call it made for you is on record**: "Leader decided for you" on the goal card lists each decision and its basis; disagree by saying so in the thread.
- **The guide is a skill**: one `SKILL.md`, kept in the project, your home directory or a plugin; leave it empty to use the built-in rules.

Turn it on under Web **Bot management → Execution mode** (group tools must be enabled), or:

```sh
dutydeck settings bot set <appId> executionMode=layered leaderAgentId=<agentId> workerAgentIds=<id1>,<id2>
```

<sub>→ <a href="docs/en/lark.md#leader-mode">Leader mode in depth</a></sub>

## 🖥️ Web Workbench <a id="web"></a>

Away from Lark, open `http://127.0.0.1:4310`. **Overview** puts what needs your decision first, **Inbox** lets you approve routine requests in place, **Tasks** shows the conversation, tool calls, per-turn diffs and terminal playback (terminal-mode agents), and **Automation** manages schedules; `Ctrl-K` (`⌘K` on macOS) searches tasks and settings. Light and dark themes, and it works on a phone too. The Web UI is currently Chinese-only.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/web-task-dark.png">
    <img src="docs/assets/web-task-light.png" alt="Task detail in the Web workbench: the agent reads files, edits code and runs tests" width="100%">
  </picture>
</p>

<table>
<tr>
<td width="37%"><img src="docs/assets/web-tasks.png" alt="Overview: a pending permission request sits at the top with approve and reject buttons; below are in-progress and resumable tasks, with recent deliveries on the right"></td>
<td width="37%"><img src="docs/assets/web-diff.png" alt="Per-turn changes: file list with review progress on the left, line-by-line diff on the right"></td>
<td width="13%"><img src="docs/assets/web-mobile-home.png" alt="Task list on a phone: status filters, and a bottom tab bar with Overview, Tasks, Inbox and More"></td>
<td width="13%"><img src="docs/assets/web-mobile-task.png" alt="Result inspector on a phone: a bottom sheet listing run, changes and verification status"></td>
</tr>
<tr>
<td align="center"><sub>Overview: pending approvals first, approvable in place</sub></td>
<td align="center"><sub>Per-turn changes, file by file</sub></td>
<td align="center" colspan="2"><sub>Phone: bottom tabs, result inspector as a sheet</sub></td>
</tr>
</table>

<p align="center"><sub><i>Screenshots come from an isolated demo instance; projects, tasks and code are made-up examples</i></sub></p>

## 🚀 Quick Start <a id="quick-start"></a>

> [!NOTE]
> You need Node.js ≥ 22.12, pnpm ≥ 11, `tmux`, and an installed, signed-in agent CLI (Claude Code, Codex, …).

After running [the commands at the top](#install):

1. Open `http://127.0.0.1:4310` (no login for local requests).
2. Click **绑定飞书 Bot** (Bind Lark bot) → **一键创建飞书机器人** (one-click create) and finish the authorization.
3. DM the bot in Lark, or @ it in a group, to dispatch work.

<details>
<summary><b>Other install options</b></summary>

- **Install the published package globally**: `pnpm add -g @byted/dutydeck`, then `dutydeck setup` and `dutydeck start` as above.
- **Scripts / CI, no prompts**: `dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes`; Lark binding flags are in [Getting started](docs/en/getting-started.md).
- **Hot-reload development from source**: see [Development](#dev) below.

</details>

<details>
<summary><b>Let your agent install it</b></summary>

Send this to your coding agent:

```text
Install and start Dutydeck for me:
https://github.com/ITcathyh/dutydeck
1. Check that Node.js ≥ 22.12, pnpm ≥ 11 and tmux are installed;
   tell me what is missing.
2. Clone, build, pack and globally install the dutydeck command
   using the commands at the top of the README.
3. Run dutydeck setup --skip-lark --yes to configure this machine
   only, then run dutydeck start.
4. Run dutydeck doctor and list any failed checks with the fix
   commands it prints.
```

</details>

## 🤖 Supported Agents <a id="agents"></a>

Dutydeck ships **30 built-in terminal adapters**, and ACP agents (21 in the acpx registry) show up automatically when no terminal adapter covers them. When an agent supports both, the terminal adapter wins, so Gemini or Cursor, for example, can only use `full-trust` in Lark; for per-action approval, set `protocol: "acp"` for it in `DUTYDECK_AGENTS_JSON`, which is also where you register custom agents.

| Agent | Connection | Per-action Lark approval |
|---|---|:---:|
| **Claude Code** (including gateway / custom-settings variants) | Terminal · ACP | ✅ |
| **Codex** | Terminal (`codex`) · ACP (`codex-acp`) | ACP ✅ |
| **TRAE** | Terminal (`traex`) · ACP (`traex-acp`) | Native policy applies |
| **Gemini CLI, Cursor, OpenCode, Copilot CLI, Kimi and more** | Terminal | `full-trust` only |
| **ACP agents** (Qwen Code, Factory Droid, iFlow and more, auto-detected) | ACP | ✅ |

> [!WARNING]
> `full-trust` skips per-action approval: the agent writes files and runs commands without asking. Use it only in isolated environments or pipelines you trust.

Approval support and permission modes per agent: [Agents & permissions](docs/en/agents.md).

<div align="right"><sub><a href="#readme-top">↑ Back to top</a></sub></div>

## 🏗️ How It Works <a id="how-it-works"></a>

<p align="center">
  <img src="docs/assets/arch-en.svg" alt="Architecture: Lark, the Web workbench and CLI/HTTP triggers connect to the Dutydeck daemon on your machine, which drives local agents over PTY or ACP" width="100%">
</p>

- **Entry points**: Lark (WebSocket + Card 2.0), the Web workbench, CLI / HTTP triggers.
- **Daemon**: runs on your machine; owns the task queue, permission gate, verification gate, memory and plugins.
- **Execution ledger**: every turn is recorded in SQLite as not submitted, running or outcome unknown.
- **Drivers**: terminal mode drives CLIs over a PTY; ACP agents speak ACP.
- **Session backend**: terminal mode uses `tmux` by default; existing Herdr setups keep working.

**Local-first**: agents, code and credentials stay on your machine; the daemon listens on `127.0.0.1` by default and remote access requires login.<br>
**No guessing**: timeouts, disconnects and restarts are never treated as "not executed" and re-sent automatically.<br>
**Leak guard**: optionally blocks reads of `~/.ssh`, `.env`, agent session logs and the like; common secrets in cards and group messages are redacted.<br>
**Safe rollouts**: `dutydeck deploy` drains tasks → switches the release → restarts → health-checks, rolling back on failure when it can; with systemd socket activation, connections queue during the restart instead of being refused.<br>
**Self-checks**: every hour it checks the long connection, pending result deliveries, unknown outcomes and overdue schedules, and DMs the bot owner about new problems.

## 📚 Documentation <a id="docs"></a>

| Doc | What's inside |
|---|---|
| 🚀 [Getting started](docs/en/getting-started.md) | Install, setup wizard, non-interactive setup, development from source |
| ✨ [Features in depth](docs/en/features.md) | Details, defaults and limits of the core capabilities |
| 📱 [Lark bridge](docs/en/lark.md) | Task lifecycle, commands, `/plan`, `/pr`, group participation, Leader mode, bot setup |
| 🖥️ [Web workbench](docs/en/web-console.md) | Overview and inbox, verification and repair, mobile diffs, usage and cost, schedules |
| 🤖 [Agents & permissions](docs/en/agents.md) | Custom agents, terminal task recovery, permission modes, workspace approval rules, environment variables |
| 🔌 [Plugins](docs/en/plugins.md) | Plugin layout, triggers, business tools, hooks, CI providers, scenario packs |
| ⌨️ [CLI & operations](docs/en/cli.md) | Daemon, logs, deploy and rollback, backup and restore, `settings`, remote access, checks |
| ⬆️ [Upgrade notes](docs/en/upgrading.md) | Behavior changes to watch when upgrading |
| ❓ [Known limits & FAQ](docs/en/troubleshooting.md) | Known limits and troubleshooting |

<sub>For AI coding agents: conventions and verification requirements are in <a href="AGENTS.md">AGENTS.md</a>.</sub>

<div align="right"><sub><a href="#readme-top">↑ Back to top</a></sub></div>

## 🛠️ Development <a id="dev"></a>

```bash
git clone https://github.com/ITcathyh/dutydeck.git
cd dutydeck
pnpm install
cp .env.example .env
pnpm dev        # Web http://127.0.0.1:4311, API http://127.0.0.1:4310
```

A pnpm monorepo: `apps/server` (daemon and CLI), `apps/web` (Web workbench), `packages/*` (runtime, ACP/terminal drivers, storage, plugin SDK and more); E2E tests in [tests/e2e/README.md](tests/e2e/README.md).

## 📄 License

No open-source license has been declared for this repository yet; until a LICENSE file is added, all rights are reserved. Third-party code and assets, with their licenses, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

<div align="center">
<br>
<img src="docs/assets/logo.svg" alt="Dutydeck" width="48">
<p><sub>Dispatch in Lark. Work on your machine.</sub></p>
<a href="#readme-top">↑ Back to top</a>
</div>

[node-shield]: https://img.shields.io/badge/Node.js-%E2%89%A5_22.12-339933?style=flat-square&logo=nodedotjs&logoColor=white
[pnpm-shield]: https://img.shields.io/badge/pnpm-%E2%89%A5_11-F69220?style=flat-square&logo=pnpm&logoColor=white
[tmux-shield]: https://img.shields.io/badge/tmux-required-1BB91F?style=flat-square&logo=tmux&logoColor=white
[lark-shield]: https://img.shields.io/badge/Lark-Card_2.0-3370FF?style=flat-square
[acp-shield]: https://img.shields.io/badge/ACP-compatible-0EA5E9?style=flat-square
