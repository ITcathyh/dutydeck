import { realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import type { ConfigRepository } from '@dutydeck/shared';
import { getAuthToken } from '../auth/auth.js';
import { pidAlive, readDaemonStatus, resolveDaemonDir, type DaemonState } from '../daemon/daemon.js';

export interface LarkListenerSyncResult {
  activeListening: boolean;
  message: string;
}

interface Dependencies {
  readState?: () => DaemonState | undefined;
  fetcher?: typeof fetch;
  interfaces?: typeof networkInterfaces;
}

function localOrigin(address: string, interfaces: typeof networkInterfaces): string | undefined {
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined;
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === '::1' || isIP(host) === 4 && host.startsWith('127.');
    const local = isIP(host) !== 0 && Object.values(interfaces()).flat().some(item => item?.address === host);
    return loopback || local ? url.origin : undefined;
  } catch { return undefined; }
}

/** Connect only to a live local daemon that serves the exact database we saved. */
export async function syncLarkListener(
  appId: string,
  context: { config: ConfigRepository; database: string },
  dependencies: Dependencies = {},
): Promise<LarkListenerSyncResult> {
  const failed = (message: string): LarkListenerSyncResult => ({ activeListening: false, message: `监听配置已保存，尚未确认接通。${message}` });
  try {
    const state = (dependencies.readState ?? (() => readDaemonStatus(resolveDaemonDir())))();
    if (state?.ready !== true || !pidAlive(state.pid) || !state.address) return failed('本机服务未运行或尚未就绪；请启动服务后重试同一任务。');
    if (!state.database || !state.cwd) return failed('无法核对服务数据库；请从使用同一数据库的 Dashboard 重新保存机器人配置。');
    let sameDatabase = false;
    try { sameDatabase = await realpath(resolve(state.cwd, state.database)) === await realpath(resolve(context.database)); }
    catch { /* A missing or unreadable database cannot establish daemon identity. */ }
    if (!sameDatabase) return failed('运行中服务的数据库与本次配置不一致；请从使用同一数据库的 Dashboard 重新保存机器人配置。');
    const origin = localOrigin(state.address, dependencies.interfaces ?? networkInterfaces);
    if (!origin) return failed('服务地址不是可验证的本机地址；请从本机 Dashboard 重新保存机器人配置。');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (state.authEnabled !== false) {
      const token = await getAuthToken(context.config);
      if (!token) return failed('本机服务访问凭据不可用；请登录 Dashboard 后重新保存机器人配置。');
      headers.authorization = `Bearer ${token}`;
    }
    const response = await (dependencies.fetcher ?? fetch)(`${origin}/api/lark/bots/${encodeURIComponent(appId)}/listener/sync`, {
      method: 'POST', headers, body: '{}', redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404) return failed('服务尚未提供动态接通接口，或未找到该机器人；请升级服务后从 Dashboard 重新保存机器人配置。');
    if (!response.ok) return failed(`服务未能接通监听（HTTP ${response.status}）；请在 Dashboard 检查监听状态后重试同一任务。`);
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || !('appId' in result) || result.appId !== appId
      || !('activeListening' in result) || result.activeListening !== true || !('listening' in result) || result.listening !== true) {
      return failed('服务没有确认当前机器人的监听已接通；请在 Dashboard 检查后重试同一任务。');
    }
    return { activeListening: true, message: '机器人监听已接通，可以在飞书中发送消息。' };
  } catch {
    return failed('连接本机服务失败或超时；请在 Dashboard 检查监听状态后重试同一任务。');
  }
}
