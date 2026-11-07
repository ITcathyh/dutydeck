/**
 * systemd socket 激活（sd_listen_fds 的约定）：配套的 .socket unit 持有监听端口，启动服务时把它从 fd 3 传进来。
 * 服务重启期间端口一直开着，新连接在内核里排队，等新进程开始 accept，不再被拒绝。
 *
 * 只认发给本进程的（LISTEN_PID 是自己），读完就从环境里删掉，免得派生的 Agent 和插件进程误以为自己被激活。
 * Node 启动时已把继承来的 fd 标为 close-on-exec，子进程（tmux、Agent）不会持有这个端口。
 */
export const SD_LISTEN_FDS_START = 3;

export type InheritedListenSocket = { fd: number } | { error: string } | undefined;

export function takeInheritedListenSocket(env: NodeJS.ProcessEnv = process.env, pid = process.pid): InheritedListenSocket {
  const listenPid = env.LISTEN_PID, listenFds = env.LISTEN_FDS;
  if (listenPid === undefined && listenFds === undefined) return undefined;
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;
  if (listenPid !== String(pid)) return undefined;
  const count = Number(listenFds);
  if (!Number.isSafeInteger(count) || count < 1) return undefined;
  // 一个服务只开一个 HTTP 端口；多个说明 .socket unit 写错了，不猜该用哪个。
  if (count > 1) return { error: `systemd 传入了 ${count} 个监听 socket，Dutydeck 只支持一个：配套的 .socket unit 里只保留一行 ListenStream=。` };
  return { fd: SD_LISTEN_FDS_START };
}

/**
 * 交给 Fastify listen 的参数。Node 有 fd 时忽略 host/port；但 Fastify 在 host 缺省（即 localhost）时会在同一端口上
 * 再绑 ::1 等地址，那个 socket 不归 systemd 管，所以显式给一个非 localhost 的 host。类型里没有 fd，运行时原样传给 server.listen。
 */
export function inheritedListenOptions(fd: number): { host: string; port: number } {
  return { fd, host: '127.0.0.1' } as unknown as { host: string; port: number };
}

/** 继承来的 socket 必须就是配置的端口：守护状态、部署健康检查和排空都按配置的地址连。 */
export function inheritedSocketMismatch(address: unknown, config: { host: string; port: number }): string | undefined {
  const bound = address && typeof address === 'object' ? address as { address?: string; port?: number } : undefined;
  if (!bound || bound.port !== config.port) {
    return `systemd 传入的监听 socket 是 ${bound ? `${bound.address}:${bound.port}` : '非 TCP 地址'}，与配置的端口 ${config.port} 不一致。让配套 .socket unit 的 ListenStream= 与 --port/--host 保持一致。`;
  }
  return undefined;
}
