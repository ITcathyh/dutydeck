import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDeploy, runDeployPrune } from './deploy.ts';

const [source, runtime, releases, stage] = process.argv.slice(2);
let pid;
let firstRead = true;
let clock = Date.now();
const hold = async () => {
  process.send({ type: 'locked' });
  await new Promise(resolve => process.once('message', resolve));
};
const deps = {
  env: {}, info: () => {}, warn: () => {},
  now: () => clock, healthTimeoutMs: 1, sleep: async () => { clock += 10; },
  checkSqlite: () => {
    if (stage === 'no-restart') {
      writeFileSync(join(runtime, `locked-${process.pid}`), 'locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return { ok: true, execPath: process.execPath };
  },
  processPaths: () => [],
  service: {
    mainPid: async () => {
      if (firstRead && stage === 'read') await hold();
      firstRead = false;
      return pid;
    },
    restart: async () => {
      if (stage === 'restart') await hold();
      pid = process.pid;
    },
    stop: async () => { if (stage === 'rollback') await hold(); pid = undefined; }
  },
  fetch: async () => {
    if (stage === 'health') await hold();
    return Response.json({ ok: stage !== 'rollback' }, { status: stage === 'rollback' ? 503 : 200 });
  }
};
process.send({ type: 'ready' });
process.once('message', async () => {
  try {
    let result;
    if (stage === 'prune') {
      result = await runDeployPrune({ releases }, { ...deps, processPaths: () => {
        process.send({ type: 'locked' });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return [];
      } });
    } else result = await runDeploy({ source, runtime, releases, unit: 'child.service', restart: !['staged', 'no-restart'].includes(stage) }, deps);
    process.send({ type: 'result', result });
  } catch (error) { process.send({ type: 'error', message: error.message }); }
  finally { process.disconnect(); }
});
