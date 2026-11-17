import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpxAdapter } from './index.js';
import { testRegexWithTimeout } from './regex-timeout.js';
import '../../../tests/support/short-acpx-reply-drain.js';

vi.mock('./regex-timeout.js', () => ({ testRegexWithTimeout: vi.fn() }));
const regex = vi.mocked(testRegexWithTimeout);
const adapters: AcpxAdapter[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  regex.mockReset();
});

describe.each([
  { outcome: 'returns', release: (gate: { resolve(value: boolean): void }) => gate.resolve(false) },
  { outcome: 'throws', release: (gate: { reject(error: Error): void }) => gate.reject(new Error('synthetic regex failure')) },
])('permission turn fencing when the asynchronous regex $outcome', ({ release }) => {
  it('emits no stale pending or rejected event in the replacement turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-regex-turn-fence-')); directories.push(cwd);
    const events: any[] = [];
    let regexEnteredResolve!: () => void;
    const regexEntered = new Promise<void>(resolve => { regexEnteredResolve = resolve; });
    let resolveRegex!: (value: boolean) => void, rejectRegex!: (error: Error) => void;
    const gate = new Promise<boolean>((yes, no) => { resolveRegex = yes; rejectRegex = no; });
    regex.mockImplementationOnce(() => { regexEnteredResolve(); return gate; });
    const adapter = new AcpxAdapter({
      id: 'mock', name: 'Mock', command: process.execPath, args: [resolve(process.cwd(), 'packages/acp-client/tests/fixtures/stale-permission-agent.mjs')],
      protocol: 'acp', cwd, env: { fixture_decisions: join(cwd, 'decisions.jsonl') }, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }, builtin: false,
    }, {
      sessionKey: `regex-turn-fence-${events.length}`,
      resolveRiskPolicy: async () => ({ enabled: true, authorized: false, pattern: 'shared' }),
      onEvent: event => events.push(event),
    });
    adapters.push(adapter);
    await adapter.start();
    const old = adapter.send('old');
    await regexEntered;
    await adapter.interrupt(); await old;
    const current = adapter.send('new silent');
    await expect.poll(() => events.some(event => event.type === 'text' && event.data.text === 'new is running')).toBe(true);
    release({ resolve: resolveRegex, reject: rejectRegex });
    await new Promise(done => setTimeout(done, 100));
    expect(events.filter(event => event.type === 'permission_request')).toEqual([]);
    await expect(adapter.resolvePermission('shared-tool', true)).resolves.toBe(false);
    await adapter.interrupt(); await current;
    expect(regex).toHaveBeenCalledTimes(1);
  }, 20_000);
});
