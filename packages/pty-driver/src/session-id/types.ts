import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { CliPathEnv } from '../cli-paths.js';

/** Everything a resolver may use to identify the session on disk. */
export interface SessionIdLookupContext {
  /** dutydeck's session id — also the fingerprint injected into prompt #1. */
  sessionId: string;
  /** The working directory the CLI was spawned in. */
  cwd: string;
  /**
   * The environment the CLI child was spawned with (`PtyCliDriver.spawnEnv()`),
   * NOT the daemon's `process.env`. The CLI wrote its records under the data
   * root ITS env named — the driver strips `CLAUDE_*` from the child, and
   * `agent.env` may relocate `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `HOME`.
   * Optional: defaults to `process.env`, which is correct whenever the two
   * environments agree.
   */
  env?: CliPathEnv;
}

/** One CLI's reverse lookup: dutydeck session id → the CLI's own session id. */
export interface SessionIdLookup {
  /**
   * cli-adapters adapter ids this lookup serves.
   *
   * A list rather than a single id because several adapters are the SAME CLI
   * on disk: `claude-code` / `seed` / `relay` share Claude's per-project JSONL
   * layout (they only differ in which root `CLAUDE_CONFIG_DIR` names, which
   * arrives through `ctx.env`). Aliasing here beats registering duplicate
   * records — one resolve implementation, one place to change.
   */
  readonly adapterIds: readonly string[];
  /** Return the CLI session id, or undefined when it cannot be determined.
   *  Implementations should be total; the registry also guards with try/catch. */
  resolve(ctx: SessionIdLookupContext): string | undefined;
}

/** Re-exported for resolvers that also expose event mapping helpers. */
export type { NormalizedDriverEvent };
