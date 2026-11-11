# CLI Reference <a id="cli-reference"></a>

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/cli.md)

Before ending a turn, agents can run `dutydeck session report --status waiting --question "一个具体问题"` or `--status blocked --summary "一句原因"`. These reports appear in Lark `/tasks`, the web attention list, and the first line of the result card. Starting the next turn or handling the task through existing actions clears the report. `ready` means done (no report is required by default); `dropped` means no action is needed. Continue using `session ask --choices` for fixed choices that block until answered.

Ordinary `session ask` generates a `requestId` and writes it to stderr before connecting. Stdout still contains only the answer; `--json` includes the identity. Use `--request-id` to supply an ID you have saved. Reusing an ID in the same session requires the same question, full body, choices, timeout and original task/attempt; conflicts are rejected and the deadline never moves. The default is 300 seconds, with a maximum of 86400 seconds for persistent ordinary questions. Legacy requests without an ID retain their one-hour limit; native permission requests retain their own deadlines.

```bash
dutydeck session ask "Continue checking?" --request-id check-1 --timeout 86400
# Read the saved question and answer after disconnection or a server restart:
dutydeck session ask-result check-1 --json
# Wait again while the original attempt remains valid, without publishing or dispatching again:
dutydeck session ask-wait check-1
```

`ask` / `ask-wait` exit codes: 0 means an answer was returned and the original attempt can continue, 124 means expired, 2 means invalid usage, and 3 means unavailable, cancelled or an ended/unknown original attempt. `ask-result` includes `continuation=available|ended|unknown`. A successful query only confirms that a record was read; a historical answer does not authorize the next shell command. Current session credentials, permissions and the original task/attempt must remain valid. Stopped or archived session credentials cannot query results. HTTP disconnection and service shutdown preserve the question; ending its original attempt, revocation or expiry prevents continuation. Answers commit before display; display failures neither lose an answer nor reopen voting.

ADHD Lark structured confirmations retain their existing 24-hour card, same-session new turn after a click, and deferred acknowledgement. They do not return an answer to the original call.

```bash
# Daemon
dutydeck start [--cwd /path] [--port 4310] [--host 0.0.0.0]
dutydeck status | restart | stop | update | doctor   # doctor warns when the daemon runs as root (in full-trust mode the Agent then has whole-machine access; if no running daemon is found it checks the current command) and when a model has no price, so usage caps do not cover it (configured bot models other than aliases such as `opus`, plus models the usage ledger failed to price in the last 30 days); it also notes a large share of free pages in the database file

# Immutable release deploy and cleanup
dutydeck deploy --source /path/to/checkout
dutydeck deploy prune --releases /path/to/releases --dry-run     # preview what would be deleted and the space freed
dutydeck deploy prune --releases /path/to/releases [--keep 5] [--include-unmarked]

# Autostart (Linux systemd --user / macOS launchd)
dutydeck autostart enable | status | disable
#   Both the Linux unit and the macOS LaunchAgent run `start --foreground` in the daemon root and append to .dutydeck/daemon/dutydeck.log.
#   systemd restarts it on crash (Restart=always); launchd restarts it after a non-zero exit (KeepAlive.SuccessfulExit=false, at most every 30 s),
#   not after a clean `dutydeck stop` and not while another instance is already running. LaunchAgents registered by older versions run in
#   background mode with no restart; `autostart status` reports them as drifted, so rerun `autostart enable` and log in again.
#   Under launchd, `dutydeck restart` drains and waits for tasks as usual, then runs `launchctl kickstart -k gui/<uid>/com.dutydeck.server`:
#   launchd stops the old process and starts a new one from the plist, which it keeps watching. Server flags on the command line cannot be
#   passed through; put them in the root `.env`. If the job is not loaded (for example autostart was disabled), the CLI starts a background
#   process as before.
#   PATH is merged, not replaced: rerunning enable writes the current shell's PATH (in order) followed by entries of the old unit/plist PATH
#   that are missing from it and still exist; duplicates keep their first position, Agent-session temp dirs containing `/tmp/arg0/` are
#   dropped from both sides, and the node binary's directory is appended when absent. A first enable also dedupes, drops `/tmp/arg0/`
#   entries and appends the node directory, otherwise keeping the shell's order. Drift checks ignore PATH: when the current shell has
#   directories the unit/plist lacks, status and doctor show one note; rerunning enable merges them in.
#   Merging only adds, so rerunning enable from a narrower PATH does not narrow it. To narrow, edit `Environment=PATH=` in the unit (Linux:
#   then run `systemctl --user daemon-reload` and `dutydeck restart`) or `PATH` in the plist (macOS: takes effect at next login), or run
#   `dutydeck stop` and `dutydeck autostart disable` (on Linux this deletes the unit file), then `dutydeck autostart enable` from the shell
#   you want. A later enable from a wider shell merges the extra directories back in.
#   `autostart disable` refuses while the daemon is running (removing the macOS job would stop it); run `dutydeck stop` first.
#   When run through the `<releases>/current` symlink, enable and status compare and write the `current` path instead of pinning the unit to
#   that release; a unit still naming an older release while `current` points elsewhere is reported as drifted.

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
dutydeck settings approval-rules list [--app cli_xxx] [--workspace .]  # workspace approval rules per bot (path compared by real path)
dutydeck settings approval-rules remove war_xxx        # revoke a rule; the next matching command asks again
dutydeck settings terminal-backend [tmux|herdr]

# Access
dutydeck auth password set [--generate]   # browser login password
dutydeck auth token [--rotate]            # token for CLI/scripts/API
dutydeck auth share-key rotate
```

`auth` commands write to `--database` when given, otherwise to `DUTYDECK_DATABASE_URL` (relative paths resolve against the Dutydeck root, as for `start`), otherwise to the database of the running daemon whose process identity is verified; state left behind by a crashed daemon is ignored and the root's default `.dutydeck/dutydeck.db` is used. The output includes `database`, the file that was written. `secret` and `lark create` follow the same rule.

To bind an international Lark app, use `dutydeck settings bot add <app-id> brand=lark --app-secret-fd 0`. Unless `LARK_OPEN_API_BASE_URL` overrides the service address, `brand=lark` validates credentials against the international Lark domain; omitting the brand defaults to Feishu. `brand`, App Secret and member lists share the credential-validation step. Submit default Agent, permissions or listening changes separately. With the Lark task dispatch channel enabled (`LARK_TASK_AGENT_ENABLED`), Dutydeck checks the bot's currently saved requester lists (`allowedUsers` / `allowedEmails`) and listening switch before each poll and when handing a task to message processing. Clearing both lists or turning listening off stops intake; an in-flight task whose handoff check sees the channel closed is returned for later dispatch and can be processed without duplicate dispatch when it reopens. Tasks that have already passed the handoff check are not withdrawn. Adding a list enables intake without a restart. An empty list still means open to everyone for ordinary direct messages.

`ou_` identities are application-scoped. Switching applications validates inherited owners and high-risk approvers against the target app, even when those lists are omitted. Definitively invalid identities reject the save without changing the saved configuration or revision. Peer bot IDs must be resolved by name through the target app or explicitly cleared. All Web and CLI save steps use the same identity boundary; temporary network or Contact-scope failures remain inconclusive rather than definitively invalid.

When the service fails to start or crashes while running, it writes `last-abnormal-exit.json` next to its database (time, kind, exit code, redacted first line of the error, version and database path); nothing is written while the database directory does not exist yet, and never into another instance that `last-daemon-dir` points to. When `dutydeck doctor` finds such a record from the last 7 days for the same database, it appends one sentence to the daemon item, "X 小时前异常退出（…）" (abnormal exit X hours ago): "已自动恢复" (recovered) when the current instance is ready and started after it, otherwise a pointer to journalctl. The item's level does not change, and the output is unchanged when there is no record.

`restart` first holds queued work. Successfully submitted `full-trust` tmux turns with verified recovery logs and original turn identity keep running in the same CLI process; the new service adopts the original turn without resending input. Other running tasks still drain, including ACP, plain PTY, Herdr, submissions in progress, missing recovery evidence, pending approvals and unauthorized high-risk gates. With systemd, preservation requires the current `KillMode=process`; other or unknown values use a full drain. Older services without recovery counts, failed drain requests and failed lease renewals also use a full drain. `--drain-timeout`, `--force` and automatic exclusion of the invoking Agent session retain their existing behavior. `deploy` uses the same preservation policy; ACP and other non-preservable tasks still drain. A restarted service starts serving HTTP as soon as initialization finishes and connects Lark long connections in parallel in the background. After `/health` passes, `deploy` and `restart` also wait for `/health/ready` to report ready, meaning the startup Lark long-connection sync has an outcome (connected, or failed with a retry scheduled), before treating the restart as complete and moving on to the next unit; a Lark outage that prevents connecting does not trigger a rollback. Older versions without `/health/ready` are checked with `/health` only. The "飞书消息监听已连接" log entry carries `connectMs` (milliseconds): `identity` (bot identity lookup and SDK load), `recovery` (inbound records left by the previous process), `reconcile` (card reconciliation) and `total`. The Web retries a dropped stream at most every 5 seconds. Agent group tools and relay commands (`dutydeck send`, `ask`, `report` and others) wait up to 90 seconds, never beyond the request's own deadline, when the connection is refused; requests that may already have arrived are not retried. With [systemd socket activation](#socket-activation), HTTP connections made during a restart wait in a queue instead of being refused.

The `codex` entry defaults to terminal mode; `codex-cli` remains available for compatibility. Existing ACP sessions continue through ACP, while new sessions use the current default protocol. Bot permissions are never raised automatically. Terminal Agents such as Codex that lack Lark per-action approval reject new Lark sessions under `ask` / `approve-reads`; choose the built-in “Codex (ACP)” (`codex-acp`), or choose a terminal Agent with approval support, such as Claude Code / Seed / Relay. Only tmux tasks already authorized for `full-trust` and backed by complete recovery evidence can continue across a service restart. A first submission without a known transcript path still drains. An adopted task that finishes fires the plugin `task.completed` hook, trigger result delivery and the trigger run status update once, as other tasks do; one that is stopped or whose result stays unknown fires none of them. Safe restart and deployment drain also wait for native background tasks that remain after the main turn completes; direct process termination and `--force` do not provide this guarantee.

**Shutdown**: on a stop signal the service closes its modules in order and, when done, logs one "停服各阶段耗时" entry (`shutdownMs`, milliseconds, such as `runtime`, `http`, `database`). If it is still not done after 12 seconds it exits with code 1 and logs the phases that had not finished (with how long they had been running), the phases that had not started, and the durations of finished phases. 12 seconds is below the unit's `TimeoutStopSec=15`, so the process exits with this information before systemd kills it.

**Concurrent starts**: the service process takes an exclusive lock on its daemon directory (`.dutydeck/daemon`) before writing the state file and holds it until exit. When two `start` commands run against the same directory at once, only one starts and the other reports that Dutydeck is already running. The lock is released when the process exits, including when it is killed, so there is nothing to clean up. The state file is written to a temporary file and renamed, so `status` and other commands never read a half-written file.

**Daemon log rotation**: when `.dutydeck/daemon/dutydeck.log` exceeds 10 MB it is rotated to `.1` (keeping `.1`–`.3`) right before a new process opens it: before a detached start, and before `start`, `restart`, `restart --unit` and `deploy` call `systemctl start` or `restart`. The last lines the old process writes while stopping land in `.1`. Automatic restarts by systemd after a crash do not rotate; the next restart or deploy does.

`GET /api/system/activity` counts sessions with an active main turn or native background tasks remaining after the main turn in `runningTasks`, once per session. Add `?restart=true` to verify recovery evidence and receive `restartBlockers` and `recoverableTasks`; no tasks are deducted unless queue claiming is held. `excludeSessionId` applies to all three counts.

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

- **Web assets**: the build writes `.br` and `.gz` copies of text files such as JS, CSS and HTML. When the browser accepts one of these encodings the server sends the compressed copy (with `Content-Encoding` and `Vary: Accept-Encoding`); otherwise, or when the request carries `Range`, it sends the original file. HEAD requests check file readability and size and return the same headers as GET without reading the file body.
- **Generate a systemd unit**: `dutydeck deploy --unit <unit> --releases "/path/with spaces/releases" --print-unit` only prints the unit rewritten to use `releases/current/dist/cli.js`; it writes no file and deploys nothing. The generated entry quotes paths containing spaces and preserves the Node path and original service arguments.
- **Deploy**: drain → switch `releases/current` → restart → health check. On a failed health check the service is stopped first. When multiple units share the same `current`, the rollback target is the release the target unit was actually running; the switch is refused if that version cannot be verified. When the target is stopped, a past successfully deployed release is a rollback candidate only when its database schema matches the current one. Automatic rollback still requires an unchanged schema; if the schema changed, automatic rollback stops to protect the data, and an old database snapshot is never restored.
- **Refused without address or database**: when the target unit has no usable health-check address or database path recorded (for example after `dutydeck stop`), deploy is refused without switching versions or restarting. Start the unit so it records them, or point `--runtime` at a `deployment.json` with `address` and `databasePath`.
- **Failure and interruption**: when a deploy fails, throws, or is interrupted by Ctrl-C / kill / a dropped ssh session, it writes a deployment record with `status: failed` (signals are also recorded in `aborted_by`) and waits for all drain renewals already sent to finish before taking the old service out of draining. New tasks resume without waiting for the lease to expire, and a late renewal cannot pause the service again. After an interruption it no longer switches releases, restarts or rolls back.
- **Startup timing**: once listening, the service logs one "启动各阶段耗时" entry (`startupMs`, milliseconds): `boot` (process and module load), `plugins`, `config`, `database` (open), `migrate`, `wiring`, `insight`, `integrations`, `relay`, `agentDefaults`, `agents` (agent registration), `sessions` (session recovery and reconciliation), `routes`, `listen`, plus `total`.
- **Concurrent deployment and cleanup**: operations sharing the same real release root are mutually exclusive, including deployments for different units, `--no-restart` and manual `deploy prune` (including `--dry-run`). A later command reports that the root is busy and refuses to proceed; retry after the active operation finishes. Different release roots operate independently.
- **Drain held during backup**: after draining, deploy backs up the database before switching versions and renews the drain every 5 seconds meanwhile. If a renewal fails, or tasks are running again when the backup finishes, deploy leaves `current` unchanged, does not restart, keeps the old service running and records a failure with the reason. Deploy again after those tasks finish, or add `--force` if interrupting them is acceptable.
- **Cleanup**: after each successful deploy the newest 5 releases are kept, and the newest 5 deployment records are kept per unit; only the newest 2 records of each unit (including this one) keep their database backups, so deploying several units under one release root in turn does not push out each other's backups. Older records lose just the backup files and keep `manifest.json`; records whose `manifest.json` has no unit never lose their backups to this count. Records created by deploy that still have no `manifest.json` after 24 hours (left by a force-killed deploy) do not count toward the limit and are deleted. `current`, its previous release and releases still referenced by running processes are always kept; both automatic cleanup and manual `deploy prune` additionally keep the most recent successfully deployed release of each unit. Cleanup failures only warn. Records from manual deployments (no `created_by: dutydeck deploy` in `manifest.json`) are left alone unless you pass `--include-unmarked`, and even then skipped when referenced by a process or modified within the last hour. `.partial` directories modified in the last hour are skipped too.
- **History retention**: every hour the service trims old data in batches, touching only finished tasks; unfinished, result-unknown and legacy sessions awaiting retirement are left alone. Terminal-mode turns older than 30 days keep only their last screen; session-state snapshots stored by older versions and tool-call mirrors older than 30 days are deleted; revision records of group policies, bindings, chat facts and roles keep the latest 20 per item. Event rows themselves are kept, so Web history stays complete and contiguous. For older databases with gaps in terminal output, the Web can still expand turns, raw logs and execution traces and show the remaining records; reads that stop before the requested end or return invalid pages still fail and can be retried. No `VACUUM` is run, so the database file does not shrink and freed space is reused by later writes; to shrink the file, follow [VACUUM during downtime](#vacuum). `dutydeck doctor` notes it once free pages make up at least 30% of the file and at least 64 MB; it never runs VACUUM itself.
- **Splitting bot data**: `scripts/split-bot-runtimes.mts` moves idle terminal state, blocked-queue and unknown-result reminders, and overdue schedule reminders into the database of the bot that owns the session. Unknown records or records whose owner cannot be established still block the split.
- **systemd service root and database resolution**: For units that invoke `node cli.js` directly, management commands (`restart`, `status`, `deploy`, and others) resolve the target database and listen address in this order: explicit ExecStart arguments, unit environment, then `WorkingDirectory/.env`. Relative working directories are based on `WorkingDirectory`. Unit environment covers both `Environment=` and `EnvironmentFile=`; environment files are parsed with systemd's quoting and comment rules and override `Environment=` in order. A missing `.env` is allowed; unreadable files or invalid critical settings cause the operation to be refused. An `EnvironmentFile=` is skipped only when it has the `-` prefix and does not exist; any other unreadable file, a relative or glob path, or an unparseable `Environment=` entry also refuses the operation. An unset database defaults to `<cwd>/.dutydeck/dutydeck.db`. Deployment backups and schema rollback checks use that same actual database. Foreground daemons continue to use daemon state, and explicit `deploy --runtime` metadata retains priority.
- **systemd socket activation** <a id="socket-activation"></a>: between the old process closing its port and the new one listening, Web requests and Agent relay calls are refused. Give the unit a `.socket` of the same name and systemd holds the port instead, queueing connections in the kernel until the new process takes over. The service uses a listening socket passed by systemd (`LISTEN_FDS`) and otherwise binds the port itself.

  ```ini
  # ~/.config/systemd/user/<unit>.socket: address and port must match the service's --host/--port; exactly one ListenStream=
  [Socket]
  ListenStream=127.0.0.1:4310
  FreeBind=true

  [Install]
  WantedBy=sockets.target
  ```

  ```ini
  # ~/.config/systemd/user/<unit>.service.d/socket-activation.conf
  [Unit]
  Requires=<unit>.socket
  After=<unit>.socket
  ```

  Then run `systemctl --user daemon-reload && systemctl --user enable <unit>.socket` and switch over with `dutydeck restart --unit <unit>`: systemd stops the old process, starts the `.socket` and hands it to the new process. Deploy a version that includes this feature first; older versions ignore the passed socket, try to bind the same port and fail to start. Once enabled, `restart` and `deploy` restart only the service and leave the `.socket` running; `dutydeck stop` and the stop during a deploy rollback also stop the `.socket`, since otherwise the next connection would start the service again; `dutydeck start` starts both. The service refuses to start when systemd passes more than one socket or a port that differs from `--port`. The passed socket stays with the service process and is not inherited by tmux, Agents or other children. To revert, run `systemctl --user disable --now <unit>.socket`, delete the `.socket` file and the drop-in, `daemon-reload`, then `systemctl --user start <unit>`; the service binds its port itself again. Keeping verified recoverable tmux turns across restarts also needs `KillMode=process` (units generated by `dutydeck autostart` already have it); any other value kills tmux and Agents in the unit cgroup on stop, so restarts wait for every task to finish.
- **Remote access**: Dutydeck listens on `127.0.0.1` by default. With `--host 0.0.0.0`, browsers log in with the password from `dutydeck auth password set`; CLI and API use the access token. After signing out you can log in again directly with the same password. After the token is rotated or the password is reset, live streams and terminal connections opened with the old credential (including ones forwarded to other instances) close within 10 seconds. Never use `--no-auth` on a reachable address.
- **Credential protection**: once a bot is open to others, it keeps group members from getting the agent to reveal local tokens, keys and agent session records. It follows the bot's risk control setting and only restricts senders outside the high-risk allowlist and other bots; people on the list work as before, including full-trust mode.
  - Guidance: the agent gets a rule not to read, copy, print or send credentials and agent session records (such as `~/.claude`, `~/.claude.json`, `~/.codex`), and to refuse in one sentence when asked.
  - Enforced: tool calls are also checked first. Reading or writing credential files and session records (such as `~/.codex/auth.json`, `~/.ssh` private keys, `.env`) or printing secret environment variables is blocked; the command does not run and the agent gets the reason. For Claude Code (terminal and ACP) and Codex terminal sessions in full-trust mode, the check is passed in the launch arguments of that agent process only; global config under `~/.claude` and `~/.codex` is not changed. Codex over ACP is checked by the workspace hook; Cursor, Trae and Pi are also checked by workspace hooks (a project extension for Pi), applying the same rules to command tools (such as Cursor `Shell` and Pi `bash`) and file tools. The turn's risk policy files (under `.dutydeck/`) and these hook configs (`.codex/hooks.json`, `.cursor/hooks.json`, `.trae/hooks.json`, `.claude/settings.json`, `.pi/extensions/`) are protected too, so the agent cannot disable the guard before running a command. A hook whose files differ from what this version generates shows as not installed and must be reinstalled.
  - Codex workspace hooks (including `codex-acp`) are ready only when native Codex loads and enables the generated hook and trusts its current content hash. A `hooks.json` file alone is insufficient. Enforced saves and session starts check `config/read` and `hooks/list` without a model turn; unsupported RPCs, errors and a 5-second timeout refuse execution. Using the Agent's `CODEX_PATH` / `CODEX_HOME`, confirm trust for the target workspace, review only the Dutydeck PreToolUse hook in `/hooks`, then choose **重新检查 Hook** in the Web. Dutydeck never trusts a project or other hooks automatically.
  - For Claude Code terminal agents (including custom agents whose adapter is `claude-code`, such as ccflash) and ACP Claude launched by Dutydeck, the same check also enforces the high-risk pattern, so enforced mode needs no workspace hook. A custom ACP Claude must launch with the released `dist/agents/claude-acp.mjs`; an old copy made elsewhere does not include the check.
  - In every mode, Lark cards, results and group tool messages replace common secret formats (such as `sk-ant-`, `ghp_`, JWTs) and secret values from the service and agent environments with `[REDACTED]`. Lark card tags written by the agent in replies or approval requests (such as `<at id=all></at>`, `<text_tag>`, `<font>`) are shown as text; they do not mention anyone or render as colored tags.

## Bot setting keys

Every key accepted by `dutydeck settings bot set <app-id> key=value ...` is listed below; `dutydeck settings bot show` prints the current values. Omitted keys keep their values. Booleans are `true` / `false`; lists accept comma-separated values or a JSON array. The default is what the server uses when a saved configuration lacks the key.

| Key | Effect | Default |
|---|---|---|
| `eventHandlers` | External HTTP handlers for Lark events (card clicks, incoming messages), called in array order; see above. `null` or `[]` disables | None |
| `cardLinks` | Extra links on progress and result cards, at most two; see Commands for external programs; `cardLinks=` clears | `[]` |
| `cardActionForwarding` | Legacy card-callback forwarding, still supported; cannot be enabled together with a non-empty `eventHandlers` | None |
| `welcomeEnabled` | Send a welcome when joining a group and on the first direct message | `true` |
| `workspace` | Default working directory for new sessions; must be absolute | None |
| `workspaceAliases` | Alias table for `/new --cwd <alias>`, a JSON object `{"alias":"/absolute/path"}` | None |
| `webBaseUrl` | Console address used for “查看详情” and other Web links on cards | A new bot reuses an existing bot's address |
| `webMobileReachable` | Whether phones can open `webBaseUrl`; `false` stores no address and cards show no “查看详情” | `true` |
| `displayName` | Custom display name, display only | None |
| `brand` | `feishu` / `lark`, selects the open platform domain; submitted in the same step as the App Secret and member lists | `feishu` |
| `defaultAgentId` | Default Agent; required in the Agent settings step | None |
| `fallbackAgentId` | Fallback Agent: when the main Agent cannot start, is rate-limited or out of quota and the turn has no output yet, switches once; must differ from the default Agent; empty disables | None |
| `fallbackModel` | Model used after switching to the fallback Agent | The fallback Agent's default model |
| `defaultAgentWeights` | Split new sessions across Agents by weight, a JSON array; `[]` disables | No split |
| `defaultModel` | Default model | The Agent's own default |
| `defaultReasoningEffort` | Default reasoning effort | The Agent's own default |
| `permissionMode` | How Lark tasks confirm actions: `ask` confirms each one, `approve-reads` auto-approves read-only actions, `full-trust` runs unattended | A saved configuration without this key is treated as `approve-reads` (`full-trust` when `fullTrustConfirmed=true`); the Web form for a new bot prefills `full-trust` before an Agent is chosen; a new bot saved without it gets `ask` if the default Agent supports per-action approval in Lark, otherwise `full-trust` |
| `fullTrustConfirmed` | Confirms that Lark tasks run unattended in full trust; must be `true` before changing Agents or enabling listening under `full-trust` | `false` |
| `roleTitle` | Role name, used for display and prompts | None |
| `roleScope` | Area of responsibility, used for display and prompts | None |
| `preInjectPrompt` | Bot-level instructions passed to the Agent with every Lark task | Empty |
| `verificationCommand` | Platform verification command run in the session directory; when unset, result cards neither mention verification nor offer “运行验证” | None |
| `listening` | Whether the bot connects to Lark and receives messages | `false` |
| `mentionPolicy` | How the bot is woken in groups: `always` / `topic` / `never` / `ambient` | `topic` for new bots; `always` when a saved configuration lacks the key |
| `defaultGroupParticipation` | Default participation when not mentioned in a group: `off` / `observe` / `selective` / `eager` | `off` |
| `p2pMode` | Direct-message routing: `chat` uses one session for the whole DM, `thread` opens a topic per top-level message | `chat` |
| `groupReplyMode` | Reply mode in ordinary groups: `chat` / `shared` / `new-topic` / `chat-topic`; `auto` clears the override | Automatic routing |
| `idleCompactEnabled` | Compact the context after a session has been idle | `true` (not among the Web new-bot form defaults; the server fills it in) |
| `idleCompactHours` | Idle hours before compaction, at least 1 | `24` |
| `groupToolsEnabled` | Let the Agent use group tools; required for Leader mode | `false` |
| `groupToolsAllowSend` | Let group tools send messages; requires `groupToolsEnabled` | `false` |
| `memoryEnabled` | Session memory; `false` injects no memory and disables the related commands and tools | On when `defaultGroupParticipation` is `selective` / `eager`, otherwise off |
| `memoryAutoExtract` | Extract and consolidate memory in the background; `false` leaves only manual `/memory consolidate` | `true` |
| `groupMemoryScope` | Group memory scope: `shared` is one pool for all groups, `per-group` one pool per group; switching does not migrate data | `shared` |
| `claudeAutoMemory` | Claude's own auto memory in group chats: `inherit` follows Claude's own settings, `off` turns it off for Claude-family sessions in group chats of a bot with session memory on (see [features.md](features.md)) | `inherit` |
| `memoryAgentId` | Agent that extracts and consolidates memory | Same as `defaultAgentId` |
| `memoryModel` | Model that extracts and consolidates memory | Same as `defaultModel` |
| `busyTriage` | Triage while busy: progress questions are answered by the host and additions to the current task try to interject; off queues as usual | `false` |
| `botLoopGuard` | Bot loop guard that stops bots from talking to each other indefinitely | `false` |
| `decisionAgentId` | Agent that decides whether to respond in a group | `memoryAgentId`, then `defaultAgentId` |
| `decisionModel` | Model that decides whether to respond in a group | Same chain, using the matching model |
| `responseAgentId` | Agent for direct replies in groups | `memoryAgentId`, then `defaultAgentId` |
| `responseModel` | Model for direct replies in groups | Same chain, using the matching model |
| `executionMode` | `single` or `layered` (Leader mode: front agent + Leader + Workers; requires group tools, see [Leader mode](lark.md#leader-mode)) | `single` |
| `leaderAgentId` | Leader Agent for Leader mode | None |
| `workerAgentIds` | Worker Agents for Leader mode, 1 to 8 | None |
| `leaderSkill` | Leader guide: a skill name, `plugin-name/skill-name`, or the absolute path of a `SKILL.md` (or its directory). A value starting with `/` or `~/` is read as an absolute path, any other value is matched first as a plugin reference, then as a path relative to the working directory, then as a skill name (duplicate names are an error). An absolute path need not be in a skill directory; only the `SKILL.md` is delivered and the Leader reads sibling reference files itself when needed. Skill directories skip symlinks that point outside them, so give a guide kept elsewhere by absolute path. `leaderSkill=` clears it and goes back to the built-in rules | Empty (built-in rules) |
| `structuredAskCards` | Ask questions with structured cards; `false` uses text options and quoted replies | `true` |
| `groupCardMention` | Mention the requester on group cards: at the end of result cards, at the top of approval and question cards | `true` |
| `pushIntervalMs` | Progress card refresh interval, 500–20000 ms | `1000` |
| `traceLimit` | Maximum entries kept on the trace card; `null` restores the default | `50` |
| `hideTraceOnComplete` | Collapse the trace card entries when the task finishes; has no effect on the trace card when compact traces are on | `true` (not among the Web new-bot form defaults; the server fills it in) |
| `compactTrace` | Compact trace card, one line per phase | `true` |
| `showAgentName` | Show the Agent's short name in the card header | `false` |
| `completionReactionOnly` | On completion only react to the triggering message instead of sending a result card; group settings can override | `false` |
| `silentProgress` | Suppress intermediate progress and keep only the final result; group settings can override | `false` |
| `adhdMode` | ADHD-friendly output; adds the matching output instructions to every Lark task | `false` |
| `urgentEnabled` | Send an in-app urgent notice for approval or question cards left unhandled, which shows as a strong alert on the recipient's phone | `false` |
| `urgentThresholdMs` | How long a card stays unhandled before the urgent notice, at least 60000; `null` restores the default | 10 minutes |
| `urgentMaxPerHourPerChat` | Maximum urgent notices per group per hour; `null` restores the default | `3` |
| `notifyMentionAction` | Mention the requester for the “需要你操作” tier; requires `groupCardMention` | `true` |
| `notifyMentionDone` | Mention the requester for the “完成” tier; requires `groupCardMention` | `true` |
| `notifyQuietHours` | Quiet hours `HH:MM-HH:MM` (daemon local time, may cross midnight); only “需要你操作” still mentions and urgent notices wait until the end; empty clears | None |
| `pinLongTasks` | Pin the progress card of long tasks; pinning changes the conversation list of group members | `false` |
| `pinAfterMs` | How long a task runs before it counts as long, at least 1000; `null` restores the default | 10 minutes |
| `allowedUsers` | Requester list, a JSON array `[{"openId":"ou_…","name":"…"}]`; no restriction when this and `allowedEmails` are both empty | Empty |
| `allowedUserNames` | Requester list by name, resolved into `allowedUsers` when saved | Empty |
| `allowedEmails` | Requester list by email | Empty |
| `allowedBots` | Trusted bots (whether or not the requester list is restricted): still allowed when the requester list is restricted, and can run conversation commands and have their un-@ messages judged, see [trusted bots](lark.md#trusted-bots); same format as `allowedUsers` | Empty |
| `allowedBotNames` | `allowedBots` by name, resolved when saved | Empty |
| `peerBotsAllowed` | When the requester list is restricted, whether authorized peer bots in the same group are allowed (requires group tools); while on, those bots are trusted bots whether or not the list is restricted | `true` |
| `highRiskAllowedUsers` | People who may run high-risk commands under enforced risk control, same format as `allowedUsers`; no extra restriction when this and `highRiskAllowedEmails` are both empty | Empty |
| `highRiskAllowedUserNames` | `highRiskAllowedUsers` by name, resolved when saved | Empty |
| `highRiskAllowedEmails` | People who may run high-risk commands, by email | Empty |
| `highRiskPattern` | High-risk command regex; empty restores the built-in rule | Built-in rule |
| `riskControlMode` | High-risk command control: `off`, `guidance` (warn only), `enforced` (block) | `off` |

## Changing a schedule's frequency

`dutydeck schedule update` changes the trigger with `--every`, `--cron` or `--at`, one at a time; other settings stay as they are. See [Scheduled tasks](web-console.md) for the full usage.

```bash
dutydeck schedule update schedule_xxx --session ses_xxx --every 60                    # every 60 minutes, counted from now
dutydeck schedule update schedule_xxx --session ses_xxx --cron '30 8 * * 1-5'         # weekdays at 08:30
dutydeck schedule update schedule_xxx --session ses_xxx --at 2026-12-01T09:00          # once, in the schedule's timezone
```

Before switching to a one-off time, clear the completion condition and deadline (`--input '{"completionCondition":null,"deadlineAt":null}'`); one-off schedules cannot have either.

## VACUUM during downtime <a id="vacuum"></a>

VACUUM rewrites the whole database file and holds it exclusively, so the service must be stopped first. Do it inside a deploy window, running every command from the daemon root (the unit's `WorkingDirectory`):

1. Make sure the Web shows no running tasks; `dutydeck stop` does not wait for them.
2. Run `dutydeck stop`, then confirm with `dutydeck status`. Under systemd it calls `systemctl --user stop`, so the unit is not restarted.
3. Back up: `dutydeck backup create --database <database file> --data-dir <its directory> --output <new directory outside the data directory>`.
4. Make sure free disk space is at least the size of the database file; VACUUM writes a full temporary copy.
5. Run VACUUM. Without the `sqlite3` CLI, use the driver bundled in the release:

   ```bash
   node -e "const D=require(process.argv[1]); const db=new D(process.argv[2]); db.pragma('wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); db.close()" \
     "$PWD/.dutydeck/releases/current/node_modules/better-sqlite3" "$PWD/.dutydeck/dutydeck.db"
   ```

   With `sqlite3` available, the equivalent is `sqlite3 .dutydeck/dutydeck.db 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'`.
6. Start with `dutydeck start`; the free-page note in `dutydeck doctor` disappears. If something goes wrong, stop the service and restore the backup from step 3 into a new directory as described under offline backups below to check it.

## Offline backups and quarantined restore

```bash
dutydeck backup create --database /path/to/runtime/dutydeck.db --data-dir /path/to/runtime --output /path/to/backups/snapshot-1
dutydeck backup inspect --archive /path/to/backups/snapshot-1
dutydeck backup restore --archive /path/to/backups/snapshot-1 --target /path/to/restored-runtime
```

All three commands emit JSON and require explicit paths, without inferring the source from `.env` or daemon records. The source database must be directly inside the data directory and use the current schema; active users block backup. Output and restore directories must not exist, and their parents must exist. Keep backups outside the source data directory. Restore never overwrites an existing target.

Backups include SQLite primary data, non-secret plugin configuration/bindings/lock files, referenced immutable plugin packages and database-referenced artifact snapshots. Database and plugin write locks span copying. Component hashes, artifact size, schema, SQLite integrity and foreign keys are checked; missing or inconsistent referenced snapshots fail. The manifest lists missing and excluded dependencies. Backup directories use 0700 and files 0600. The full database may contain authentication tokens and share signing keys still valid against the source instance, as well as private content. This format adds no encryption and is not secret-free.

Only external credential files, such as `.env`, local secret-provider files and private-key files, are excluded; credentials inside SQLite are preserved intact. Native CLI sessions, external working directories/worktrees, external services and plugin runtime data are excluded. Missing packages, legacy mutable packages and immutable packages containing symlinks are omitted as whole packages and reported as missing dependencies. Inspection and restore report `status: quarantined`, not a ready-to-run complete instance. Restored data preserves unknown execution outcomes and submission facts; service startup and runtime attachment are blocked, and tasks are never replayed automatically. These commands do not reconnect credentials or remove quarantine. Enabling a restored instance requires separately verified dependencies and authorization.

## Agent CLI (`dutydeck agent`)

Agents in Lark sessions use `dutydeck agent` for general operations. Every turn, the host supplies a complete command prefix bound to that execution: `<absolute path> agent --turn <credential>`, plus available capabilities. Reuse that prefix without looking up or guessing the current task. Examples below use `$TURN` for the host-provided credential. Controlled exports use the separate `plugin-tool` entry; see [Controlled plugin results](plugins.md#controlled-plugin-results).

Unattended group-collaboration mandates using `ask` or an unset permission mode analyze frozen material without tool, Herdr or interactive-question instructions. Mandates explicitly using `approve-reads` / `full-trust` retain tool guidance. Missing material is reported with unfinished work; it cannot justify “nothing new.” The scheduler delivers the result.

The `adhdMode` output setting puts commands, paths or code first, groups lists, and makes progress and verification explicit. Lark result cards hide follow-up buttons and omit the verification placeholder when neither a verification command nor a suggestion is available. Structured ask cards contain only the question and choices. Cards omit the header and brand footer, a single choice uses a primary button, and the optional "Other" text box of regular question cards is not shown. Registration returns `deferred` and quietly ends the original turn (recorded as cancelled for durable confirmation), without an interruption result card or a retry of the original request; confirmation survives later messages and service restarts, and expires after 24 hours without a click: the card collapses to “已过期，未执行” and the original request is not replayed (confirmations registered before this deadline existed count from when their card was sent). Only the original requester or a currently listed high-risk approver may click; chat membership and authority are checked against the current state at click time, and chat members are not queried while waiting. A click registers one input in the original session with the question, fixed operation context and selected options; its Lark cards, task navigation and queue previews use the original request title, falling back to “已确认” when unavailable, while the internal replay text remains unchanged; the agent must search for duplicates before writing. This deduplicates input registration per card, not external writes. Multi-question calls register only the first question. Archiving the original session or disabling listening ends confirmation; revoked authority for the original request (for example, the requester left the chat) is detected and ends it at click time. Answered cards show the selected option, responder and time; terminated cards show one short status. Free-text asks, plan and permission cards retain their existing timeout and authorization boundaries. This mode adds no confirmation requirements and does not stop repairs after three attempts.

For every bot, static pending ask, approval and plan cards use non-streaming mode; content-generating process and result cards keep their existing streaming behavior. Workflow decisions and closing text are persisted before returning the callback response; cards close asynchronously about one second later. Failed closing logs a warning and retries at most five times across restarts. If the process exits before closing, startup reconciliation repairs the card.

- **Tool approval**: In `ask` / `approve-reads`, sessions with injected tool credentials automatically approve a single `dutydeck agent …` command using the exact session command prefix, in Claude Code / Seed / Relay terminal mode and ACP. The approval reason is recorded. Shell chaining, redirection and expansions still require approval; `group send-file` uploads local file bytes to the chat as-is, so it always asks a human. `send-file` only sends files from the session workspace or this session's own delivery directory under the system temp directory (`dutydeck-artifacts/<session>`), and refuses `.env` files, private keys, credential files, Agent transcripts, instance data (database, secrets, attachments and so on) and hard links. high-risk guards and write confirmation cards remain in effect. Other terminal CLIs do not support this exact approval. Web and Lark approvals use the same final execution receipt. The original approval card shows the accepted decision, while genuinely expired requests retain their expiry state. A request temporarily hidden during decision submission is not marked expired, and persisted decisions repair cards after restart.
- **Help**: `dutydeck agent --help` starts with a quick guide for the Agent; every subcommand's `--help` has a `Risk` line (`read`, `write-confirm` posts a confirm card, `write` takes effect at once) and examples. Help needs no service or credentials.
- **Output**: stdout carries exactly one JSON. Success is `{"ok":true,"data":...}`; failure is `{"ok":false,"error":{"code","message","hint"?,"params"?:[{"name","reason"}]}}` with a non-zero exit code. `params` names the wrong parameter, with allowed values in `reason` when there are any.
- **Read**: `status`, `agents`, `tasks [--page]`, `queue`, `schedules`, `ci`, plus the read commands under `group`, `history`, `memory`, `work` and `collaborate`. Results go back to the Agent without posting a card; permissions are the same as the turn's requester sending that command in the original topic.
- **Write**: `session new/resume/fork`, `retry`, `plan --task`, `schedule create/enable/disable`, `queue cancel/top`, `access grant/revoke --member`, `pr open`, `ci wait/fix/cancel` and `repair` post a confirm card under the turn's request message; after 确认 they run the same way as the matching slash command. `group send`, `memory add` and the like still take effect directly. `schedule create/update` cannot set a plan's pre-check command (`--condition-command`); only the Web plan panel or the local `dutydeck schedule` can, see [Scheduled tasks](web-console.md). Every write command accepts `--dry-run`, which returns what would happen, whether it needs confirmation and what the card says, without running anything or posting a card.
- **Revising a goal plan**: `work revise <goal id> --file revision.json`, where the JSON is `{"expectedRevision":<revision from show>,"plan":{complete new plan},"reason":"why"}`. `--dry-run` asks the service for the impact (keep, rerun, stop first, remove, add) without changing the goal. Narrowing revisions apply at once; widening revisions, or any revision of a goal that required confirmation, stay pending until the user chooses 确认修订, and the goal keeps running on its current plan meanwhile. See [Goal plan revisions](web-console.md#work-plan-revision); the legacy `dutydeck work revise` entry works the same way.
- **Task ownership**: reads, writes, final delivery and handoffs validate the execution-specific `--turn`. Missing credentials, old tasks and earlier attempts of the same task are rejected. Late requests cannot acquire a new task or requester. Help remains available offline.
- **Existing sessions after upgrading**: credential-free tool calls from old prompts are no longer accepted. Use the new command prefix supplied by the host for this turn; never reuse a previous turn’s prefix. Legacy group, history and memory commands accept a top-level credential, for example `dutydeck --agent-turn "$TURN" group self`.

---

`dutydeck agent --turn "$TURN" settings show` reads common bot settings. `dutydeck agent --turn "$TURN" settings set defaultAgentId=codex notifyQuietHours=22:00-08:00` sends a confirmation card and saves only after a bot admin confirms. Users can simply ask “use codex by default” or “mute notifications from 10 pm to 8 am”. The whitelist contains only `defaultAgentId`, `defaultModel`, `defaultReasoningEffort`, `p2pMode`, `groupReplyMode`, `notifyQuietHours`, `notifyMentionAction`, `notifyMentionDone`, `busyTriage`, and `botLoopGuard`. Permissions, allowlists and credentials are excluded. An empty quiet-hours value clears the window. Choosing "automatic" (or setting `groupReplyMode=auto`) clears an explicit override and restores default routing; omitted fields in an update patch keep their values. `show` returns bot defaults even when a group has overrides; a `null` group reply mode means no explicit setting and preserves legacy routing.

Confirmation requires bot settings management permission (`channel_bot.update`) in managed groups; high-risk operation permission alone is insufficient. Elsewhere, an explicit deployment member/email allowlist is required; an empty allowlist cannot confirm. Cards bind the configuration revision when proposed. A later Web edit makes an old card fail instead of overwriting newer settings.

## Automatic read-only checks

Each instance checks health about five minutes after startup and hourly thereafter: Lark connections, unconfirmed result deliveries, blocked queues, unknown results, overdue schedules, and background memory jobs. New findings are summarized in one direct message to the bot owner; an issue is reported once until recovery, with no recovery message. Checks never modify or retry tasks, and Web instances send no direct messages. A failed direct message is resent (same deduplication key) about every 5 minutes until the 55-minute deduplication window runs out; notifications whose outcome is still unknown are not resent after that; doctor shows this status. When Lark rejects the direct message for a missing permission, it is not recorded as unknown: it is retried at most once a day, doctor shows the missing permission, and the message is resent within 24 hours after the permission is granted on the open platform. If an earlier attempt of the same message had an unknown outcome, it stays unknown and is not resent. Doctor drops the warning once 24 hours pass with nothing left to send, when the bot stops listening, or when no direct-message receiver is found. Run `dutydeck doctor` to see unresolved findings and their first observation times.

Recovered findings are retained for seven days, capped at the latest 1,000 per scope; active findings and records referenced by pending notifications are protected.

Read-only checks also flag latest uncleared waiting/blocked reports older than 24 hours and unaccepted intake or still-pending decisions/confirmations older than one hour. Rejected, silent, handled, cancelled, and expired confirmations are excluded. These fixed thresholds only notify the owner; checks never decide or resubmit tasks.

Unknown results are judged by whether the current execution attempt is settled: settled ones are no longer reported, and earlier findings recover on the next check. Bot messages that group participation never judges do not count as intake backlog. Checks also report a schedule whose latest trigger failed, a session whose stop is unverified (messages to it will fail), a terminal that is gone while its record still says live, and a schedule left disabled more than 24 hours after creation; all go into the same hourly direct message. The receiver is the first allowlisted user, else the person who created the app; members registered only because they sent a request in a group do not count. When none exists, `dutydeck doctor` shows “巡检无人接收” and the log warns at most once a day. Adding someone to the allowlist restricts who can use the bot, so do not do it only to receive check messages.

Lark card reconciliation treats a settled unknown-result card as done. While cards are still open, queued or running tasks keep the 5-second cadence; when only cards waiting for a person or a resend remain, the interval doubles each round up to 1 minute and only those cards are re-read. A new message or task state change returns to 5 seconds with a full re-read.

## Commands for external programs

These commands connect as the local installation owner using the same instance discovery and authentication as `session list`. Each `task` command accepts `--url http://127.0.0.1:4310 --database /path/to/runtime.db` to select an exact instance. The database is opened only to read its access token; the URL must be local HTTP. Lists use the Web visibility filter. Origin enrichment runs at concurrency four with a shared three-second budget; tasks still return with known origin information when enrichment times out. Writes retain the existing authorization checks.

```bash
dutydeck task list --json --limit 50
dutydeck task list --recent --limit 200 --json
dutydeck task read <session-id> --json --limit 40
dutydeck task send <session-id> --text 'Additional requirements' --mode queue --client phone --json
printf '%s' 'Additional requirements' | dutydeck task send <session-id> --stdin --json
dutydeck task interrupt <session-id> --client phone --json
dutydeck task archive <session-id> --client rovetap --json
dutydeck task decide <session-id> --waiting <request-id> --option allow --client phone --json
dutydeck task decide <session-id> --waiting <request-id> --option deny --text 'Use a test directory' --json
dutydeck task decide <session-id> --waiting <ask-id> --option <choice-value> --json
dutydeck task decide <session-id> --waiting <ask-id> --option answer --text 'Custom answer' --json
```

Task IDs are session IDs. `list` excludes archived sessions before returning up to 50 sessions by default, newest updated first. Completed or stopped sessions remain in the list until archived. `read` returns the latest 40 conversation entries, and archived history remains readable by session ID. Both accept `--limit` from 1 to 200. `send` requires exactly one of `--text` or `--stdin`. Its mode is `queue` (default) or `steer`; unsupported sessions reject steering. `interrupt` returns `interrupting` when accepted but the original turn has not yet been confirmed finished, `interrupted` only when the execution ledger confirms that turn has ended, or `idle` when there is no active turn. Approvals accept `allow` or `deny`, with optional rejection text. Questions accept a choice value or `answer --text` for free text.

`list --recent` uses `GET /api/tasks?recent=true&limit=200` in the example above. It keeps visible, unarchived running, queued and waiting tasks, plus tasks completed within the last 24 hours, including the exact boundary. Future or invalid completion timestamps are excluded. Completion time and `updated_at` use the latest completed task’s `updatedAt`, falling back to the session update time only when no task records exist. Filtering precedes the limit; running, queued and waiting tasks come before completed tasks, newest updated first within each group. Origin enrichment reads only the selected tasks. This mode returns `data` as `{"tasks":[...],"archivable":["ses_example"]}`. `archivable` contains only returned sessions that permit `run.interrupt` and can be archived; managed background steps do not offer archival. Plain `list` still returns only `{"tasks":[...]}`, and the existing `actions` enum is unchanged.

`archive` calls the existing session archive route to stop execution, cancel queued work and permanently archive the session. Success returns `{"archived":true}`. Existing `run.interrupt` authorization still applies; the client name is audit metadata only. Success requires a matching session ID and valid archive timestamp in the receipt. A 5xx, connection loss or damaged receipt returns `unknown_outcome`; never retry automatically, read again to reconcile. When archiving a currently submitted turn, the installation owner’s termination decision ends execution while preserving an unknown historical outcome, never marking it completed. Archival is refused without proven physical exit and does not automatically settle results that were already unknown before the request. A failed archive is never reported as successful.

With `--json`, stdout contains exactly one JSON object. Success exits 0 and returns `{"ok":true,"data":...}`. Examples of `data` (optional fields are omitted when no source evidence exists):

```json
{"tasks":[{"id":"ses_example","title":"Check project","status":"waiting","updated_at":"2026-11-11T00:00:00Z","agent":"codex","agent_label":"Example Agent","cwd":"/path/to/project","origin":{"kind":"web","label":"web"},"waiting":[{"id":"request_example","kind":"approval","prompt":"Run tests","detail":"pnpm test","options":[{"id":"allow","label":"允许","kind":"allow"},{"id":"deny","label":"拒绝","kind":"deny"}],"free_text":false}],"verification":{"state":"none","summary":""},"actions":["send","interrupt","decide"]}]}
{"items":[{"role":"user","text":"Check project","at":"2026-11-11T00:00:00Z"},{"role":"assistant","text":"Findings","at":"2026-11-11T00:01:00Z"}],"truncated":false}
{"task_id":"ses_example","accepted":true}
{"state":"interrupted"}
{"resolved":true}
{"archived":true}
```

Status is `running|waiting|queued|done|failed|stopped|unknown`; pending approvals/questions take precedence as `waiting`, while unreconciled results are `unknown`. Agent family is `claude|codex|other`. Origin is `lark|schedule|web|trigger|other`, with `origin.url` when known. A `question` uses options of `kind=answer`; `free_text` indicates whether arbitrary text is accepted. Prompts are limited to 500 characters, operation details to 2000 and verification summaries to 200. Verification state is `passed|failed|none`; stale or absent evidence yields `none`. Actions contain only currently available, authorized operations. Conversation entries are chronological, with roles `user|assistant|tool|system`. Tool calls and results merge into a summary; thinking is excluded. Text over 4000 characters is clipped with `…`; clipped text or omitted older entries set `truncated=true`.

Failures return `{"ok":false,"error":{"code":"already_resolved","message":"This request has already been handled"}}`:

| Exit | Code and meaning |
|---|---|
| 2 | `invalid_argument`: invalid input or unsupported action |
| 3 | `unavailable`: runtime unreachable during a read, or a write proven unsubmitted, such as a refused connection before submission |
| 4 | `not_found`: missing object; `already_resolved`: already handled or submitting, never execute twice |
| 5 | `unknown_outcome`: a submitted write received a 5xx, damaged response or connection loss without proof it was unexecuted; read again to reconcile, never automatically retry |
| 1 | `forbidden`: insufficient authority; `conflict`: incompatible current state |

Writes accept `--client <name>`, matching `[a-z0-9-]{1,32}`. This adds an audit label without granting authority. Decisions from Web or CLI close the original Lark approval/question card in place, showing “已处理（经 Web or client name）” and removing controls. Failed card updates use the existing persistent retries. Questions reject duplicate actions while an answer is being submitted and close only after the answered receipt is persisted. If persistence fails and the question returns to pending, the original card remains actionable.

### Archive cards and extra links

```bash
dutydeck lark send '## Archive summary' --app <app-id> --chat-id <chat-id> --json
dutydeck lark send '## Archive summary' --app <app-id> --reply-to <message-id> --in-thread --json
dutydeck settings bot set <app-id> 'cardLinks=[{"label":"Open task","url":"https://client.example.test/tasks/{sessionId}","android_url":"client://tasks/{sessionId}"}]'
dutydeck settings bot set <app-id> cardLinks=
```

`lark send --json` returns `{"ok":true,"data":{"message_id":"om_example","url":"https://client.example.test/message"}}`. `--app` selects a saved bot from the local database; optionally pass `--database /path/to/runtime.db`. Omitting it preserves existing `LARK_*` environment behavior. `--reply-to` replies to a message, and `--in-thread` places the reply in its thread. All sending retries within one invocation share a fixed idempotency UUID. Once an attempt has an uncertain outcome, a later rejection cannot prove the earlier attempt was unexecuted; only a confirmed success clears uncertainty for that invocation. An uncertain delivery caused by a connection loss or response read failure, or a sent message whose link cannot be retrieved, returns `unknown_outcome` (exit 5); do not resend automatically.

The bot's `cardLinks` setting is a JSON array of at most two entries. Omission preserves the value; `cardLinks=` or `[]` clears it. Each entry requires a 1–12 character `label` and an HTTPS `url`; every URL is limited to 2048 characters. Optional `android_url`, `ios_url` and `pc_url` accept application schemes, excluding `javascript:`, `vbscript:` and `data:`. `{sessionId}` expands to the URL-encoded session ID. If any expanded URL exceeds 2048 characters, that link is omitted. Progress and result cards render these links at the bottom using Lark `multi_url`. Links are omitted if adding them would exceed the complete card budget; existing body handling is preserved.

### Idle CPU policy

The service startup option `--driver-idle-cpu-action off|diagnose|retire` maps to `DUTYDECK_DRIVER_IDLE_CPU_ACTION` and defaults to `diagnose`. Diagnosis only logs candidates; `retire` permits early release of idle PTY CLIs with verified safety and recovery evidence. For example:

```sh
dutydeck --driver-idle-cpu-action retire
```

Use `--driver-idle-cpu-action diagnose` to restore diagnosis or `--driver-idle-cpu-action off` to disable the check. This is a service startup setting; an existing background service needs the environment variable in its startup configuration and its usual restart procedure. The general idle timeout remains independent; see [Agent configuration](agents.md#sustained-cpu-use-by-idle-clis).
