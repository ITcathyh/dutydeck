# CLI Reference <a id="cli-reference"></a>

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/cli.md)

Before ending a turn, agents can run `dutydeck session report --status waiting --question "一个具体问题"` or `--status blocked --summary "一句原因"`. These reports appear in Lark `/tasks`, the web attention list, and the first line of the result card. Starting the next turn or handling the task through existing actions clears the report. `ready` means done (no report is required by default); `dropped` means no action is needed. Continue using `session ask --choices` for fixed choices that block until answered.

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

To bind an international Lark app, use `dutydeck settings bot add <app-id> brand=lark --app-secret-fd 0`. Unless `LARK_OPEN_API_BASE_URL` overrides the service address, `brand=lark` validates credentials against the international Lark domain; omitting the brand defaults to Feishu. `brand`, App Secret and member lists share the credential-validation step. Submit default Agent, permissions or listening changes separately. With the Lark task dispatch channel enabled (`LARK_TASK_AGENT_ENABLED`), Dutydeck checks the bot's currently saved requester lists (`allowedUsers` / `allowedEmails`) and listening switch before each poll and when handing a task to message processing. Clearing both lists or turning listening off stops intake; an in-flight task whose handoff check sees the channel closed is returned for later dispatch and can be processed without duplicate dispatch when it reopens. Tasks that have already passed the handoff check are not withdrawn. Adding a list enables intake without a restart. An empty list still means open to everyone for ordinary direct messages.

`ou_` identities are application-scoped. Switching applications validates inherited owners and high-risk approvers against the target app, even when those lists are omitted. Definitively invalid identities reject the save without changing the saved configuration or revision. Peer bot IDs must be resolved by name through the target app or explicitly cleared. All Web and CLI save steps use the same identity boundary; temporary network or Contact-scope failures remain inconclusive rather than definitively invalid.

`restart` first holds queued work. Successfully submitted `full-trust` tmux turns with verified recovery logs and original turn identity keep running in the same CLI process; the new service adopts the original turn without resending input. Other running tasks still drain, including ACP, plain PTY, Herdr, submissions in progress, missing recovery evidence, pending approvals and unauthorized high-risk gates. With systemd, preservation requires the current `KillMode=process`; other or unknown values use a full drain. Older services without recovery counts, failed drain requests and failed lease renewals also use a full drain. `--drain-timeout`, `--force` and automatic exclusion of the invoking Agent session retain their existing behavior. `deploy` uses the same preservation policy; ACP and other non-preservable tasks still drain. A restarted service starts serving HTTP as soon as initialization finishes and connects Lark long connections in parallel in the background; the health check does not wait for the Lark handshake, and failed connections keep the existing retry backoff. The Web retries a dropped stream at most every 5 seconds, and Agent group tools wait up to 90 seconds when the connection is refused; requests that may already have arrived are not retried.

The `codex` entry defaults to terminal mode; `codex-cli` remains available for compatibility. Existing ACP sessions continue through ACP, while new sessions use the current default protocol. Bot permissions are never raised automatically. Terminal Agents such as Codex that lack Lark per-action approval reject new Lark sessions under `ask` / `approve-reads`; choose the built-in “Codex (ACP)” (`codex-acp`), or choose a terminal Agent with approval support, such as Claude Code / Seed / Relay. Only tmux tasks already authorized for `full-trust` and backed by complete recovery evidence can continue across a service restart. A first submission without a known transcript path still drains. An adopted task that finishes fires the plugin `task.completed` hook, trigger result delivery and the trigger run status update once, as other tasks do; one that is stopped or whose result stays unknown fires none of them. Safe restart and deployment drain also wait for native background tasks that remain after the main turn completes; direct process termination and `--force` do not provide this guarantee.

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

- **Web assets**: HEAD requests check file readability and size and return the same `Content-Length` as GET without reading the file body.
- **Deploy**: drain → switch `releases/current` → restart → health check. On a failed health check the service is stopped first. When multiple units share the same `current`, the rollback target is the release the target unit was actually running; the switch is refused if that version cannot be verified. When the target is stopped, a past successfully deployed release is a rollback candidate only when its database schema matches the current one. Automatic rollback still requires an unchanged schema; if the schema changed, automatic rollback stops to protect the data, and an old database snapshot is never restored.
- **Refused without address or database**: when the target unit has no usable health-check address or database path recorded (for example after `dutydeck stop`), deploy is refused without switching versions or restarting. Start the unit so it records them, or point `--runtime` at a `deployment.json` with `address` and `databasePath`.
- **Failure and interruption**: when a deploy fails, throws, or is interrupted by Ctrl-C / kill / a dropped ssh session, it writes a deployment record with `status: failed` (signals are also recorded in `aborted_by`) and waits for all drain renewals already sent to finish before taking the old service out of draining. New tasks resume without waiting for the lease to expire, and a late renewal cannot pause the service again. After an interruption it no longer switches releases, restarts or rolls back.
- **Startup timing**: once listening, the service logs one "启动各阶段耗时" entry (`startupMs`, milliseconds): `boot` (process and module load), `plugins`, `config`, `database` (open), `migrate`, `wiring`, `insight`, `integrations`, `relay`, `agentDefaults`, `agents` (agent registration), `sessions` (session recovery and reconciliation), `routes`, `listen`, plus `total`.
- **Concurrent deployment and cleanup**: operations sharing the same real release root are mutually exclusive, including deployments for different units, `--no-restart` and manual `deploy prune` (including `--dry-run`). A later command reports that the root is busy and refuses to proceed; retry after the active operation finishes. Different release roots operate independently.
- **Drain held during backup**: after draining, deploy backs up the database before switching versions and renews the drain every 5 seconds meanwhile. If a renewal fails, or tasks are running again when the backup finishes, deploy leaves `current` unchanged, does not restart, keeps the old service running and records a failure with the reason. Deploy again after those tasks finish, or add `--force` if interrupting them is acceptable.
- **Cleanup**: after each successful deploy the newest 5 releases are kept, and the newest 5 deployment records are kept per unit; only the newest 2 records of each unit (including this one) keep their database backups, so deploying several units under one release root in turn does not push out each other's backups. Older records lose just the backup files and keep `manifest.json`; records whose `manifest.json` has no unit never lose their backups to this count. Records created by deploy that still have no `manifest.json` after 24 hours (left by a force-killed deploy) do not count toward the limit and are deleted. `current`, its previous release and releases still referenced by running processes are always kept; both automatic cleanup and manual `deploy prune` additionally keep the most recent successfully deployed release of each unit. Cleanup failures only warn. Records from manual deployments (no `created_by: dutydeck deploy` in `manifest.json`) are left alone unless you pass `--include-unmarked`, and even then skipped when referenced by a process or modified within the last hour. `.partial` directories modified in the last hour are skipped too.
- **History retention**: every hour the service trims old data in batches, touching only finished tasks; unfinished, result-unknown and legacy sessions awaiting retirement are left alone. Terminal-mode turns older than 30 days keep only their last screen; session-state snapshots stored by older versions and tool-call mirrors older than 30 days are deleted; revision records of group policies, bindings, chat facts and roles keep the latest 20 per item. Event rows themselves are kept, so Web history stays complete and contiguous. For older databases with gaps in terminal output, the Web can still expand turns, raw logs and execution traces and show the remaining records; reads that stop before the requested end or return invalid pages still fail and can be retried. No `VACUUM` is run, so the database file does not shrink and freed space is reused by later writes; to shrink the file, stop the service and run `VACUUM` on the database.
- **Splitting bot data**: `scripts/split-bot-runtimes.mts` moves idle terminal state, blocked-queue and unknown-result reminders, and overdue schedule reminders into the database of the bot that owns the session. Unknown records or records whose owner cannot be established still block the split.
- **systemd service root and database resolution**: For units that invoke `node cli.js` directly, management commands (`restart`, `status`, `deploy`, and others) resolve the target database and listen address in this order: explicit ExecStart arguments, unit environment, then `WorkingDirectory/.env`. Relative working directories are based on `WorkingDirectory`. A missing `.env` is allowed; unreadable files or invalid critical settings cause the operation to be refused. An unset database defaults to `<cwd>/.dutydeck/dutydeck.db`. Deployment backups and schema rollback checks use that same actual database. Foreground daemons continue to use daemon state, and explicit `deploy --runtime` metadata retains priority.
- **Remote access**: Dutydeck listens on `127.0.0.1` by default. With `--host 0.0.0.0`, browsers log in with the password from `dutydeck auth password set`; CLI and API use the access token. After signing out you can log in again directly with the same password. Never use `--no-auth` on a reachable address.
- **Credential protection**: once a bot is open to others, it keeps group members from getting the agent to reveal local tokens, keys and agent session records. It follows the bot's risk control setting and only restricts senders outside the high-risk allowlist and other bots; people on the list work as before, including full-trust mode.
  - Guidance: the agent gets a rule not to read, copy, print or send credentials and agent session records (such as `~/.claude`, `~/.claude.json`, `~/.codex`), and to refuse in one sentence when asked.
  - Enforced: tool calls are also checked first. Reading or writing credential files and session records (such as `~/.codex/auth.json`, `~/.ssh` private keys, `.env`) or printing secret environment variables is blocked; the command does not run and the agent gets the reason. For Claude Code (terminal and ACP) and Codex terminal sessions in full-trust mode, the check is passed in the launch arguments of that agent process only; global config under `~/.claude` and `~/.codex` is not changed. Codex over ACP is checked by the workspace hook.
  - Codex workspace hooks (including `codex-acp`) are ready only when native Codex loads and enables the generated hook and trusts its current content hash. A `hooks.json` file alone is insufficient. Enforced saves and session starts check `config/read` and `hooks/list` without a model turn; unsupported RPCs, errors and a 5-second timeout refuse execution. Using the Agent's `CODEX_PATH` / `CODEX_HOME`, confirm trust for the target workspace, review only the Dutydeck PreToolUse hook in `/hooks`, then choose **重新检查 Hook** in the Web. Dutydeck never trusts a project or other hooks automatically.
  - For Claude Code terminal agents (including custom agents whose adapter is `claude-code`, such as ccflash) and ACP Claude launched by Dutydeck, the same check also enforces the high-risk pattern, so enforced mode needs no workspace hook. A custom ACP Claude must launch with the released `dist/agents/claude-acp.mjs`; an old copy made elsewhere does not include the check.
  - In every mode, Lark cards, results and group tool messages replace common secret formats (such as `sk-ant-`, `ghp_`, JWTs) and secret values from the service and agent environments with `[REDACTED]`.

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

The `adhdMode` output setting puts commands, paths or code first, groups lists, and makes progress and verification explicit. Lark result cards hide follow-up buttons and omit the verification placeholder when neither a verification command nor a suggestion is available. Structured ask cards contain only the question and choices. Cards omit the header and brand footer, and a single choice uses a primary button. Registration returns `deferred` and quietly ends the original turn (recorded as cancelled for durable confirmation), without an interruption result card or a retry of the original request; confirmation survives later messages and service restarts, and expires after 24 hours without a click: the card collapses to “已过期，未执行” and the original request is not replayed (confirmations registered before this deadline existed count from when their card was sent). Only the original requester or a currently listed high-risk approver may click; chat membership and authority are checked against the current state at click time, and chat members are not queried while waiting. A click registers one input in the original session with the question, fixed operation context and selected options; its Lark cards, task navigation and queue previews use the original request title, falling back to “已确认” when unavailable, while the internal replay text remains unchanged; the agent must search for duplicates before writing. This deduplicates input registration per card, not external writes. Multi-question calls register only the first question. Archiving the original session or disabling listening ends confirmation; revoked authority for the original request (for example, the requester left the chat) is detected and ends it at click time. Answered cards show the selected option, responder and time; terminated cards show one short status. Free-text asks, plan and permission cards retain their existing timeout and authorization boundaries. This mode adds no confirmation requirements and does not stop repairs after three attempts.

For every bot, static pending ask, approval and plan cards use non-streaming mode; content-generating process and result cards keep their existing streaming behavior. Workflow decisions and closing text are persisted before returning the callback response; cards close asynchronously about one second later. Failed closing logs a warning and retries at most five times across restarts. If the process exits before closing, startup reconciliation repairs the card.

- **Tool approval**: In `ask` / `approve-reads`, sessions with injected tool credentials automatically approve a single `dutydeck agent …` command using the exact session command prefix, in Claude Code / Seed / Relay terminal mode and ACP. The approval reason is recorded. Shell chaining, redirection and expansions still require approval; high-risk guards and write confirmation cards remain in effect. Other terminal CLIs do not support this exact approval. Web and Lark approvals use the same final execution receipt. The original approval card shows the accepted decision, while genuinely expired requests retain their expiry state. A request temporarily hidden during decision submission is not marked expired, and persisted decisions repair cards after restart.
- **Help**: `dutydeck agent --help` starts with a quick guide for the Agent; every subcommand's `--help` has a `Risk` line (`read`, `write-confirm` posts a confirm card, `write` takes effect at once) and examples. Help needs no service or credentials.
- **Output**: stdout carries exactly one JSON. Success is `{"ok":true,"data":...}`; failure is `{"ok":false,"error":{"code","message","hint"?,"params"?:[{"name","reason"}]}}` with a non-zero exit code. `params` names the wrong parameter, with allowed values in `reason` when there are any.
- **Read**: `status`, `agents`, `tasks [--page]`, `queue`, `schedules`, `ci`, plus the read commands under `group`, `history`, `memory`, `work` and `collaborate`. Results go back to the Agent without posting a card; permissions are the same as the turn's requester sending that command in the original topic.
- **Write**: `session new/resume/fork`, `retry`, `plan --task`, `schedule create/enable/disable`, `queue cancel/top`, `access grant/revoke --member`, `pr open`, `ci wait/fix/cancel` and `repair` post a confirm card under the turn's request message; after 确认 they run the same way as the matching slash command. `group send`, `memory add` and the like still take effect directly. Every write command accepts `--dry-run`, which returns what would happen, whether it needs confirmation and what the card says, without running anything or posting a card.
- **Task ownership**: reads, writes, final delivery and handoffs validate the execution-specific `--turn`. Missing credentials, old tasks and earlier attempts of the same task are rejected. Late requests cannot acquire a new task or requester. Help remains available offline.
- **Existing sessions after upgrading**: credential-free tool calls from old prompts are no longer accepted. Use the new command prefix supplied by the host for this turn; never reuse a previous turn’s prefix. Legacy group, history and memory commands accept a top-level credential, for example `dutydeck --agent-turn "$TURN" group self`.

---

`dutydeck agent --turn "$TURN" settings show` reads common bot settings. `dutydeck agent --turn "$TURN" settings set defaultAgentId=codex notifyQuietHours=22:00-08:00` sends a confirmation card and saves only after a bot admin confirms. Users can simply ask “use codex by default” or “mute notifications from 10 pm to 8 am”. The whitelist contains only `defaultAgentId`, `defaultModel`, `defaultReasoningEffort`, `p2pMode`, `groupReplyMode`, `notifyQuietHours`, `notifyMentionAction`, `notifyMentionDone`, `busyTriage`, and `botLoopGuard`. Permissions, allowlists and credentials are excluded. An empty quiet-hours value clears the window. Choosing "automatic" (or setting `groupReplyMode=auto`) clears an explicit override and restores default routing; omitted fields in an update patch keep their values. `show` returns bot defaults even when a group has overrides; a `null` group reply mode means no explicit setting and preserves legacy routing.

Confirmation requires bot settings management permission (`channel_bot.update`) in managed groups; high-risk operation permission alone is insufficient. Elsewhere, an explicit deployment member/email allowlist is required; an empty allowlist cannot confirm. Cards bind the configuration revision when proposed. A later Web edit makes an old card fail instead of overwriting newer settings.

## Automatic read-only checks

Each instance checks health about five minutes after startup and hourly thereafter: Lark connections, unconfirmed result deliveries, blocked queues, unknown results, overdue schedules, and background memory jobs. New findings are summarized in one direct message to the bot owner; an issue is reported once until recovery, with no recovery message. Checks never modify or retry tasks, and Web instances send no direct messages. A failed direct message is resent (same deduplication key) about every 5 minutes until the 55-minute deduplication window runs out; notifications whose outcome is still unknown are not resent after that; doctor shows this status. Run `dutydeck doctor` to see unresolved findings and their first observation times.

Recovered findings are retained for seven days, capped at the latest 1,000 per scope; active findings and records referenced by pending notifications are protected.

Read-only checks also flag latest uncleared waiting/blocked reports older than 24 hours and unaccepted intake or still-pending decisions/confirmations older than one hour. Rejected, silent, handled, cancelled, and expired confirmations are excluded. These fixed thresholds only notify the owner; checks never decide or resubmit tasks.

Unknown results are judged by whether the current execution attempt is settled: settled ones are no longer reported, and earlier findings recover on the next check. Bot messages that group participation never judges do not count as intake backlog. Checks also report a schedule whose latest trigger failed, a session whose stop is unverified (messages to it will fail), a terminal that is gone while its record still says live, and a schedule left disabled more than 24 hours after creation; all go into the same hourly direct message. The receiver is the first allowlisted user, else the person who created the app; members registered only because they sent a request in a group do not count. When none exists, `dutydeck doctor` shows “巡检无人接收” and the log warns at most once a day.

Lark card reconciliation treats a settled unknown-result card as done. While cards are still open, queued or running tasks keep the 5-second cadence; when only cards waiting for a person or a resend remain, the interval doubles each round up to 1 minute and only those cards are re-read. A new message or task state change returns to 5 seconds with a full re-read.
