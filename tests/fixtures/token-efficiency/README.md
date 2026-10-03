# Token efficiency replay

Run the deterministic local replay:

```sh
node --import tsx scripts/evaluate-token-efficiency.mts tests/fixtures/token-efficiency/local-manifest.json /tmp/token-local-report.json
```

The report has `status: unverified` and the CLI exits 1 because mock execution cannot establish provider savings. The synthetic token counts test aggregation only. `pnpm exec vitest run tests/token-efficiency-evaluator.test.ts` exercises quality errors, omitted constraints, absent usage, duplicate/conflicting background receipts, timeout, exit failure and p95 regression.

## Declared runner protocol

The manifest freezes model/protocol/reasoning configuration, cases, initial files, tool data, repetitions and machine quality checks before execution. `runners.legacy` and `runners.optimized` are argv arrays; paths starting `./` resolve relative to the manifest. Each arm runs independently in a new temporary workspace with only its declared initial files, an isolated HOME/CODEX_HOME, and no live Lark environment. Explicit `providerEnv` can pass provider API credentials, but cannot pass live group capabilities, homes, PATH or executable hooks. Runner commands are trusted code: the evaluator's process isolation does not sandbox arbitrary third-party commands.

The runner reads one JSON request from stdin:

```json
{"version":1,"case":{"id":"case","type":"retrieval","input":{},"toolData":{},"checks":[]},"policy":"legacy","config":{"model":"model","protocol":"protocol"},"workspace":"/tmp/isolated","inputDigest":"sha256"}
```

It writes exactly one JSON response to stdout and diagnostic text to stderr. Required response fields are `status`, `output`, `executionSource` (`mock` or `provider`), unchanged `inputDigest` and `config`, measured whole execution `latencyMs`, `attempts`, and `coverage`. Every attempt preserves `attemptId`, globally unique `usageRef`, `role` (`root`, `child`, `background`), actual `source`, `model`, `protocol`, `rawUsage`, and normalized `usage`. Usage must explicitly use `semantics: input_excludes_cache` and supply nonnegative `input`, `cacheRead`, `cacheWrite`, `output`. Missing counters stay unavailable and fail coverage; tokenizer guesses and reasoning subtotals are never added. `coverage` must declare a complete execution inventory through `attemptIds` and `usageRefs`; the adapter must derive that inventory from actual runtime executions, not only records with available usage.

A shared background receipt uses one identical usageRef and record in all referencing runs; it is counted once per arm globally. Different attempts/repetitions require distinct refs. Conflicting records fail. Failed runs and retries remain in reports and token totals. Provider metadata may include `rawUsage.modelSource: requested|reported`; observed-model coverage remains unverified when the CLI reports only the requested model.

Checks compare exact JSON values, required/excluded text or array facts, or a flat object schema with required keys and optional extra keys. An empty path checks the complete output. `needsReview: true`, or no machine checks, always requires human quality review. The evaluator reports nearest-rank p95 by task type and fails an optimized increase over the fixed 10% limit. It also requires strict total-token reduction and complete usage coverage. Pricing is not inferred.

## Safe real provider smoke runner

`scripts/token-efficiency-codex-runner.mts` invokes Codex with explicit model/reasoning settings, ephemeral state, ignored user config/rules, empty MCP config, disabled web search and disabled shell/apps/browser/computer/code/image/multi-agent/skill tools. It rejects and terminates any emitted tool item or unexpected event. It uses only `case.input.prompts[policy]`, labels `executionScope: model_no_tools`, and records the prompt source. Populate both prompts from actual old/new production builders to compare assembly; the example uses small fictional fixture facts.

```sh
node --import tsx scripts/evaluate-token-efficiency.mts tests/fixtures/token-efficiency/codex-manifest.json /tmp/token-provider-report.json
```

This command makes paid provider requests; it is an entrypoint, not a recorded result. The isolated CLI needs a provider API credential declared in `providerEnv`, or explicit `providerAuth: codex_login` (as in this sample). The latter copies only the current Codex `auth.json` into the temporary `.codex` directory with mode 0600 and deletes that workspace after each run. It does not copy config, rules or skills; secrets never enter the manifest or report. No authentication files or secrets belong in fixture manifests. Cache-write absence is unavailable, and the runner fails coverage rather than assuming zero. Nonzero cache-write normalization also stays unverified and fails coverage until its input-token membership is established; the smoke runner accepts only a reported zero cache-write counter. It retains provider JSONL usage and source metadata. A no-tools sample cannot verify retrieval strategy, child/background executions, memory recovery, cache behavior, open-answer quality or the full pipeline; `fullPipelineVerified` remains false. Full-agent replay requires a declared runner using frozen tool data and simulated write endpoints, with the same inventory and usage contract.

## History range semantics

`dutydeck history show <task-id>` retains its existing clipped output. `--field request|answer [--offset N] [--length N]` returns saved verbatim text. `--cursor` continues the previous field, task, chat scope, page length and digest, and cannot combine with those options. The HTTP equivalent uses the same query fields. Offsets/counts are UTF-16 code units; start rounds down and end rounds up when a requested boundary crosses a surrogate pair, so the page may exceed its requested length by one unit at either boundary. `complete` indicates the end of saved text, and `originalScope: stored` limits the assertion to preserved storage rather than unrecorded upstream material. Every page rechecks authorization. A changed saved version returns `HISTORY_CONTENT_CHANGED` (409). Missing/unsettled/read_error responses carry null ranges and `complete: false`; output beyond the existing result-read limit remains a read error, never a complete partial answer.
