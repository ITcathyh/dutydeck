import type { AdapterSessionContext, CliAdapter, PtyLike } from '../types.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Pi 的活动态 busy 标记：turn 进行中渲染的临时状态行。 */
const PI_WORKING_PATTERN = /Working\.\.\./;

/**
 * Pi coding-agent 原生 TUI（`pi`）适配器。
 *
 * ## 为什么没有 readyPattern（纯 quiescence 适配器）
 * Pi 每轮结束后不打任何稳定的就绪标记，所以就绪判定完全靠「PTY 静默」+
 * `Working...` busy 标记，而不是 readyPattern。裸 quiescence 会误判，实际
 * 有三道闸门，其中两道是适配器能表达的：
 *
 *  1. 启动窗口：TUI 会在 CLI 真正开始消费 argv 里的首轮 prompt 之前好几秒就把
 *     输入框画出来（扩展/模型还在加载）。此时的静默不是 idle——需要 driver 把
 *     首次 ready 压到「turn 确实起来了」为止（PTY 上出现 `Working...`）。
 *     这条闸门在 driver 侧，精简契约里没有对应字段。
 *  2. turn 中途：当前未接入 JSONL transcript 终止事件压制屏幕 idle，这条闸门缺失。
 *  3. idle 之后：`idleToBusyPattern` 把误判的 ready 拉回 working——`Working...`
 *     在一次 idle 上报之后重新出现，就说明刚才那次 ready 是假的。它当 idle→busy
 *     边沿标记是安全的：Pi 的 `Working...` 是临时状态行，从不参与历史重绘，
 *     所以已结束的 turn 不会被重新点亮。
 */
export function createPiAdapter(): CliAdapter {
  return {
    id: 'pi',
    capabilities: { resume: true, initialPromptViaArgs: true },

    buildArgs({ sessionId, resume, resumeSessionId, initialPrompt, model }: AdapterSessionContext): string[] {
      // Pi 的会话文件名是 `<时间戳>_<uuid>.jsonl`，`--session-id` 只接受裸 UUID；
      // dutydeck sessionId 形如 `ses_<uuid>`，先剥前缀。
      const uuid = sessionId.replace(/^ses_/, '');
      // Pi 没有独立的 --resume：同一个 --session-id 再启一次就是续接，
      // 所以 fresh 与 resume 的 argv 结构相同。resumeSessionId 也要剥前缀——
      // driver 反查失败时退回来的是 `ses_<uuid>`，不剥就会指到另一个会话，
      // 而且 Pi 不报错，只是静默丢掉全部历史。
      const args = ['--session-id',
        resume && resumeSessionId ? resumeSessionId.replace(/^ses_/, '') : uuid];
      if (model && model.trim()) args.push('--model', model.trim());
      // Pi 交互模式在 TUI 启动完成后才处理位置参数形式的首轮消息，既避开了
      // stdin 竞态，又保留原生 TUI。
      //
      // 当前不支持的能力：暂不支持对超过 4096 字节或含控制字符的首轮 prompt 改
      // 写成 `@<文件>` 位置参数配 extension 投递。该机制需要 session
      // 数据目录与沙箱只读挂载，当前精简契约不包含——超长首轮 prompt
      // 需要 driver 改走 writeInput。
      if (initialPrompt) args.push(initialPrompt);
      return args;
    },

    async writeInput(backend: PtyLike, prompt: string): Promise<void> {
      if (backend.pasteText && backend.sendSpecialKeys) {
        backend.pasteText(prompt);
        await delay(200);
        backend.sendSpecialKeys('Enter');
      } else {
        backend.write('\x1b[200~' + prompt + '\x1b[201~');
        await delay(1000);
        backend.write('\r');
      }
    },

    buildResumeCommand(sessionId: string): string[] {
      return ['--session-id', sessionId.replace(/^ses_/, '')];
    },

    busyPattern: PI_WORKING_PATTERN,
    idleToBusyPattern: PI_WORKING_PATTERN,
  };
}
