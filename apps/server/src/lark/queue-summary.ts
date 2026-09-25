// 运行卡心跳里的本 scope（群/会话）排队摘要（S6）。
// 现状心跳只给 queuedAhead 计数，连发三条任务时看不到排了什么；这里补「条数 + 每条一句话」。
// 摘要随心跳 PATCH 进同一张运行卡，按终裁 §6 永不新消息、永不 @ 人，因此 prompt 文本必须
// 转义掉 <at> 等标签（与 card-mentions 的约束同源），防止排队内容在卡面注入 @。
//
// 预算自守（终裁工程约束 3：24KB/180 组件）：最多 5 条、每条原文 80 字、总长 500 字。
// 普通文本恒定上界约 460 字（标题 + 5 行 × 83 + 换行 + 溢出提示）；含 & < > 的文本
// 转义后会变长，此时由总长 500 兜底减行（减行后条数计入溢出提示），任何输入都不破限。

/** 最多展示的排队条目数。 */
export const QUEUE_SUMMARY_MAX_ITEMS = 5;
/** 摘要 markdown 总字符上限。 */
export const QUEUE_SUMMARY_MAX_CHARS = 500;
/** 单条 prompt 展示的字符上限。 */
export const QUEUE_SUMMARY_PER_ITEM_CHARS = 80;
/** 摘要固定只占一个 markdown 组件，供主控做 180 组件预算核验。 */
export const QUEUE_SUMMARY_COMPONENT_COUNT = 1;
/** 心跳卡内摘要元素的固定 element_id，便于主控去重/替换。 */
export const QUEUE_SUMMARY_ELEMENT_ID = 'queue_summary';

/** 入参形状对齐 shared TaskRecord（只取本模块需要的字段，TaskRecord 可直接传入）。 */
export interface QueueSummaryTask {
  id: string;
  prompt?: string;
}

export interface QueueSummaryOptions {
  /** 当前一轮停在执行端审批上：排队条目都要等这条审批处理完。 */
  blockedByApproval?: boolean;
}

export interface QueueSummaryElement {
  tag: 'markdown';
  element_id: string;
  content: string;
  text_size: 'notation';
  margin: '0px';
}

/** 换行折叠为空格（先做，保证一条任务只占一行）。 */
const normalizeLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * & < > 转义在截断之后做：避免把 &amp; 这类实体截成半截裸文本。
 * 导出给 /queue 的回执复用：回显同一批 prompt，必须用同一份转义，否则 <at> 会在卡面变成真的 @。
 */
export const escapeLarkPromptEcho = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** 按码点截断原文并补省略号：不在 emoji 代理对中间下刀；返回值原文长度 = limit + 1。 */
const clipCodePoints = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  let cut = limit;
  if (cut > 0) {
    const unit = text.charCodeAt(cut - 1);
    // 高位代理落刀口时回退一位，代理对整体保留或整体丢弃。
    if (unit >= 0xD800 && unit <= 0xDBFF) cut -= 1;
  }
  return `${text.slice(0, cut)}…`;
};

const overflowSuffix = (remaining: number) =>
  remaining > 0 ? `…其余 ${remaining} 条可在 /tasks 查看` : '';

/**
 * 渲染排队摘要 markdown；无排队条目返回 undefined（主控不追加元素）。
 * 条目顺序按调用方给入顺序（runtime 队列序），主控负责过滤 status === 'queued'。
 */
export function renderQueueSummary(tasks: readonly QueueSummaryTask[], options: QueueSummaryOptions = {}): string | undefined {
  const queued = tasks.filter(task => task.id?.trim());
  if (!queued.length) return undefined;

  const title = `**排队 ${queued.length} 条${options.blockedByApproval ? '（被审批阻塞）' : ''}**`;
  const lines: string[] = [];
  let shown = 0;
  for (const task of queued) {
    if (shown >= QUEUE_SUMMARY_MAX_ITEMS) break;
    const raw = normalizeLine(task.prompt ?? '');
    const prompt = raw
      ? escapeLarkPromptEcho(clipCodePoints(raw, QUEUE_SUMMARY_PER_ITEM_CHARS - 1))
      : '（无描述）';
    const line = `${shown + 1}. ${prompt}`;
    const remainingAfter = queued.length - (shown + 1);
    const projected = [title, ...lines, line, overflowSuffix(remainingAfter)].join('\n').length;
    if (projected > QUEUE_SUMMARY_MAX_CHARS) break;
    lines.push(line);
    shown += 1;
  }

  const parts = [title, ...lines];
  const remaining = queued.length - shown;
  if (remaining > 0) parts.push(overflowSuffix(remaining));
  return parts.join('\n');
}

/** 渲染为可直接拼进运行卡 elements 的 markdown 元素；无摘要时返回 undefined。 */
export function renderQueueSummaryElement(tasks: readonly QueueSummaryTask[], options: QueueSummaryOptions = {}): QueueSummaryElement | undefined {
  const content = renderQueueSummary(tasks, options);
  return content
    ? { tag: 'markdown', element_id: QUEUE_SUMMARY_ELEMENT_ID, content, text_size: 'notation', margin: '0px' }
    : undefined;
}
