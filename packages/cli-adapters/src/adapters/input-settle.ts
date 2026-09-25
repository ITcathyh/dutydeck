import type { PtyLike } from '../types.js';

/**
 * 写入用户消息前后的屏幕时序，参考 coder/agentapi（lib/screentracker）：
 * 屏幕已连续 0.5 秒没有变化就直接写入，CLI 还在输出时才等到静止；写入后等回显
 * 出现并稳定 300ms 再提交，回显 2 秒内没稳定也照常提交。CLI 还在输出时插入的
 * 按键会和它的重绘交错。
 *
 * 屏幕变化以 `lastOutputAt`（driver 按 PTY 输出打点）为准；后端不提供时不等待，
 * 保持原有时序。
 */

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** 回显出现前的检查间隔。 */
const POLL_MS = 50;
/** 写入前屏幕需连续不变的时长。agentapi 的 ScreenStabilityLength 是 2 秒，这里取 0.5 秒，
 *  控制每条消息的额外延迟；首写和后续写入都用它。 */
export const INPUT_QUIET_MS = 500;
/** 屏幕一直在变（如计时器刷新）时最多等这么久，之后照常写入。 */
export const INPUT_QUIET_TIMEOUT_MS = 10_000;
/** 回显出现后需稳定的时长。 */
export const INPUT_ECHO_SETTLE_MS = 300;
/** 回显最多等这么久（agentapi 的 writeStabilizeEchoTimeout），超时照常提交。 */
export const INPUT_ECHO_TIMEOUT_MS = 2_000;

/** 屏幕已静止 INPUT_QUIET_MS 就立即返回；否则睡到静止点，期间有新输出就顺延，最多等 INPUT_QUIET_TIMEOUT_MS。 */
export async function waitForQuietScreen(backend: PtyLike): Promise<void> {
  if (!backend.lastOutputAt) return;
  const deadline = Date.now() + INPUT_QUIET_TIMEOUT_MS;
  for (;;) {
    const wait = Math.min(backend.lastOutputAt() + INPUT_QUIET_MS, deadline) - Date.now();
    if (wait <= 0) return;
    await delay(wait);
  }
}

/** 等 `since` 之后写入的内容回显并稳定 INPUT_ECHO_SETTLE_MS，最多等 INPUT_ECHO_TIMEOUT_MS。 */
export async function waitForInputEcho(backend: PtyLike, since: number): Promise<void> {
  if (!backend.lastOutputAt) return;
  const deadline = Date.now() + INPUT_ECHO_TIMEOUT_MS;
  for (;;) {
    const outputAt = backend.lastOutputAt();
    const ready = outputAt >= since ? outputAt + INPUT_ECHO_SETTLE_MS : Date.now() + POLL_MS;
    const wait = Math.min(ready, deadline) - Date.now();
    if (wait <= 0) return;
    await delay(wait);
  }
}
