import { createHash } from 'node:crypto';
import { canonicalExecutionJson } from '@dutydeck/shared';

// Separate from ledger.ts so callers that only hash can import `@dutydeck/runtime/digest` without the whole runtime.
export const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
