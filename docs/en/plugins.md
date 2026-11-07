# Plugins <a id="plugins"></a>

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/plugins.md)

A plugin adds commands, agents, skills, external triggers, hooks, CI providers, controlled result tools and scenario packs. The core has no platform-specific code; GitHub and Codebase CI support and alert triage are plugins.

```text
my-plugin/
├── .dutydeck-plugin/plugin.json   manifest (required, strictly validated)
├── commands/*.md                  slash commands (prompt template or read-only query mapping)
├── agents/*.json                  agent definitions (same shape as one DUTYDECK_AGENTS_JSON entry)
├── skills/                        skills directory
├── triggers/<id>.json             external triggers
├── hooks/hooks.json               hooks
├── scenarios/*.json               scenario packs
└── index.mjs                      providers entry (CI providers, scenario pack providers, in-process hooks)
```

`plugin.json` fields: `name` (kebab-case, ≤ 64), `version`, `description`, `apiVersion`, `host`/`dependencies`, `permissions` (`secrets`, `network`, `filesystem`, `effects`), declarative Web `slots` (`settings`, `command_palette`, `task_panel`, `result_card`), `commands` / `agents` / `skills` / `triggers` (directories), `hooks` (file), `providers` (ESM entry, no default), `scenarios` (directory, default `scenarios/`), `userConfig` (`{ <snake_case key>: { description, sensitive? } }`). Paths must stay inside the plugin. Provider module loading and registration share a 15-second deadline; a timeout skips that plugin and ignores later registrations.

**Trust.** `agents`, `hooks:<event>` and `providers` execute code or commands and must be confirmed at install (non-interactive installs need `--yes`). The daemon loads only enabled plugins whose required capabilities are all confirmed. `plugin update` re-confirms only newly added capabilities. npm sources are packed with `--ignore-scripts`.

**Scopes** (`--scope`): `global` (default), `bot:<appId>` (only that bot's sessions; not effective in Web sessions, which have no bot), `workspace:<absolute path>` (sessions whose cwd is under it). Triggers check this scope too: the bot workspace before starting a new session, or the actual cwd of a reused session. Both the scope root and target directory are resolved through symlinks and compared by real path; aliases pointing inside the scope are allowed. A missing, unresolvable or out-of-scope directory prevents session creation and dispatch. Agents are always merged globally.

**Built-in plugins** <a id="builtin-plugins"></a>. Plugins shipped with Dutydeck live in `builtin-plugins/` (`dist/builtin-plugins` once packaged) and load before installed plugins. There is one today: `alarm`, which provides alert triage and same-alert-rule correlation (group usage is under Group participation). Built-in plugins need no trust confirmation, are always enabled with `global` scope, cannot be uninstalled, and show as 「内置」 (built-in) in `plugin list`. An external plugin with the same name is refused at install, and one already installed is not loaded (`plugin list` and `doctor` say so). A scenario pack in an external plugin that reuses a built-in pack id is skipped; the rest of that plugin still loads.

**Commands.** `/<plugin>:<name>` always works; `/<name>` works if not ambiguous. Names that clash with built-ins are rejected, and agent-native names such as `compact`, `clear`, `init`, `review` only work as `/<plugin>:<name>`.

A direct read-only command uses `query` and `argument` in its file frontmatter, and its SDK query must explicitly declare `commandOutput: 'chat'`. After configuring and granting the [fake-ticket example](../../examples/plugins/fake-ticket/README.md), send `/fake-ticket:ticket-status T-1` in Lark to receive only title and status without an Agent session. The host requires a trusted human inbound event, an enabled binding and matching actor, tool, read-effect and exact-resource grants, rechecked before delivery. Chat permission alone grants no business-data access. Only queries explicitly declaring output safe for everyone in the originating chat are accepted; private results use controlled exports, and write actions cannot be mapped. Duplicate events and unknown execution after a restart are never automatically replayed. Existing prompt commands and queries without chat-output opt-in retain their behavior; see the [Plugin SDK](../../packages/plugin-sdk/README.md).

**CLI**

```bash
dutydeck plugin install <source> [--scope global|bot:<appId>|workspace:<path>] [--yes] [--json]
dutydeck plugin list | validate <dir> [--strict] | inspect <dir|tarball|source> --json | test <dir|tarball|source> | init <name> [--dir <dir>]
dutydeck plugin config <plugin> <key> --value <v>                      # non-sensitive
printf %s "$SECRET" | dutydeck plugin config <plugin> <key> --value-fd 0   # sensitive values only via fd
dutydeck plugin trigger-token <plugin>/<trigger> [--rotate]
dutydeck plugin update [name] [--yes]  # stage a candidate only
dutydeck plugin status <name> [--json]
dutydeck plugin activate <name> [--json] | rollback <name> [--json]
dutydeck plugin enable <name> | disable <name> | uninstall <name>
```

`plugin validate` also checks scenario packs (format, template variables, regexes, parameters) and reports file and field. `plugin validate --strict` checks host compatibility, permission declarations, skill references and resource limits. `plugin inspect` prints capabilities, permission footprint and a content digest without installing; `plugin test` runs an isolated Host fixture. `install` and `update` do not fail on scenario pack problems but list the packs that will not load and why.

Sources: a local directory, `git+https://…`, `git@…`, `file://…` (`#ref` pins a branch, tag or commit; git sources are pinned by SHA), or `npm:name@version`. `plugin update` stages an immutable candidate; the live Host keeps its provider, hook and skill paths on the original artifact. Restarting does not activate a candidate.  If a candidate is modified, drain and stop the service, run `plugin update` again from the same source, then activate it. Damaged active or previous artifacts are never overwritten in place. Internal relative symlinks are supported; external, absolute or unresolvable links are rejected during installation and updates. Content digests detect changes without a version bump; unchanged content does not produce another candidate. Concurrent mutations are serialized by the store lock. At startup the daemon waits up to 30 seconds for the plugin store lock (longer than one `plugin activate` isolated validation). If the lock is still busy, `plugins.lock.json` is corrupt, or the `.hosts/` lease cannot be written, the daemon still starts but **loads only built-in plugins and no external plugin at all**: the log records a warning naming the failing file, plugin diagnostics list the reason, and the `dutydeck doctor` "plugin store" check fails. Sessions bound to an external plugin refuse new tasks. Fix the cause and restart the daemon to load external plugins again. Stopped or exited leases of the same database in `.hosts/` are removed at the next startup; unparsable leases are kept and still block activation until fixed by hand.

`plugin status` distinguishes the selected artifact, candidate, previous artifact, actual live Host generation and switch blockers. To activate or roll back, first finish or cancel unfinished tasks and reconcile this plugin's pending actions on the current version. Run `dutydeck stop`; for systemd-managed instances, use `systemctl --user stop <unit>` for every instance sharing this plugin directory. Run `plugin activate <name>` or `plugin rollback <name>`, then `dutydeck start` / `systemctl --user start <unit>`. Live Hosts, recoverable tasks and this plugin's unknown actions block switching. Dead process leases are recognized, but a dead daemon does not prove its tmux tasks ended. Unfinished legacy tasks without verifiable plugin dependencies conservatively block switching; terminal history and unrelated plugin actions do not.

Activation imports and registers trusted providers in a terminable Node process with a temporary data directory and minimal environment. This is not a sandbox for malicious code. Previous artifacts remain available for rollback; there is no per-session multiversion provider dispatch or automatic private-data rollback. Installation and enable/disable changes still require a new Host; uninstall also requires no active consumers. Data lives under `plugins/` next to the database: `plugins.lock.json`, immutable `.artifacts/<name>/<content-digest>/`, `.hosts/` generation/database records, `.data/<name>/`, and 0600 `.trigger-tokens.json` / `.config.json`. Legacy `<name>/` roots remain compatible and are not moved during an update.

Plugin installation unpacks artifacts without running npm install. Runtime imports of `definePlugin` or third-party libraries must be bundled into the provider entry before publishing, for example `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs`. Include `dist` and `.dutydeck-plugin` in npm files; do not mark `@dutydeck/plugin-sdk` external. Type-only SDK imports need no runtime dependency. Acceptance covers an independently installed SDK, bundling, packing, deleting the author directory, and loading and calling the result through the real Host.

Workspace binding edits resolve aliases and symlinks on the target server, preserve saved configuration and revisions, and can locate disabled bindings for re-enablement. The CLI does not resolve server paths on its own filesystem.

## Business query and action tools

Trusted providers register `api.registerQuery` / `api.registerAction` using the public `@dutydeck/plugin-sdk`. Each tool declares a serializable JSON Schema, compatibility version and resource selector. The supported schema subset is object, array, string, number, integer and boolean with the SDK's listed bounds; objects must reject additional properties. Queries return model-visible JSON; actions return short receipts. Private files use the separate controlled-result interface below.

Installation and enablement require a separate Bot/group or exact workspace binding, plus explicit installation-owner grants. Business configuration cannot increase permission. Grants match toolId, bindingId, trusted actor, effect, resource and invoke/reconcile operation; default is deny. Resource `*` explicitly grants every resource for that tool.

```bash
dutydeck tool-grant set --database /path/to/dutydeck.db --json '{"id":"ticket-close","toolId":"fake-ticket/close","bindingId":"<binding ID>","actor":{"kind":"installation_owner","id":"installation_owner"},"effects":["write"],"resources":["ticket:T-1"],"operations":["invoke","reconcile"]}'
dutydeck tool-grant list --database /path/to/dutydeck.db
dutydeck tool-grant revoke ticket-close --database /path/to/dutydeck.db
# Within the active task, reuse the host's complete command prefix and TURN
dutydeck tool list --turn "$TURN"
dutydeck tool list --summary --turn "$TURN"
dutydeck tool describe fake-ticket/get --turn "$TURN"
# Available after the plugin declares the guide below
dutydeck tool manual fake-ticket/get guide --turn "$TURN"
dutydeck tool call fake-ticket/get --json '{"ticket":"T-1"}' --call-id read-1 --turn "$TURN"
dutydeck tool call fake-ticket/close --json '{"ticket":"T-1"}' --call-id close-1 --turn "$TURN"
dutydeck tool reconcile <actionId> --turn "$TURN"
```

`list` retains full parameter schemas; `--summary` lists authorized tools without schemas, `describe` reads one tool, and `manual` reads optional reference material by logical ID. Each read rechecks the current turn identity, binding and grants. A plugin must explicitly declare a manual, for example for a registered `get` tool:

```json
{"toolManuals":{"get":{"guide":{"description":"Optional reference","path":"manuals/guide.md","maxBytes":16384}}}}
```

The manual is UTF-8 text in the package; `maxBytes` is 1–65536, defaulting to 16384. It does not replace required SOPs or `skillResources`.

Lark actors use `{"kind":"channel","appId":"cli_xxx","id":"ou_xxx"}`. Web tasks use the authenticated installation owner. The host derives actor/session/task/attempt from persisted tasks; request arguments and MCP `_meta` cannot override them. `cwd` is the actual worktree, while `workspaceRoot` selects the original project's binding. Web identities have no synthetic chatId.

HTTP exposes `/api/plugin-tools/list`, `/summary`, `/describe`, `/manual`, `/call` and `/reconcile`. The MCP Streamable HTTP tools endpoint `/api/plugin-tools/mcp` supports initialize, ping, tools/list and tools/call, without resources or sampling. Both require a session relay Bearer and `x-dutydeck-tool-turn`. MCP names are `plugin__tool`, with `{input,callId}` arguments; `dutydeck_reconcile` checks an actionId. JSON-RPC ids correlate requests only. Grant management at `/api/plugins/tool-grants` requires installation-owner authorization.

The host namespaces action IDs by tool, session, task and stable callId. Retries retain arguments and callId. Duplicates return ledger state; timeouts and lost responses become unknown and are never automatically reexecuted. Reconciliation checks both the original actor's current invoke permission and the current operator's reconcile permission. Incompatible binding revisions or handler versions leave the action unresolved. Plugins must observe AbortSignal and pass actionId to the external system for idempotency; a host timeout cannot prove external effects were cancelled. Plugin code is trusted and runs without a process sandbox.

See the packaged [fake-ticket example](../../examples/plugins/fake-ticket/README.md) and its fake service contract.

## Package bindings, skills and author SDK

Installation controls code and maximum scope. A binding selects configuration for each group or project at call time. Control Center → 插件与技能 (Plugins and skills) edits, disables and explains saved bindings; `dutydeck settings` uses the same validation:

```bash
dutydeck settings plugin-binding list
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_a 'config={"docs_dir":"/srv/runbooks/a"}'
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_b 'config={"docs_dir":"/srv/runbooks/b"}'
dutydeck settings plugin-binding set team-faq --workspace /srv/project 'config={"docs_dir":"/srv/runbooks/project"}'
dutydeck settings plugin-binding explain team-faq --app cli_bot --chat oc_a
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_a enabled=false --expected-revision 1
```

A group binding replaces the entire Bot default binding; missing fields use manifest defaults only. Web bindings match a canonical project directory exactly, including the trusted source directory of a managed worktree. Bot/group calls never fall back to a workspace binding. Saves compare revisions. Each controlled call resolves the current binding; old secret accessors reject changed or disabled bindings. Management requires installation administrator access and rejects task credentials.

Manifests may declare `apiVersion: 1` (unsupported versions are rejected) and `bindingConfig`. Supported types are `string`, `number`, `integer`, `boolean`, `string_list`, and `secret`, with applicable `required/default/enum/min/max` constraints. The binding page renders Web slot elements as a bounded preview; actions stay disabled without task context and never execute plugin scripts or arbitrary URLs. Invalid values, defaults and enum types are rejected. Credentials are stored separately and created through hidden local input or an inherited file descriptor:

```bash
dutydeck settings plugin-binding secret-set my-plugin group-a --value-fd 0
# Reads stdin and returns plugin.my-plugin.group-a; never pass plaintext as an argument.
dutydeck settings plugin-binding set my-plugin --app cli_bot --chat oc_a 'secrets={"token":"plugin.my-plugin.group-a"}'
```

References belong to one plugin. To rotate, create a new reference and revision-update the binding. Scenario `context` / `match` and business tools receive host-injected `bindingId`, `revision`, immutable `config`, and `getSecret(key)` at call time. Undeclared secret keys are rejected; explanations and snapshots never contain values. Legacy `api.config`, hooks, Agent and CI retain installation-level behavior; the panel labels Agent/CI as legacy-global.

Skills use stable `package/skill-directory` references and standard YAML multiline descriptions. Ambiguous legacy `/skills name` directives require a specific reference or path. Catalog and delivery both enforce current package, Bot/group binding and workspace scope. A manifest's `requiredSkills` plus the selected binding's `skills` apply to each task. Scenario `skills` are frozen only for the selected scenario, covering model decisions/replies/actions and direct bot messages; unselected scenario SOPs are excluded. Catalog scans isolate malformed entries and show diagnostics and incomplete results. An unrelated bad entry does not block a valid selection; an explicitly selected or required invalid Skill still rejects the task, and an incomplete catalog cannot silently resolve an ambiguous name.

The host inlines required SOPs and bounded text declared in `skillResources`, including readonly tasks: 128 KiB per skill, 64 KiB per resource (16 KiB default), 512 KiB total. Escaping links and non-text resources are rejected. After `task.beforeRun`, removed legacy content is marked `replaced`; removing required SOPs rejects the task. Historical records without a status remain unverified. Freezing text does not freeze scripts, provider processes or all executable code.

The independent `@dutydeck/plugin-sdk` exports `definePlugin`, binding/scenario types, query/action contracts, CI provider types and controlled result-tool types without server or private shared dependencies. Packaging tests install its tarball into an empty directory, compile a third-party TypeScript plugin and import it at runtime. `plugins/team-faq` is a real `npm pack` sample containing its manifest, provider, scenarios, SOP and references; tests remove the source directory and exercise two group bindings through the installed tarball. See [team-faq usage](../../plugins/team-faq/README.md).

## Controlled plugin results

A trusted `providers` plugin registers exports through `api.registerResultTool({ name, description, inputSchema, execute })`. `inputSchema.parse(input)` validates arguments; `execute(input, { invocationId, requester, signal })` returns `Promise<{ files: Array<{ name: string, data: Uint8Array }> }>`. Tools return names and bytes without filesystem paths, recipients or a model-visible body. The host stores bytes and sends a fixed viewing notice. The model receives only `deliveryId`, `status` and `fileCount`; `delivered` confirms the notice, not a download or overall task completion.

The opt-in [private-export example](../../examples/plugins/private-export/README.md) uses `.dutydeck-plugin/plugin.json`, with `providers` pointing to `providers.mjs`. Install from a source checkout; the private endpoint `<source_url>/<reportId>` supplies report bytes:

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

## External triggers

`POST /api/plugins/<plugin>/triggers/<id>`, no Web login, authenticated by the trigger's own `token` header or `hmac-sha256`. HMAC requests must include a timestamp header (default `x-dutydeck-timestamp`, Unix seconds), a one-time nonce header (default `x-dutydeck-nonce`) and the signature header; the signature is `HMAC-SHA256(secret, timestamp + "\\n" + nonce + "\\n" + SHA256(rawBody))`, in hex with an optional `sha256=` prefix. Timestamps are accepted within 300 seconds by default and a nonce can be used once. Responses: `202 {runId, sessionId, taskId, statusUrl}`, `200 {duplicate:true, runId}`, `400` not JSON, `401` bad token/signature/timestamp or reused nonce, `404` unknown trigger or disabled plugin, `413` body over 1 MiB, `429` over `maxConcurrent` (default 4, 1 to 32), `502` delivery failed (the dedupe record is revoked, so retry). Query `GET .../runs/<runId>` or cancel a still-queued run not yet submitted to the Agent with `POST .../cancel`; HMAC status and cancel requests sign an empty body and use a fresh nonce once. Cancellation cannot undo an external side effect already sent. Dedupe lasts 24 hours and survives restarts. Template values in the prompt are wrapped as untrusted data; templates cannot read auth headers, `authorization` or `cookie`. See `examples/plugins/hello`:
The same contract is available through `POST /api/plugin-triggers/v1/runs?plugin=<plugin>&triggerId=<trigger>`; status and cancellation use `/api/plugin-triggers/v1/runs/<runId>` and `/cancel` with those query parameters. `Idempotency-Key` and the manifest's `idempotencyKey` template participate in the 24-hour dedupe window, and `dryRun=true` validates authentication and rendering without starting a task. See `examples/plugins/hello`:

**Starting a work-item template.** Replace `prompt` with `workTemplate` (exactly one of the two) to open a work item from a saved template instead of sending a prompt:

```json
"workTemplate": { "session": "{{config.template_session}}", "id": "{{config.template_id}}", "version": 2, "goal": "Handle alert: {{payload.title}}" }
```

`session` is the session that saved the template; `id` and `version` are listed under `templates` in `GET /api/sessions/<session>/work-items` (an agent in the session can also use `dutydeck work templates --turn "$TURN"`). All three accept `{{config.<key>}}`; `version` is a number or a config value that resolves to a positive integer. A template starts only in the session that saved it, and that session must be the Lark session of the `target` bot in `target.chatId`; `target.session` is not used. The work item starts as the installation owner and keeps the template's confirmation rule (in a Lark group it runs only after someone confirms it in the group); its result is delivered through the work item's own delivery to that session's thread. `goal` renders like `prompt`, with external values wrapped as untrusted data. Acceptance returns `202 {runId, sessionId, workItemId, awaitingConfirmation, statusUrl}`. A missing template or version, a missing session or one outside the target chat, a disallowed scope, an inactive session or an unconfirmed delivery location returns `422 PLUGIN_TRIGGER_TEMPLATE_UNAVAILABLE` with the reason code in `cause` (for example `WORK_TEMPLATE_NOT_FOUND`); no work item is created and the dedupe record is revoked, so the same event can be resent after the configuration is fixed. Run status follows the work item: `queued` while awaiting confirmation, `running` while executing or waiting for a person, then `succeeded`, `failed` or `cancelled`, and `unknown` while a result awaits reconciliation. Work items awaiting confirmation, running, waiting or awaiting reconciliation count toward `maxConcurrent`. `cancel` only cancels a work item awaiting its first confirmation with no step attempts; started work (including work with a plan revision awaiting confirmation) stays `running` and is stopped from the work item; a failed work item with a pending revision also reports `running` and keeps its slot, and one that receives the revision only after failing takes its slot back on the next trigger request (for runs recorded within the last 24 hours). A triggered work item is not attributed to the turn currently running in the template session: it does not inherit that turn's risk policy or count toward its usage.

Use `dutydeck plugin trigger-token <plugin>/<id>` to read a token or add `--rotate` to replace it immediately. Concurrent creation or rotation of tokens for different triggers preserves each successful change.

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

**Hooks.** Each hook has `command` (string via `/bin/sh -c`, or an argv array; cwd is the plugin root), required `timeout` (100 to 600000 ms), `onFailure` (`ignore` default, or `block`) and optional `matcher` regex. stdin gets `{ event, plugin, eventId?, bindingRevision?, actor?, botAppId?, chatId?, sessionId?, taskId?, attemptId?, cwd?, payload }`; `eventId`, `actor` and `bindingRevision` are host-generated and cannot be overridden by a plugin. Exit 0 allows (stdout may be JSON with `decision` allow/deny/ask, `reason`, `additionalContext`, `updatedPrompt`); exit 2 blocks with stderr as the reason; other non-zero exits or timeouts are non-blocking errors (blocking with `onFailure: block`). The process group is killed on timeout. Hook processes inherit only basic `PATH`/`HOME`/temporary/locale variables plus explicit non-sensitive plugin metadata and config. In-process handlers registered with `api.registerHookHandler(event, handler, { timeout?, matcher? })` receive `(input, { signal })`; after the timeout (10 s by default) the host stops waiting and aborts `signal`, so pass it to any request the handler starts. Events include `tool.beforeCall` (deny can gate a tool after host authorization) and `delivery.completed` (observation), in addition to task, permission and notification events. A `permission.request` allow/deny decides without a human approval card; any other result, or a decision whose approval record cannot be written, falls back to human approval. Group collaboration's decision, response-generation and memory sessions also pass through `task.received` and `task.beforeRun` with their bot's `botAppId`, so `bot:<appId>` hooks apply to them.

**CI providers.** `/ci`, auto follow-up, Web "wait for CI", the scheduled-task condition and `POST /api/hooks/<provider id>` all go through CI provider plugins. With none installed, Lark `/ci` says it is not configured and the Web shows "no CI plugin installed". A provider registers via `api.registerCiProvider` with `id`, `displayName`, `matchRepository`, `getPipelineStatus`, `getFailureLogs`, optional PR methods used by `/pr` (`createPullRequest`, `listReviewComments`, `postComment`, and `getPullRequest(repository, number)` returning `{ state: 'open'|'closed'|'merged', headSha?, headBranch?, baseBranch?, headRepository?, title?, url? }`, which is how a merged or closed PR is noticed; only providers that return both `headBranch` and `headRepository` support claiming an existing PR with `/pr follow`; a `headRepository` different from the workspace repository is rejected as a fork, and a missing one is rejected because a fork cannot be ruled out; without it only the webhook's merge_request event can stop follow-up, otherwise polling continues until the round limit or a manual stop) and an optional `webhook: { verify, parse }` (see `packages/shared/src/plugins.ts`). The host gives every asynchronous provider call (pipeline status, failure logs, PR methods, `webhook.verify` / `parse`) a total time limit, 25 seconds by default. A provider can ask for more per method with `callTimeoutMs: { <method>: ms }` (for example paginated comments); the host clamps it between 1 second and its own ceiling: `getPipelineStatus` at most 25 seconds (CI waits poll under a 30-second lease), everything else at most 120 seconds (PR follow-up polls every 2 minutes). A timeout counts as a failed call and logs a warning: that polling round is skipped and retried next round without holding up other scheduled tasks. Every method receives a trailing `{ signal }` argument that is aborted on timeout; pass it to `fetch` and stop further pages. A timed-out `createPullRequest` or `postComment` may still have taken effect; the host does not retry it and the error asks you to check the platform first. Each `CiReviewComment` returned by `listReviewComments` carries `trusted`, `isBot` and `authorAssociation`; **comments without `trusted: true` are never handled automatically**, they only produce a "needs your decision" card. The github plugin sets `trusted` when `author_association` is OWNER, MEMBER or COLLABORATOR and the author is not a Bot. The `id` returned by `postComment` must use the same format as the ids from `listReviewComments`, otherwise Dutydeck's own reply is treated as a new comment. Bundled (install from a source checkout; the npm package does not include them):

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

**Security.** Only install plugins you trust; agents, hooks and providers run on your machine. **Provider code runs inside the daemon process with the daemon's trust level**; there is no sandbox. If a timer, connection or callback it leaves behind after `register(api)` throws an unhandled exception or rejection, the whole daemon exits with Node's default behavior (systemd restarts it, but only eligible tasks survive a restart). The `Fatal …` crash log is followed by a line naming plugins whose code appears in the stack; disable that plugin (`dutydeck plugin disable <name>`) before investigating. Hook processes and plugin services are separate processes and cannot take the daemon down. Hook processes receive an allowlisted base environment and non-sensitive declared config; secrets are available through binding accessors. **Expose trigger URLs only over HTTPS or an internal network**: HMAC requests use a short-lived timestamp and one-time nonce; token requests still rely on transport protection. Untrusted wrapping reduces prompt-injection risk but does not eliminate it; don't point an external trigger at a `full-trust` bot.
