import type { NormalizedDriverEvent } from '@dutydeck/shared';
import type { SessionIdLookupContext } from '@dutydeck/cli-adapters';
export type { SessionIdLookupContext } from '@dutydeck/cli-adapters';

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
