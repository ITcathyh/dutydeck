# Dutydeck

<p align="center">
  <strong>Local-First AI Agent Engineering Workbench & Lark Bridge</strong><br>
  <em>Turn your local coding agents into a 24/7 collaborative engineering partner in Lark and on the Web.</em>
</p>

<p align="center">
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

## 📖 Overview & Value Proposition

**Dutydeck** is a local-first engineering workbench designed for individual developers and software teams. It seamlessly connects local coding agents running on your machine or development server (such as Claude Code, Codex, ACP-compliant agents, and custom CLI tools) to **Lark (Feishu)** and a full-featured **Web Dashboard**.

You no longer need to stay glued to your terminal watching code stream line by line. Whether you are at your desk, in a meeting, or commuting, simply send a prompt in a private chat or mention `@bot` in a group on Lark. The agent immediately gets to work inside an isolated sandbox on your machine.

```text
┌───────────────────────── Interfaces ─────────────────────────┐
│  📱 Lark (Mobile & Desktop App)         🌐 Web Workbench      │
│  · Direct task dispatch via chat       · Task list & filtering│
│  · Live dynamic progress cards         · Incremental logs/pty │
│  · 1-click approvals & prompts         · Git Worktree manager │
│  · Cross-session memory & delegation   · Real verification run│
└──────────────────────────────┬───────────────────────────────┘
                               │ (WebSocket / SSE / Card 2.0)
┌──────────────────────────────▼───────────────────────────────┐
│                    Dutydeck Local Daemon                     │
│  · Task queuing, preemption & recovery · Strict permission gate│
│  · Automated memory consolidation      · Verification capture │
│  · SQLite transaction persistence      · GitHub Actions sync  │
└──────────────────────────────┬───────────────────────────────┘
                               │ (ACP Protocol / PTY Adapter)
┌──────────────────────────────▼───────────────────────────────┐
│                     Local Agent Engines                      │
│  · Claude Code (Native / CPA Gateway)  · ACP Agents (acpx)   │
│  · Custom CLI & PTY Adapters           · Git Worktrees       │
└──────────────────────────────────────────────────────────────┘
```

### Why Dutydeck?

| Challenge | Traditional Terminal CLI | With Dutydeck |
|---|---|---|
| **Mobile & Async Dispatch** | Tied to an active terminal window; disconnects kill the run | Dispatch from Lark mobile on the go; runs asynchronously with rich status cards |
| **High-Risk Actions** | All-or-nothing (either unsafe YOLO mode or blocked prompt) | Interactive 1-click "Approve / Reject" buttons right on the Lark card |
| **Branch & Dirty State** | Overwrites files in your current working tree | Automatically spawns isolated Git Worktrees from HEAD; zero dirty state pollution |
| **Quality Verification** | Agent merely claims "tests passed" (often unverified) | Host-level test execution recording real exit codes, runtimes, and commit hashes |
| **Team Synergy & Memory** | Context resets every session; repeated prompt boilerplate | Persistent cross-session memory, proactive group participation, and scheduled summaries |

---

## ✨ Key Features

- 🤖 **Full-Featured Lark (Feishu) Bridge**: Private & group dispatch, dynamic card progress streaming, inline permission approvals, interactive clarifying questions, and automatic delivery of long outputs as Markdown file attachments.
- 🛡️ **Defensive Permission Postures**: Default `ask` (real-time approval for dangerous operations); supports `approve-reads`, `deny-all`, and `full-trust` (reserved for trusted unattended environments).
- 🌿 **Git Worktree Sandbox Isolation**: Spawns clean worktrees directly from the current commit to safeguard uncommitted changes in your main workspace, coupled with rigorous pre-cleanup checks upon archive.
- 🧪 **Real Verification & Audit Trail**: Runs actual verification commands (`pnpm test`, `go test`, linter, etc.) on the host machine, storing exit codes, duration, and output proof.
- 🧠 **Cross-Session Long-Term Memory**: Scoped memory per chat that survives `/new` resets and server reboots. Manual `/remember` storage plus background automatic fact extraction and periodic consolidation.
- 👥 **Group Collaboration & Ongoing Delegation**: Configurable group participation (`off`, `observe`, `selective`) and natural language recurring delegation (e.g., "Summarize today's progress every weekday at 6 PM").
  Set a Bot's default group participation to apply it to existing and newly joined groups without individual overrides. Groups can opt out or return to inheriting the default; saved overrides are preserved. Observation requires group read access, and Tag replies also require send access. Changes apply without restarting the listener.
  Tag can retrieve team context across readable groups joined by the same Bot, including observed messages, recent history, followups, and group memory. Replies identify source groups and partial coverage. Reading another group does not enable proactive participation there.
- 🔌 **Standard Agent Protocol Ecosystem**: Built-in standard `acpx@0.13.0` ACP support alongside a resilient PTY adapter for Claude Code and custom command-line tools.
- 🎛️ **Zero-Friction DevOps & Self-Healing**: Includes `dutydeck setup` (interactive onboarding), `dutydeck doctor` (actionable diagnostic suite), and `dutydeck autostart` (native OS service registration).

---

## ⚡ Quick Start <a id="quick-start"></a>

### 1. Prerequisites

- **Node.js**: `>= 22.12.0`
- **Package Manager**: `pnpm >= 11`
- **Agent CLI**: An authenticated CLI (e.g., Claude Code, Codex, or another ACP agent) installed on the local machine.

### 2. Installation & Setup

Install globally and run the guided configuration wizard:

```bash
# Install globally
pnpm add -g @byted/dutydeck --registry=http://bnpm.byted.org

# Run guided setup (detects local agents, configures workspace, and binds Lark bot)
dutydeck setup
```

> **Idempotent Setup**: `dutydeck setup` is safe to re-run anytime. It prompts to preserve or update existing settings and never leaves half-configured state. For CI or automated scripting, pass flags directly:
> ```bash
> dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes
> ```

### 3. Launching the Service

```bash
# Start background daemon
dutydeck start

# Check status
dutydeck status

# Run diagnostic check (suggests exact fixes for any failure)
dutydeck doctor
```

Once running, open your browser:
- **Web Console**: `http://127.0.0.1:4310` (Local access requires no authentication by default)

---

### 💡 Development Mode from Source

If you want to contribute or develop locally:

```bash
# 1. Clone repository and install dependencies
git clone https://github.com/bytedance/dutydeck.git
cd dutydeck
pnpm install

# 2. Prepare environment file
cp .env.example .env

# 3. Start development servers (hot-reload for both server and frontend)
pnpm dev
```

In development mode:
- **Web UI**: `http://127.0.0.1:4311`
- **Backend API**: `http://127.0.0.1:4310` (Vite automatically proxies API requests)

---

## 🤖 Lark Bridge Usage Guide <a id="lark-guide"></a>

The Lark Bot is the primary driver for Dutydeck. Once bound, you can steer entire software engineering cycles directly inside chat.

### 1. Core Interaction Lifecycle

```text
[Send message on Lark] ──────► [Receipt reaction: 👌] ──────► [Live progress card sent]
                                                                        │
┌───────────────────────── Agent requests permission or clarifies ◄────┘
▼
[Card displays "Approve / Reject" buttons] or [Question card: click to reply]
│
▼
[Task completes] ──────► [Progress card finalized] ──────► [Standalone result card sent]
```

- **Dispatching Tasks**: Send your requirement in a private 1-on-1 chat, or mention `@bot` in a group.
- **Continuing Conversations**: Once finished, simply reply to the result card or send a follow-up message to continue within the same session.
- **Inline Approvals**: When the agent attempts a privileged action (e.g., editing files, running bash commands), an interactive card allows you to click **Approve** or **Reject**.
- **Answering Clarifications**: If an agent needs more context, answer directly via the question card or type `/answer <card_id> <reply>`.

### 2. Common Lark Commands

| Command | Example | Description |
|---|---|---|
| `/help` | `/help` | Display list of available commands and actions |
| `/new` | `/new -- Fix memory leak in auth handler` | Close previous context and start a fresh task |
| `/new (Advanced)` | `/new --cwd "/data/app" --workspace worktree -- Refactor API` | Target a specific folder and spawn an isolated Git Worktree |
| `/tasks` | `/tasks 1` | View active, pending, and recently finished tasks |
| `/approve` | `/approve <card_id>` | Approve a pending sensitive action (same as clicking button) |
| `/reject` | `/reject <card_id>` | Reject a pending sensitive action |
| `/answer` | `/answer <card_id> Use option B` | Reply to an agent's clarifying question |
| `/cancel` | `/cancel` | Cancel or interrupt the currently running task |
| `/retry` | `/retry` | Re-run the previous task turn |
| `/remember` | `/remember Always use pnpm test for tests` | Store a long-term preference or fact for this chat |
| `/memory` | `/memory 1` | Paginate through saved long-term memories |
| `/forget` | `/forget <memory_id>` | Mark a memory entry as deleted |
| `/ci` | `/ci wait build.yml` | Watch GitHub Actions and resume agent when finished |

> **Syntax for `/new` options**: When passing command flags, you **must** separate them from the task prompt with a double dash `--`:  
> `/new --cwd "/path/to/repo" --model "gemini-3.8-flash-high" --effort "high" --workspace worktree -- Prompt content here`

---

### 3. Cross-Session Long-Term Memory

Dutydeck maintains a distinct, isolated memory bank for each chat (private conversations and group chats are strictly separated):

1. **Prompt Injection**: Every turn injects a compact index (`MEMORY.md`, ≤ 3,000 chars) into the agent's context.
2. **On-Demand Access**: Users can manually save facts via `/remember <content>`. Agents can inspect full details or search via `dutydeck memory show <topic>` or `dutydeck memory search <keyword>`.
3. **Automated Extraction & Consolidation**:
   - Every **3 completed turns**, a background read-only agent analyzes requests and final answers to extract persistent preferences, decisions, and environment facts.
   - Every **8 turns** (or when the index fills up), an optimization pass consolidates duplicates, retires obsolete records, and cleans up topics.
   - Strict safety gates enforce limits and prevent user instructions from being rewritten. You can also trigger an immediate consolidation with `/memory consolidate`.

---

### 4. Group Collaboration & Recurring Delegation

In project channels, configure the bot as an intelligent team member:

- **Participation Modes**:
  - `off`: Only responds when explicitly `@mentioned`.
  - `observe`: Silently reads message history to maintain context; never chimes in proactively.
  - `selective`: Stays silent by default without a mention. Replies to clearly addressed requests, verifiable follow-ups, or an evidenced urgent risk requiring immediate warning; an addressed request that needs a link read, a tool call, or a delegation change is handed to the executing Agent as if it were a mention. Peer conversations, undirected questions, progress updates, thanks, and uncertain intent receive no reply or acknowledgement reaction.
- **One mention is enough**: With `observe` or `selective`, replying to your own request that mentioned the bot or to the bot's reply, or continuing in a thread you started that the bot already works in, needs no further mention; messages from others, replies that mention someone else, or replies to other people's messages follow the rules above. If you forget the mention on a request, sending a bare mention within 10 minutes makes the bot act on that request without asking for confirmation. `/status` shows the group's participation mode.
- **Processing status and concurrency**: Accepted replies get an `OK` reaction on the source message while the answer is generated and sent, then the reaction is removed. Silent decisions stay invisible. Groups run independently; each group processes replies in order and coalesces pending messages before accepting a reply.
- **Layered execution**: Set the bot's "执行方式" (execution mode) to layered and pick a Leader and Workers. The mentioned default Agent then acts as PMO: it answers directly or hands code and test work to the Leader as a brief. The Leader plans read-only, assigns Workers, reviews the results last, and the result returns to the original thread. It applies to group chats only, and plans wait for "开始执行" (start). See [Tag layered execution](docs/tag-layered-execution.md) (Chinese).
- **Natural Language Delegation**:
  - `@bot Track a todo: submit the release ticket before 5:00 PM tomorrow.`
  - `@bot Summarize today's engineering progress in this group every weekday at 18:00 until cancelled.`
  - `@bot Check the build status every 2 hours and notify me only if it fails.`

---

### 5. Connecting a Lark Bot

#### Option A: Web One-Click Creation (Recommended)
1. Open the Web Dashboard (`http://127.0.0.1:4310`) and click **"Add Bot"** on the home screen.
2. Enter a name and click **"Create Bot"**.
3. Dutydeck automatically reuses your local Lark developer login (or displays a QR code to log in), creates the self-built app via open templates, configures event subscriptions and card callbacks, and publishes the initial version.
4. Select your preferred Agent and working directory, then enable listening.

#### Option B: CLI Quick Setup
```bash
# Create and connect a brand new bot
dutydeck lark create "DevBot" --agent ccflash --listen

# Bind an existing self-built app by App ID
dutydeck setup --lark-app-id cli_xxxxxxxx
```

---

## 🖥️ Web Console & Engineering Loop <a id="web-console"></a>

The Web Console provides full visibility into task queues, sandbox worktrees, and automated execution.

### 1. Task Board & Status Transitions
- Tasks are grouped into **"Needs Attention"** (waiting for approval or clarification), **"Running"**, **"Completed"**, and **"Archived"**.
- View collapsible tool calls, prompt timelines, error traces, and exact execution duration. An integrated terminal drawer provides real-time ANSI output playback (powered by Xterm).
- When an agent is busy, new instructions can be queued or triggered with **"Interrupt & Preempt"**.

### 2. Git Worktree Isolation
When creating tasks in the Web UI or specifying `--workspace worktree` via Lark:
- **Clean Isolation**: Spawns an isolated temporary Git worktree from the current HEAD commit, keeping your primary working directory untouched.
- **Strict Safe-Cleanup Gate**: Before removing an archived worktree, Dutydeck ensures:
  - No uncommitted or un-tracked changes exist (including skip-worktree/assume-unchanged files);
  - No unmerged commits exist;
  - No submodule conflicts or running locks remain.
  - Once verified, only the temporary folder is deleted, leaving the Git branch and all execution history intact.

### 3. Automated Verification Gate
Associate a verification command (`pnpm test`, `go test ./...`, etc.) with a Lark bot. When a turn finishes and that turn changed code (a worktree is compared with its source commit; a shared directory compares its code fingerprint at the start and end of the turn), the command runs automatically; the result card also offers a manual "Run verification" button:
- Executes on the host in the specific task directory with strict timeout (default 5m) and output caps (128 KiB).
- Captures real exit codes, runtimes, and code fingerprints. The result card header only says the run finished; verification status is a separate line (passed / failed / not verified). If later edits change the code, prior proof is marked expired. If the service restarts while an automatic verification is running, the card is marked as interrupted after restart and offers "Run verification" again.
- On failure, the truncated output is sent back to the agent as a repair turn, at most 2 rounds per request; after that the card stays marked as failed. Tool problems (command not found, spawn failure, timeout) also count as failed but are not sent back for repair.
- Bots without a command get a suggestion the first time a task finishes in a workspace, inferred from `package.json` (test / typecheck), `Makefile` (test target) or `go.mod` on the base branch (the worktree's source commit, or the default branch for a shared directory); one click on the result card saves it.

### 4. GitHub Actions CI Follow-Up
Trigger `/ci wait [workflow]` from Lark or Web:
- Dutydeck polls GitHub Workflow runs in the background (using `DUTYDECK_GITHUB_TOKEN`).
- Once finished, Dutydeck automatically wakes the agent with the build outcome, queuing fixes if the build failed.

---

## ⚙️ Agent Configuration <a id="agent-config"></a>

Dutydeck communicates with agents via the standard Agent Client Protocol (ACP) or terminal PTY adapters.

### 1. Custom Agent Configurations (`DUTYDECK_AGENTS_JSON`)

Configure custom agents via the `DUTYDECK_AGENTS_JSON` environment variable.

#### Example: Claude Code via an Internal Proxy / CPA Gateway
If your team uses an internal Claude proxy (e.g., Claude Proxy API):

```json
[
  {
    "id": "ccflash",
    "name": "CCFlash (Claude Code)",
    "protocol": "pty-cli",
    "adapterId": "claude-code",
    "command": "claude",
    "args": ["--settings", "/home/username/.claude/ccflash.settings.json"],
    "model": "gemini-3.8-flash-high",
    "permissionMode": "ask"
  }
]
```

Sample `ccflash.settings.json`:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8320",
    "ANTHROPIC_AUTH_TOKEN": "your-proxy-token",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gemini-3.8-flash-high",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gemini-3.8-flash-high",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.8-flash-high"
  }
}
```

> **Best Practices**:
> - Use `--settings` to pass custom configurations rather than modifying the global `~/.claude/settings.json`, preventing concurrent task conflicts.
> - `command` must be an absolute path or a binary resolved in your system `PATH`. Shell aliases are not supported.

#### Example: Custom ACP Agent
```json
[
  {
    "id": "custom-acp",
    "name": "My Custom ACP",
    "protocol": "acp",
    "command": "/usr/local/bin/my-agent-acp",
    "args": ["serve"],
    "permissionMode": "ask"
  }
]
```

---

### 2. Permission Postures Matrix

| Posture | Behavior | Best For |
|---|---|---|
| `ask` (Default) | Halts on dangerous actions (file writes, shell execution) and requests user approval on Lark/Web | Default recommendation for maximum safety |
| `approve-reads` | Automatically allows read-only tool calls (read files, list directories); write operations still require approval | Code review, auditing, and bug investigation |
| `deny-all` | Rejects any privileged action that requires privilege escalation | Strictly read-only exploration |
| `full-trust` | Skips all permission prompts (YOLO / fully autonomous execution) | **Only** for trusted, isolated CI/sandbox containers |

---

### 3. Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DUTYDECK_HOST` | `127.0.0.1` | Binding address; set to `0.0.0.0` for LAN access |
| `DUTYDECK_PORT` | `4310` | Daemon port |
| `DUTYDECK_LOCAL_ONLY` | `false` | When `true`, strictly binds to loopback `127.0.0.1` |
| `DUTYDECK_AUTH` | `true` | Requires Access Token auth (only set to lowercase `false` to disable) |
| `DUTYDECK_DEFAULT_CWD` | Launch folder | Default workspace directory |
| `DUTYDECK_DATABASE_URL` | `<cwd>/.dutydeck/dutydeck.db` | Local SQLite database location |
| `DUTYDECK_AGENTS_JSON` | `[]` | JSON array defining custom agents |
| `DUTYDECK_GITHUB_TOKEN` | - | GitHub Personal Access Token for Actions polling |
| `LARK_APP_ID` | - | Lark App ID |
| `LARK_APP_SECRET` | - | Lark App Secret (stored securely on the server) |

---

## 🛡️ Remote Access & Security

1. **Zero Exposure by Default**: Dutydeck listens strictly on `127.0.0.1` out of the box.
2. **LAN & Remote Access**:
   - Pass `--host 0.0.0.0` to open access across your LAN or behind a reverse proxy.
   - Remote access strictly enforces **Access Token Authentication**. View or rotate tokens with:
     ```bash
     dutydeck auth token          # View current token
     dutydeck auth token --rotate # Rotate token and invalidate existing browser sessions
     ```
   - Authentication sets an `HttpOnly; SameSite=Strict` cookie, keeping tokens out of URLs and frontend storage.
3. **Passwordless Mode Warning (`--no-auth`)**:
   - Only use `--no-auth` if Dutydeck is deployed behind a trusted identity-aware proxy (SSO / VPN).
   - **Never** expose an unauthenticated Dutydeck server directly to the public internet, as it grants full execution capabilities on the host!

---

## 🛠️ CLI Reference <a id="cli-reference"></a>

### 1. Daemon Management

Dutydeck runs as a system background daemon by default:

```bash
# Start background daemon
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]

# Check daemon status (PID, address, logs)
dutydeck status

# Restart daemon
dutydeck restart

# Stop daemon
dutydeck stop

# Update global package and cleanly restart service
dutydeck update
```

### 2. Diagnostics & Self-Healing (`doctor`)

Run health checks whenever something seems amiss:

```bash
dutydeck doctor
```

`doctor` verifies Node.js version, process health, port availability, SQLite access, folder permissions, registered agents, and Lark listen status. **Every reported error provides a copy-paste remediation command.**

### 3. Auto-Start Service Registration (`autostart`)

Manage OS-level service startup:

```bash
dutydeck autostart enable   # Register service (macOS launchd / Linux systemd --user)
dutydeck autostart status   # Check registration status
dutydeck autostart disable  # Unregister service
```

---

## ❓ FAQ & Troubleshooting <a id="faq"></a>

### Q1: The Lark bot does not react with `👌` or respond to messages.
- **Steps to fix**:
  1. Run `dutydeck doctor` to verify that the Lark persistent listener (`Lark Listen`) is active.
  2. In the Lark Developer Console, ensure the app has the **Bot** feature enabled and subscribes to `im.message.receive_v1` via WebSocket.
  3. Ensure the bot has been invited into the chat or channel, and verify that you `@mentioned` the bot in group chats.

### Q2: Seeing `Persisted key policy violation` errors?
- **Cause**: ACPX session options strictly enforce lowercase `snake_case` keys for all persisted configuration entries.
- **Fix**: Do not pass UPPERCASE environment variable names directly into `acpx.session_options.env`. The agent dock tools use `dutydeck_group_tools_url` and `dutydeck_group_tools_token`.

### Q3: `Agent command not found` error?
- **Cause**: The background daemon runs in a non-interactive shell environment and does not load aliases from `~/.bashrc` or `~/.zshrc`.
- **Fix**: Specify the full absolute path to the binary in `DUTYDECK_AGENTS_JSON` (e.g., `/home/user/.nvm/versions/node/v22.x/bin/claude`).

### Q4: Can I run multiple bots for different teams on one instance?
- Yes. You can register multiple bots in the Web Console. Each bot can bind its own default working directory, agent configuration, and target channels independently.

---

## 📚 Technical Docs & Architecture

- [End-to-End Acceptance Test Matrix](tests/e2e/README.md)
- [Generic Group Collaboration Implementation](docs/generic-collaboration-implementation.md)
- [Tag Layered Execution: PMO + Leader + Worker](docs/tag-layered-execution.md)
- [Collaboration Extensions Technical Specification](docs/collaboration-extensions.md)
- [Lark Session Memory Architecture](docs/lark-memory-design.md)
- [Legacy Data Import CLI Manual](docs/legacy-import-cli.md)
- [Full Product Parity Plan](docs/full-product-parity-plan.md)

---

## 📄 License & Third-Party Notices

Dutydeck core code is open source. Certain protocol adapters and terminal implementations evolved from early internal prototypes. For comprehensive third-party copyright notices and dependencies, please refer to [Third-Party Notices](THIRD_PARTY_NOTICES.md).
