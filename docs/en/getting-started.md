# 3-Minute Quick Start <a id="quick-start"></a>

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/getting-started.md)

## 1. Prerequisites

- **Node.js** `>= 22.12.0`, **pnpm** `>= 11`
- `tmux` for the default terminal backend; an explicitly configured Herdr backend remains supported.
- An authenticated Agent CLI (Claude Code `claude`, Codex, or another ACP agent)

## 2. Install and set up

```bash
pnpm add -g @byted/dutydeck
dutydeck setup
```

The wizard detects Agent CLIs, sets the default working directory and can bind a Lark bot. The default Agent and the App Secret are stored in the bot configuration (the same one the Web panel shows), not in `.env`; the secret is prompted with hidden input. When creating a bot interactively it asks whether to start listening now (default yes).

New bots use `ask`. The selected Agent must support Lark approval (ACP or Claude Code / Seed / Relay terminal mode). Otherwise, the wizard leaves the bot configuration unsaved and asks you to rerun with `--agent <id>` using an Agent with approval support; it never enables full trust automatically. Any Open Platform binding already completed remains in place.

Non-interactive:

```bash
dutydeck setup --cwd /path/to/project --port 4310 --skip-lark --yes

# Bind a Lark app; read the secret from a pipe, never from argv
printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxx --lark-app-secret-fd 0 --agent claude --listen --yes
```

`--agent <id>` sets the default Agent (must be a detected CLI), `--lark-app-secret-fd <fd>` reads the secret from a file descriptor, `--listen` also enables listening. A running service needs `dutydeck restart` to pick up the new bot configuration.

After the bot is configured, interactive setup offers the delivery check through a dedicated default-No question; declining starts no listener and sends nothing. After you accept and the temporary listener is ready, the terminal shows a one-time UUID. Send that code to the bot in a Lark direct message. Only a user DM containing this UUID within the bounded wait is accepted; the bot then replies to that message with the same UUID. Lark accepting the reply means inbound passed and outbound was sent, not that you received it—confirm receipt in Lark. A timeout means inbound is unverified and nothing was sent. `--yes`, non-interactive mode and `--json` skip the check. The flow does not change bot scopes or persist a user's open_id.

If the shell says `dutydeck: command not found`, your package manager's global executable directory is not on `PATH`. For pnpm, run `pnpm setup`, follow its PATH instructions and restart the terminal. For npm, use `npm prefix -g` to locate the global prefix and add its executable directory to `PATH`. Alternatively, leave `PATH` unchanged and run `pnpm dlx @byted/dutydeck setup` or `npx @byted/dutydeck setup`.

When rerun in a directory that already has a `.env`, the wizard shows values on screen only for the settings it manages: default working directory, port, host, local-only and Lark App ID. The App Secret shows only its last 4 characters; other `.env` keys (such as `DUTYDECK_AGENTS_JSON`) are listed by name without their values.

## 3. Start and check

```bash
dutydeck start
dutydeck doctor    # runs `--version` on each bot's default Agent (5s timeout, no model call); with no .env in the current directory it falls back to the directory in last-daemon-dir and says which one it read
dutydeck status
```

The `terminal.backend` doctor check also runs the tmux version command and creates, verifies and exits a session on a private temporary socket; it never connects to the default tmux server. Every invocation uses `-f /dev/null`, `XDG_CONFIG_HOME` points to a private directory, and the test session runs only a controlled keep-alive command, so `/etc/tmux.conf`, XDG configuration and a user's `default-command` are not loaded. If tmux is missing, install it or fix `PATH` as shown in the remedy. Configurations that only use ACP, or explicitly use Herdr, do not treat missing tmux as fatal.

Web console: `http://127.0.0.1:4310` (no login for local requests).

An interactive foreground start with no readable bot configuration prints `setup`, `doctor` and the actual Web address below the listening address. It does so whenever that condition holds; no “already shown” state is stored. `--json`, non-TTY output and daemon children omit the guidance.

## Development from source

```bash
git clone https://github.com/ITcathyh/dutydeck.git
cd dutydeck
pnpm install
cp .env.example .env
pnpm dev
```

Frontend `http://127.0.0.1:4311`, backend `http://127.0.0.1:4310`.
