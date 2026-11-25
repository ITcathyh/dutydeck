import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

// Readers can observe either snapshot while a separate process updates the hub.
export function writeHubState(file, state) {
  const pending = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(pending, JSON.stringify(state, null, 2));
    renameSync(pending, file);
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
}
