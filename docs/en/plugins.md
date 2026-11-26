# Plugins <a id="plugins"></a>

> [← Back to README](../../README.en.md) · [All docs](../../README.en.md#docs) · [简体中文](../zh/plugins.md)

A plugin adds commands, agents, skills, external triggers, hooks, CI providers, controlled result tools and scenario packs. The core has no platform-specific code; GitHub and configurable code-host CI support and alert triage are plugins.

## Directory layout

```text
my-plugin/
├── .dutydeck-plugin/plugin.json   manifest (required)
├── commands/*.md                  slash commands (prompt template or read-only query mapping)
├── agents/*.json                  agent definitions (same shape as one DUTYDECK_AGENTS_JSON entry)
├── skills/                        skills directory
├── triggers/<id>.json             external triggers
├── hooks/hooks.json               hook configuration
├── scenarios/*.json               scenario packs
└── index.mjs                      providers entry (CI providers, scenario providers, in-process hooks)
```

`plugin.json` is strictly validated; errors identify the file and field. Fields:

| Field | Meaning |
|---|---|
| `name` | Required, kebab-case, at most 64 characters |
| `version`, `description` | Optional |
| `commands` / `agents` / `skills` / `triggers` | Directories, defaulting to `commands/`, `agents/`, `skills/`, `triggers/`; a missing default path means the component is absent |
| `hooks` | Hook configuration file, default `hooks/hooks.json` |
| `providers` | ESM entry file; no default |
| `scenarios` | Scenario-pack directory, default `scenarios/`; a missing default path means there are no packs |
| `service` | Optional standalone process service: `{ entry, mode, args? }`; `entry` is a package-relative entry, `mode` is `manual` (default) or `auto`, and `args` accepts at most 32 nonempty arguments |
| `userConfig` | `{ <snake_case key>: { description, sensitive? } }`, installation-level plugin configuration |

Paths must stay inside the plugin directory. An explicitly declared path that does not exist is an error.

`host.api` is checked for host compatibility. `host.channels` currently only declares metadata and does not participate in loading decisions. The installation record selects the `active` artifact and its `enabled` state determines whether it loads; all capabilities that require trust must still be confirmed. `binding` and the installation `scope` determine the groups, projects and calls where the loaded plugin is available.

## Eight component types

| Component | Purpose | Trust confirmation required |
|---|---|---|
| commands | By default, `/<name>` expands to a prompt template and `$ARGUMENTS` is replaced with the arguments. A command can instead map explicitly to a public read-only query without starting an Agent. `/<plugin>:<name>` always works; `/<name>` works when unambiguous. Names that clash with built-in commands are rejected. Agent-native names such as `compact`, `clear`, `init` and `review` only work as `/<plugin>:<name>` | No |
| agents | Registers Agents before merging `DUTYDECK_AGENTS_JSON`; the environment wins for the same id, and built-in Agents cannot be replaced. Definitions carry an origin marker and disappear after the plugin is disabled or uninstalled and the host restarts | **Yes** |
| skills | Loaded as one skills root | No |
| triggers | An external system starts one task over HTTP (see below) | No |
| hooks | Runs your commands at task lifecycle points (see below) | **Yes**, separately by event, such as `hooks:task.received` |
| providers | The entry module exports `register(api)` to register CI providers, scenario providers or in-process hooks. Module loading and registration share a 15-second deadline; a timeout skips that plugin and ignores later registrations | **Yes** |
| service | Runs a package service in a standalone process; `manual` starts on demand and `auto` starts with the Host, with ordered stop and restart handling | **Yes** |
| scenarios | Scenario packs handle kinds of group messages according to declarative rules (see [Writing a scenario pack](#scenario-packs)). A pack is JSON and executes no code; any provider it references is confirmed with `providers` | No |

A direct read-only command uses `query` and `argument` in its file frontmatter, and its SDK query must explicitly declare `commandOutput: 'chat'`. After configuring and granting the [fake-ticket example](../../examples/plugins/fake-ticket/README.md), send `/fake-ticket:ticket-status T-1` in Lark to receive only title and status without an Agent session. The host requires a trusted human inbound event, an enabled binding and matching actor, tool, read-effect and exact-resource grants, rechecked before delivery. Chat permission alone grants no business-data access. Only queries explicitly declaring output safe for everyone in the originating chat are accepted; private results use controlled exports, and write actions cannot be mapped. Duplicate events and unknown execution after a restart are never automatically replayed. Existing prompt commands and queries without chat-output opt-in retain their behavior; see the [Plugin SDK](../../packages/plugin-sdk/README.md).

For a direct read-only command, `plugin test` checks only that its target query is registered; it does not call the query handler or read external business data. Prompt commands still check template expansion only and do not start an Agent.

## Trust confirmation

`agents`, `hooks`, `providers` and `service` execute code or commands and must be confirmed at install. The daemon loads only **enabled plugins whose required capabilities are all confirmed**. The providers 15-second deadline covers asynchronous loading and registration that yield to the event loop; it cannot interrupt a synchronous infinite loop, which requires process termination and the next-start quarantine mechanism.

- An interactive terminal lists the capabilities and asks. A non-interactive install requires `--yes`; otherwise it refuses and lists the capabilities that need confirmation.
- `plugin update` re-confirms only **newly added** capabilities under the original rule. When a slash-command template or query mapping, Agent launch configuration or hook execution specification differs from the active version, the output lists the command identifier and before/after SHA-256 digests, not the full replacement command. An interactive terminal treats those execution changes as capabilities requiring renewed trust and asks again; declining does not write the candidate. A non-interactive update without `--yes` only prints the changes and gains no new failure; `--yes` behaves as before. Description-only and argument-hint-only edits do not count as execution changes, and an existing candidate with no new execution changes is not prompted for again. JSON output exposes the same digests in `changes`.
- npm sources are packed with `--ignore-scripts`, so prepare and other package scripts do not execute before confirmation.

## Scopes

`--scope` determines where a plugin applies:

- `global` (default): applies everywhere.
- `bot:<appId>`: applies only to that bot's sessions; a trigger's target bot must also be that bot. Web sessions have no bot, so bot-scoped commands, skills and hooks do not apply there.
- `workspace:<absolute path>`: applies only when the session working directory is under that path. Triggers check this scope too: the bot workspace before starting a new session, or the actual cwd of a reused session. Both the scope root and target directory are resolved through symlinks and compared by real path; aliases pointing inside the scope are allowed. A missing, unresolvable or out-of-scope directory prevents session creation and dispatch.
- Agents are not scope-limited; they are merged globally.

## Built-in plugins <a id="builtin-plugins"></a>

Plugins shipped with Dutydeck live in `builtin-plugins/` (`dist/builtin-plugins` once packaged). The daemon loads them before installed plugins. There is one today: `alarm`, which provides alert triage and same-alert-rule correlation; see [Group participation](lark.md#3-group-participation) for group usage.

- Built-in plugins need no trust confirmation, always have `global` scope, stay enabled and cannot be uninstalled. `plugin list` marks them as 「内置」 (built-in).
- An external plugin with the same name is refused at install; one already installed is not loaded, and `plugin list` and `doctor` report the conflict.
- A scenario pack in an external plugin that reuses a built-in pack id is skipped; the rest of that plugin still loads, so it cannot take over an existing confirmed group binding.

## CLI

```bash
dutydeck plugin install <source> [--scope global|bot:<appId>|workspace:<path>] [--yes] [--json]
dutydeck plugin list [--json]
dutydeck plugin validate <dir> [--strict]
dutydeck plugin inspect <dir|tarball|source> --json
dutydeck plugin test <dir|tarball|source>
dutydeck plugin init <name> [--dir <dir>]
dutydeck plugin config <plugin> <key> --value <value>                 # non-sensitive
printf %s "$SECRET" | dutydeck plugin config <plugin> <key> --value-fd 0   # sensitive values only via fd
dutydeck plugin trigger-token <plugin>/<trigger> [--rotate]
dutydeck plugin update [name] [--yes]       # stage a candidate only
dutydeck plugin status <name> [--json]
dutydeck plugin activate <name> [--json]    # activate a candidate offline
dutydeck plugin rollback <name> [--json]    # restore the previous version offline
dutydeck plugin enable <name>
dutydeck plugin disable <name>
dutydeck plugin uninstall <name>
```

- `<source>` is a local directory, `git+https://…`, `git@…`, `file://…` (`#ref` pins a branch, tag or commit), or `npm:name@version`. Git sources are pinned by commit SHA.
- `plugin update` stages an immutable candidate only; the active Host's provider, hook and skill paths always point to the original artifact, and restarting does not activate a candidate. If a candidate is modified, drain and stop the service, run `plugin update` again from the same source to repair it, then activate it. Damaged active or previous artifacts are never overwritten in place. Internal relative symlinks are supported; external, absolute or unresolvable links are rejected during installation and updates. Content digests detect changes without a version bump; unchanged content does not produce another candidate. Concurrent mutations are serialized by the store lock. At startup the daemon waits up to 30 seconds for the plugin store lock (longer than one `plugin activate` isolated validation). If the lock is still busy, `plugins.lock.json` is corrupt, or the `.hosts/` lease cannot be written, the daemon still starts but **loads only built-in plugins and no external plugin at all**: the log records a warning naming the failing file, plugin diagnostics list the reason, and the `dutydeck doctor` "plugin store" check fails. Sessions bound to an external plugin refuse new tasks. Fix the cause and restart the daemon to load external plugins again. Stopped or exited leases of the same database in `.hosts/` are removed at the next startup; unparsable leases are kept and still block activation until fixed by hand.
- `plugin status` distinguishes the selected artifact, candidate, previous artifact, actual live Host generation and switch blockers. Activation and rollback use offline checks: first finish or cancel unfinished tasks and reconcile this plugin's pending actions on the current version, then stop every instance sharing the plugin directory. Use `dutydeck stop` for an ordinary instance. When managing systemd directly, first inspect `systemctl --user show <unit> --property=TriggeredBy`; for socket activation, run `systemctl --user stop <unit>.socket <unit>` so the next connection cannot restart the Host. Then run `plugin activate` or `plugin rollback`, followed by `dutydeck start` or `systemctl --user start <unit>.socket <unit>`. Live Hosts, recoverable tasks and this plugin's unknown actions block switching. Dead process leases are recognized, but a dead daemon does not prove its tmux tasks ended. Unfinished legacy tasks without verifiable plugin dependencies conservatively block switching; terminal history and unrelated plugin actions do not.
- Activation imports and registers trusted providers in a terminable Node process with a temporary data directory and minimal environment. This is not a sandbox for malicious code. Validation imports only the candidate package. For the candidate manifest's direct dependencies, it reads only the name and enabled active version of external dependencies from the same lock snapshot, plus available builtin names from the same builtinRoot, for compatibility checks; it does not import dependency providers or expose dependency directories, data directories or credentials. The active artifact remains available for rollback; there is no per-session multiversion provider dispatch or automatic private-data rollback. Installation and enable/disable changes still require a new Host; uninstall also requires no active consumers.
- `plugin validate` also checks scenario packs (format, template variables, regexes and parameters) and reports file and field. `plugin validate --strict` additionally checks host compatibility, permission declarations, skill references and resource boundaries. `plugin inspect <dir|tarball|source> --json` only inspects and prints capabilities, permission footprint and a digest; it does not install the source or write plugin installation state, although a remote source may be downloaded temporarily and cleaned up afterwards. `plugin test <dir|tarball|source>` actually executes the provider module and its `register(api)`; isolation means temporary Host data and registries, **not a sandbox for malicious code**, so run it only on code you already trust. `install` and `update` do not fail on scenario pack problems but list the packs that will not load and why.
- Data lives under `plugins/` next to the database: `plugins.lock.json` (source, pinned version, scope and confirmed capabilities), immutable `.artifacts/<name>/<content-digest>/`, `.hosts/` (Host generations and database records; the legacy `<name>/` layout remains compatible), and `.data/<name>/` (the plugin's writable directory). `.trigger-tokens.json` and `.config.json` have mode 0600; sensitive configuration is stored in the local secret store.
The legacy standalone root remains `plugins/<name>/`; `plugin update`, `activate` and `rollback` never move it into `.hosts/`.

## External triggers

A trigger lets an external system (monitoring, CI or a script) make one HTTP request that starts a task in a specified group for a specified bot. See the runnable `examples/plugins/hello` example.

`triggers/<id>.json`:

```json
{
  "auth": { "type": "token", "header": "x-dutydeck-token" },
  "target": { "botAppId": "{{config.bot_app_id}}", "chatId": "{{config.chat_id}}", "session": "new" },
  "prompt": "An external system sent a ping. Reply briefly and repeat its message:\n{{payload.message}}",
  "dedupeKey": "{{payload.id}}",
  "maxConcurrent": 2
}
```

- Address: `POST /api/plugins/<plugin>/triggers/<id>`. No Web login; authentication uses the trigger's own token or signature.
- Authentication is `token` (a token in a request header, optionally prefixed with `Bearer `) or `hmac-sha256`. HMAC requests must also include a timestamp header (default `x-dutydeck-timestamp`, Unix seconds), a one-time nonce header (default `x-dutydeck-nonce`) and the signature header. In two-line pseudocode, `payload = timestamp + "\n" + nonce + "\n" + lowercaseHex(SHA256(rawBody))` and `signature = lowercaseHex(HMAC-SHA256(secret, payload))`. Here `\n` is one real LF byte (0x0A), not the two characters backslash and n, and the body hash is lowercase hexadecimal. The final hexadecimal signature may carry a `sha256=` prefix. Timestamps are accepted within 300 seconds by default and a nonce can be used once. Use `dutydeck plugin trigger-token <plugin>/<id>` to read a token or `--rotate` to replace it immediately. Concurrent creation or rotation of tokens for different triggers preserves each successful change.
- `target` values may use `{{config.<key>}}` to reference plugin configuration; the trigger is unavailable until all required values are set. `session` is `new` (a new session every time) or `reuse`.
- Responses: `202 {runId, sessionId, taskId, statusUrl}` accepted; `200 {duplicate:true, runId}` duplicate event; `400` body is not JSON; `401` invalid token, signature or timestamp, or reused nonce; `404` unknown trigger or disabled plugin; `413` body over 1 MiB; `429` over `maxConcurrent`; `502` delivery failed (the dedupe record is revoked, so retry). With the same authentication, query `GET .../runs/<runId>` or cancel a still-queued run not yet submitted to the Agent with `POST .../cancel`. HMAC status and cancel requests sign an empty body with a fresh nonce used once. A run that has started stays running; cancellation cannot undo an external side effect already sent.
- The unified task entry is also available: `POST /api/plugin-triggers/v1/runs?plugin=<plugin>&triggerId=<trigger>`; status and cancellation use `/api/plugin-triggers/v1/runs/<runId>` and `/cancel` with those query parameters. Deduplication uses the first available source in this order: `Idempotency-Key` request header, manifest `idempotencyKey` template, legacy `dedupeKey`, then the entire request body; simultaneous values are not combined. `dryRun=true` covers authentication, JSON, concurrency/deduplication pre-processing and template rendering only. It does not prove that the saved template version, owning session, target or actual delivery is usable; validate a real template through a controlled real trigger.
- Dedupe lasts 24 hours and survives restarts, using the rendered key selected by the precedence above; only the absence of all three explicit sources falls back to the entire body. `maxConcurrent` defaults to 4 and ranges from 1 to 32. Active tasks and work items that still hold a concurrency slot, including those awaiting first confirmation, keep their run records beyond 24 hours and remain queryable and counted after a restart. Expired finished records are removed. Dedupe expiry does not cancel an old run; the same event can create a new run in the next window subject to concurrency limits.
- `{{payload.a.b}}` in a template reads a request-body field and `{{payload}}` reads the whole body. Every value entering the prompt is wrapped as **untrusted data** with a random boundary and a 20,000-character limit per value. Templates cannot read authentication headers, `authorization` or `cookie`.
- Task results are sent to the target group as text, up to 8,000 characters.
- **Starting a work-item template:** replace `prompt` with `workTemplate` (exactly one of the two) to open a work item from a saved template instead of sending a prompt:

  ```json
  "workTemplate": { "session": "{{config.template_session}}", "id": "{{config.template_id}}", "version": 2, "goal": "Handle alert: {{payload.title}}" }
  ```

  `session` is the session that saved the template; `id` and `version` are listed under `templates` in `GET /api/sessions/<session>/work-items` (an Agent in the session can also use `dutydeck work templates --turn "$TURN"`). All three accept `{{config.<key>}}`; `version` is a number or a config value that resolves to a positive integer. A template starts only in the session that saved it, and that session must be the Lark session of the `target` bot in `target.chatId`; `target.session` is not used. The work item starts as the installation owner and keeps the template's confirmation rule (in a Lark group it runs only after someone confirms it in the group); its result is delivered through the work item's own delivery to that session's original thread. `goal` renders like `prompt`, with external values wrapped as untrusted data.
  - Acceptance returns `202 {runId, sessionId, workItemId, awaitingConfirmation, statusUrl}`. A missing template or version, a missing session or one outside the target chat, a disallowed scope, an inactive session or an unconfirmed delivery location returns `422 PLUGIN_TRIGGER_TEMPLATE_UNAVAILABLE` with the reason code in `cause` (for example `WORK_TEMPLATE_NOT_FOUND`). No work item is created and the dedupe record is revoked, so the same event can be resent after the configuration is fixed.
  - Run status follows the work item: `queued` while awaiting confirmation, `running` while executing or waiting for a person, then `succeeded`, `failed` or `cancelled`, and `unknown` while a result awaits reconciliation. Work items awaiting confirmation, running, waiting or awaiting reconciliation count toward `maxConcurrent`. `cancel` only cancels a work item awaiting its first confirmation with no step attempts; started work (including work with a plan revision awaiting confirmation) stays `running` and is stopped from the work item. A failed work item with a pending revision also reports `running` and keeps its slot; one that receives the revision only after failing takes its slot back on the next trigger request, for runs recorded within 24 hours of the trigger. A triggered work item is not attributed to the turn currently running in the template session: it does not inherit that turn's risk policy or count toward its usage.

```bash
dutydeck plugin install examples/plugins/hello --yes
dutydeck plugin config hello bot_app_id --value cli_xxx
dutydeck plugin config hello chat_id --value oc_xxx
dutydeck plugin trigger-token hello/ping        # save the token
dutydeck restart
curl -X POST http://127.0.0.1:4310/api/plugins/hello/triggers/ping \
  -H 'content-type: application/json' -H "x-dutydeck-token: $TOKEN" \
  -d '{"id":"1","message":"hi"}'
```

## Business query and action tools

Trusted providers register `api.registerQuery` / `api.registerAction` using the public `@dutydeck/plugin-sdk`. Each tool declares a serializable JSON Schema, compatibility version and resource selector. The supported schema subset is object, array, string, number, integer and boolean with the SDK's listed bounds; objects must reject additional properties. Queries return model-visible JSON; actions return short receipts. Private files use the separate controlled-result interface below.

Installation and enablement require a separate Bot/group or exact workspace binding, plus explicit installation-owner grants. Business configuration cannot increase permission. Grants match toolId, bindingId, trusted actor, effect, resource and invoke/reconcile operation; default is deny. Resource `*` explicitly grants every resource for that tool. For example:

```bash
dutydeck tool-grant set --database /path/to/dutydeck.db --json '{"id":"ticket-close","toolId":"fake-ticket/close","bindingId":"<binding ID>","actor":{"kind":"installation_owner","id":"installation_owner"},"effects":["write"],"resources":["ticket:T-1"],"operations":["invoke","reconcile"]}'
dutydeck tool-grant list --database /path/to/dutydeck.db
dutydeck tool-grant revoke ticket-close --database /path/to/dutydeck.db
```

Lark actors use `{"kind":"channel","appId":"cli_xxx","id":"ou_xxx"}`. Web tasks use the authenticated installation owner. The host derives actor/session/task/attempt from persisted tasks; request arguments and MCP `_meta` cannot override them. `cwd` is the actual worktree, while `workspaceRoot` selects the original project's binding. Web identities have no synthetic chatId.

```bash
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

HTTP exposes `/api/plugin-tools/list`, `/summary`, `/describe`, `/manual`, `/call` and `/reconcile`. The MCP Streamable HTTP tools endpoint `/api/plugin-tools/mcp` supports initialize, ping, tools/list and tools/call, without resources or sampling. Both require a session relay Bearer and `x-dutydeck-tool-turn`. MCP names are `plugin__tool`, with `{input,callId}` arguments; `dutydeck_reconcile` checks an actionId. JSON-RPC ids correlate requests only, not idempotency keys. Grant management at `/api/plugins/tool-grants` requires installation-owner authorization.

The host namespaces action IDs by tool, session, task and stable callId. Retries retain arguments and callId. Duplicates return ledger state; timeouts and lost responses become unknown and are never automatically reexecuted. Reconciliation checks both the original actor's current invoke permission and the current operator's reconcile permission. Incompatible binding revisions or handler versions leave the action unresolved. Plugins must observe AbortSignal and pass actionId to the external system for idempotency; a host timeout cannot prove external effects were cancelled. Plugin code is trusted and runs without a process sandbox.

See the packaged [fake-ticket example](../../examples/plugins/fake-ticket/README.md) and its fake service contract.

## Package bindings, skills and author SDK

Installation controls code and maximum scope. A binding selects configuration for each group or project at call time. Control Center → 插件与技能 (Plugins and skills) edits, disables and explains saved bindings; the CLI uses the same validation:

```bash
dutydeck settings plugin-binding list
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_a 'config={"docs_dir":"/srv/runbooks/a"}'
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_b 'config={"docs_dir":"/srv/runbooks/b"}'
dutydeck settings plugin-binding set team-faq --workspace /srv/project 'config={"docs_dir":"/srv/runbooks/project"}'
dutydeck settings plugin-binding explain team-faq --app cli_bot --chat oc_a
dutydeck settings plugin-binding set team-faq --app cli_bot --chat oc_a enabled=false --expected-revision 1
```

A group binding replaces the entire Bot default binding; missing fields use manifest defaults only. Web bindings match a canonical project directory exactly. When editing through the CLI, the target server resolves workspace aliases, including symlinks, and preserves saved configuration and revisions; disabled bindings can be re-enabled. A managed worktree uses the trusted session's original project directory. Bot/group calls never fall back to a workspace binding. Saves compare revisions, and the next controlled call resolves the new binding. An old call's secret accessor rejects changed or disabled bindings. Management APIs require installation administrator access and reject task credentials.

Manifests may declare `apiVersion: 1` (unsupported versions are rejected), `host`/`dependencies`, `permissions` (`secrets/network/filesystem/effects` are audit declarations only), and declarative Web `slots` (`settings`, `command_palette`, `task_panel`, `result_card`; elements are limited to text, status, tables and actions targeting registered commands or tools). Dependency versions use semver ranges: a complete `^0.0.3` accepts only `0.0.3`, not `0.0.4`, while wildcard ranges such as `^0.0.x` retain wildcard semantics. The binding page renders these elements as a bounded preview; actions stay disabled without task context and never execute plugin scripts or arbitrary URLs. `bindingConfig` supports `string`, `number`, `integer`, `boolean`, `string_list` and `secret`, with applicable `required/default/enum/min/max` constraints. Ordinary values and secret references are stored separately; invalid values, defaults and enum types are rejected. Credentials are created only through hidden local input or a file descriptor:

```bash
dutydeck settings plugin-binding secret-set my-plugin group-a --value-fd 0
# Reads stdin and returns plugin.my-plugin.group-a; never pass plaintext as an argument.
dutydeck settings plugin-binding set my-plugin --app cli_bot --chat oc_a 'secrets={"token":"plugin.my-plugin.group-a"}'
```

References belong to one plugin. To rotate, create a new reference and revision-update the binding instead of overwriting the old reference. A provider's `context` / `match` and business tools receive host-injected `bindingId`, `revision`, immutable `config`, and `getSecret(key)` at call time. Undeclared secret keys are rejected; explanations and task snapshots never contain secret values. Legacy `api.config` remains installation-level string configuration; legacy hooks, Agent and CI retain installation-level behavior, and the panel labels Agent/CI as legacy-global capabilities.

Skills use stable `package/skill-directory` references and standard YAML multiline descriptions in `SKILL.md`. Ambiguous legacy `/skills name` directives require a specific reference or path. Plugin, Bot/group binding and workspace scope constrain both catalog discovery and actual reads; disabling prevents reads even through an explicit reference. A manifest's `requiredSkills` plus the selected binding's `skills` are shared SOPs for every task. Scenario `skills` are frozen only after that scenario is selected, covering model decisions/replies/actions and direct bot messages; unselected scenario SOPs are excluded. Catalog scans isolate malformed entries and show diagnostics and incomplete results. An unrelated bad entry does not block a valid selection; an explicitly selected or required invalid Skill still rejects the task, and an incomplete catalog cannot silently resolve an ambiguous name.

The host inlines required SOPs and bounded text declared in `skillResources`, including readonly backends: at most 128 KiB per skill, 64 KiB per resource (16 KiB default), and 512 KiB total. Escaping links and non-text resources are rejected. Final content is checked and frozen after `task.beforeRun`: skills replaced by legacy hooks are marked `replaced`, and removing required SOPs rejects the task. Historical records without a status remain "unverified" and cannot prove final delivery. Freezing body and reference snapshots does not freeze scripts, provider processes or all executable code.

Plugin installation unpacks artifacts without running npm install. Runtime imports of `definePlugin` or third-party libraries must be bundled into the provider entry before publishing, for example `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs`. Include `dist` and `.dutydeck-plugin` in npm files; do not mark `@dutydeck/plugin-sdk` external. Type-only SDK imports need no runtime dependency. Acceptance covers an independently installed SDK, bundling, packing, deleting the author directory, and loading and calling the result through the real Host.

The independent `@dutydeck/plugin-sdk` exports `definePlugin`, `PluginBindingContext`, scenario, query/action, CI provider and controlled result-tool author types without server or private shared dependencies. Packaging tests install its tarball into an empty directory, compile a third-party TypeScript plugin and import it at runtime. `plugins/team-faq` is a real `npm pack` sample containing its manifest, provider, scenarios, SOP and references; tests remove the source directory and exercise two group bindings through the installed tarball. See [team-faq usage](../../plugins/team-faq/README.md).

### Packaging a Leader guide as a plugin skill <a id="leader-guide"></a>

In [Leader mode](lark.md#leader-mode), the skill that the bot setting `leaderSkill` points to decides which rules the Leader follows. To hand one set of rules to several bots or teams, package it as a plugin with a single skill: no commands, hooks or providers, so installing it needs no trust confirmation. The [leader](../../examples/plugins/leader/README.md) example is a generic guide: what to look at first, what the Leader decides itself, what it escalates, which questions acceptance asks and how to word an escalation.

```bash
dutydeck plugin install ./examples/plugins/leader --scope bot:<appId> --yes
dutydeck restart
dutydeck settings bot set <appId> leaderSkill=leader-guide/leader
```

Reference files you want the Leader to receive on every run go into the manifest's `skillResources`; for the rest, name the path in `SKILL.md` and the Leader reads them itself when needed (the Leader Agent must be able to read the skill directory). A plugin is optional: skill directories skip symlinks that point outside them, so for a guide kept elsewhere put the absolute path of its `SKILL.md` (or directory) in `leaderSkill`; that source does not inline `skillResources`, and the Leader reads sibling reference files itself by path. The authorization ledger and the decision record are supplied by the host on each run, so the guide should not have the Leader maintain files for them.

## Plugin services

Start, stop, restart and automatic restart requests for the same plugin service run in order; a restart ends the old instance before starting its replacement. On POSIX systems, stopping waits for workers in the owned process group too, forcibly ending survivors after the grace period. A parent exiting first does not report the service as stopped. Failed cleanup returns an error; another instance can start only after the old one has been cleaned up. Descendants that leave the process group are outside this cleanup scope; Windows still manages only the direct child.

### Optional service plugin: Lark `/job` intake for RoveTap projects (rovetap-jobs) <a id="rovetap-jobs"></a>

`plugins/rovetap-jobs` is a repository-shipped plugin you install explicitly. Its auto service intercepts `/job [project] [instruction]` messages from dispatch groups through `eventHandlers` (it replies `stop` for recognized commands and `continue` for ordinary traffic), reads verifiable material in the topic with the bot's own credentials, creates a job for a fixed project leader through local `pairfob project submit/status`, and posts acceptance and phase updates back into the original topic. It starts no extra Agent and has no third-party runtime dependencies. The full operator guide, including the config key reference and troubleshooting, is [`plugins/rovetap-jobs/README.md`](../../plugins/rovetap-jobs/README.md) (Chinese).

People and bots share the `commanderOpenIds` allowlist. To authorize a bot, use the `ou_...` ID that the receiving app sees in `sender.sender_id.open_id` on a message event. The bot can forward a message into a group listed in `allowedChatIds` and reply to the forwarded copy with `@receiving-bot /job` using its own credentials. Acceptance and progress updates appear in that topic.

Set `"allowAllBotCommanders": true` in the plugin's `config.json` and restart the plugin service to let every bot in the groups listed in `allowedChatIds` dispatch jobs. People still need an entry in `commanderOpenIds`. Set that list to `[]` for bot-only dispatch. The option defaults to off.

To add a second service for new orders from unlisted bots, enable `allowAllBotCommanders`, copy the original `commanderOpenIds`, and set `additionalBotCommandsSince` to a fixed ISO 8601 timestamp with a time zone. Register the new handler before the original one. Commands sent before the cutoff and commands from listed senders continue to the original handler.

Enable the plugin in chats that support topic replies. If Feishu reports that the chat lacks topic support (230071), the receipt is marked as failed.

Shortest working sequence; see the plugin README for details:

```bash
# 1) Enable the dedicated pairfob project entry, bind one leader, then restart the pairfob hub
pairfob hub project-job enable --project rovetap --leader pl_<24 hex chars>
# 2) Install and trust the service capability
dutydeck plugin install ./plugins/rovetap-jobs --yes
# 3) Write a 0600 config at <database-dir>/plugins/.data/rovetap-jobs/config.json:
#    appId, handlerToken(File), appSecret(File), allowedChatIds, commanderOpenIds,
#    selfOpenId (bot.open_id) if you want `@bot /job`,
#    a fixed listen.port (the default 0 picks a random port and cannot back a stable
#    eventHandlers URL), pairfob.bin (absolute path), and the hub-printed
#    pairfob.socket/tokenFile
# 4) Restart the host so the auto service starts, then check health
dutydeck restart            # systemd units: dutydeck restart --unit <unit>
curl http://127.0.0.1:<fixed-port>/healthz
# 5) Bind the message event handler last (the array replaces wholesale; append to existing handlers)
dutydeck settings bot set cli_xxx 'eventHandlers=[{"id":"rovetap-jobs","eventTypes":["im.message.receive_v1"],"url":"http://127.0.0.1:<fixed-port>/lark/events","token":"<same value as handlerToken>"}]'
```

Two boundaries come up often. The first is @-mentions and visibility: a bare `/job` is accepted whenever Feishu delivers the event and does not need `selfOpenId`; an `@bot /job` form is accepted only when the configured trusted `selfOpenId` exactly matches the mention `open_id` in the event — without it (or on a mismatch) the message continues through Dutydeck. So when the Feishu app only receives @-addressed group messages, set `selfOpenId` first (`bot.open_id` from `GET /open-apis/bot/v3/info` with the same app credentials); otherwise use a bare `/job` after the `im:message.group_msg` scope is approved and published. The second is material: forward the feedback to the group, open its topic, and send `/job` or `@bot /job`. The forwarded message can be the topic root, or a merged forward can appear beneath an ordinary title. A single forwarded message does not always carry a platform forwarding marker. When several sources are available, the original commander selects one in the same topic using `/job 选 #<short code>` from the receipt; the plugin verifies the choice and sends the original instruction and selected material to the leader. The selection prompt lasts 24 hours; after it expires, quote the material again and send `/job`. Follow the receipt if attribution, ordering, or completeness cannot be established. Duplicate deliveries and restarts reuse durable state; an unknown submission outcome is reconciled before any retry. Instructions and material are each capped at 4000 Unicode code points; both `limits.maxInstructionChars` and `limits.maxMaterialChars` can only lower that. On configuration, `listen.host` may only be a local loopback address; if required values such as the material-reading `appSecret`, `pairfob.bin`, or the pairfob project token file are missing, the service fails at startup and names the config key or path on stderr instead of accepting `/job` commands that never receive a reply.

When the project connection fails before submission, the plugin waits and retries with the original saved command and material. An unknown submission outcome triggers a status lookup by the original key.

The acceptance reply includes a task number and a title fragment. In the RoveTap desktop client connected to the hub, go to **Projects** and open **Project leader** under the relevant project. On the updated desktop board, enter the full task number in **Search tasks** to distinguish tasks that share the default title from a bare `/job`. On older versions and mobile, look for the title fragment. For tasks with the same title, compare the quoted source and intake time under **Job source** in the task details. Progress updates continue in the original topic. An optional `webBaseUrl` opens the task only in a RoveTap environment with an existing hub connection. Feishu's in-app browser shows the connection screen when it has no such connection.

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

## Hook protocol

`hooks/hooks.json` lists commands by event:

```json
{
  "task.received": [
    { "command": ["node", "hooks/log-event.mjs"], "timeout": 5000 }
  ]
}
```

- `command`: a string runs through `/bin/sh -c`; an array executes directly. The working directory is the plugin root. `timeout` is required, from 100 to 600000 ms. `onFailure` is `ignore` (default) or `block`. `matcher` is an optional regular expression (see the table for its target); installation rejects patterns vulnerable to catastrophic backtracking.
- **Input:** stdin receives one JSON object: `{ event, plugin, eventId?, bindingRevision?, actor?, botAppId?, chatId?, sessionId?, taskId?, attemptId?, cwd?, payload }`. `eventId`, `actor` and `bindingRevision` are host-generated and cannot be overridden by a plugin. Session/task/attempt identities available from task and tool entry points are also passed at the top level.
- **Environment:** only basic variables such as `PATH`, `HOME`, temporary directories, locale and timezone are inherited, plus `DUTYDECK_PLUGIN_NAME`, `DUTYDECK_PLUGIN_ROOT`, `DUTYDECK_PLUGIN_DATA`, non-sensitive `DUTYDECK_PLUGIN_CONFIG_<KEY>` and `DUTYDECK_HOOK_EVENT`. Secrets are available only through binding accessors.
- **Output:** exit 0 allows; stdout may be JSON containing `decision` (`allow` / `deny` / `ask`), `reason`, `additionalContext` and `updatedPrompt`. Exit 2 blocks, with stderr as the reason. Other non-zero exits and timeouts are non-blocking errors, or blocking with `onFailure: block`. On POSIX, a timeout kills the owned process group and returns immediately; Windows terminates only the direct child and does not guarantee descendant cleanup. After UTF-8 decoding, stdout is limited to 65,536 JavaScript UTF-16 code units and stderr to 8,192 code units; these are not UTF-8 byte limits. Excess stdout is treated as absent.
- **Ordering:** plugins run by plugin name, then declaration order. `deny` takes effect immediately and stops; otherwise `ask` takes precedence over `allow` when results are merged.
- **In-process hooks:** handlers registered with `api.registerHookHandler(event, handler, { timeout?, matcher? })` receive `(input, { signal })`. After the timeout (10 seconds by default), the host stops waiting and aborts `signal`; handlers should pass it to requests they start and stop background work promptly.

| Event | When it runs | Payload | `matcher` target | Effective output |
|---|---|---|---|---|
| `task.received` | On task ingress (Web, Lark, automation and triggers) | source, namespace, key, prompt, mode, actor | Session source | `deny` rejects the task (403 `PLUGIN_HOOK_DENIED`) |
| `task.beforeRun` | Before task start, after skills processing and before prompt freezing | source, prompt, skills | Session source | `deny` rejects; `additionalContext` appends; `updatedPrompt` replaces |
| `tool.beforeCall` | After business-tool authorization and before the actual call | tool, input, resource, actor | Tool name | `deny` blocks; identity is stamped by the host |
| `permission.request` | Before an approval request is sent | Complete permission request | Request title | `allow` / `deny` decides directly without human approval; any other result, or failure to write the substitute approval record, falls back to human approval |
| `task.completed` | Asynchronously after task settlement | status, prompt, source; taskId at top level | status | None |
| `verification.completed` | Asynchronously after verification finishes | Verification result plus source | status | None |
| `notify` | Before CI notices and trigger results are sent | `ci_notice` (title, text, failed) or `trigger_result` (taskId, status, text) | kind | `deny` suppresses delivery |
| `delivery.completed` | After a business-tool call completes (succeeded, failed, unknown or rejected by a gate) | tool, status, actionId when available | kind | Asynchronous observation only |

Group collaboration's decision, response-generation, memory and reply-polishing sessions also pass through `task.received` and `task.beforeRun`, with their owning bot's `botAppId`, so `bot:<appId>` hooks apply to them; memory sessions have no `chatId`. For these four session kinds, `task.beforeRun` honors only `deny`: `additionalContext` and `updatedPrompt` are ignored with a warning. `permission.request` likewise honors only `deny`; `allow` is ignored with a warning and the original human approval flow continues regardless of plugin scope. Their `task.completed` (and `verification.completed` where applicable) also carries `botAppId`, so bot-scoped hooks receive it. Use payload `source` (`lark-decision`, `lark-response`, `lark-memory`, `lark-reply-polish`) to distinguish them.

Currently `notify` covers only CI notices and trigger results; Lark task result cards do not pass through it.

## CI providers

The core routes `/ci`, automatic follow-up, Web "wait for CI", scheduled-task conditions and `POST /api/hooks/<provider id>` through CI provider plugins. **With no CI plugin installed**, Lark `/ci` replies "not configured" with installation instructions, the Web shows "no CI plugin installed", and ordinary scheduled tasks are unaffected. Installing any one plugin does not enable every subcommand: `/ci wait` without a webhook needs `getPipelineStatus`, `/ci fix` needs a configured webhook matching origin, and other operations are checked against their own method capabilities.

A provider registers through `api.registerCiProvider(provider)` in the `providers` entry. Interface (types in `packages/shared/src/plugins.ts`):

- `id`, `displayName` (required; shown in cards, prompts and the Web), and optional `changeRequestLabel(n)`;
- `matchRepository(remoteUrl)`: return the repository (`{owner, name, slug}`) when the remote belongs to this provider, otherwise `undefined`;
- Optional `getPipelineStatus(query)` for polling waits and `getFailureLogs(repository, runId)` for supplemental failure logs. Without the former, polling waits are unavailable; without the latter, supplemental failure logs are unavailable. Registration still succeeds and every other capability is checked against its own methods;
- Every asynchronous host call (pipeline status, failure logs, PR methods, `webhook.verify` / `parse`) has a total deadline, 25 seconds by default. A provider can request more per method with `callTimeoutMs: { <method>: ms }` (for example paginated comments); the host clamps it between 1 second and its own ceiling: `getPipelineStatus` at most 25 seconds (CI waits poll under a 30-second lease), everything else at most 120 seconds (PR follow-up polls every 2 minutes). A timeout ends only this provider wait and logs a warning; later subscriptions in a serial tick and later ticks can be delayed, and multiple timeouts accumulate. Every method receives a trailing `{ signal }` argument that is aborted on timeout: pass it to `fetch` and stop further pages, or it can continue occupying later work. A timed-out `createPullRequest` or `postComment` may still have taken effect; the host does not retry it and the error asks you to check the platform first;
- Optional PR methods used by `/pr` and Web "open PR": `createPullRequest`, `listReviewComments`, `postComment`, and `getPullRequest(repository, number)`, returning `{ state: 'open' | 'closed' | 'merged', headSha?, headBranch?, baseBranch?, headRepository?, title?, url? }` to discover merged or closed PRs. Only providers returning both `headBranch` and `headRepository` support claiming an existing PR with `/pr follow`. A `headRepository` different from the workspace repository is rejected as a fork; a missing one is rejected because a fork cannot be ruled out. Without `getPullRequest`, only the webhook's pull_request event can discover a merge or close; with neither, follow-up polls until the round limit or a manual stop. Each `CiReviewComment` returned by `listReviewComments` carries `trusted`, `isBot` and `authorAssociation`: **comments without `trusted: true` are never handled automatically**, they only produce a "needs your decision" card. The github plugin sets `trusted` when `author_association` is OWNER, MEMBER or COLLABORATOR and the author is not a Bot. The `id` returned by `postComment` must use the same format as the corresponding comment's `id` from `listReviewComments`, otherwise Dutydeck's own reply is treated as a new comment;
- Optional `webhook: { verify(req), parse(req) }`: `verify` may return `signedAt`, and event `occurredAt` returned by `parse` uses the same unit; both are **Unix epoch milliseconds, not seconds**. The host uses `signedAt` for a five-minute replay window. For a valid event the provider does not handle, `parse` returns `undefined` and the host responds 202 ignored; throw `statusCode: 400` only for an invalid request body. `timeIsAdvisory: true` means `occurredAt` is used for ordering only, not replay-window checks. If an optional method is absent, its corresponding capability is unavailable.

After webhook verification, the host saves the normalized event and the IDs of subscriptions matched at receipt time in one database transaction before returning `accepted`. If processing exits partway, restart handles only subscriptions not yet admitted. Persisted repair or continuation tasks use the existing execution ledger; recovery does not replay the whole event or add newer subscriptions. Provider availability, subscriptions, sessions and task authorization are checked again. Cancelled or invalid targets do not execute. A full subscription pipeline queue leaves the event pending for a later maintenance round.

Reusing an event ID with different content within the deduplication retention period returns a conflict. Pending admissions are not deleted when the dedupe TTL expires; admitted completed records can be removed after expiry, so deduplication does not extend beyond record cleanup. Plugin-trigger dedupe-only records retain their existing semantics, and `/pr` follow-up remains a best-effort notification; neither is covered by this durable admission guarantee.

The repository includes two CI plugins (install from a source checkout; the npm package does not include them):

| Plugin | Provides | Configuration |
|---|---|---|
| `plugins/github` | GitHub Actions status and failure logs (failed jobs and steps, last 3,000 log characters); PR creation, state and comment read/write for `/pr` and Web "open PR"; optional webhook `POST /api/hooks/github` (`X-Hub-Signature-256`) | `github.token` (required for private-repository reads and writes such as creating PRs or posting comments; public build, PR-state and comment reads can start anonymously), `github.webhook_secret` (optional; enables the webhook when set) |
| `plugins/codebase` | Configurable code-host pipeline and MR webhook `POST /api/hooks/codebase`; also an example CI webhook plugin | `codebase.host` (optional, defaults to `git.example.com`), `codebase.webhook_secret` (optional, sensitive) |

```bash
dutydeck plugin install ./plugins/github --yes
printf %s "$TOKEN"  | dutydeck plugin config github token --value-fd 0
printf %s "$SECRET" | dutydeck plugin config github webhook_secret --value-fd 0
dutydeck restart
```

Configurable code-host CI example:

```bash
dutydeck plugin install ./plugins/codebase --yes
dutydeck plugin config codebase host --value git.example.com
printf %s "$SECRET" | dutydeck plugin config codebase webhook_secret --value-fd 0
dutydeck restart
```

Writes such as opening a PR or posting a comment require `github.token` with pull-request read/write permission. Reading Actions, PR state or comments in private repositories also needs the corresponding token permissions. Public build, PR-state and comment reads can start anonymously; restricted or private resources still require a token. Pushing uses local git credentials, not this token. See each plugin directory's `README.md` for signatures, tokens, `X-Dutydeck-Event-Id` and other details. Without a GitHub webhook, polling waits for builds; with one, `/ci wait` without a workflow argument and `/ci fix` wait for GitHub events instead, while explicit `/ci wait <workflow>` still polls.

Related behavior:

- The scheduled-task condition "run when CI has a new failed build" is `ci_new_failure`; the old `github_new_failure` remains readable and accepted.
- `GET /api/sessions/:id/automation/ci-providers` lists loaded CI providers.
- Lark `/ci` is provided by CI providers. Only `/ci wait` without a workflow argument prefers a matching webhook; explicit `/ci wait <workflow>` always polls and requires `getPipelineStatus`. `/ci fix` requires a configured webhook matching origin. A polling-only provider does not make both operations available.
- `/pr` works with any CI plugin implementing `createPullRequest`. A webhook provider's pull_request merge or close event stops PR follow-up immediately, and a pipeline event triggers an immediate check.

## Writing a scenario pack <a id="scenario-packs"></a>

A scenario pack tells the bot how to handle one kind of group message, for example starting a triage task when a source bot posts an alert. Each pack is one JSON file in the plugin's `scenarios/` directory; `packages/shared/src/scenarios.ts` is the authoritative schema for its format and field limits. Examples: `builtin-plugins/alarm` (`direct` mode with a correlation provider) and `plugins/team-faq` (`model` mode with a context provider).

A pack declares parameters (confirmed when enabled in the group and editable on the Web; types are `integer`, `string_list`, `bot_list`), the trigger, execution instruction, group on/off phrases and confirmation-card text, a `/status` line, "why no reply" explanations and Web text. Pack ids are kebab-case, at most 32 characters.

A pack `version` is semver. Within the same major version, existing group bindings keep working and parameters the pack adds take the pack defaults. When the major version changes, existing bindings must be confirmed again in the group, and enable confirmation cards sent before the upgrade no longer work, so say it again.

**Two modes**

- `direct`: triggered only by bot messages. A match skips the decision model; dedupe and the hourly cap decide whether to start a task, which runs in the name of the person who confirmed in the group, through the same path as an @ to the bot. These are mandatory contracts; omitting them only selects defaults, never "unlimited":
  - Only source bots listed in the `bot_list` parameter named by `trigger.sourceBotsParam` (`role: "source"`) trigger the pack, never the bot itself. Other `role: "source"` parameters only keep those bots from counting as bots that answer; they do not trigger.
  - A requester is required: enabling only happens through the in-group confirmation card, and the Web can only edit a confirmed binding. Therefore a `direct` pack must declare `phrases` with non-empty `enable` and `disable` or it fails validation.
  - `trigger.filter.keywordsAnyParam` names a `string_list` parameter; a message whose text contains none of its keywords is recorded as filtered and starts nothing. An empty list filters nothing. `trigger.filter` is `direct`-only: a `model` pack that declares it fails validation, and `model` packs select messages with `trigger.match`.
  - `dedupe` is either the core `source_text_v1` (source plus text with links, numbers, long hex strings and whitespace removed, so changing times, values and instance ids still count as the same alert) or the pack's own provider. The dedupe-window parameter is 1–168 hours and the hourly-cap parameter is 1–30.
  - In multi-bot groups only the responder acts. Every outcome (started, filtered, duplicate, over the cap, not the responder, no requester, abstained on error) is recorded so "why no reply" can find it.
- `model`: triggered by human messages, only at the `selective` and `eager` levels; messages that @ the bot or reply to it do not go through packs. A match goes to the participation decision model with the pack's guidance and context:
  - The guidance is part of the decision prompt, and the provider's `context` is attached as untrusted material, at most `decisionChars` characters. When the decision is to answer, the reply or task gets the same context (at most `maxChars` characters) and `execution.instruction`, without calling the provider again.
  - A matched pack counts as the bot's scope, so a `selective` bot without a scope that is not the responder can still answer such messages. Conversely, matched messages are judged by scope too: the `eager` "answer by default" and single-human-group default no longer apply directly. Role scope and scenario eligibility are evaluated independently; either can qualify the message. A scenario abstaining does not cancel eligibility from the role scope or a message clearly addressing the bot. With Team FAQ as the only basis, a keyword match without runbook coverage still goes unanswered. The guidance only says when to answer and cannot loosen the core rules.
  - When several `model` packs match one message, only the first by pack id is used.
  - After deciding and before replying or starting the task, the bot checks again that the pack is still on in the group and sends nothing if it was turned off.
  - Enabling needs no requester and can be done directly from the Web or with `scenarios=`. The in-group phrases post a confirmation card with no parameters to fill in.

A pack may declare `topicOwnership: { "sourceTopics": "neutral" }` (used by `alarm`): in multi-bot groups, a topic opened under a source bot's message does not count as another bot's topic. The bot stays out only when another bot has already posted there or the topic cannot be read completely or fails to load. This does not guarantee that only one bot answers.

**Providers and trust**

A pack can reference providers registered by its plugin in `register(api)` with `api.registerScenarioProvider(provider)`: `match` (extra matching or a dedupe key), `correlationKey` (the key for finding an earlier turn) and `context` (context for `model` mode). Providers are plugin code and are confirmed together with `providers`. Every call has a deadline (`match` 500 ms, 1 second total for one correlation round, `context` 5 seconds by default and at most 15 seconds); late results are discarded. A pack whose provider is not registered is skipped.

**Regular expressions**

Regexes in triggers and group on/off phrases allow only the `i`, `m`, `s`, `u` flags (the host adds `g` for capture-all) and at most 1,000 characters of source. They run in an isolated host thread with a 200 ms limit per run, on at most the first 4,000 characters of input. `validate` only warns about patterns that may backtrack catastrophically; safety comes from isolated execution and the timeout.

**Template variables**

Text fields accept `{variable}` and one level of conditionals `{variable?when set:when empty}`. Each position allows a fixed set of variables; anything else fails validation:

| Position | Available variables |
|---|---|
| `execution.instruction`, `execution.intro` | `{source}` (source bot name; a `model` instruction takes none) |
| `correlation.prompt` | `{date}` |
| `correlation.cardLine` | `{date}`, `{headline}`, `{url}` |
| `confirm.enableSummary`, `disableSummary`, `enabledResult` | `{summary}` and parameters |
| `status.summary` | Parameters |
| `explain.*` | `{time}`, `{reason}`, `{snippet}` |
| `web.description` | `{requesterId}` and parameters |

Titles, nouns, decision guidance, parameter descriptions, `reasons` and similar fields are literal text and cannot contain variables. Message text and model output never go into an instruction position: the source message and earlier conclusion follow the instruction as untrusted material, and the source bot's name has line breaks and bracket characters removed before it is inserted.

**On errors**

A pack that fails JSON validation is skipped while the rest of the plugin loads, and `plugin list` and `doctor` show why. A pack whose provider is missing or whose id clashes is also skipped, with the reason in the daemon log. A regex or provider error or timeout at run time makes that pack abstain for that message: `direct` records an abstained outcome and starts nothing. For `model`, when the context provider times out, fails, returns a malformed result, or returns no material while `missing` is not empty, the message is decided again as if the pack were not there; the decision record keeps the reason, `/status` counts it as context failed, and "why no reply" explains it. When one message matches several `direct` packs, only the first by pack id is handled.

# Upgrade note: migrating CI environment variables to plugins

Deployments that previously configured CI with environment variables must migrate: **these variables no longer work after upgrading**: `DUTYDECK_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `DUTYDECK_CODEBASE_WEBHOOK_SECRET`. After upgrading:

1. Run `dutydeck plugin install ./plugins/github --yes` (or `./plugins/codebase`);
2. Use `dutydeck plugin config …` to restore the token, code host or webhook secret (`github.token`, `github.webhook_secret`, `codebase.host`, `codebase.webhook_secret`; use `--value-fd 0` for sensitive values);
3. Run `dutydeck restart`.

Otherwise old wait subscriptions and `github_new_failure` schedules stop working, the Web shows "no CI plugin installed", and `/api/hooks/codebase` returns 404 (the codebase plugin now provides it and must be installed). Old subscription data remains readable, and old subscriptions without a provider field are treated as GitHub. There is no automatic migration.

## Security notes

- Install plugins only from sources you trust. `agents`, `hooks`, `providers` and `service` execute commands on your machine; installation confirmation is not a formality.
- **Provider code runs inside the daemon process with the daemon's trust level**; there is no sandbox. If a timer, connection or callback it leaves behind after `register(api)` throws an unhandled exception or rejection, the whole daemon exits with Node's default behavior (systemd restarts it, but only eligible tasks survive a restart). The `Fatal …` crash log is followed by a line naming plugins whose code appears in the stack, and those external plugins are **quarantined**: the entire package does not load on the next start. A daemon killed or restarted while stuck loading a plugin's providers also quarantines that plugin on the next start. Quarantined plugins appear in plugin diagnostics, `dutydeck plugin status/list` and `dutydeck doctor` (fail). After fixing or reviewing, run `dutydeck plugin enable <name>` to clear quarantine and restart (`activate`, `rollback` and `uninstall` also clear it). Built-in plugins are never quarantined. Hook subprocesses and plugin services are separate processes and cannot take the daemon down when they crash.
- Hook subprocesses inherit only the base environment; plugin secrets are supplied through binding accessors and never enter the hook environment.
- **Expose trigger URLs only over HTTPS or an internal network.** HMAC requests carry a short-lived timestamp and one-time nonce; token requests still rely on transport protection. External material is wrapped as untrusted data, but that cannot eliminate prompt injection. Triggered sessions inherit the bot's permission mode; do not point an external trigger at a `full-trust` bot.
- Git sources are pinned by commit SHA; newly added capabilities in `plugin update` require renewed confirmation.
- If a triggered session's bot is in `ask` mode, approval cards may appear only on the Web and not necessarily in Lark (**unverified**).
