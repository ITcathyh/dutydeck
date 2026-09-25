/**
 * 把服务监听 host/port 换算成「本机回环访问」用的基础 URL。
 *
 * 服务监听在通配地址（IPv4 的 0.0.0.0 或 IPv6 的 ::）时，本机客户端统一走 127.0.0.1，
 * 既能连到双栈 socket，也避免把通配地址当作 Host 头。服务端拼内部回调地址、CLI 在本机
 * 查询守护进程（如 restart 前 drain）都用这一份换算，避免两套映射出现一边漏了 ::。
 */
export function localLoopbackUrl(host: string, port: number | string): string {
  const loopback = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${loopback.includes(':') ? `[${loopback}]` : loopback}:${port}`;
}
