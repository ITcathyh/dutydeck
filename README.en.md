# Dutydeck

<p align="center">
  <strong>Local-First AI Agent Engineering Workbench & Lark Bridge</strong><br>
  <em>Turn coding agents running on your machine (Claude Code, Codex, CLI) into an always-on collaborative teammate on Lark and the Web</em>
</p>

<p align="center">
  <a href="#why-dutydeck">💡 Why Dutydeck</a> •
  <a href="#key-highlights">✨ Key Highlights</a> •
  <a href="#quick-start">⚡ Quick Start</a> •
  <a href="#lark-guide">🤖 Lark Bridge</a> •
  <a href="#web-console">🖥️ Web Console</a> •
  <a href="#agent-config">⚙️ Agent Config</a> •
  <a href="#cli-reference">🛠️ CLI Reference</a> •
  <a href="#faq">❓ FAQ</a>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> | <strong>English</strong>
</p>

---

## 📖 Overview

**Dutydeck** is a local-first engineering workbench designed for individual developers and software teams.

Through a lightweight local daemon, it seamlessly connects local coding agents running on your machine or development server (such as Claude Code, Codex, ACP-compliant agents, and custom CLI tools) to **Lark (Feishu)** and a full-featured **Web Dashboard**.

You no longer need to stay glued to your terminal watching code stream line by line. Whether you are coding at your desk, in a meeting, or commuting, simply send a prompt in a private chat or mention `@bot` in a group on Lark. The agent works inside an isolated sandbox on your machine, executes real verification tests, and delivers clean results with full proof right to your mobile device.

```text
┌───────────────────────── Interfaces ─────────────────────────┐
│  📱 Lark (Mobile & Desktop App)         🌐 Web Workbench      │
│  · Dispatch tasks anytime from mobile  · Full task dashboard  │
│  · Interactive permission approvals    · Real-time Xterm pty  │
│  · Cross-session memory & delegation   · Git Worktree manager │
└──────────────────────────────┬───────────────────────────────┘
                               │ (WebSocket / SSE / Card 2.0)
┌──────────────────────────────▼───────────────────────────────┐
│                    Dutydeck Local Daemon                     │
│  · Task queuing, preemption & recovery · Strict permission gate│
│  · Real verification gates (test/lint) · Automated memory sync│
│  · SQLite transaction persistence      · CI pipeline self-heal│
└──────────────────────────────┬───────────────────────────────┘
                               │ (ACP Protocol / PTY Adapter)
┌──────────────────────────────▼───────────────────────────────┐
│                     Local Agent Engines                      │
│  · Claude Code (Native / CPA Gateway)  · ACP Agents (acpx)   │
│  · Custom CLI & PTY Adapters           · Clean Git Worktrees │
└──────────────────────────────────────────────────────────────┘
```

---

## 💡 Why Choose Dutydeck? (Value & Scenarios) <a id="why-dutydeck"></a>

Developers often use `claude` or other CLI coding assistants in a local terminal, but run into friction in everyday workflows:

| Scenario | Traditional Terminal CLI | With Dutydeck |
|---|---|---|
| **Mobile & Async Dispatch** | Tied to an active terminal window; disconnects kill the run | Dispatch from Lark mobile on the go; runs asynchronously with rich dynamic status cards |
| **High-Risk Actions** | All-or-nothing (either unsafe YOLO mode or blocked prompt) | Interactive 1-click "Approve / Reject" buttons right on the Lark card |
| **Branch & Dirty State** | Overwrites files in your current working tree | Automatically spawns isolated **Git Worktrees** from HEAD; zero dirty state pollution |
| **Quality Verification** | Agent merely claims "tests passed" (often hallucinated) | **Host-level test execution** recording real exit codes, runtimes, and commit hashes |
| **Team Synergy & Memory** | Context resets every session; repeated prompt boilerplate | **Persistent cross-session memory**, proactive group participation, and scheduled summaries |
| **Automated CI Self-Healing** | Manually babysit CI builds after push; re-open agent on failure | Listens to GitHub Actions and Codebase Webhooks to **wake up agent and self-heal automatically** |

---

## ✨ Six Key Highlights <a id="key-highlights"></a>

### 1. 📱 Full-Featured Lark Bridge: True Mobile Engineering
- **Dynamic Streaming Cards**: Real-time progress updates, active steps, and execution timers directly in chat.
- **1-Click Approvals**: Safe privilege elevation right from your phone for file edits or bash executions.
- **Automated Long-Form Packaging**: Long outputs and analysis reports are automatically bundled as downloadable Markdown attachments.
- **ADHD-Friendly Mode**: Conclusions first, numbered steps, max 5 items per list, zero pleasantries or conversational filler.

### 2. 🌿 Git Worktree Sandbox: Zero Workspace Pollution
- **Safe Concurrent Work**: Working on an active feature branch? Dutydeck automatically spins up a clean Git Worktree from HEAD to fix bugs without dirtying your working tree.
- **Strict Cleanup Gates**: Pre-archive validation ensures no uncommitted changes, untracked files, or unmerged commits are abandoned.

### 3. 🧪 Real Verification Gate with Automated Repair
- **Zero Blind Trust**: Runs real verification commands (e.g., `pnpm test`, `go test ./...`) on the host machine.
- **Immutable Evidence**: Records exit codes, durations, stdout/stderr, and code fingerprint hashes.
- **Auto-Fix Loop**: On failure, error logs are piped back into the agent for automated repair rounds (up to 2 attempts) before reporting back.

### 4. 🧠 Scoped Cross-Session Memory
- **Persistent Knowledge**: Independent long-term memory per chat that survives `/new` context resets and daemon restarts.
- **Manual & Automated Ingestion**: Save explicit rules via `/remember`; background jobs extract facts every 3 turns and consolidate duplicates every 8 turns.
- **Compact Injections**: Automatically injects a trimmed index (`MEMORY.md`, ≤ 3000 chars) into new task prompts.

### 5. 👥 Intelligent Group Teammate & Ongoing Mandates
- **Selective Participation**: Stays quiet by default in team channels; chimes in only on explicit mentions, urgent risks, or follow-ups.
- **Mention Once Flow**: Continue conversations in active topics without repeatedly @-mentioning the bot.
- **Natural Language Mandates**: Schedule recurring tasks conversationally (e.g., "Summarize today's progress every weekday at 6 PM").
- **Hierarchical Collaboration**: Configure PMO dispatchers, Leader planners, and Worker executors with automated result sign-off.

### 6. 🔄 CI Pipeline Self-Healing Loop
- **GitHub Actions Integration**: Run `/ci wait` to monitor workflow runs and trigger agent follow-ups.
- **Codebase / GitLab Webhook**: Receives merge request and pipeline failures via `POST /api/hooks/codebase` (secured with HMAC-SHA256 signatures), triggering bounded, safe self-healing iterations.

---

## ⚡ 3-Minute Quick Start <a id="quick-start"></a>

### 1. Prerequisites

- **Node.js**: `>= 22.12.0`
- **Package Manager**: `pnpm >= 11`
- **Agent CLI**: An authenticated CLI (e.g., Claude Code `claude`, Codex, or another ACP agent) installed on the machine.

### 2. Installation & Guided Setup

```bash
# Install globally
pnpm add -g @byted/dutydeck --registry=http://bnpm.byted.org

# Run the interactive configuration wizard
dutydeck setup
```

> **Non-Interactive Mode**: For automated environments or CI:  
> `dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes`

### 3. Start Daemon & Run Diagnostics

```bash
# Start background daemon
dutydeck start

# Run comprehensive health check (prints copy-pasteable fix commands for errors)
dutydeck doctor

# Check running status
dutydeck status
```

Open your browser:
- **Web Console**: `http://127.0.0.1:4310` (local requests require no authentication by default)

---

### 💡 Development from Source

To contribute or inspect the codebase directly:

```bash
# 1. Clone repository and install dependencies
git clone https://github.com/bytedance/dutydeck.git
cd dutydeck
pnpm install

# 2. Configure environment
cp .env.example .env

# 3. Start development servers with hot reload
pnpm dev
```

- **Frontend UI**: `http://127.0.0.1:4311`
- **Backend API**: `http://127.0.0.1:4310`

---

## 🤖 Lark Bridge Usage Guide <a id="lark-guide"></a>

### 1. Core Interaction Lifecycle

```text
[Send prompt on Lark] ──────► [Receipt reaction: 👌] ──────► [Live progress card streamed]
                                                                        │
┌───────────────────────── Agent requests permission or clarifies ◄────┘
▼
[Card displays "Approve / Reject"] or [Clarification card: click to reply]
│
▼
[Task completes] ──────► [Host runs real test verification] ──────► [Standalone result card sent]
```

---

### 2. Common Lark Commands

| Command | Example | Description |
|---|---|---|
| `/help` | `/help` | Display available commands and actions |
| `/new` | `/new -- Optimize login endpoint latency` | Reset context and start a clean session |
| `/new (Worktree)` | `/new --cwd "/data/app" --workspace worktree -- Refactor auth` | Target a directory and run inside an isolated Git Worktree |
| `/new --handoff` | `/new --handoff Add retry test cases` | Start a new session carrying over previous git state and change summary |
| `/tasks` | `/tasks` | List active, pending, and completed tasks |
| `/approve` | `/approve <card_id>` | Approve a pending sensitive action (same as clicking button) |
| `/reject` | `/reject <card_id>` | Reject a pending sensitive action |
| `/answer` | `/answer <card_id> Use option B` | Reply to an agent's clarifying question |
| `/cancel` | `/cancel` | Cancel active running task |
| `/retry` | `/retry` | Re-run previous failed or interrupted task |
| `/remember` | `/remember Never push directly to master branch` | Manually persist a long-term rule into memory |
| `/memory` | `/memory 1` | List saved memories for this chat |
| `/forget` | `/forget <memory_id>` | Mark a memory item as deleted |
| `/ci` | `/ci wait build.yml` or `/ci fix` | Monitor CI workflows and trigger auto-fixes on failure |

---

### 3. Lark Bot Setup

#### Method A: 1-Click Setup via Web Console (Recommended)
1. Open Web Console (`http://127.0.0.1:4310`), click **"Add Bot"** in the top right.
2. Enter bot name, click **"Create Bot"**.
3. Reuses logged-in Lark credentials or prompts for QR code login to automatically configure event subscriptions, issue scopes, and persist secrets.
4. Select default workspace and agent to start using immediately.

#### Method B: CLI Setup
```bash
# Create and bind a new bot
dutydeck lark create "Dev Assistant" --agent ccflash --listen

# Bind an existing enterprise Lark app
dutydeck setup --lark-app-id cli_xxxxxxxx
```

---

## 🖥️ Web Workbench & Automation Loop <a id="web-console"></a>

### 1. Task Board & Terminal Playback
- Clear stage filtering: **Awaiting Action**, **In Progress**, **Completed**, and **Archived**.
- Cards display execution time, tool invocations, and answers. Expand right panel for real-time **Xterm terminal playback**.
- Supports task queueing and immediate preemption (**Interrupt**).

### 2. Verification Gate with Auto-Fix
- Define verification commands (e.g., `pnpm test`).
- Status lines show **Passed**, **Failed**, or **Expired** (if files changed post-verification).
- Failed outputs trigger automated follow-up iterations for rapid bug fixes.

---

## ⚙️ Agent Configuration & Permission Postures <a id="agent-config"></a>

Supports both standard ACP (Agent Client Protocol) and PTY-wrapped CLI agents.

### 1. Custom Agent Config (`DUTYDECK_AGENTS_JSON`)

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

### 2. Permission Posture Comparison

| Mode | Behavior | Ideal For |
|---|---|---|
| `ask` **(Default)** | Halts on write/bash operations and requests approval via Lark/Web | Daily development; balanced speed and security |
| `approve-reads` | Automatically allows read operations; prompts on writes and command runs | Code inspection, bug triage, research |
| `deny-all` | Rejects all privileged operations | Strict read-only exploration |
| `full-trust` | Skips all confirmation prompts (YOLO mode) | Fully trusted sandboxes and unattended CI pipelines |

---

## 🛠️ CLI & DevOps Reference <a id="cli-reference"></a>

```bash
# Daemon management
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]
dutydeck status
dutydeck restart
dutydeck stop
dutydeck update
dutydeck doctor

# Production immutable release deploy
dutydeck deploy --source /path/to/checkout

# Autostart on boot (Linux systemd / macOS launchd)
dutydeck autostart enable
dutydeck autostart status
dutydeck autostart disable

# Configure settings via CLI
dutydeck settings bot show cli_xxx
dutydeck settings bot set cli_xxx adhdMode=true
dutydeck settings group set oc_xxx participation=selective
dutydeck settings usage set-cap 50 --app cli_xxx
dutydeck settings terminal-backend [tmux|herdr]
```

---

## ❓ Frequently Asked Questions (FAQ) <a id="faq"></a>

### Q1: Bot doesn't react or add `👌` emoji when messaged on Lark?
1. Run `dutydeck doctor` to verify Lark WebSocket listener status.
2. Ensure the Lark developer app has the **Bot** capability enabled and event subscription is configured for WebSocket (`im.message.receive_v1`).
3. Ensure the bot is added to the channel and @-mentioned.

### Q2: Error `Persisted key policy violation`?
- ACPX requires `snake_case` keys for persisted session options. Do not write uppercase environment variables directly into session options.

### Q3: Error `Agent command not found`?
- Non-interactive daemons do not load shell aliases from `.bashrc` / `.zshrc`. Provide absolute binary paths in `DUTYDECK_AGENTS_JSON`.

---

## 📄 License

Dutydeck core code is licensed under open-source terms. See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for full licensing details.
