/** Resolve a promise after `ms` milliseconds (for command timing loops). */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}