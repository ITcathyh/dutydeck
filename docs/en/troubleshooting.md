# Known Limits & FAQ

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/troubleshooting.md)

## Known Limits <a id="known-limits"></a>

- **Allow rules in your local `~/.claude/settings.json` bypass Lark per-action approval.** Claude terminal sessions from Lark start in `default` mode, but `permissions.allow` rules still apply, and matching actions never produce an approval card. Clear those rules if you need strict per-action approval.
- **With `/plan`, pre-approved writes on the ACP side cannot be blocked.** Planning blocks writes by rejecting every permission request the agent sends. If Claude ACP has its own allow rules (e.g. in settings) or runs in bypass mode, those actions never ask Dutydeck. Don't pre-approve writes on the ACP side when you use `/plan`.
- **Credential protection matches rules; it is not isolation.** Rewriting a command (encoding, building the path, writing a script and running it) may get past it, and in full-trust mode senders outside the allowlist can still make the agent run any command as the local user. For bots open to others, use enforced mode or don't give them full trust.
- Cursor terminal sessions with raw-screen output only may show an answer in playback but still be recorded as failed because normalized final text is unavailable.
- The verification gate only applies to Lark tasks and needs a command configured.
- Traex terminal mode reports no usage; Codex terminal mode records per-turn tokens and estimated cost but is not yet counted against caps. Caps don't apply to either; cost figures are estimates.
- Plain token trigger auth has no timestamp or nonce and relies on HTTPS or an internal network; HMAC-signed requests carry a timestamp and a one-time nonce (see Plugins → Security).
- Draft pages are hidden unless "experimental features" is turned on.

---

## FAQ <a id="faq"></a>

**The bot doesn't react in Lark?** Run `dutydeck doctor` (it checks the Lark listener and each default Agent's `--version`); make sure the app has the Bot capability and a long-connection event subscription (`im.message.receive_v1`); in groups, `@` the bot unless the topic is already owned (levels above "mention only").

**`Persisted key policy violation`?** ACPX persists session options and requires `snake_case` keys. Don't write uppercase env names into session options.

**A custom Agent is missing or its command is not found?** The daemon does not read your shell aliases, and an Agent whose `command` cannot be found is not registered. `dutydeck doctor` names it; use an absolute path in `DUTYDECK_AGENTS_JSON` and `dutydeck restart`.

**Session fails because of per-action approval?** The Agent can't do Lark approval (only ACP and Claude Code / Seed / Relay terminal modes can). Either `dutydeck settings bot set <appId> permissionMode=full-trust fullTrustConfirmed=true`, or switch to an ACP / Claude terminal Agent.

**Several bots on one machine?** Yes; each has its own workspace, Agent and Lark credentials.

**Claude Code / CCFlash finished, but the Lark card reports missing tool results?** Older versions could interpret historical API request snapshots in CLI logs as current tool calls. After upgrading, these snapshots neither enter the execution timeline nor acknowledge the current prompt. Actual tool calls without results still cause a failure status.

**A Claude terminal session reports "Claude 启动尚未就绪（最后屏幕：X）" (startup not ready, last screen: X)?** Within 30 seconds Claude showed neither an empty composer nor a recognized confirmation page. The task was not written, so it is recorded as failed and can be resent after you deal with the cause. X is the category of the last screen:
- **目录信任页未能核对** (trust page could not be verified): the screen is on the folder-trust page, but its folder does not match the session folder, the page is incomplete, or under `full-trust` the page was recognized but the automatic confirmation keys never took effect. Open the terminal and confirm the folder; if the folder is not what you expect, check the working directory in the session or bot settings.
- **空白** (blank): the terminal shows nothing. Check that the Claude command starts, then read the daemon log (`journalctl --user -u <unit>`).
- **未识别** (unrecognized): the screen shows a prompt Dutydeck does not recognize. Open the terminal and handle the current prompt.

A long folder that breaks mid-word onto several lines of the trust page is still recognized as the current folder: under `ask` / `approve-reads` you get "Claude 正在确认此目录是否可信" (Claude is asking whether this folder is trusted) and confirm it in the terminal; under `full-trust` the folder is trusted automatically. A folder with spaces that wraps at a space may not be recognized; startup then times out with 目录信任页未能核对, and confirming trust once in the terminal is enough.
