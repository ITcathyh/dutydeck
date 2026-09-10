# PTY 终端 WebSocket 协议（TERMINAL_API）

Web 工作台“终端”标签与服务端之间的实时终端协议。服务端通过 `GET /api/terminal/:sessionId` WebSocket 端点，把 Dutydeck PTY 运行的屏幕流推给浏览器，并把浏览器的键盘输入回写给 PTY。`sessionId` 是兼容 API 使用的内部运行标识。

## 1. 端点与 URL 推导

- 端点：`GET /api/terminal/:sessionId`（HTTP Upgrade 为 WebSocket）。
- `sessionId` 是会话 ID，**必须**经过 `encodeURIComponent` 编码后再拼进路径。
- 协议与端口与 Web 工作台同源推导：页面是 `http://` 则用 `ws://`，`https://` 则用 `wss://`，host 取 `window.location.host`。
  - 例：页面 `http://127.0.0.1:4311/sessions/abc` → `ws://127.0.0.1:4311/api/terminal/abc`。
- Web 端的 URL 推导逻辑在 `apps/web/src/terminal.ts` 的 `terminalWsUrl`，服务端无需关心推导过程，只需保证该路径可达。

## 2. 鉴权约定

- 与 Web 同源：浏览器自动携带同域 cookie，服务端按现有 Web 鉴权中间件（cookie / 同源会话）校验即可，Web 端不附加任何自定义头或 token。
- 若平台侧后续启用 HMAC token 等统一鉴权注入，由平台层（反向代理 / 网关）统一处理，**Web 端不做特殊处理**，协议本身不预留鉴权字段。
- 鉴权失败：服务端应以 HTTP 401/403 拒绝 Upgrade（不要建立连接后再关）。

## 3. 帧格式

双向均为 **JSON 文本帧**（每帧一条 JSON，UTF-8）。未知 `type`、非法 JSON、缺字段的帧，接收方必须静默丢弃（不抛异常、不断连）。

### 3.1 服务端 → 客户端

```ts
type TerminalServerFrame =
  | { type: 'data'; data: string }      // PTY 屏幕输出（含 ANSI 转义序列），原样写进 xterm
  | { type: 'exit'; code: number | null } // PTY 进程已退出；code 为退出码，被信号终止时为 null
  | { type: 'error'; message: string };  // 终端/会话异常的人类可读说明
```

- `data` 帧：`data` 是 PTY 的原始输出字节流（按 UTF-8 解码后的字符串），可包含颜色、光标定位等 ANSI 序列，客户端原样 `term.write`，不做转义。
- `exit` 帧：进程生命周期结束。客户端在屏幕上追加一行暗色提示 `[进程已退出，code=<code>]`。**发完 exit 后服务端可以关闭连接**；客户端会自动重连（见第 5 节），重连后从当前屏幕继续。
- `error` 帧：会话不存在、PTY 未启动等异常。客户端追加一行暗色错误提示。error 帧之后连接是否关闭由服务端决定。

### 3.2 客户端 → 服务端

```ts
type TerminalClientFrame =
  | { type: 'input'; data: string }       // 用户键盘输入（含控制字符，如 \r、\x03）
  | { type: 'resize'; cols: number; rows: number }; // 终端当前行列数
```

- `input` 帧：`data` 是 xterm `onData` 的原始输入，服务端原样写入 PTY master，不做换行转换。
- `resize` 帧：**由客户端驱动**。客户端在连接建立成功后、以及容器尺寸变化（`ResizeObserver` + FitAddon 重新计算）后各发一次，`cols`/`rows` 为 xterm 当前行列数。服务端收到后应对 PTY 执行 `TIOCSWINSZ`（等价操作）。

## 4. 生命周期

1. 客户端 mount 即建立 WebSocket；连接成功后服务端**立即开始推当前屏幕输出流**（PTY 的实时输出）。
2. **无历史回放保证**：服务端不承诺缓存断线前的输出。客户端重连成功后不请求历史，保留当前屏幕内容，仅追加一行暗色 `[已重新连接]` 提示，然后继续接收实时流。
3. 服务端应在 PTY 进程退出时发 `exit` 帧；会话被销毁/归档时可发 `error` 帧后关闭。
4. 客户端卸载（切走终端 tab、关闭会话详情）时主动 `close()`，服务端应据此清理该连接对应的资源（同一 session 允许多个并发连接，各自独立推流）。

## 5. 重连

- 客户端对**非主动关闭**的断连做指数退避重连：间隔 `min(1000 * 2^attempt, 30000)` ms（1s、2s、4s……封顶 30s），逻辑在 `terminal.ts` 的 `nextTerminalBackoffMs`。
- 重连成功后 `attempt` 归零；重连期间终端保留最后一屏内容，不清屏。
- 服务端无需感知重连：每次新连接都按「连接成功即推当前屏幕流」处理即可。

## 6. 完整交互示例

```
客户端                                      服务端
  │                                            │
  │── GET /api/terminal/sess-1 (Upgrade) ─────►│  校验同源 cookie，Upgrade 成功
  │◄────────────── 101 Switching ──────────────│
  │                                            │
  │── {"type":"resize","cols":120,"rows":32} ─►│  PTY 设置窗口大小
  │◄─ {"type":"data","data":"$ ls\r\n"} ───────│  PTY 实时输出（回显）
  │◄─ {"type":"data","data":"src\r\n"} ────────│
  │── {"type":"input","data":"l"} ─────────────►│  用户敲键，写入 PTY
  │── {"type":"input","data":"s"} ─────────────►│
  │── {"type":"input","data":"\r"} ────────────►│
  │◄─ {"type":"data","data":"ls\r\nsrc\r\n$ "} ─│
  │                                            │
  │  (网络抖动，连接断开)                         │
  │── 1s 后重连，再次 Upgrade ─────────────────►│
  │◄─ {"type":"data","data":"...当前屏幕流..."} ─│  不回放历史，直接推实时流
  │                                            │
  │◄─ {"type":"exit","code":0} ────────────────│  PTY 进程退出
  │  (客户端显示 [进程已退出，code=0])            │
```

## 7. 客户端实现对照

| 职责 | 位置 |
|---|---|
| URL 推导 / 帧解析 / 退避算法（纯函数，可单测） | `apps/web/src/terminal.ts` |
| xterm 生命周期、WS 收发、重连、ResizeObserver | `apps/web/src/components/TerminalView.tsx` |
