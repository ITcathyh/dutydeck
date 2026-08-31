# Botmux parity E2E assets

This directory is an executable acceptance inventory, not an activation tool. It records what Dockmux can prove today, what is deliberately blocked, and what requires an externally fenced opt-in environment.

The runner never starts/stops a Dockmux or Botmux listener, writes an existing Dockmux database, edits Botmux source data, acquires real credentials, enables a Schedule, or performs cutover/rollback. Offline commands may create disposable synthetic SQLite/secret/archive files under a case-private temporary directory. Its default action is manifest self-check only.

## What was used as the behavioral baseline

The cases were derived read-only from existing implementation and tests:

- Botmux `src/im/lark/event-dispatcher.ts`: oncall, allowed groups and grants can provide talk; operate is a separate decision and does not inherit group-wide talk.
- Botmux `src/utils/bot-routing.ts`: same-name Bot routing prefers the App whose oncall mapping contains the target chat.
- Botmux `test/team-operate.test.ts`: a trusted bot union can operate, but a human in the same team chat does not inherit operate.
- Botmux `test/session-liveness.test.ts` and restart tests: managed sessions remain recoverable; a dead PID is not sufficient proof that a transcript-backed run should be discarded.
- Botmux scheduler/provenance/idempotency tests: schedule identity is App+Chat/task scoped and repeated delivery must be accounted for.
- Dockmux access-mode/auth/Terminal WS tests: explicit remote-open mode is tokenless but still exact same-origin for browsers.
- Dockmux SecretProvider and secret CLI tests: credential values cross only the explicit FD/runtime boundary; metadata, permissions, CAS and symlink handling are independently enforced.
- Dockmux GroupBinding tests and management API: bot defaults, App+Chat overrides, mention/topic routing, group-tool ceilings and role assignments produce one effective configuration.
- Dockmux foundation policy edges: staged managed integrations deny listener/session/terminal/high-risk/group-tool execution with machine-readable reasons.
- Dockmux Schedule foundation: timezone/DST preview, generation-pinned occurrences, durable planning watermark, CAS lease/fence and offline API are implemented without an executor.
- Dockmux importer core and CLI tests: discover, plan and archive are read-only; imported assets remain `NO_GO`, disabled and non-activatable.
- Dockmux identity-preflight probe, service and CLI tests: App×Chat evidence is obtained through read-only Lark APIs, persisted with credential/identity revision fencing, projected through public allowlists, and never changes listener activation.

The baseline is intentionally semantic. No live Botmux configuration, history, identity, path, token, cookie or App secret is copied into this directory.

## Case status model

`cases.json` is the machine-readable source of truth.

- `pass`: an executable assertion exists. `offline` cases are safe to run locally; `remote_opt_in` cases require an explicit flag and environment.
- `expected_blocked`: the end-to-end behavior is not implemented/proven. The runner reports the blocker and does not run a substitute test.
- `skip`: execution requires an external harness or authority intentionally absent from this repository.

Current inventory:

| Manifest disposition | Count |
|---|---:|
| Offline executable, expected pass | 12 |
| Remote-open opt-in executable | 1 |
| Explicit expected-blocked | 3 |
| Real-Lark opt-in skip | 1 |

On a host with tmux installed, a successful `--run-offline` ends with `pass=12`, `fail=0`, `skip=2`, `expected_blocked=3`. If tmux is unavailable, the restart case uses exit `77`, so the expected counts become `pass=11`, `skip=3`; it is never converted into a pass.

| Area | Disposition |
|---|---|
| Remote-open HTTP/SSE auth and Origin contract | offline pass case |
| Remote-open Terminal WS auth and Origin contract | offline pass case |
| Actual remote development endpoint, no token | opt-in pass case |
| SecretProvider + secret CLI metadata/value boundary | offline pass case |
| Importer core redaction, `NO_GO`, source immutability, encrypted archive | offline pass case |
| Importer CLI discover/plan/archive, exclusive outputs and safe passphrase FD | offline pass case |
| Completed-turn service restart, same pane PID, final stop destroy | offline pass case |
| Active-turn final-result reconstruction across restart | expected-blocked |
| Agent → ChannelBot → GroupBinding offline effective config and mention/topic | offline pass case |
| can_talk / can_operate / admin persisted policy + management authorizer | offline pass case |
| Terminal/group-tool independent action gates and staged denial | offline pass case |
| Unwired/staged management fail-closed contract | offline pass case |
| Schedule DST, idempotency, watermark, lease/fence and offline API | offline pass case |
| Schedule timer/executor/activation | expected-blocked |
| Loopback fake-Lark App×Chat identity preflight, service API and CLI | offline pass case |
| Listener lease, cross-runtime dual-consumer fencing and rollback | expected-blocked |
| Real Lark App+Chat | opt-in skip; external driver required |

The WP2 service-level test now proves the completed-turn restart boundary with two service lifetimes, one SQLite database, the same pane PID, lazy driver reconnect, persisted prompts and final stop destruction. The parity wrapper gives that test an isolated `TMPDIR` and `TMUX_TMPDIR`, then checks and destroys only that private tmux server namespace. Active-turn final-result reconstruction remains blocked and is not inferred from the completed-turn test.

The WP4 offline identity case starts only ephemeral loopback fake-Lark HTTP servers and disposable Dockmux service state. It covers successful identity/chat verification, local and remote App mismatch, missing/unreadable credentials, not-member/inaccessible chats, CAS invalidation of previously successful facts, and API/CLI leakage canaries. Its check wrapper suppresses the child test process output because the service test intentionally creates a disposable access token; only a fixed allowlisted result crosses the runner output boundary. A successful preflight still reports `activationChanged=false` and `listenerReadiness=blocked`; it is evidence validation, not listener activation. This offline case does not claim that a real App owns a real chat—the separate real-Lark case remains an externally fenced opt-in skip.

## Safe commands

Self-check validates the manifest, required coverage, case dispositions, allowlisted command shapes, fixture containment and synthetic-value policy. It executes no test case:

```bash
node tests/e2e/botmux-parity/runner.mjs --self-check
```

List cases without executing them:

```bash
node tests/e2e/botmux-parity/runner.mjs --list
```

Run all offline cases. Expected-blocked and opt-in cases are emitted as such and are not executed. Every case gets a private `HOME`, `TMPDIR`, `TMUX_TMPDIR`, ephemeral port setting, and sanitized environment; any command failure or isolated tmux residue makes the suite exit non-zero:

```bash
node tests/e2e/botmux-parity/runner.mjs --run-offline
```

Run one offline case:

```bash
node tests/e2e/botmux-parity/runner.mjs --run-case importer-redaction-no-go-source-immutable
```

Outputs are NDJSON and finish with exact `pass`, `fail`, `skip`, and `expected_blocked` counts. The custom checks suppress raw errors so an unexpected URL/path/session never appears in normal output.

Executable cases use exit code `77` for a missing host dependency such as tmux. The runner records that as `skip`, never as `pass`; an assertion failure remains a non-zero suite failure.

## Remote development endpoint: explicit no-token probe

This check is read-only but it targets a real running Dockmux. The operator must first provide an isolated development instance explicitly configured for open mode and a dedicated disposable PTY-CLI session. Do not point it at a shared or production service. The runner does not create the session or change the service lifecycle.

The check sends no Authorization header, Cookie, query token, terminal input, POST/PUT/PATCH/DELETE request, or listener command. It verifies:

1. `/api/auth/status` confirms `required=false`;
2. normal HTTP is reachable without a token;
3. SSE connects with the exact public Origin and rejects a different Origin;
4. Terminal WS connects with the exact public Origin and rejects a different Origin.

The base URL must contain only scheme/host/port. Userinfo, query, fragment and non-root path are rejected.

```bash
DOCKMUX_PARITY_BASE_URL=http://devbox.example:4310 \
DOCKMUX_PARITY_SESSION_ID=dedicated_synthetic_session \
DOCKMUX_PARITY_REMOTE_OPEN_ACK=read_only_dedicated_instance \
node tests/e2e/botmux-parity/runner.mjs \
  --run-case remote-dev-open-mode-no-token \
  --allow-remote-open
```

The session must support Terminal WS. An ACP-only or missing session correctly fails instead of being treated as a skip.

Failures expose only an allowlisted `stage` and `error_code`; response bodies, URLs, session identifiers and transport errors are never echoed. The stages are `input_validation`, `health`, `auth_status`, `tokenless_http`, `session_metadata`, `cross_origin_sse`, `same_origin_sse`, `same_origin_terminal_ws`, and `cross_origin_terminal_ws`. In particular, `SESSION_TERMINAL_INELIGIBLE` means the selected session is archived, failed, or stopped, while `SAME_ORIGIN_TERMINAL_WS_SESSION_NOT_LIVE` means its metadata is eligible but the daemon has no live Terminal stream attached.

## Real Lark opt-in runbook

The repository deliberately contains no real-Lark driver and no credential lookup. A real case may proceed only through a separate operator-owned harness after all of the following are true:

1. Use a newly created dedicated test App and disposable chat. Existing production Botmux Apps/chats are forbidden.
2. Resolve the bot identity under that exact App and positively verify App+Chat membership.
3. Resolve every principal under the target App. Never copy an `ou_` from another App; App scope must be positively verified.
4. Externally drain the Botmux listener for the test App and inhibit its supervisor reconnect. A Dockmux-local flag is not sufficient fencing.
5. Keep the Dockmux listener disabled while preparing evidence. Record the shared generation and a source watermark.
6. Keep Botmux as the only Schedule writer. This suite cannot authorize a Schedule handoff.
7. Write only opaque refs and boolean evidence into a new private `0600` preflight file matching `real-lark-preflight.schema.json`. The file must expire within four hours. Never put a token, secret, raw App ID, chat ID or open ID in it.
8. Validate the file locally:

```bash
node tests/e2e/botmux-parity/runner.mjs \
  --validate-real-lark-preflight /private/path/preflight.json
```

9. Confirm the repository case remains a skip even after valid preflight; the actual message/listener driver must live in the externally fenced operator environment:

```bash
node tests/e2e/botmux-parity/runner.mjs \
  --run-case real-lark-dedicated-test-app \
  --allow-real-lark \
  --preflight /private/path/preflight.json
```

The expected result is `skip` with `REAL_LARK_DRIVER_INTENTIONALLY_NOT_BUNDLED`. Treating preflight validation as a parity pass is forbidden.

## Fixtures

- `fixtures/importer/` is a fully synthetic Botmux tree template. The importer check materializes it under a private temporary directory with `0700` directories and `0600` files, replacing only the data-dir breadcrumb. It is removed after the check.
- `fixtures/restart-run.json` captures the required no-respawn/reconcile outcome for a future whole-daemon E2E.
- `fixtures/routing-and-rbac.json` captures App+Chat routing and least-privilege decisions without real identities.
- `fixtures/schedule-and-fencing.json` captures the implemented local Schedule ledger expectations plus the still-blocked cross-runtime fence boundary.

Fixture values use `.invalid`, `/synthetic/`, `*_fixture_*`, or `SYNTHETIC_*_NEVER_VALID` markers. They must never be replaced with copied production data.

## Promotion rules

An `expected_blocked` case may become `pass` only when its command drives the external/runtime path described by the title. A local foundation proof cannot promote an external listener or executor case. In particular:

- daemon restart must span two server lifetimes and prove the same owned CLI process;
- active-turn promotion additionally requires exact terminal-result/task/delivery reconstruction and cannot reuse the completed-turn restart proof;
- real App×Chat routing/RBAC still requires the dedicated real-Lark harness and App-scoped identity preflight;
- Schedule activation additionally requires a reviewed timer/executor and cannot be inferred from the offline occurrence ledger;
- dual-consumer fencing must be externally enforceable by both Botmux and Dockmux and must exercise rollback ordering.

No case in this directory is permission to activate a current App.
