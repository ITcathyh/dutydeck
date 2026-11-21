import { DutydeckRuntime } from '@dutydeck/runtime';

// Test ledgers override the ID read. Use the runtime's own key lookup so both
// entry points observe the same accepted record and injected read failures.
export const readTestAcceptanceByKey = DutydeckRuntime.prototype.getAcceptedTaskByKey;
