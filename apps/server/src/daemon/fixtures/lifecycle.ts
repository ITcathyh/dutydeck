import { daemonRestart, daemonStart, daemonStatus, daemonStop } from '../command.js';

const handlers = {
  serve(_options: unknown, ready?: () => void) {
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
    ready?.();
  }
};
const action = process.argv[2];
const result = action === 'start' ? await daemonStart({}, handlers)
  : action === 'restart' ? await daemonRestart({}, handlers)
    : action === 'stop' ? await daemonStop() : daemonStatus();
console.log(JSON.stringify(result));
if ('ok' in result && !result.ok) process.exitCode = 1;
