import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('releases completed wait and workspace-read contexts while their parents remain live', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '--eval', `
    import { AsyncLocalStorage } from 'node:async_hooks';
    import { setImmediate } from 'node:timers/promises';
    import { createRepositories } from '@dutydeck/storage';
    import { DutydeckRuntime } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    import { owner, SessionMutations } from ${JSON.stringify(new URL('./ownership.ts', import.meta.url).href)};

    const context = new AsyncLocalStorage();
    const mutations = new SessionMutations();
    const parent = owner('long-lived-parent');
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repos, {
      driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: () => ({ start: async () => {}, send: async () => {}, stop: async () => {},
        interrupt: async () => {}, resume: async () => {}, isStopped: async () => true })
    });
    async function request(operation) {
      const value = { payload: new Array(1024).fill('request context') };
      const reference = new WeakRef(value);
      await context.run(value, operation);
      return reference;
    }
    try {
      await runtime.initialize([{ id: 'memory', name: 'Memory', command: 'unused', args: [],
        protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'ask', timeout: 10,
        capabilities: { pause: false, resume: true }, builtin: false }]);
      const session = await runtime.start({ agentId: 'memory' });
      const waits = [], reads = [];
      for (let i = 0; i < 128; i++) {
        waits.push(await request(() => mutations.run(owner('child', parent), () =>
          mutations.wait(() => i % 2 ? Promise.reject(new Error('operation failed')) : Promise.resolve(i)).catch(() => {}))));
        reads.push(await request(() => runtime.getSession(session.id)));
      }
      // WeakRef targets stay alive within the current job. Collect only after
      // crossing event-loop turns, with both the runtime and parent still live.
      for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
      const retained = { waits: waits.filter(ref => ref.deref()).length, reads: reads.filter(ref => ref.deref()).length };
      if (parent.revoked || !await runtime.getSession(session.id)) throw new Error('Parents must remain usable during collection');
      console.log(JSON.stringify(retained));
    } finally {
      parent.revoke();
      await runtime.shutdown();
      repos.close();
      context.disable();
    }
  `]);
  expect(JSON.parse(stdout.trim())).toEqual({ waits: 0, reads: 0 });
});
