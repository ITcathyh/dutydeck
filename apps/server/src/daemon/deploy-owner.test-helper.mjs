import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDeploy, runDeployPrune } from './deploy.ts';

const [source, runtime, releases, stage] = process.argv.slice(2);
const aborting = stage === 'abort' || stage === 'abort-after-backup';
let pid;
let firstRead = true;
let clock = Date.now();
const hold = async () => {
  process.send({ type: 'locked' });
  await new Promise(resolve => process.once('message', resolve));
};
const deps = {
  env: {}, info: () => {}, warn: () => {}, readToken: () => undefined,
  now: () => clock, healthTimeoutMs: 1, sleep: async () => { clock += 10; },
  checkSqlite: () => {
    if (stage === 'no-restart') {
      writeFileSync(join(runtime, `locked-${process.pid}`), 'locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return { ok: true, execPath: process.execPath };
  },
  processPaths: () => [],
  // abort：旧进程在跑，排空成功后卡在备份里等测试发信号；排空请求逐条落盘（进程随即退出，IPC 不一定送达）。
  // abort-after-backup：备份期间收到 SIGTERM、备份随后完成；退出排空的请求故意慢，主流程先走到切换前，此时不能再切换版本或重启。
  processRelease: () => join(releases, 'previous'),
  backupDatabase: async () => {
    if (stage === 'abort') await hold();
    if (stage === 'abort-after-backup') { process.kill(process.pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 50)); }
  },
  service: {
    mainPid: async () => {
      if (firstRead && stage === 'read') await hold();
      firstRead = false;
      return aborting ? process.pid : pid;
    },
    restart: async () => {
      if (aborting) appendFileSync(join(runtime, 'restart-calls'), 'restart\n');
      if (stage === 'restart') await hold();
      pid = process.pid;
    },
    stop: async () => { if (stage === 'rollback') await hold(); pid = undefined; }
  },
  fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (aborting) {
      const draining = path === '/api/system/drain' ? JSON.parse(String(init.body)).draining : undefined;
      if (draining !== undefined) appendFileSync(join(runtime, 'drain-calls'), `${draining}\n`);
      if (draining === false && stage === 'abort-after-backup') await new Promise(resolve => setTimeout(resolve, 300));
      return Response.json(path === '/api/system/activity' ? { runningTasks: 0 } : { draining: true });
    }
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
