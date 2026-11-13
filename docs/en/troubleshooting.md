# Known Limits & FAQ

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/troubleshooting.md)

## Known Limits <a id="known-limits"></a>

- **Allow rules in your local `~/.claude/settings.json` bypass Lark per-action approval.** Claude terminal sessions from Lark start in `default` mode, but `permissions.allow` rules still apply, and matching actions never produce an approval card. Clear those rules if you need strict per-action approval.
- **With `/plan`, pre-approved writes on the ACP side cannot be blocked.** Planning blocks writes by rejecting every permission request the agent sends. If Claude ACP has its own allow rules (e.g. in settings) or runs in bypass mode, those actions never ask Dutydeck. Don't pre-approve writes on the ACP side when you use `/plan`.
- **Credential protection matches rules; it is not isolation.** Rewriting a command (encoding, building the path, writing a script and running it) may get past it, and in full-trust mode senders outside the allowlist can still make the agent run any command as the local user. For bots open to others, use enforced mode or don't give them full trust.
- **The high-risk command pattern matches raw text; it is not a sandbox.** Quoting, backslashes, path prefixes or subshells (e.g. `"rm" -rf`, `\rm`, `/bin/rm`, `$(rm …)`, `git 'push'`) may get past it, and so does an option in between such as `git -C . push`. It narrows exposure, like credential protection.
- Cursor terminal sessions with raw-screen output only may show an answer in playback but still be recorded as failed because normalized final text is unavailable.
- The verification gate only applies to Lark tasks and needs a command configured.
- Traex terminal mode reports no usage; Codex terminal mode records per-turn tokens and estimated cost but is not yet counted against caps. Caps don't apply to either; cost figures are estimates.
- Plain token trigger auth has no timestamp or nonce and relies on HTTPS or an internal network; HMAC-signed requests carry a timestamp and a one-time nonce (see Plugins → Security).
- Draft pages are hidden unless "experimental features" is turned on.

---

## FAQ <a id="faq"></a>

**The bot doesn't react in Lark?** Run `dutydeck doctor` (it checks the Lark listener and each default Agent's `--version`); make sure the app has the Bot capability and a long-connection event subscription (`im.message.receive_v1`); in groups, `@` the bot unless the topic is already owned (levels above "mention only").

**The long connection dropped and never came back?** The Lark SDK reconnects on its own first. If a reconnect stays stuck (e.g. a proxy accepts the connection but never answers) for more than 10 minutes, Dutydeck rebuilds just that long connection without touching running sessions, and rebuilds it again after the same interval if it is still stuck. Set the interval with the daemon environment variable `DUTYDECK_LARK_RECONNECT_STALL_MS` (milliseconds, minimum 60 seconds, `0` turns it off). When `doctor` says "Dutydeck 已在 … 重建长连接，仍未恢复" (the long connection was rebuilt at … and has not recovered yet), check the network and proxy path to the Lark Open Platform.

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

**The tmux socket was deleted but the old terminal is still running?** On Linux, `/tmp` cleanup can remove the tmux socket file while its server and panes survive. Dutydeck refuses to start a second server for that name, so two CLIs cannot operate on one conversation. Follow the tmux manual to send `SIGUSR1` to the original server and rebuild the socket, or end that server before sending the message again. Point `TMUX_TMPDIR` at a directory that is not cleaned, or exclude the tmux directory from `systemd-tmpfiles`. Non-Linux systems keep the previous behavior because this kernel check is unavailable. With `remain-on-exit`, the next start reaps a Dutydeck-owned session only when every pane is dead; sessions with any live pane stay available for inspection.

**Logging in or out on different ports of one host affects the other port?** Upgrade to the version with port-scoped cookies. A Host with a valid explicit port uses `dutydeck_access_<port>`, while a Host without one keeps `dutydeck_access`. Legacy cookies are accepted only after validation against the current instance. With an explicit port, an additional shared legacy cookie is cleared only after such validation; the same-named cookie without an explicit port keeps the existing logout behavior. After a rollback, a browser with only the new port-scoped cookie must log in again; never copy another instance's token into this one.

**How do I retry a lost send response without executing twice?** For queue or interrupt, if the server accepted the submission but the client missed the response, retry the same unchanged draft snapshot: the idempotency key returns the original task. Editing the submission, intentionally sending again after acknowledgment, or choosing “requeue at the back” creates a new task. `steer` is never retried automatically. After an unknown steer outcome, inspect the existing tasks and execution record before deciding what to do next; do not immediately resend.

**An answer is visible, so why did the turn still fail?** Distinguish final text from opening text before a tool call. Only a repeated non-terminal `tool_call` with the same non-empty id is ignored, and only when that tool started before the final text. Opening text such as "I'll take a look" is not a final answer. A later `tool_result`, `thinking`, a call with no id or a different id, or a terminal call remains a boundary: without newer final text, the turn still fails. This interpretation does not change the stored events or output digest.

**Why did a successful verification or schedule pre-check used to time out, and what does a cleanup error mean now?** The old executor kept the main timer running until every pipe closed, so a background descendant holding stdout or stderr could produce both exit code 0 and a false timeout. The main shell's `exit` now settles the main process, and that false timeout no longer occurs. A pre-check previously blocked by it may now pass and fire one schedule occurrence. Dutydeck still waits for same-group processes to exit and for pipes to drain within a bounded cleanup period. A surviving group or undrained observable pipe produces a cleanup error and blocks the run; check for background descendants and inherited pipes. A descendant that both leaves the process group with `setsid` and redirects its pipes cannot be proven cleaned up by this executor. Once a pre-check passes, one occurrence advances once and recovery continues with the original idempotency key without rerunning that passed command.

**How are completion notices and run counts matched after resuming a Claude background Agent?** A `resumedAgentId` or `revivedAgentId` starts a new generation only when its notification timestamp is strictly later than the latest completion. A late notice from an older generation stays with that generation and cannot complete the new one; duplicate notices and transcript replays do not count twice. Equal or missing timestamps and ambiguous source order never cause a guessed revival. If the Claude version does not write these fields, an old notice alone does not create a new generation and Dutydeck does not resend the follow-up instruction.

**Will a schedule retry in a fresh session or become disabled when the Agent environment is temporarily unavailable?** `AGENT_UNAVAILABLE` has its own classification: the occurrence and coalesced same-cause notices are recorded, while the schedule stays enabled for the next normal scheduled time. There is no fresh-session retry and no streak-based disable for this classification; the streak clears after a successful run. Accepted or unknown work is reconciled rather than replayed. Model-content failures, permission denials, user-requested stops and other environment errors retain their existing policies. If the problem persists, run `dutydeck doctor` to check the Agent command and availability.

**How should scheduler counts and duration logs for a slow work item be read?** While an earlier tick is still making progress, later one-second callbacks are skipped rather than wrapped again. Logs therefore record real progress and its duration, not a stack of wrappers; this is not a throughput claim. After a rejected tick, a later normal tick can continue. Direct calls to the same tick still share the original Promise, and persistent state and recovery semantics are unchanged.

**No UTF-8 locale on the host?** Dutydeck forces every tmux client it launches to use UTF-8 (`-u`), so terminal sessions are still detected correctly and Chinese or other non-ASCII text is not replaced with underscores because of the host locale.
