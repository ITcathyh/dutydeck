import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * After every prompt response ACPX waits until no session update has arrived for a full second. Fake agents write all
 * their updates before the response, so that second is pure idle time on each real-ACP turn. Import this module for
 * its side effect in such a test file: the drain still runs, with a short idle window. Vitest gives every file its
 * own process, so other files keep the real value. ACPX does not export its client, hence the lookup by method name.
 */
const IDLE_MS = 20;

const dist = dirname(createRequire(new URL('../../packages/acp-client/package.json', import.meta.url)).resolve('acpx/runtime'));
const chunk = readdirSync(dist).find(name => /^live-checkpoint-.*\.js$/.test(name));
if (!chunk) throw new Error(`No ACPX live-checkpoint chunk in ${dist}`);
const exported: unknown[] = Object.values(await import(pathToFileURL(join(dist, chunk)).href));
const client = exported.find((value): value is { prototype: { waitForSessionUpdatesIdle(options?: { idleMs?: number; timeoutMs?: number }): Promise<void> } } =>
  typeof value === 'function' && typeof value.prototype?.waitForSessionUpdatesIdle === 'function');
if (!client) throw new Error('ACPX client no longer has waitForSessionUpdatesIdle; update this helper');

const drain = client.prototype.waitForSessionUpdatesIdle;
client.prototype.waitForSessionUpdatesIdle = function (options) {
  return drain.call(this, { ...options, idleMs: Math.min(options?.idleMs ?? 0, IDLE_MS) });
};
