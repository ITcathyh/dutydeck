# G3 implementation report

Date: 2026-11-15. Base: `652ba7ad`. Scope: BM7-01, QA7-08 and the owner-requested bilingual upgrade note. QA7-07 was not implemented.

## Deliverables

| Item | Before | Now | User-visible result | Commit |
|---|---|---|---|---|
| BM7-01 | TraeX checked readiness only before paste, then always pressed Enter. | `pasteAndSubmit` has optional pre-paste/pre-Enter hooks, used only by TraeX. TraeX re-reads the authoritative screen before paste, waits through resume redraws, and recognizes an active `Question N/M (N unanswered)` page with numbered options before Enter. | A question before paste produces `PROMPT_NOT_WRITTEN` with zero input bytes. A question after paste produces `DRIVER_INPUT_UNCONFIRMED`, does not press Enter and never resends. Other adapters retain their original timing. | `d7ba2e865cd14b4ac11af2aa140704ef44181312` |
| QA7-08 | Launcher group cleanup and output drain could each wait forever after child exit. | One 5000 ms deadline starts only on child exit and covers both phases. Timeout destroys only the two launcher-owned source streams, writes `drained=false`, removes the owned report and exits 1. Expected timeout destruction no longer triggers self-SIGTERM. | Escaped descriptors cannot hang a task forever. Normal EOF, full output, target write callbacks and exit-code/signal behavior remain unchanged. | `9cf1001e1fb8d138830c3273d0519b84236d7991` |
| Upgrade note | The old deny-all TraeX ACP resume limitation was undocumented. | Added one matching fact to `docs/zh/upgrading.md` and `docs/en/upgrading.md`. | Users are told that affected sessions fail with `ACP_LAUNCHER_VERSION_CHANGED` and need `/new`. No argv migration was added. | `6d1ca95258e9b8b01292d3ae9a5546692e9591cc` |

## Red/green evidence

| Item | Red | Green |
|---|---|---|
| BM7-01 | `impl-logs/g3-BM7-01-red.log`: initial pre-paste and post-paste question cases both resolved instead of rejecting. The subsequently added resume-redraw case also failed with `PromptNotWrittenError` before the readiness correction. | `impl-logs/g3-BM7-01-green.log`: 3 files, 101 tests passed. Covers both ledger error classes, zero writes before paste, no Enter after paste, no numeric options, prose, historical question scrollback, resume redraw and unchanged Codex timing. |
| QA7-08 | `impl-logs/g3-QA7-08-red.log`: inherited stdout and stuck group cleanup each exceeded the 12-second test bound; the other five cases passed. | `impl-logs/g3-QA7-08-green.log`: all 7 launcher cases passed, followed by 52 AcpxAdapter/lifecycle cases passed. Timeout cases completed in about 5.1 seconds. |

## Real and integration validation

### BM7-01

`impl-logs/g3-BM7-01-real-traex.log` records a final-build run with the installed TraeX `0.213.1-alpha.1` binary. The harness used a temporary workspace/database/port and a private tmux socket. After the fresh turn it stopped the owned service and tmux server, restarted from the same database and resumed the native session.

- Fresh: one native user record, one Attempt, one confirmed input receipt; Attempt `settled`, outcome `completed`.
- Native resume: same native session identity, one native user record, one Attempt, one confirmed input receipt; Attempt `settled`, outcome `completed`.
- The two prompts appeared exactly once each in the native records (`fresh: 1`, `resume: 1`).
- A real native question-page race was not constructed: **unverified**. Synthetic regression tests cover that race; they were not used as a substitute for the ordinary-input gate.
- Supplemental environment check: after an automatic CLI update, `0.215.1-alpha.5` did not show the composer required by the pre-existing `prepareInput` readiness check and timed out with `TraeX 启动尚未就绪，请打开终端检查启动状态后再发送任务。`. This report does not claim BM7-01 support for that version; no out-of-scope readiness migration was attempted.

### QA7-08

- Real `AcpxAdapter` ordinary turns with the local ACP fixture passed in `codex-environment.test.ts`; this validates the actual adapter and launcher path, not a real model provider.
- The local large-output command preserved exactly 2 MiB stdout and 512 KiB stderr and propagated exit code 7.
- A slow destination reader, normal EOF, SIGTERM, real source failure, one-sided inherited stdout, stuck group cleanup, and a main child still running past five seconds were all exercised. Only test-created PIDs/process groups were used for cleanup.
- No real model-provider ACP turn was required or claimed for this launcher change.

## Final gates

All commands ran from the assigned worktree.

| Command | Result | Log |
|---|---|---|
| `pnpm typecheck` | Passed for all workspaces. | `impl-logs/g3-typecheck.log` |
| `pnpm exec vitest run --project=node packages/cli-adapters/src packages/acp-client/src` | 30 files passed, 1 skipped; 746 tests passed, 1 skipped. | `impl-logs/g3-vitest.log` |
| `pnpm build:packages` | Passed. | `impl-logs/g3-build-packages.log` |
| `pnpm build` | Passed, including the production server bundle. | `impl-logs/g3-build.log` |
| `pnpm smoke --port 0` | Passed all 69 assertions using the mock CLI; no real-model claim. | `impl-logs/g3-smoke.log` |
| `pnpm verify:package` | Passed 11 package Vitest tests, 4 Node package tests and plugin activate/rollback verification. | `impl-logs/g3-verify-package.log` |
| `git diff --check 652ba7ad..HEAD` | Passed. | Final audit. |

## Compatibility and rollback

- BM7-01 adds no setting, persistent field, result enum or public driver interface. Rolling back removes only the new TraeX guards. Any already confirmed unknown submission still requires reconciliation; rollback never authorizes replay.
- QA7-08 does not change the launcher protocol. Normal exits are unchanged; only an abnormal unbounded post-exit wait becomes a bounded failure. Rolling back restores the hang.
- The upgrade note documents a safe existing rejection. QA7-07 argv/record migration is intentionally absent; no old TraeX identity is rewritten and no database change is involved.
- No changes were made to `packages/acp-client/src/index.ts` or `packages/shared/src/driver.ts`.

## Changed files

- `packages/cli-adapters/src/adapters/traex.ts`
- `packages/cli-adapters/src/adapters/input-settle.ts`
- `packages/cli-adapters/src/native-input.test.ts`
- `packages/acp-client/agents/launcher-process.mjs`
- `packages/acp-client/src/launcher-process.test.ts`
- `docs/zh/upgrading.md`
- `docs/en/upgrading.md`
- `impl-logs/g3-report.md`
