import type { AppConfig } from '@dutydeck/config';

export function listenOptions(config: Pick<AppConfig, 'host' | 'port'>) {
  if (config.host === '0.0.0.0') {
    return { host: '::', port: config.port, ipv6Only: false } as const;
  }
  return { host: config.host, port: config.port };
}

export function accessMode(config: Pick<AppConfig, 'host' | 'authEnabled'>): 'local' | 'token' | 'open' {
  // Loopback keeps its stricter Host/Origin rebinding protection even when the
  // redundant --no-auth flag is present.
  if (config.host === '127.0.0.1' || config.host === '::1') return 'local';
  return config.authEnabled ? 'token' : 'open';
}

/** 显式确认在非回环地址上免认证运行：--unsafe-no-auth 或这个环境变量 */
export const UNSAFE_NO_AUTH_ENV = 'DUTYDECK_UNSAFE_NO_AUTH';

/**
 * 监听地址不是回环、认证又关着（open 模式）时返回拒绝启动的说明，显式确认 unsafe 时放行。
 * 第一行带 refused 且不含 password/token 字样：`dutydeck start` 只从守护日志回放这样的行。
 */
export function unauthenticatedListenRefusal(config: Pick<AppConfig, 'host' | 'authEnabled'>, env: NodeJS.ProcessEnv): string | undefined {
  if (accessMode(config) !== 'open' || env[UNSAFE_NO_AUTH_ENV] === 'true') return undefined;
  return [
    `Dutydeck refused to start: 监听地址 ${config.host} 不是本机回环地址，访问认证却已关闭，同网络任何人都能查看任务、驱动 Agent、打开终端。`,
    '先设置访问密码：dutydeck auth password set，再去掉 --no-auth（或 .env 里的 DUTYDECK_AUTH=false）重新启动；浏览器用这个密码登录，CLI 和本机调用照旧用 access token。',
    `确需在这个地址免认证运行，改用 --unsafe-no-auth 或设置 ${UNSAFE_NO_AUTH_ENV}=true。`
  ].join('\n');
}
