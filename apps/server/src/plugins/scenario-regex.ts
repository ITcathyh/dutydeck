import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { SCENARIO_LIMITS, scenarioRegexFlags } from '@dutydeck/shared';

/**
 * 场景包正则的宿主执行：包作者写的正则一律在常驻 worker 线程里跑，一条消息的所有正则一次调用跑完；
 * 超时就终止并重建 worker。输入先截到上限，标志只允许 i、m、s、u，取全部匹配时由宿主加 g。
 */

export class ScenarioRegexTimeoutError extends Error {
  readonly code = 'SCENARIO_REGEX_TIMEOUT';
  constructor(readonly timeoutMs: number) {
    super(`场景包正则超过 ${timeoutMs}ms，已终止隔离线程`);
    this.name = 'ScenarioRegexTimeoutError';
  }
}

export interface ScenarioRegexJob {
  source: string;
  flags?: string;
  input: string;
  /** 输入长度上限，超出部分截掉；不给或更大时按触发匹配的 4000 字。 */
  maxInput?: number;
  /** 取全部匹配（宿主在 worker 里加 g）。 */
  all?: boolean;
}
export interface ScenarioRegexResult { matched: boolean; matches: string[] }

const MAX_MATCHES = 100;

const workerSource = `
const { workerData } = require('node:worker_threads');
const port = workerData.port;
port.on('message', ({ id, jobs }) => {
  try {
    const results = jobs.map(job => {
      if (job.all) {
        const matches = [];
        for (const match of job.input.matchAll(new RegExp(job.source, job.flags + 'g'))) { matches.push(match[0]); if (matches.length >= ${MAX_MATCHES}) break; }
        return { matched: matches.length > 0, matches };
      }
      const match = new RegExp(job.source, job.flags).exec(job.input);
      return match ? { matched: true, matches: [match[0]] } : { matched: false, matches: [] };
    });
    port.postMessage({ id, results });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

interface Pending {
  id: number;
  jobs: Array<Required<Omit<ScenarioRegexJob, 'maxInput'>>>;
  resolve(results: ScenarioRegexResult[]): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

type WorkerReply = { id: number; results?: ScenarioRegexResult[]; error?: string };

export class ScenarioRegexRunner {
  /** 启动过的 worker 数；超时重建时加一。 */
  workerStarts = 0;
  private worker?: Worker;
  /** worker 回结果用的专用通道：计时器触发时能同步取出已经到达、但主线程还没来得及处理的结果。 */
  private port?: MessagePort;
  private online?: Promise<void>;
  private readonly queue: Pending[] = [];
  private current?: Pending;
  private nextId = 1;

  constructor(private readonly timeoutMs: number = SCENARIO_LIMITS.regexTimeoutMs) {}

  /**
   * 调用约定：一个场景包一次调用（这个包这条消息要跑的全部正则）。一次调用共用一个计时器、整批成败：
   * 超时或出错时这个包这条消息弃权，不影响其他包的调用。
   */
  run(jobs: ScenarioRegexJob[]): Promise<ScenarioRegexResult[]> {
    for (const job of jobs) {
      const bad = [...job.flags ?? ''].filter(flag => !(scenarioRegexFlags as readonly string[]).includes(flag));
      if (bad.length) return Promise.reject(new Error(`正则标志 ${bad.join('')} 不允许：只能用 i、m、s、u`));
    }
    const prepared = jobs.map(job => {
      const limit = Math.min(job.maxInput ?? SCENARIO_LIMITS.triggerInputChars, SCENARIO_LIMITS.triggerInputChars);
      return { source: job.source, flags: job.flags ?? '', input: job.input.slice(0, Math.max(0, limit)), all: job.all === true };
    });
    if (!prepared.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, jobs: prepared, resolve, reject });
      this.pump();
    });
  }

  close() {
    for (const pending of this.queue.splice(0)) pending.reject(new Error('正则执行器已关闭'));
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(new Error('正则执行器已关闭')); this.current = undefined; }
    this.reset();
  }

  /** 有任务时 worker 和通道保持进程存活，空闲时不阻止进程退出（CLI 校验完就该退出）。 */
  private pump() {
    if (this.current) return;
    if (!this.queue.length) { this.worker?.unref(); this.port?.unref(); return; }
    const task = this.queue.shift()!;
    this.current = task;
    const worker = this.ensureWorker();
    const port = this.port!;
    worker.ref();
    port.ref();
    // 计时从 worker 就绪开始，冷启动不算进正则的 200ms。
    void this.online!.then(() => {
      if (this.current !== task || this.worker !== worker) return;
      task.timer = setTimeout(() => {
        if (this.current !== task) return;
        // 主线程被别的工作阻塞时，计时器和结果可能同时到期：先取一次通道里已到的结果，到了就算成功。
        for (let pending = receiveMessageOnPort(port); pending; pending = receiveMessageOnPort(port)) {
          if (this.settle(pending.message as WorkerReply)) return;
        }
        this.current = undefined;
        this.reset();
        task.reject(new ScenarioRegexTimeoutError(this.timeoutMs));
        this.pump();
      }, this.timeoutMs);
      port.postMessage({ id: task.id, jobs: task.jobs });
    });
  }

  /** 处理 worker 的回复；是当前任务的回复时返回 true。 */
  private settle(message: WorkerReply): boolean {
    const task = this.current;
    if (!task || message.id !== task.id) return false;
    clearTimeout(task.timer);
    this.current = undefined;
    if (message.error !== undefined) task.reject(new Error(`正则执行失败：${message.error}`)); else task.resolve(message.results ?? []);
    this.pump();
    return true;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(workerSource, { eval: true, workerData: { port: port2 }, transferList: [port2] });
    this.workerStarts += 1;
    this.worker = worker;
    this.port = port1;
    this.online = new Promise(resolve => worker.once('online', () => resolve()));
    port1.on('message', (message: WorkerReply) => { this.settle(message); });
    const crashed = (error: Error) => {
      if (this.worker !== worker) return;
      this.reset();
      const task = this.current;
      this.current = undefined;
      if (task) { clearTimeout(task.timer); task.reject(error); }
      this.pump();
    };
    worker.on('error', crashed);
    worker.on('exit', code => crashed(new Error(`正则隔离线程退出：${code}`)));
    return worker;
  }

  private reset() {
    const worker = this.worker;
    const port = this.port;
    this.worker = undefined;
    this.port = undefined;
    this.online = undefined;
    if (port) { port.removeAllListeners(); port.close(); }
    if (!worker) return;
    worker.removeAllListeners();
    void worker.terminate();
  }
}

let shared: ScenarioRegexRunner | undefined;
/** 进程内共用的执行器（加载时的 examples 检查、运行时的匹配）。 */
export function scenarioRegexRunner(): ScenarioRegexRunner {
  shared ??= new ScenarioRegexRunner();
  return shared;
}
