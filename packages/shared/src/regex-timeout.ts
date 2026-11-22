import { Worker } from 'node:worker_threads';

export class RegexMatchTimeoutError extends Error {
  readonly code = 'REGEX_MATCH_TIMEOUT';
  constructor(readonly timeoutMs: number) {
    super(`正则匹配超过 ${timeoutMs}ms，已终止隔离任务`);
    this.name = 'RegexMatchTimeoutError';
  }
}

const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
try {
  parentPort.postMessage({ matched: new RegExp(workerData.pattern, 'i').test(workerData.input) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
`;

export function testRegexWithTimeout(pattern: string, input: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { pattern, input } });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new RegexMatchTimeoutError(timeoutMs))), timeoutMs);
    worker.once('message', (result: { matched?: boolean; error?: string }) => finish(() => result.error ? reject(new Error(`正则匹配失败：${result.error}`)) : resolve(result.matched === true)));
    worker.once('error', error => finish(() => reject(error)));
    worker.once('exit', code => { if (code !== 0) finish(() => reject(new Error(`正则匹配隔离任务异常退出：${code}`))); });
  });
}
