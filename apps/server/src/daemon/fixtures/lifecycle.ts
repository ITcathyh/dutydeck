import { daemonRestart, daemonStart, daemonStatus, daemonStop } from '../command.js';

const handlers = {
  serve(_options: unknown, ready?: () => void) {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
    ready?.();
  },
  // 假守护进程不监听端口：排空与任务数查询由这里应答，restart 照常走等待流程，也不会连到本机真实服务。
  fetch: (async (url: string) => new Response(JSON.stringify(new URL(url).pathname === '/api/system/drain' ? { draining: true } : { runningTasks: 0 }), { status: 200 })) as typeof fetch
};
const action = process.argv[2];
const result = action === 'start' ? await daemonStart({}, handlers)
  : action === 'restart' ? await daemonRestart({}, handlers)
    : action === 'stop' ? await daemonStop() : daemonStatus();
console.log(JSON.stringify(result));
if ('ok' in result && !result.ok) process.exitCode = 1;
