// 飞书过程卡 / 结果卡的用户可见状态、时长与时间格式、结论首句。
//
// 内部状态机有十几种说法（排队受阻、需要核对、结果未知、已核对结果未确认……），
// 读者分不清它们的区别，也没有对应的不同操作。这里把它们收敛成 5 个用户可见状态，
// 具体原因作副标题；内部状态到 5 个状态的映射只在这一处。
// 本模块必须保持纯函数、不 import service.ts / card-renderer.ts（它们会反过来 import 本模块）。

export type LarkUserStatus = 'running' | 'attention' | 'completed' | 'failed' | 'interrupted';

// 标题栏颜色按 5 状态：进行中 blue、需要你处理 orange、完成 green、失败 red、中断 grey。
export const larkUserStatusPresentation: Record<LarkUserStatus, { label: string; template: string; tagColor: string }> = {
  running: { label: '进行中', template: 'blue', tagColor: 'blue' },
  attention: { label: '需要你处理', template: 'orange', tagColor: 'orange' },
  completed: { label: '完成', template: 'green', tagColor: 'green' },
  failed: { label: '失败', template: 'red', tagColor: 'red' },
  interrupted: { label: '中断', template: 'grey', tagColor: 'neutral' }
};

/** 这些调用方传入的说法就是状态本身，不再作为副标题重复一遍。 */
const plainLabels = new Set(['执行中', '运行完成', '已完成', '已失败', '已中断', '已取消', '排队中', '已接收']);
/** 恢复类说法：任务停在不确定的位置，用户可见状态统一为「中断」，原因文本由恢复流程负责。 */
const recoveryLabels = new Set(['排队受阻', '需要核对', '结果未知', '已核对，结果未确认', '已放弃']);
const stalledLabel = '可能卡住';
const approvalLabels = new Set(['等待审批', '等待回答']);

export interface LarkUserStatusInput {
  /** 卡片的内部状态（buildLarkCard 的 state）。 */
  state: string;
  /** 调用方给的说法（recovery.label、「可能卡住」等）；没有就是默认。 */
  label?: string;
  /** 卡上有待处理的审批，或在等用户回答。 */
  waiting?: boolean;
  awaitingAnswer?: boolean;
  /** 排队第几位（从 1 起）。 */
  queuePosition?: number;
}

export interface LarkUserStatusView {
  status: LarkUserStatus;
  label: string;
  template: string;
  tagColor: string;
  /** 具体原因，放在副标题里；没有就不写。 */
  reason?: string;
  /** 任务没在往前走（卡住、受阻、待核对）：用时不再累加，改写「停在 HH:MM」。 */
  stopped: boolean;
}

export function larkUserStatus(input: LarkUserStatusInput): LarkUserStatusView {
  const label = input.label?.trim() || undefined;
  const view = (status: LarkUserStatus, reason?: string, stopped = false): LarkUserStatusView =>
    ({ status, ...larkUserStatusPresentation[status], ...(reason ? { reason } : {}), stopped });
  const detail = label && !plainLabels.has(label) ? label : undefined;
  if (input.waiting || (label && approvalLabels.has(label))) {
    return view('attention', label && approvalLabels.has(label) ? label : input.awaitingAnswer ? '等待回答' : '等待审批');
  }
  switch (input.state) {
    case 'completed': return view('completed', detail);
    case 'failed': return view('failed', detail);
    case 'interrupted': return view('interrupted', detail);
    case 'cancelled': return view('interrupted', label ?? '已取消');
    case 'reconcile_required':
    case 'legacy_unresolved': return view('interrupted', label ?? '需要核对', true);
    default: break;
  }
  if (label && recoveryLabels.has(label)) return view('interrupted', label, true);
  if (label === stalledLabel) return view('running', label, true);
  if (input.state === 'queued') {
    return view('running', input.queuePosition && input.queuePosition > 0 ? `排队第 ${input.queuePosition}` : detail ?? '排队中');
  }
  return view('running', detail);
}

/** 时长：不足 1 分钟写秒，不足 1 小时写「X 分 Y 秒」，再长写「X 小时 Y 分」。 */
export function larkElapsedLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return value % 60 ? `${minutes} 分 ${value % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

const shanghaiParts = (at: Date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at).map(part => [part.type, part.value]));
  return { day: `${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}` };
};

/** 「停在 HH:MM」；与当前不在同一天（上海时区）时带上日期。时间不可用时返回 undefined。 */
export function larkStoppedAtLabel(at: string | number | Date | undefined, now: number = Date.now()): string | undefined {
  if (at === undefined) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  const stopped = shanghaiParts(date);
  return shanghaiParts(new Date(now)).day === stopped.day ? `停在 ${stopped.clock}` : `停在 ${stopped.day} ${stopped.clock}`;
}

// 只是个栏目名、没有内容的行不当结论；超长结论转附件后卡上的节选标签同理。
const headingOnly = /^(?:结论|总结|摘要|概述|小结|tl;?dr|正文开头节选（非完整结论）)[:：]?$/i;
const needsYouLine = /^(?:\*\*)?需要你[：:]/;

/**
 * 结论第一句：去掉 Markdown 符号，取第一个有内容的行的第一句，超过 maxChars 截断加省略号。
 * 代码块、表格、分隔线和「需要你：」行不参与；取不到时返回 undefined，调用方回退到原来的说法。
 */
export function larkConclusionHeadline(markdown: unknown, maxChars = 120): string | undefined {
  if (typeof markdown !== 'string') return undefined;
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    // 整行只有一个加粗短语（「**最终答复**」）是栏目标签，真正的结论在它下面。
    if (inFence || !line || line.startsWith('|') || /^\*\*[^*：:。！？.!?]{1,12}\*\*$/.test(line) || /^(?:[-*_]\s*){3,}$/.test(line) || needsYouLine.test(line.replace(/^(?:[-*+]\s+)/, ''))) continue;
    const text = line
      .replace(/^#{1,6}\s+/, '').replace(/^>+\s*/, '').replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '').replace(/\*\*|__|~~|[*`]/g, '')
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
      .replace(/\s+/g, ' ').trim();
    if (!text || headingOnly.test(text)) continue;
    const end = text.search(/[。！？；]|[.!?;](?=\s|$)/u);
    const sentence = (end >= 0 ? text.slice(0, end + (/[！？!?]/.test(text[end]!) ? 1 : 0)) : text).trim();
    if (!sentence) continue;
    const characters = Array.from(sentence);
    return characters.length <= maxChars ? sentence : `${characters.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
  }
  return undefined;
}
