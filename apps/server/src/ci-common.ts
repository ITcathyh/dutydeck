import type { Session } from '@dutydeck/shared';

// CI 等待（ci-webhook.ts）与 PR 跟进（pull-requests.ts）共用的小工具。

export const iso = (ms: number) => new Date(ms).toISOString();
export const short = (value: string) => value.slice(0, 12);
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 300);
export const isRunnable = (session: Session | undefined): session is Session => Boolean(session && !session.archivedAt && !['stopped', 'failed'].includes(session.state));
export const codeBlock = (value: string) => `\`\`\`\n${value.replace(/```/g, "'''")}\n\`\`\``;

/** 超时以 Error('timeout') 拒绝；计时器不阻止进程退出。 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

/** 同一时刻只跑一轮：上一轮没结束时返回同一个 Promise，结束后清掉。 */
export class SingleFlight {
  current?: Promise<void>;

  run(task: () => Promise<void>): Promise<void> {
    if (this.current) return this.current;
    const operation = task().finally(() => { if (this.current === operation) this.current = undefined; });
    this.current = operation;
    return operation;
  }
}
