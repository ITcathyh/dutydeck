/**
 * 飞书长连接的实际状态。守护进程的连接池每次同步、重连后写进 configs 表；
 * `dutydeck doctor` 在另一个进程里跑，读不到内存里的连接池，只读这一份，
 * 再和配置里「应该监听」的机器人对比。
 */
export const larkListenerStatusKey = 'lark.listener.status';

export interface LarkListenerStatus {
  /** 写入这份状态的进程；和守护进程的 pid 对不上，说明是上一个进程留下的。 */
  pid: number;
  updatedAt: string;
  /** 已经连上的机器人。 */
  active: string[];
  /** 连接失败、等待重连的机器人：最近一次错误（已脱敏）与下一次重连时间。 */
  retrying: Array<{ appId: string; error: string; failedAt: string; nextRetryAt: string }>;
  /** 连上之后断线、SDK 正在自己重连的机器人，不计入 active。 */
  reconnecting: Array<{ appId: string; since: string }>;
}
