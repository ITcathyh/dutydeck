import type { NormalizedDriverEvent } from '@dockmux/shared';

/** Everything a resolver may use to identify the session on disk. */
export interface SessionIdLookupContext {
  /** dockmux's session id — also the fingerprint injected into prompt #1. */
  sessionId: string;
  /** The working directory the CLI was spawned in. */
  cwd: string;
}

/** One CLI's reverse lookup: dockmux session id → the CLI's own session id. */
export interface SessionIdLookup {
  /** cli-adapters adapter id this lookup serves. */
  readonly adapterId: string;
  /** Return the CLI session id, or undefined when it cannot be determined.
   *  Implementations should be total; the registry also guards with try/catch. */
  resolve(ctx: SessionIdLookupContext): string | undefined;
}

/** Re-exported for resolvers that also expose event mapping helpers. */
export type { NormalizedDriverEvent };
