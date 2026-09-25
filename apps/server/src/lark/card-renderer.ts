import type { AgentEvent, VerificationResponse, VerificationStatus } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import { boundLarkCardElements, LarkServiceError } from './service.js';
import { redactTraceText, sensitiveTraceKey } from './secret-redaction.js';
import { maxLarkVerificationRepairRounds, type LarkAutoVerificationNote } from './auto-verification.js';

// 卡片渲染与限流/拒绝判断辅助。
// 飞书只展示可观察的阶段摘要、工具活动和最终结果；模型 thinking 属于内部推理，
// 只能用于计数和阶段状态判断，不得把原文写入卡片或降级 Markdown。
// compactTrace 开启时过程卡进入精简模式：历史阶段与当前阶段都只保留一行标题/旁白，
// 不再展开工具与终端面板；完整细节仍由 renderLarkTrace / renderLarkRecordExport 保留。

export type TraceEntry = { type: AgentEvent['type']; data: Record<string, any>; timestamp: string };
export type TraceGroup = { narratives: TraceEntry[]; actions: TraceEntry[] };
export type LarkCardElement = Record<string, any>;
type TraceToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'git' | 'test' | 'data' | 'agent' | 'tool';
const visibleTraceGroupLimit = 5;

// 任务终态集合：reconcile 与 trace 渲染共用（runtime task 状态机的终态判定）。
export const terminalTaskStates = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

export const isLarkMessageRateLimit = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && Number(error.details?.upstreamCode) === 230020;

export const larkRateLimitBackoffMs = (failures: number) => Math.min(60_000, 5_000 * (2 ** Math.max(0, failures - 1)));

export const isLarkCardContentRejected = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && [230028, 230099].includes(Number(error.details?.upstreamCode));

export const isLarkMessageUnupdatable = (error: unknown): error is LarkServiceError => error instanceof LarkServiceError
  && [230012, 230030, 230031].includes(Number(error.details?.upstreamCode));

const rejectedDeltaElement = (changedCount: number): LarkCardElement => ({
  tag: 'markdown',
  element_id: 'dutydeck_rejected_delta',
  content: `<font color='orange'>本次新增或变化的 ${Math.max(1, changedCount)} 个内容区块未通过飞书审核，已保留上一次成功内容。</font>`,
  text_size: 'notation',
  margin: '8px 0px 0px 0px'
});

export function patchRejectedCardDelta(previous: LarkCardElement[] = [], current: LarkCardElement[] = []): LarkCardElement[] {
  // previous 来自库里存的上一版快照，改名前存下的用的是旧 id。
  // 只按新 id 过滤会让旧提示留在原地，再叠一条新的上去。
  const baseline = previous.filter(element =>
    element.element_id !== 'dutydeck_rejected_delta' && element.element_id !== 'dockmux_rejected_delta');
  const same = (left: LarkCardElement, right: LarkCardElement) => JSON.stringify(left) === JSON.stringify(right);
  let prefix = 0;
  while (prefix < baseline.length && prefix < current.length && same(baseline[prefix]!, current[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < baseline.length - prefix
    && suffix < current.length - prefix
    && same(baseline[baseline.length - 1 - suffix]!, current[current.length - 1 - suffix]!)
  ) suffix++;
  const previousChangedEnd = baseline.length - suffix;
  const currentChangedCount = Math.max(1, current.length - prefix - suffix);
  return boundLarkCardElements([
    ...baseline.slice(0, prefix),
    ...baseline.slice(prefix, previousChangedEnd),
    rejectedDeltaElement(currentChangedCount),
    ...(suffix ? current.slice(current.length - suffix) : [])
  ]);
}

function compactTraceEntries(events: AgentEvent[]): TraceEntry[] {
  const result: TraceEntry[] = [];
  const tools = new Map<string, TraceEntry>();
  const permissions = new Map<string, TraceEntry>();
  for (const event of events) {
    if (event.type === 'task' || event.type === 'completed' || event.type === 'status') continue;
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, any> : { value: event.data };
    if (event.type === 'text' && data.role === 'user') continue;
    if (event.type === 'raw_terminal' && typeof data.text === 'string') {
      try {
        const raw = JSON.parse(data.text);
        if (raw && typeof raw === 'object' && raw.type === 'status') continue;
      } catch { /* Non-JSON terminal output remains a visible execution record. */ }
    }
    const previous = result.at(-1);
    const role = data.role ?? 'assistant';
    if ((event.type === 'text' || event.type === 'thinking') && previous?.type === event.type && (previous.data.role ?? 'assistant') === role) {
      previous.data.text = `${previous.data.text ?? ''}${data.text ?? ''}`;
      continue;
    }
    if ((event.type === 'tool_call' || event.type === 'tool_result') && data.id) {
      const existing = tools.get(String(data.id));
      if (!existing) {
        const terminal = /completed|failed|error|cancelled|rejected/.test(String(data.status ?? '').toLowerCase()) || event.type === 'tool_result';
        const entry = { type: event.type, data: { ...data, startedAt: data.startedAt ?? event.timestamp, ...(terminal ? { completedAt: data.completedAt ?? event.timestamp } : {}) }, timestamp: event.timestamp };
        tools.set(String(data.id), entry);
        result.push(entry);
        continue;
      }
      const incomingName = String(data.name ?? '').trim();
      const existingName = String(existing.data.name ?? '').trim();
      const incomingGeneric = !incomingName || /^(?:tool|tool call)$/i.test(incomingName);
      existing.type = event.type;
      existing.data = {
        ...existing.data,
        ...data,
        name: incomingGeneric ? existingName || incomingName || 'tool' : incomingName,
        input: data.input ?? existing.data.input,
        output: data.output ?? existing.data.output,
        startedAt: existing.data.startedAt ?? existing.timestamp,
        ...(/completed|failed|error|cancelled|rejected/.test(String(data.status ?? '').toLowerCase()) || event.type === 'tool_result' ? { completedAt: data.completedAt ?? event.timestamp } : {})
      };
      existing.timestamp = event.timestamp;
      continue;
    }
    if (event.type === 'permission_request' && data.id) {
      const permissionId = String(data.id);
      const existing = permissions.get(permissionId);
      if (existing) {
        existing.data = { ...existing.data, ...data };
        existing.timestamp = event.timestamp;
      } else {
        const entry = { type: event.type, data: { ...data }, timestamp: event.timestamp };
        permissions.set(permissionId, entry);
        result.push(entry);
      }
      continue;
    }
    result.push({ type: event.type, data: { ...data }, timestamp: event.timestamp });
  }
  return result;
}

export function eventsForRuntimeTask(events: AgentEvent[], taskId: string) {
  const start = events.findIndex(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === taskId);
  if (start < 0) return events;
  const endOffset = events.slice(start + 1).findIndex(event => {
    if (event.type !== 'task') return false;
    const task = (event.data as any)?.task;
    return task?.id === taskId && terminalTaskStates.has(task.status);
  });
  return events.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset);
}

export async function loadLarkTaskEvents(
  runtime: { getEvents?(id: string): Promise<AgentEvent[]>; getRecentEvents?(id: string, limit: number): Promise<AgentEvent[]> },
  sessionId: string, taskId: string, limit: number
) {
  if (!runtime.getRecentEvents) return eventsForRuntimeTask(await runtime.getEvents!(sessionId), taskId);
  // A long streamed answer can span more events than the trace window. Expand
  // until the task boundary is present so the result cannot lose its beginning.
  for (;;) {
    const events = await runtime.getRecentEvents(sessionId, limit);
    if (events.length < limit || events.some(event => event.type === 'text' && (event.data as any)?.role === 'user' && (event.data as any)?.taskId === taskId)) {
      return eventsForRuntimeTask(events, taskId);
    }
    limit *= 2;
  }
}

const fenced = (value: unknown) => {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `\n\n\`\`\`text\n${text.replaceAll('```', '``\\`')}\n\`\`\``;
};

const truncate = (value: unknown, limit: number) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n…（内容过长，已截断）`;
};
const redactTraceValue = (value: unknown, seen = new WeakSet<object>(), depth = 0): unknown => {
  if (typeof value === 'string') return redactTraceText(value);
  if (!value || typeof value !== 'object') return value;
  if (depth >= 12) return '[REDACTED: nested value]';
  if (seen.has(value)) return '[REDACTED: circular value]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactTraceValue(item, seen, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    sensitiveTraceKey.test(key) ? '[REDACTED]' : redactTraceValue(item, seen, depth + 1)
  ]));
};

const truncateTrace = (value: unknown, limit: number) => truncate(redactTraceValue(value), limit);

// 值自己就能说清自己是什么的字段。命令、路径、URL 裸着放也不会被读错，
// 其余字段名必须留着：`{cwd:'/srv/repo'}` 去掉 cwd 之后就成了「执行了 /srv/repo」，
// 与事实相反。toolPresentation 判断标题是否已覆盖输入时用的也是这一份。
const selfEvidentInputKeys = new Set(['command', 'cmd', 'path', 'file_path', 'url', 'href']);

// JSON.stringify 把值里的换行写成字面 `\n`：一段 20 行的 python heredoc 会挤成一行带
// `\n` 的长字符串，读者得在脑子里反转义一遍才能看懂自己刚跑过的脚本。JSON 在这里唯一
// 的作用是标注字段名，不该拿值的可读性去换。自解释的单字段直接给值，其余保留字段名，
// 多行的值原样成段。
const readableInput = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value, null, 2) ?? '';
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return '';
  const [soleKey, soleValue] = entries[0]!;
  if (entries.length === 1 && typeof soleValue === 'string' && selfEvidentInputKeys.has(soleKey)) return soleValue;
  return entries.map(([key, item]) => typeof item === 'string'
    ? (item.includes('\n') ? `${key}:\n${item}` : `${key}: ${item}`)
    : `${key}: ${JSON.stringify(item)}`).join('\n');
};
const truncateInline = (value: string, limit = 64) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
};

// CLI 命令常以一串环境变量赋值开头（`FOO=1 BAR=2 真正的命令 …`）。标题只有 64 个字符，
// 两三个 NO_UPDATE_NOTIFIER 之类的开关就能把它占满：真实会话里三条不同的 lark-cli 调用
// 渲染出了三行一模一样的标题，真正的子命令一个字都没露出来。前缀对读者没有可操作性，
// 标题从第一个真实命令词开始；完整命令仍由展开区的「完整内容」保留。
// 只认全大写的名字。环境变量名按惯例大写，而小写的 `key=value` 多半是日志字段：
// `level=error msg=数据库连接失败 retry=3` 按大小写不敏感的规则会被剥成 `retry=3`，
// 标题于是指向一件没发生的事。
const stripEnvAssignments = (value: string) =>
  value.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)[ \t]+)+/, '');

// raw_terminal 有两种形态，合并只对第一种成立：
//   · pty-driver 每 200ms 发一帧整屏快照（driver.ts:713），相邻帧大面积重叠；
//   · transports 的 stdio stderr 逐行发（transports/src/index.ts:32），每条就是一行增量。
// 对第一种直接首尾相接等于把同一屏抄几十遍——真实会话里终端行重复率 88–90%，出现最多
// 的那一行被抄了 1778 次。对第二种做重叠合并则会吞掉内容：连着两行相同的
// `npm warn deprecated foo@1.0.0` 会被当成重复帧，只剩一行。
// 用行数区分：整屏快照必然多行，逐行增量必然单行，单行条目一律原样追加。
//
// 重叠从长到短试：终端滚动一行时新帧与尾部有 rows-1 行重叠，取最长的才不会把整屏重新
// 追加一遍。已知取舍——内容高度周期性（例如「失败/重试」两行循环）且每帧滚动量整除该周期
// 时，贪心会匹配到比真实滚动更长的重叠，把中间几轮折叠掉。失败方向是少显示重复行，
// 不会拼出不存在的内容，完整记录在 Dutydeck Web。
const mergeTerminalFrames = (frames: string[]) => {
  const output: string[] = [];
  for (const frame of frames) {
    const lines = frame.split('\n');
    if (lines.length < 2) { output.push(...lines); continue; }
    let overlap = Math.min(lines.length, output.length);
    while (overlap > 0) {
      let same = true;
      for (let index = 0; index < overlap; index++) {
        if (output[output.length - overlap + index] !== lines[index]) { same = false; break; }
      }
      if (same) break;
      overlap--;
    }
    output.push(...lines.slice(overlap));
  }
  return output.join('\n');
};

// TUI 把自己的界面装饰画在屏幕上，快照就把装饰一并收下：底部的模式状态栏、
// 「Thought for 2s (ctrl+o to expand)」这类折叠占位、转圈动画帧和它带的 token 计数。
// 它们每帧都在变（所以躲得过 driver 那道「屏幕文本没变就不发」的闸），对读者却是零信息量
// ——真实会话里这类行占终端全部非空行的 43%。去掉它们剩下的才是命令与输出。
// 每条都要窄到只认 TUI 自己画的那一行。这些规则作用在 agent 的真实输出上，宽一分就会
// 吃掉别人的日志：只匹配 `esc to interrupt` 的话，一句「press esc to interrupt the run」
// 的 README 摘录会整行消失；只匹配 `(ctrl+? to expand)` 结尾的话，`Compiled main.ts
// (ctrl+c to expand)` 这种真实编译输出会被当成折叠占位。
const terminalChromePattern = new RegExp([
  // 底部模式状态栏，形如
  // `⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents`。
  // 要求任意两个特征词同现，单独引用其中一句的正常输出因此不受影响。
  '^(?=(?:.*(?:esc to interrupt|shift\\+tab to cycle|bypass permissions|for agents)){2}).*$',
  // 折叠占位行，只有这两种形态：`Thought for 2s (ctrl+o to expand)`、`… +23 lines (…)`。
  '^\\s*(?:Thought for \\d+[smh]|…\\s*\\+\\d+ lines?)\\b.*\\(ctrl\\+[a-z] to (?:expand|toggle)\\)\\s*$',
  // 转圈动画帧：`✻ Seasoning… (2s · ⚒ 1.6k tokens)`。后面那个耗时括号是必需的——
  // 少了它，`* Building…`、`· 正在同步…` 这类真实进度行会一起被吃掉。
  '^\\s*[✢✳✶✻✽]\\s+\\S+…\\s*\\(\\d+[smh]',
  // Claude Code 的随机提示行：`⎿  Tip: Use /memory …`
  '^\\s*⎿\\s*Tip:'
].join('|'));
const stripTerminalChrome = (text: string) => text.split('\n')
  .filter(line => !terminalChromePattern.test(line)).join('\n');
// 耗时只在「值得注意」时才占用标题里的一段位置。毫秒级和一两秒的步骤是绝大多数，
// 读者不会因为一条 1ms 改变任何判断，但每一条都会挤掉真正要读的命令。
const notableElapsedMs = 3_000;
const traceElapsed = (startedAt?: string, completedAt?: string) => {
  if (!startedAt) return '';
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const milliseconds = end - start;
  if (milliseconds < notableElapsedMs) return '';
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
};
const escapeCardInline = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const firstValue = (value: unknown, keys: string[]): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(record)) {
    const nested = firstValue(candidate, keys);
    if (nested) return nested;
  }
  return undefined;
};

const toolIcon = (kind: TraceToolKind) => ({
  command: 'command_outlined',
  read: 'file-link-text_outlined',
  edit: 'edit_outlined',
  search: 'search_outlined',
  web: 'web-card_outlined',
  git: 'code_outlined',
  test: 'doc-checklist_outlined',
  data: 'data-sheet_outlined',
  agent: 'robot_outlined',
  tool: 'setting_outlined'
}[kind]);

const toolPresentation = (entry: TraceEntry) => {
  const data = entry.data;
  const name = String(data.name ?? data.title ?? '').trim() || '工具';
  const normalized = name.toLowerCase();
  const command = typeof data.input === 'string' ? data.input.trim() : firstValue(data.input, ['command', 'cmd']);
  const url = firstValue(data.input, ['url', 'href']);
  const path = firstValue(data.input, ['path', 'file_path', 'cwd']);
  const description = firstValue(data.input, ['description']) ?? (typeof data.description === 'string' ? data.description.trim() : undefined);
  let action = /^(?:tool|tool call)$/i.test(name) ? '工具调用' : name;
  let kind: TraceToolKind = 'tool';
  // 分类只看命令的第一段管道。`lark-cli im +chat-messages-list --help 2>&1 | head -60`
  // 这一步做的是查参数说明，末尾的 head 只是把输出截短；按整条命令匹配时那个 head 会把
  // 它判成「读取文件」，于是图标和分类名一起指向一件没发生的事。
  const haystack = `${normalized} ${stripEnvAssignments(command ?? '').split('|')[0] ?? ''}`;
  if (/\b(?:apply_patch|patch|edit|write|replace|create_file)\b/.test(haystack)) { action = '修改文件'; kind = 'edit'; }
  else if (/\b(?:read|cat|head|tail|sed\s+-n|open_file)\b/.test(haystack)) { action = '读取文件'; kind = 'read'; }
  else if (/\b(?:rg|grep|find|search|glob|query)\b/.test(haystack)) { action = '搜索内容'; kind = 'search'; }
  else if (url || /\b(?:browser|web|fetch|curl|wget|open_url)\b/.test(haystack)) { action = '访问网页'; kind = 'web'; }
  else if (/\bgit\b/.test(haystack)) { action = 'Git 操作'; kind = 'git'; }
  else if (/\b(?:vitest|jest|pytest|go\s+test|pnpm\s+test|npm\s+test|yarn\s+test)\b/.test(haystack)) { action = '运行测试'; kind = 'test'; }
  else if (/\b(?:sqlite|sql|database|postgres|mysql)\b/.test(haystack)) { action = '查询数据'; kind = 'data'; }
  else if (/\b(?:agent|spawn|delegate|group\s+(?:self|peers|messages|send|wait))\b/.test(haystack)) { action = 'Agent 协作'; kind = 'agent'; }
  else if (command || /shell|bash|terminal|exec|command/.test(normalized)) { action = '运行命令'; kind = 'command'; }
  // 文件路径留最后两段：`/home/user/.claude/skills/lark-shared/SKILL.md` 前面那几层目录
  // 对聊天里的读者没有可操作性，却占掉标题一大半，把文件名挤到截断线外。留两段而不是
  // 只留文件名，是因为 `SKILL.md`、`index.ts` 这类名字在一个仓库里能有几十份，
  // 上一层目录往往正是区分它们的那一段。完整路径仍由展开区的输入保留。
  // 只削文件，不削目录——cwd 的最后一段是它唯一的内容，削成 `repo` 就什么都没剩下。
  const filePath = firstValue(data.input, ['path', 'file_path']);
  const shortPath = path && path === filePath
    ? path.split('/').filter(Boolean).slice(-2).join('/') || path
    : path;
  const fullDetail = redactTraceText(command ?? url ?? shortPath ?? (/^(?:tool|tool call)$/i.test(name) ? '' : name));
  const detail = truncateInline(stripEnvAssignments(fullDetail));
  // 标题已经完整展示了唯一的输入字段时，展开区里的「输入」只是把同一条内容再用
  // JSON 包一层：三行括号讲一件标题上已经写着的事。只有输入里还有标题没覆盖的字段，
  // 或标题被截断（fullDetail !== detail）时，展开才有内容可看。
  //
  // 字段名必须在白名单内，因为隐藏输入会连字段名一起隐藏。cwd 就是反例：
  // `{cwd:'/srv/repo'}` 的标题是「运行命令 /srv/repo」，把工作目录读成了被执行的命令，
  // 此时那层 JSON 是唯一能说清「这是 cwd」的东西，不能省。
  const inputEntries = data.input && typeof data.input === 'object' && !Array.isArray(data.input)
    ? Object.entries(data.input as Record<string, unknown>)
    : [];
  const soleEntry = inputEntries.length === 1 ? inputEntries[0]! : undefined;
  const titleCoversInput = Boolean(fullDetail) && fullDetail === detail && (
    typeof data.input === 'string'
      ? redactTraceText(data.input.trim()) === fullDetail
      : Boolean(soleEntry) && selfEvidentInputKeys.has(soleEntry![0])
        && typeof soleEntry![1] === 'string' && redactTraceText((soleEntry![1] as string).trim()) === fullDetail
  );
  // 判定必须落在 fullDetail 实际取到的那个值上，不能各查各的：firstValue 先扫顶层再递归，
  // `{cwd:'/srv/repo', args:{file_path:'a.ts'}}` 会让 path 取到 cwd、而独立查一次
  // ['path','file_path'] 递归到 a.ts 判成 true，标题就退化成一个裸的 /srv/repo。
  const selfEvidentDetail = Boolean(command || url || (path && path === firstValue(data.input, ['path', 'file_path'])));
  const status = String(data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')).toLowerCase();
  const failed = /fail|error|reject|cancel/.test(status);
  const running = /running|pending|started|in_progress/.test(status);
  return {
    kind,
    action: redactTraceText(action),
    description: description ? redactTraceText(description) : description,
    detail,
    statusLabel: failed ? '失败' : running ? '执行中' : '已完成',
    statusColor: failed ? 'yellow' : running ? 'orange' : 'green',
    indicatorColor: failed ? 'trace_failure' : running ? 'trace_running' : 'trace_success',
    elapsed: traceElapsed(data.startedAt ?? entry.timestamp, running ? undefined : data.completedAt ?? entry.timestamp),
    selfEvidentDetail,
    fullDetail,
    titleCoversInput,
    // 顺序不能反：redactTraceValue 里那条「字段名命中就整值替换」的规则（sensitiveTraceKey）
    // 只在对象形态下生效。先拍成文本再脱敏的话，它就退化成纯文本正则——而文本正则的值形状
    // 停在第一个空白或逗号处，`{password:'S3cret Pass Phrase'}` 会漏出 `Pass Phrase`，
    // 数组形态的 `{access_token:[...]}` 会漏掉除第一个以外的全部元素。
    input: truncate(readableInput(redactTraceValue(data.input)), 250),
    output: truncateTrace(data.output, 450)
  };
};

type ToolPresentation = ReturnType<typeof toolPresentation>;

// 一句话说清这一步在做什么：工具自带的描述优先，其次是自解释的命令/路径，最后才是分类名。
// 与 toolPanel 的标题同一套取舍，只是不转义——调用方各自按落点转义。
const toolHeadline = (tool: ToolPresentation) => tool.description
  || (tool.selfEvidentDetail ? tool.detail : '')
  || tool.action;

const toolKindLabel: Record<TraceToolKind, string> = {
  command: '命令', read: '读文件', edit: '改文件', search: '搜索', web: '网页',
  git: 'Git', test: '测试', data: '数据', agent: '协作', tool: '工具'
};

// 标题整行加粗；文本自带 * 时不包，免得和它自己的 Markdown 拼出一串字面星号。
const strong = (markdown: string) => markdown.includes('*') ? markdown : `**${markdown}**`;

export const hasUnresolvedToolCalls = (events: AgentEvent[]) => compactTraceEntries(events).some(entry =>
  (entry.type === 'tool_call' || entry.type === 'tool_result') && toolPresentation(entry).statusLabel === '执行中'
);

type StageRecord = { kind: 'tool'; entry: TraceEntry } | { kind: 'terminal'; entries: TraceEntry[]; text: string };

// 终端回显不是工具调用。把每一条 raw_terminal 都套成工具，会得到一排完全相同、
// 零信息量的「运行命令 · terminal」标题，真正的输出反而被压进折叠层——一次翻页拉取
// 就是 18 个同名面板。连续回显合并成一段终端输出，由一个折叠面板承载全部内容。
const stageRecords = (actions: TraceEntry[], keepScreenFallback = false): StageRecord[] => {
  const records: StageRecord[] = [];
  // 屏幕流是兜底，不是第二份执行记录。pty-driver 同时发两路：transcript 解析出的
  // 结构化 tool_call/tool_result，和「永不丢」的整屏快照（driver.ts:42-48）。两路讲的是
  // 同一批事实——一次 Bash 调用，结构化那份是命令加结果两行，屏幕那份是几十帧带 TUI
  // 边框的重绘。同一个阶段里两者都在时只留结构化的那份；阶段里一个工具记录都没有
  // （transcript 缺席或中途断开）时仍然渲染屏幕流，否则那个阶段会变成一片空白。
  const hasStructuredTools = actions.some(entry => entry.type === 'tool_call' || entry.type === 'tool_result');
  // 例外：任务已经收尾，工具却还停在「执行中」——结果永远不会来了。CLI 崩了、卡在交互
  // 授权、鉴权失败都是这个形状，而结构化记录此时只有一行「执行中」，一个字的原因都没有。
  // 屏幕上那几行是唯一说得清原因的东西，这时必须留。运行态不走这条：那时「还没拿到结果」
  // 是正常的，留下屏幕流就等于把 TUI 录像原样搬回卡片。
  const awaitingResultForever = keepScreenFallback && actions.some(entry =>
    (entry.type === 'tool_call' || entry.type === 'tool_result')
    && toolPresentation(entry).statusLabel === '执行中');
  for (const entry of actions) {
    if (entry.type === 'raw_terminal') {
      if (hasStructuredTools && !awaitingResultForever) continue;
      // PTY 每吐一个提示符就是一条纯空白回显。它们不值得占一个面板，也不该被算进条数。
      if (!String(entry.data.text ?? '').trim()) continue;
      const last = records.at(-1);
      if (last?.kind === 'terminal') last.entries.push(entry);
      else records.push({ kind: 'terminal', entries: [entry], text: '' });
      continue;
    }
    if (entry.type === 'tool_call' || entry.type === 'tool_result') records.push({ kind: 'tool', entry });
  }
  // 合并、脱敏和去装饰都在这里做完，面板只负责显示。整屏快照里可能一行正文都没有
  // （一屏全是状态栏和转圈动画），那样的记录不能留下一个点开是空的折叠箭头。
  //
  // 拼完再脱敏，不能逐条脱敏后拼接：stderr 是逐行发事件的，一份多行私钥必然被切成多条，
  // 逐条脱敏时只有带 BEGIN 标记的那条被替换，密钥体所在的几条一个规则都不命中，会原样
  // 进群消息。代价是一条含 BEGIN 字样、又没等到 END 的输出会把后面的内容一起吞成
  // [REDACTED_PRIVATE_KEY]——宁可让读者去 Web 看全文，不能漏密钥。
  return records.filter(record => {
    if (record.kind !== 'terminal') return true;
    // 先滤装饰再合并，顺序不能反：破坏帧间重叠的正是那几行每帧都在变的装饰（转圈动画、
    // 带秒数的状态栏）。它们留在帧里时，新帧与尾部的重叠会掉到 0，整屏被原样再追加一遍
    // ——合并等于没做。实测同一块屏幕的 5 帧，先合并后滤会让正文重复 5 次。
    record.text = redactTraceText(mergeTerminalFrames(
      record.entries.map(entry => stripTerminalChrome(String(entry.data.text ?? '')))
    )).trim();
    return Boolean(record.text);
  });
};

// 头尾都要保留：命令回显和第一条报错在开头，当前进度在结尾，中间是翻页噪声。
// 只留尾部会让「FAIL src/critical.test.ts」这类只出现一次的关键行彻底消失。
const terminalHeadLimit = 300;
const terminalTailLimit = 600;
// 被掐掉的中间段里，报错行和翻页噪声不等权：一整屏 PASS 里那一行 FAIL 是读者
// 唯一要读的东西，按字符位置一起丢掉，卡上就只剩「1 failed」而看不到失败在哪。
const terminalAlertPattern = /(?:\bFAIL(?:ED)?\b|\bERROR\b|\bTraceback\b|\bpanic:|error:)/i;
const terminalAlertLimit = 5;
const clipTerminalText = (text: string) => {
  if (text.length <= terminalHeadLimit + terminalTailLimit) return text;
  const middle = text.slice(terminalHeadLimit, text.length - terminalTailLimit);
  const alerts = middle.split('\n').map(line => line.trim())
    .filter(line => terminalAlertPattern.test(line)).slice(0, terminalAlertLimit);
  const notice = alerts.length
    ? `…（已省略中间 ${middle.length} 个字符，其中的报错行保留如下）`
    : `…（已省略中间 ${middle.length} 个字符）`;
  return [text.slice(0, terminalHeadLimit), notice, ...alerts, text.slice(-terminalTailLimit)].join('\n');
};
const terminalPanel = (record: Extract<StageRecord, { kind: 'terminal' }>, index: string | number, margin = '0px 0px 0px 20px'): LarkCardElement => {
  const clipped = clipTerminalText(record.text);
  return {
    tag: 'collapsible_panel', element_id: `trace_tool_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin,
    header: {
      title: {
        tag: 'markdown',
        // 不写条数：合并去重之后它与面板里实际有多少内容再无关系。40 帧同一块屏幕会
        // 合并成几行，标题却写着「40 条」，读者会以为剩下的被省略了。
        content: '终端输出',
        text_size: 'notation',
        icon: { tag: 'standard_icon', token: toolIcon('command'), color: 'grey' }
      },
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: [{ tag: 'markdown', content: `\`\`\`text\n${clipped.replaceAll('```', '``\\`')}\n\`\`\``, text_size: 'notation', margin: '0px' }]
  };
};

const stageRecordPanel = (record: StageRecord, index: string | number, margin = '0px 0px 0px 20px'): LarkCardElement =>
  record.kind === 'terminal' ? terminalPanel(record, index, margin) : toolPanel(record.entry, index, margin);

const toolPanel = (entry: TraceEntry, index: string | number, margin = '0px 0px 0px 20px'): LarkCardElement => {
  const tool = toolPresentation(entry);
  // 标题写这一步实际做的事：优先用工具自带的描述，其次用命令、URL 或文件路径这类
  // 自己就能说清自己的值。分类名（「运行命令」「搜索内容」）退到兜底位置——左边的图标
  // 已经表达了分类，再用四个汉字复述一遍，只会把唯一有信息量的那段挤到后半行。
  //
  // 只有自解释的值才能独占标题。cwd 是反例：它和 file_path 会被归并成同一个 detail，
  // 但语义相反，裸着放进标题时 `{cwd:'/srv/repo'}` 会被读成「执行了 /srv/repo」，
  // 此时「运行命令」这四个字正是唯一能说清那是工作目录的东西。
  const description = tool.description ? escapeCardInline(truncateInline(tool.description, 72)) : '';
  const detail = escapeCardInline(tool.detail || '');
  const headline = description
    || (tool.selfEvidentDetail ? detail : '')
    || escapeCardInline(truncateInline(tool.action, 72));
  // 描述已经用人话说清这一步在做什么，后面再拼一段命令只是把同一件事用机器语言重讲，
  // 而它通常比描述长得多——标题被撑成两行，真正要读的那半句反倒退到第一行末尾。
  // 命令不会丢：它就在展开区的输入里。没有描述时命令仍要留在标题上，那时它是唯一线索。
  const detailSuffix = detail && detail !== headline && !description ? `　<font color='grey'>${detail}</font>` : '';
  const elapsedSuffix = tool.elapsed ? `　<font color='grey'>${tool.elapsed}</font>` : '';
  // 成功是默认预期。每条都点一个绿灯，等于把「没有异常」重复 N 遍，
  // 还会让真正需要人看的那一个失败灯淹在同色的一排里。只有失败和执行中值得占这个位置。
  const stateLamp = tool.indicatorColor === 'trace_success' ? '' : `<font color='${tool.indicatorColor}'>●</font>　`;
  // 零参工具的 input 会被序列化成 `{}`，那是个真值但没有内容——展开只会看到一对括号。
  // titleCoversInput 的前提是「标题上写的就是那个唯一的输入字段」。description 占了标题
  // 时这个前提不成立，必须把输入放出来——否则 `{command:'pnpm install'}` 配一句「安装依赖」
  // 会让命令既不在标题也不在展开区，上面那句「命令就在展开区的输入里」会落空。
  const showInput = Boolean(tool.input) && !['{}', '[]'].includes(tool.input)
    && (!tool.titleCoversInput || Boolean(description));
  const parts: Array<{ label: string; text: string }> = [];
  // 标题被截断且没有输入区兜底时，展开区必须还能拿到完整命令。
  if (tool.fullDetail && tool.fullDetail !== tool.detail && !showInput) parts.push({ label: '完整内容', text: tool.fullDetail });
  if (showInput) parts.push({ label: '输入', text: tool.input });
  if (tool.output) parts.push({ label: '结果', text: tool.output });
  // 只有一段内容时省掉标签：面板标题已经说明这是哪个工具，一个「结果」字样只多占一行。
  const sections = parts.map(part => {
    const fenced = `\`\`\`text\n${part.text.replaceAll('```', '``\\`')}\n\`\`\``;
    return parts.length > 1 ? `${part.label}\n\n${fenced}` : fenced;
  });
  const title = {
    tag: 'markdown',
    content: `${stateLamp}${headline}${detailSuffix}${elapsedSuffix}`,
    text_size: 'notation',
    icon: { tag: 'standard_icon', token: toolIcon(tool.kind), color: 'grey' }
  };
  // 没有可展开内容时不给折叠面板：一个点开只显示「暂无内容」的箭头是空承诺。
  // 正在执行、还没拿到结果的工具本来就只有标题这一行信息，直接平铺即可。
  if (!sections.length) return { ...title, element_id: `trace_tool_${index}`, margin };
  return {
    tag: 'collapsible_panel', element_id: `trace_tool_${index}`, expanded: false,
    direction: 'vertical', vertical_spacing: '4px', padding: '4px 0px 0px 0px', margin,
    header: {
      title,
      vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '12px 12px' },
      icon_position: 'right', icon_expanded_angle: -180
    },
    elements: sections.map(content => ({ tag: 'markdown', content, text_size: 'notation', margin: '0px' }))
  };
};

const traceGroups = (entries: TraceEntry[]): TraceGroup[] => {
  const groups: TraceGroup[] = [];
  let narratives: TraceEntry[] = [];
  let actions: TraceEntry[] = [];
  const flush = () => {
    if (narratives.length || actions.length) groups.push({ narratives, actions });
    narratives = [];
    actions = [];
  };
  for (const entry of entries) {
    if (entry.type === 'thinking' || entry.type === 'text') {
      if (actions.length) flush();
      narratives.push(entry);
      continue;
    }
    actions.push(entry);
  }
  flush();
  return groups;
};

const historyGroupPanel = (
  group: TraceGroup,
  index: number,
  showElapsed = false,
  expanded = false,
  keepScreenFallback = false,
  compact = false
): LarkCardElement => {
  const records = stageRecords(group.actions, keepScreenFallback);
  const tools = records.flatMap(record => record.kind === 'tool' ? [record.entry] : []);
  const statuses = tools.map(entry => toolPresentation(entry));
  const failedCount = statuses.filter(item => item.statusLabel === '失败').length;
  const succeededCount = statuses.filter(item => item.statusLabel === '已完成').length;
  const runningCount = statuses.filter(item => item.statusLabel === '执行中').length;
  const hasFailed = failedCount > 0;
  const status = hasFailed && succeededCount > 0
    ? { label: '有失败', color: 'trace_failure' }
    : hasFailed
      ? { label: '失败', color: 'trace_failure' }
      : runningCount > 0 ? { label: '执行中', color: 'trace_running' }
      : { label: '已完成', color: 'green' };

  const assistantNarrative = [...group.narratives].reverse().find(entry => entry.type === 'text');
  const narrativeText = assistantNarrative?.data.text ? redactTraceText(String(assistantNarrative.data.text)).trim() : '';

  const primaryTool = statuses[0];
  // 阶段标题是收起态唯一露出来的一行，它要回答的是「这一步在干什么」，不是「敲了什么命令」。
  // Agent 自己的旁白最好，其次是工具自带的描述——真实会话里 86–94% 的工具调用都带着一句
  // 中文描述（「拉取群内 9月8日以来的全部消息」），此前却一直被跳过，标题退化成
  // 「读取文件 · lark-cli im +chat-messages-list --chat-id oc_f34138…」：分类名重复了左边的
  // 图标，命令被截断在参数中间，三个不同的阶段因此渲染出三行几乎一样的标题。
  // 命令留在展开区，那里才是查细节的地方。
  const mainTitle = narrativeText
    || primaryTool?.description
    || (primaryTool ? `${primaryTool.action}${primaryTool.selfEvidentDetail && primaryTool.detail ? ` · ${primaryTool.detail}` : ''}` : '')
    || (records.some(record => record.kind === 'terminal') ? '终端输出' : '')
    || (group.narratives.some(e => e.type === 'thinking') ? '分析与规划' : '执行过程');

  const first = group.narratives[0] ?? group.actions[0];
  const last = group.actions.at(-1) ?? group.narratives.at(-1);
  const elapsed = showElapsed ? traceElapsed(first?.data.startedAt ?? first?.timestamp, last?.data.completedAt ?? last?.timestamp) : '';

  const preview = escapeCardInline(truncateInline(mainTitle, 92));
  const elapsedSuffix = elapsed ? `　<font color='grey'>${elapsed}</font>` : '';
  // 成功是默认预期，不需要标注。一次顺利的执行会有五个阶段，五个绿点「已完成」
  // 只是在重复「没有异常」这件事，同时把失败的那一个淹掉。
  const stateSuffix = status.label === '已完成' ? '' : `　<font color='${status.color}'>● ${status.label}</font>`;
  const headerTitle = `${preview}${elapsedSuffix}${stateSuffix}`;

  // 精简模式：阶段只留一行，不渲染任何工具/终端面板。左边的图标说明这个阶段结束了没有、
  // 是不是整段失败，耗时单独一列靠右，旁白长了折行也不会把耗时挤到下一行开头。
  // 部分步骤失败（通常是失败后重试成功）仍按原样标「有失败」：图标只区分「整段失败」。
  if (compact) {
    const allFailed = hasFailed && succeededCount === 0 && runningCount === 0;
    const suffix = status.label === '有失败' || status.label === '执行中' ? stateSuffix : '';
    return {
      tag: 'column_set', element_id: `trace_group_${index}`, flex_mode: 'none', horizontal_spacing: '8px', margin: '0px',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top', elements: [{
          tag: 'markdown', content: `${preview}${suffix}`, text_size: 'notation', margin: '0px',
          icon: allFailed
            ? { tag: 'standard_icon', token: 'close_outlined', color: 'red' }
            : { tag: 'standard_icon', token: 'done_outlined', color: 'grey' }
        }] },
        ...(elapsed ? [{ tag: 'column', width: 'auto', vertical_align: 'top', elements: [
          { tag: 'markdown', content: `<font color='grey'>${elapsed}</font>`, text_size: 'notation', margin: '0px' }
        ] }] : [])
      ]
    };
  }

  let actionElements: LarkCardElement[] = [];
  // 单条记录（一个工具、或一段合并后的终端输出）直接摊平：阶段本身已经是一层折叠，
  // 再套一层意味着读者要点三次才能看到内容。
  if (records.length === 1) {
    const panel = stageRecordPanel(records[0]!, `${index}_0`, '0px');
    // 无内容的工具已经是一行纯文本，没有 header/elements 可以摊平。
    actionElements = panel.tag === 'collapsible_panel' ? [{
      tag: 'interactive_container',
      element_id: panel.element_id,
      behaviors: [],
      has_border: false,
      padding: '0px',
      margin: '0px',
      direction: 'vertical',
      vertical_spacing: '4px',
      elements: [
        panel.header.title,
        ...panel.elements
      ]
    }] : [panel];
  } else if (records.length) {
    actionElements = records.map((record, actionIndex) => stageRecordPanel(record, `${index}_${actionIndex}`));
  } else if (narrativeText) {
    actionElements = [{
      tag: 'markdown',
      content: escapeCardInline(truncateTrace(narrativeText, 1_500)),
      text_size: 'notation',
      margin: '0px'
    }];
  } else if (group.narratives.some(e => e.type === 'thinking')) {
    actionElements = [{
      tag: 'markdown',
      content: "<font color='grey'>内部分析已完成</font>",
      text_size: 'notation',
      margin: '0px'
    }];
  }

  // 一个阶段可能什么都没留下：纯空白终端回显被跳过，又没有叙述或思考。
  // 折叠面板在这种时候只是一个点开是空的箭头，直接退化成标题行。
  if (!actionElements.length) {
    return { tag: 'markdown', element_id: `trace_group_${index}`, content: headerTitle, text_size: 'notation', margin: '0px' };
  }

  return {
    tag: 'collapsible_panel',
    element_id: `trace_group_${index}`,
    expanded,
    direction: 'vertical',
    vertical_spacing: '2px',
    padding: '2px 0px 0px 0px',
    margin: '0px',
    header: {
      title: { tag: 'markdown', content: headerTitle, text_size: 'notation' },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '14px 14px' },
      icon_position: 'right',
      icon_expanded_angle: -180
    },
    elements: actionElements
  };
};

const currentRunningStagePanel = (group: TraceGroup, index: number, showFallbackTitle = true, compact = false): LarkCardElement => {
  const records = stageRecords(group.actions);
  const tools = records.flatMap(record => record.kind === 'tool' ? [record.entry] : []);
  const assistantNarrative = [...group.narratives].reverse().find(entry => entry.type === 'text');
  const narrativeText = assistantNarrative?.data.text ? redactTraceText(String(assistantNarrative.data.text)).trim() : '';

  const toolPresentations = tools.map(toolPresentation);
  const primaryTool = toolPresentations[0];

  // 精简模式下旁白截断放宽到 200：工具行不再展示，旁白是这一阶段唯一的可读信息。
  const narrativeLimit = compact ? 200 : 92;
  // 没有旁白时用工具自带的描述，再没有才落到分类名。detail 不参与：它就是紧挨着的那行
  // 工具摘要的内容，再拼一次等于同一条命令连着出现两行。
  const currentTitle = narrativeText
    ? truncateInline(narrativeText, narrativeLimit)
    : (primaryTool?.description ? truncateInline(primaryTool.description, 92)
      : primaryTool ? primaryTool.action : '正在执行…');

  const failedCount = toolPresentations.filter(item => item.statusLabel === '失败').length;
  const succeededCount = toolPresentations.filter(item => item.statusLabel === '已完成').length;
  const hasFailed = failedCount > 0;
  const stageStatus = hasFailed && succeededCount > 0
    ? { label: '有失败', color: 'trace_failure' }
    : hasFailed
      ? { label: '失败', color: 'trace_failure' }
      : toolPresentations.some(item => item.statusLabel === '执行中') ? { label: '执行中', color: 'trace_running' }
      : { label: '已完成', color: 'green' };

  const statusSuffix = hasFailed
    ? `　<font color='${stageStatus.color}'>● ${stageStatus.label}</font>`
    : '';

  const elements: LarkCardElement[] = [];
  if (compact) {
    // 精简模式不展开工具，当前阶段回答三件事：这一阶段在做什么（旁白）、此刻在做哪一步
    // （最新一个工具的描述）、到目前为止做了哪些事（按类型计数）。真实任务里一个阶段常常
    // 连跑几十次工具，只有旁白和总数时，这块在整个阶段里一动不动，看起来像卡住了。
    // 没有旁白时标题直接用最新一步——取第一步同样会让标题定格。
    const latest = toolPresentations.at(-1);
    const latestHeadline = latest ? toolHeadline(latest) : '';
    const title = narrativeText
      ? truncateInline(narrativeText, narrativeLimit)
      : latestHeadline ? truncateInline(latestHeadline, 92) : '正在执行…';
    const first = group.narratives[0] ?? group.actions[0];
    const elapsed = traceElapsed(first?.data.startedAt ?? first?.timestamp);
    // 图标由 service 按卡片状态换成加载动图或等待标识；这里放的是没有动图时的兜底。
    elements.push({
      tag: 'column_set', element_id: 'current_head', flex_mode: 'none', horizontal_spacing: '8px', margin: '0px',
      columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top', elements: [{
          tag: 'markdown', element_id: 'current_title', content: strong(escapeCardInline(title)), text_size: 'normal', margin: '0px',
          icon: { tag: 'standard_icon', token: 'loading_outlined', color: 'blue' }
        }] },
        ...(elapsed ? [{ tag: 'column', width: 'auto', vertical_align: 'top', elements: [
          { tag: 'markdown', element_id: 'current_elapsed', content: `<font color='grey'>${elapsed}</font>`, text_size: 'notation', margin: '0px' }
        ] }] : [])
      ]
    });
    // 缩进与标题文字对齐（让出标题前的图标）。
    const indent = '0px 0px 0px 20px';
    if (narrativeText && latest) {
      const step = escapeCardInline(truncateInline(latestHeadline, 72));
      elements.push({
        tag: 'markdown', element_id: 'current_now', text_size: 'notation', margin: indent,
        content: latest.statusLabel === '失败'
          ? `<font color='red'>失败：${step}</font>`
          : `<font color='grey'>${latest.statusLabel === '执行中' ? '正在' : '最近一步'}：${step}</font>`
      });
    }
    // 终端回显不算步骤：它只是屏幕流，不是结构化工具调用。
    if (tools.length > 0) {
      const counts = new Map<string, number>();
      for (const tool of toolPresentations) counts.set(toolKindLabel[tool.kind], (counts.get(toolKindLabel[tool.kind]) ?? 0) + 1);
      const chips = [...counts].map(([label, count]) => `<text_tag color='neutral'>${label} ${count}</text_tag>`);
      if (failedCount > 0) chips.push(`<text_tag color='red'>失败 ${failedCount}</text_tag>`);
      elements.push({ tag: 'markdown', element_id: 'current_steps', content: chips.join(' '), text_size: 'notation', margin: indent });
    }
    return {
      tag: 'interactive_container',
      element_id: `trace_group_${index}`,
      behaviors: [],
      has_border: false,
      padding: '0px',
      margin: '0px',
      direction: 'vertical',
      vertical_spacing: '4px',
      elements
    };
  }
  const omitFallbackTitle = !showFallbackTitle && !narrativeText && !primaryTool && records.length > 0;
  if (!omitFallbackTitle) {
    elements.push({
      tag: 'markdown',
      element_id: 'current_title',
      // 「Agent 此刻在做什么」是运行态卡片的信息主体，用正文字号；
      // 用 notation 会让最该读的一行成为卡上最小的字。
      content: `${escapeCardInline(currentTitle)}${statusSuffix}`,
      text_size: 'normal',
      margin: '0px'
    });
  }

  for (let actionIndex = 0; actionIndex < records.length; actionIndex++) {
    elements.push(stageRecordPanel(records[actionIndex]!, `${index}_${actionIndex}`, '0px'));
  }

  return {
    tag: 'interactive_container',
    element_id: `trace_group_${index}`,
    behaviors: [],
    background_style: 'current_bg',
    has_border: false,
    corner_radius: '8px',
    padding: '8px 10px 8px 10px',
    margin: '0px',
    direction: 'vertical',
    vertical_spacing: '4px',
    elements
  };
};

// 失败卡上最该讲清的是失败在哪一步。任务事件里没有任务级的失败原因，这里能给的只有
// 执行记录里最后一个失败的步骤——它之后可能已经重试成功，所以标题写「最后失败的步骤」，
// 不写「失败原因」。报错行按终端的报错规则挑，挑不到就用输出的最后一行。
// service 只在失败卡上放这一块，其余终态丢弃。
const failureStepElement = (entry: TraceEntry): LarkCardElement => {
  const tool = toolPresentation(entry);
  const output = entry.data.output === undefined ? '' : typeof entry.data.output === 'string' ? entry.data.output : JSON.stringify(entry.data.output);
  const lines = redactTraceText(output).split('\n').map(line => line.trim()).filter(Boolean);
  const alertLine = [...lines].reverse().find(line => terminalAlertPattern.test(line));
  const errorLine = alertLine ?? lines.at(-1);
  const code = (text: string) => `\`${escapeCardInline(text).replaceAll('`', "'")}\``;
  const headline = toolHeadline(tool);
  const facts = [
    // 标题已经是这条命令/路径本身时不再重复一遍。
    tool.selfEvidentDetail && tool.detail && tool.detail !== headline ? code(tool.detail) : '',
    tool.elapsed,
    errorLine ? `${alertLine ? '报错' : '输出末行'} ${code(truncateInline(errorLine, 120))}` : ''
  ].filter(Boolean).join(' · ');
  return {
    tag: 'interactive_container', element_id: 'failure_step', behaviors: [], background_style: 'failure_bg',
    has_border: false, corner_radius: '8px', padding: '8px 10px 8px 10px', margin: '0px', direction: 'vertical', vertical_spacing: '2px',
    elements: [
      {
        tag: 'markdown', content: strong(`最后失败的步骤：${escapeCardInline(truncateInline(headline, 72))}`), text_size: 'normal', margin: '0px',
        icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'red' }
      },
      ...(facts ? [{ tag: 'markdown', content: facts, text_size: 'notation', margin: '0px 0px 0px 20px' }] : [])
    ]
  };
};

const traceOmissionElement = (omittedGroupCount: number, margin: string): LarkCardElement => ({
  tag: 'markdown', element_id: 'trace_omission',
  content: `<font color='grey'>另有 ${omittedGroupCount} 个更早阶段未展示。</font>`,
  text_size: 'notation', margin
});

// 待审批的卡上，读者只需要知道两件事：要批的是什么、去哪批。
// 这里原先在这两件事之前还压着一个「高风险待确认」标签和一行「任务已暂停，需要人工
// 确认」——连同卡片顶部的橙色色带和状态行里的「等待审批」，同一件事被说了四遍，
// 而真正要批的那个操作被挤到第三行。
//
// 剩下的只有「要批的是什么」。「去哪批」这一层说不准：带按钮的审批卡要 workflows 已装配
// 且 runtime 实现了 resolvePermission / getPendingPermissions 才会发出来
// （workflow-interactions.ts:110-113），Web 出口要配了 webBaseUrl 页脚才有，两个条件
// 渲染这一层都看不见。指一条可能不存在的路比不指更糟，所以 pending 不写指引。
const permissionAlert = (entry: TraceEntry, index: number): LarkCardElement => {
  const status = String(entry.data.status ?? 'pending').toLowerCase();
  const pending = /pending|waiting|requested/.test(status);
  const rejected = /reject|denied|blocked|cancel/.test(status);
  const title = truncateTrace(entry.data.title, 800) || 'Agent 请求执行受保护操作';
  // pending 不带标签：卡片顶部已经是橙色色带，状态行也已经写着「等待审批」，
  // 这里再挂一个「待审批」就是同一件事的第三遍，而它正好压在要批的那个操作前面。
  // 已拦截 / 已授权则必须自己说——那时任务状态行显示的是「执行中」，不是审批结果。
  const resolvedTag = pending ? '' : rejected
    ? "<text_tag color='red'>已拦截</text_tag>　"
    : "<text_tag color='green'>已授权</text_tag>　";
  // 已拦截是唯一需要指引的分支：它是终局，而且下一步与部署形态无关。
  const guidance = rejected && !pending ? '可调整指令后重试，或由有权限的成员重新发起。' : '';
  const visualStatus = pending ? 'pending' : rejected ? 'rejected' : 'resolved';
  return {
    tag: 'markdown', element_id: `risk_alert_${visualStatus}_${index}`,
    // title 是 agent 侧内容，可能自带 ** 或换行。用 ** 包住它，遇到「写入文件 **README.md**」
    // 会渲染出一串字面星号，遇到多行标题则加粗跨段落直接失效。这一行是块内唯一的正文，
    // 靠字号和它下面那行灰字指引就分得出层级，不需要再加粗。
    content: `${resolvedTag}${title}${guidance ? `\n\n<font color='grey'>${guidance}</font>` : ''}`,
    text_size: 'normal', margin: '6px 0px 8px 0px'
  };
};

// 失败已经由卡片顶部的红色色带和状态行说清楚了，这里再挂一个「执行异常」标签加一句
// 「需要关注」，是把同一件事说到第四遍，而且「需要关注」没有说明要关注什么。
// 这一行唯一值得占位置的是失败原因本身，图标承担「这是异常」的语义。
const errorAlert = (entry: TraceEntry, index: number): LarkCardElement => ({
  tag: 'markdown', element_id: `execution_alert_${index}`,
  // 兜底放在 truncateTrace 之后：`?? ` 挡不住空串，而 ACP 侧的 message 可以是空串
  // （acp-client/src/index.ts:124 的 `event.message ?? ...`，第三方 agent 回 `{"error":{"message":""}}` 即是），
  // truncateTrace 内部的 trim 又会把纯空白压成空串——两条路都会得到一个 content 为空的
  // markdown，正好出现在任务真的出错的时候。
  content: truncateTrace(entry.data.message, 1_500) || 'Agent 执行未完全成功',
  text_size: 'normal', margin: '6px 0px 8px 0px',
  icon: { tag: 'standard_icon', token: 'warning_outlined', color: 'red' }
});

export function renderLarkCardElements(
  events: AgentEvent[],
  config: Pick<StoredLarkConfig, 'traceLimit' | 'hideTraceOnComplete' | 'compactTrace'>,
  completed = false,
  compensation = false,
  /** 保留入参以免改动全部调用点；下一步提示移除后渲染不再按会话类型分叉。 */
  _chatType?: string,
  view: 'combined' | 'process' | 'result' = 'combined'
): LarkCardElement[] {
  const compact = config.compactTrace === true;
  const entries = compactTraceEntries(events);
  const lastIndex = (predicate: (entry: TraceEntry) => boolean) => {
    for (let index = entries.length - 1; index >= 0; index--) if (predicate(entries[index]!)) return index;
    return -1;
  };
  const finalMessageIndex = completed ? lastIndex(entry => entry.type === 'text' && entry.data.role !== 'user') : -1;
  // final 文本必须位于最后一次**活动**之后：工具调用前的阶段描述不得提升为 final_output，
  // 未决的 permission_request / error 也必须继续挡住提升。
  // raw_terminal 例外——它是屏幕回显，不是活动。PTY 形态的 Agent 给出最终答复之后，
  // 屏幕上必然还会再吐一个提示符；把它算作活动会让真实答复失去 final 资格，
  // 而 hideTraceOnComplete 默认隐去 trace，用户最终一个字都看不到。
  const lastActivityIndex = lastIndex(entry => entry.type !== 'text' && entry.type !== 'raw_terminal');
  const finalFollowsActivity = finalMessageIndex > lastActivityIndex;
  const finalMessage = finalMessageIndex >= 0 && finalFollowsActivity ? entries[finalMessageIndex] : undefined;
  const finalText = view === 'result' ? redactTraceText(String(finalMessage?.data.text ?? '')).trim() : truncateTrace(finalMessage?.data.text, 6_000);
  const activityEntries = entries.filter(entry => entry !== finalMessage || !finalFollowsActivity);
  const permissionEntries = activityEntries.filter(entry => entry.type === 'permission_request');
  const errorEntries = activityEntries.filter(entry => entry.type === 'error');
  const traceEntries = activityEntries.filter(entry => entry.type !== 'permission_request' && entry.type !== 'error');
  // 先全量分组，再只展示最近五组有效活动。traceLimit 控制上游取样/对账规模，
  // 不控制卡片视觉密度；否则默认 50 会把运行态重新变成日志墙。
  // 若在 entry 级别切片，滑动窗口可能切断 group 边界，导致 group 数量随新事件到来而跳变。
  // 按 group 级别裁剪后，卡片始终保留最近且完整的阶段。
  const allGroups = traceGroups(traceEntries);
  const groups = allGroups.slice(-visibleTraceGroupLimit);
  const omittedGroupCount = allGroups.length - groups.length;
  const elements: LarkCardElement[] = [];

  if (compensation) {
    elements.push({ tag: 'markdown', content: "<font color='orange'>原运行卡片未能更新，Dutydeck 已补发终态结果。</font>", text_size: 'notation', margin: '0px 0px 8px 0px' });
  }
  elements.push(...permissionEntries.map(permissionAlert));
  elements.push(...errorEntries.map(errorAlert));
  if (finalText && view !== 'process') {
    elements.push({ tag: 'markdown', element_id: 'final_output', content: completed ? finalText : `**当前进展**\n\n${finalText}`, text_align: 'left', text_size: 'normal_v2', margin: '0px' });
  } else if (completed && view !== 'process' && errorEntries.length === 0) {
    elements.push({ tag: 'markdown', element_id: 'result_missing', content: "<text_tag color='orange'>结果不完整</text_tag>　Agent 未返回最终输出，可直接要求 Agent 总结本轮结论。", text_size: 'normal', margin: '4px 0px' });
  }

  if (view === 'result') return elements;

  // 全部阶段的步骤总数（含卡上省略掉的更早阶段），由 service 放进底部那一行。
  const toolCount = traceEntries.filter(entry => entry.type === 'tool_call' || entry.type === 'tool_result').length;
  if (toolCount) elements.push({ tag: 'markdown', element_id: 'trace_steps', content: `共 ${toolCount} 步`, text_size: 'notation', margin: '0px' });
  if (completed) {
    const lastFailed = [...traceEntries].reverse().find(entry =>
      (entry.type === 'tool_call' || entry.type === 'tool_result') && toolPresentation(entry).statusLabel === '失败');
    if (lastFailed) elements.push(failureStepElement(lastFailed));
  }

  if (groups.length) {
    if (completed) {
      if (omittedGroupCount) elements.push(traceOmissionElement(omittedGroupCount, '0px 0px 4px 0px'));
      // 精简模式下历史阶段退化为无 expanded 属性的单行，arrange 按默认规则折叠总面板，
      // hideTraceOnComplete 对过程卡不再生效。展开后要能看出每段花了多久，所以带耗时。
      const expanded = !compact && config.hideTraceOnComplete === false;
      elements.push(...groups.map((group, index) => historyGroupPanel(group, index, compact, expanded, true, compact)));
    } else {
      const historyGroups = groups.slice(0, -1);
      const currentGroup = groups.at(-1)!;

      if (historyGroups.length > 0) {
        // 历史阶段就排在当前阶段下面，位置本身已经说明了它们是历史，不必再用一行
        // 灰字讲一遍「此前阶段」——那一行只是把当前阶段继续往下推。位置表达不了的
        // 只有「还有多少个更早阶段没展示」，所以这里只在真的省略了阶段时才出一行。
        if (omittedGroupCount) elements.push(traceOmissionElement(omittedGroupCount, '4px 0px 2px 0px'));
        elements.push(...historyGroups.map((group, index) => historyGroupPanel(group, index, true, false, false, compact)));
      }
      elements.push(currentRunningStagePanel(currentGroup, groups.length - 1, view !== 'process', compact));
    }
  }
  // 完成时的占位带 id：过程卡的回执自己会说结果在不在下一条，service 据此把它拿掉。
  if (!elements.length) elements.push(completed
    ? { tag: 'markdown', element_id: 'trace_empty', content: '执行过程已结束，结果见单独的结果消息。', text_size: 'normal', margin: '0px' }
    : { tag: 'markdown', content: '正在思考中…', text_size: 'normal', margin: '0px' });
  return elements;
}

export const renderLarkProcessElements = (events: AgentEvent[], config: Pick<StoredLarkConfig, 'traceLimit' | 'hideTraceOnComplete' | 'compactTrace'>, terminal = false) =>
  renderLarkCardElements(events, config, terminal, false, undefined, 'process');

export const renderLarkResultElements = (events: AgentEvent[]) =>
  renderLarkCardElements(events, { hideTraceOnComplete: true }, true, false, undefined, 'result');

export function renderLarkResultTextElements(text: string): LarkCardElement[] {
  const finalText = redactTraceText(text).trim();
  const elements: LarkCardElement[] = [];
  if (finalText) {
    elements.push({
      tag: 'markdown',
      element_id: 'final_output',
      content: finalText,
      text_align: 'left',
      text_size: 'normal_v2',
      margin: '0px'
    });
  } else {
    elements.push({
      tag: 'markdown',
      element_id: 'result_missing',
      content: "<text_tag color='orange'>结果不完整</text_tag>　Agent 未返回最终输出，可直接要求 Agent 总结本轮结论。",
      text_size: 'normal',
      margin: '4px 0px'
    });
  }
  return elements;
}

export function renderLarkTrace(events: AgentEvent[], config: Pick<StoredLarkConfig, 'traceLimit'>, _completed = false) {
  let entries = compactTraceEntries(events);
  if (config.traceLimit) entries = entries.slice(-config.traceLimit);
  if (!entries.length) return '正在思考中…';
  return entries.map(entry => {
    const data = entry.data;
    if (entry.type === 'text') return `**Agent**\n\n${redactTraceText(String(data.text ?? ''))}`;
    if (entry.type === 'thinking') return '**内部分析**\n\n> Agent 已完成内部分析（推理原文不展示）';
    if (entry.type === 'tool_call' || entry.type === 'tool_result') return `**工具 · ${redactTraceText(String(data.name ?? 'tool'))}** · ${data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')}${fenced(redactTraceValue(data.output ?? data.input))}`;
    if (entry.type === 'permission_request') return `**权限请求** · ${data.status ?? 'pending'}\n\n${redactTraceText(String(data.title ?? ''))}`;
    if (entry.type === 'error') return `**错误**\n\n${redactTraceText(String(data.message ?? 'Agent 执行失败'))}`;
    if (entry.type === 'raw_terminal') return `**终端**${fenced(redactTraceText(String(data.text ?? '')))}`;
    return '';
  }).filter(Boolean).join('\n\n---\n\n');
}

/** Full public execution record: do not export internal analysis or opaque PTY
 * screens, which may contain a CLI's private reasoning. No visual trace limits. */
export function renderLarkRecordExport(events: AgentEvent[]): string {
  const sections = compactTraceEntries(events).flatMap(entry => {
    const data = entry.data;
    const time = entry.timestamp;
    if (entry.type === 'text') return [`## ${time} · Agent\n\n${redactTraceText(String(data.text ?? ''))}`];
    if (entry.type === 'tool_call' || entry.type === 'tool_result') {
      return [`## ${time} · 工具 ${redactTraceText(String(data.name ?? 'tool'))}\n\n状态：${redactTraceText(String(data.status ?? (entry.type === 'tool_result' ? 'completed' : 'running')))}\n\n输入${fenced(redactTraceValue(data.input))}\n\n输出${fenced(redactTraceValue(data.output))}`];
    }
    if (entry.type === 'permission_request') return [`## ${time} · 权限请求\n\n${redactTraceText(String(data.title ?? ''))}\n\n状态：${redactTraceText(String(data.status ?? 'pending'))}`];
    if (entry.type === 'error') return [`## ${time} · 错误\n\n${redactTraceText(String(data.message ?? 'Agent 执行未完全成功'))}`];
    return [];
  });
  return '# 公开执行记录\n\n包含本轮公开输出、工具输入输出、审批及错误；已脱敏，不含内部分析、用户原始请求与原始终端屏幕。\n\n'
    + (sections.join('\n\n---\n\n') || '本轮没有可导出的结构化公开记录。');
}

/** 结果卡上验证状态行的 element_id。结果重发与卡片 PATCH 都靠它定位并整行替换。 */
export const LARK_VERIFICATION_ELEMENT_ID = 'verification_status';

/** 记录自身的结论用词。这里刻意不叫「通过/未通过」：过期的记录同样会用到它们。 */
const verificationOutcomeLabels: Record<VerificationStatus, string> = {
  running: '执行中', passed: '通过', failed: '失败', timed_out: '超时', interrupted: '中断', unverified: '结论未确认'
};

const verificationStaleReasons: Record<NonNullable<VerificationResponse['staleReason']>, string> = {
  code_changed: '验证之后代码已变化',
  changed_during_run: '验证期间代码发生变化',
  current_fingerprint_unavailable: '无法确认当前代码版本',
  record_fingerprint_missing: '记录缺少代码指纹'
};

const verificationTime = (value: string | undefined): string => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '时间未记录';
};

/** 自动验证进展接在结论后面的说明；执行中由状态标签自己说明。 */
const autoVerificationNotes: Record<LarkAutoVerificationNote['phase'], (note: LarkAutoVerificationNote) => string> = {
  running: () => '',
  interrupted: () => '',
  skipped: () => '本轮改了代码，但会话里还有任务在执行，自动验证已跳过。',
  repairing: note => `已把失败输出发回 Agent 返修（第 ${note.round}/${maxLarkVerificationRepairRounds} 轮），修好后会重新验证。`,
  exhausted: () => `已自动返修 ${maxLarkVerificationRepairRounds} 轮仍未通过，需要人工处理。`,
  infrastructure: () => '这是验证工具本身的问题，没有发回 Agent 返修。'
};

/**
 * 结果卡的验证状态行。
 *
 * 这条信息在飞书侧此前一个字都没有，而「说做完了其实没做完」正是最常见的失望来源：
 * 验证命令在目标目录真实执行并留下退出码、有限输出、时间与代码指纹，Agent 自述
 * 测试通过不会产生任何验证记录，两者必须在卡上分得开。标题栏的「运行完成」只说这一轮
 * 跑完了，验证状态单独写在这一行：验证通过 / 验证未通过 / 未验证 / 验证已过期。
 *
 * 三条硬规则：
 * 1. 没配验证命令 → 整行不渲染（返回 undefined），也不给按钮，不暗示不存在的能力；
 *    唯一例外是带了候选命令：只提议，同卡渲染「使用这个验证命令」按钮；
 * 2. 记录 stale（代码已变／验证期间变／指纹缺失）→ 必须显示为已过期，绝不能显示成通过；
 * 3. 通过要给出足以自行核对的信息：退出码、代码指纹前若干位、验证时间。
 */
export function renderLarkVerificationElement(input: {
  command?: string;
  latest?: VerificationResponse;
  /** 这张卡上是否同时渲染了「运行验证」按钮；false 时不写「可点按钮」的指引。 */
  canRun?: boolean;
  /** 没配验证命令时按基准推断出的候选命令；这张卡上同时渲染「使用这个验证命令」按钮。 */
  suggestion?: string;
  /** 本轮结束后自动验证的进展；coordinator 只在它对应的正是 latest 这条记录时传入。 */
  auto?: LarkAutoVerificationNote;
}): LarkCardElement | undefined {
  const command = input.command?.trim();
  const suggestion = input.suggestion?.trim();
  let content: string;
  if (!command) {
    if (!suggestion) return undefined;
    content = `<text_tag color='grey'>未验证</text_tag>　这个机器人还没有配置验证命令。按基准分支上的项目文件推断可以用 \`${truncateTrace(suggestion, 120)}\`，点「使用这个验证命令」保存后，改了代码会自动验证。`;
  } else {
    // 命令与 error 都会被原样印在群里，一律走 truncateTrace（内含 redactTraceValue 脱敏）。
    const label = `\`${truncateTrace(command, 120)}\``;
    const run = input.canRun ? '可点「运行验证」执行。' : '';
    const record = input.latest;
    const auto = input.auto;
    const autoNote = auto ? autoVerificationNotes[auto.phase](auto) : '';
    if (auto?.phase === 'running' || record?.status === 'running') {
      content = `<text_tag color='blue'>验证执行中</text_tag>　${auto?.phase === 'running' ? '本轮改了代码，' : ''}正在执行 ${label}，结论以完成后的记录为准。`;
    } else if (auto?.phase === 'interrupted') {
      content = `<text_tag color='orange'>验证被中断</text_tag>　${label} 还没执行完就被服务重启或会话停止打断，这次没有结论。${run}`;
    } else if (!record && auto?.phase === 'infrastructure') {
      content = `<text_tag color='red'>验证未通过</text_tag>　${label} 没能执行${auto.error ? `：${truncateTrace(auto.error, 200)}` : ''}。${autoNote}${run}`;
    } else if (!record) {
      content = `<text_tag color='grey'>未验证</text_tag>　平台没有执行过 ${label}；Agent 自述测试通过不产生验证记录。${autoNote}${run}`;
    } else {
      const outcome = verificationOutcomeLabels[record.status] ?? '结论未知';
      const exit = record.exitCode === undefined ? '无退出码' : `退出码 ${record.exitCode}`;
      const time = verificationTime(record.completedAt ?? record.startedAt);
      if (record.stale) {
        const reason = record.staleReason ? verificationStaleReasons[record.staleReason] : '无法确认当前代码版本';
        content = `<text_tag color='orange'>验证已过期</text_tag>　${label} 上次${outcome}（${exit}，${time}），但${reason}，不能用来判断当前代码。${autoNote}${run}`;
      } else if (record.status === 'passed') {
        const fingerprint = record.afterFingerprint ? `代码指纹 ${record.afterFingerprint.slice(0, 12)}` : '代码指纹缺失';
        content = `<text_tag color='green'>验证通过</text_tag>　${label} ${exit}　${fingerprint}　${time}`;
      } else {
        content = `<text_tag color='red'>验证未通过</text_tag>　${label} ${outcome}　${exit}　${time}${record.error ? `　${truncateTrace(record.error, 200)}` : ''}${autoNote ? `　${autoNote}` : ''}${run ? `　${run}` : ''}`;
      }
    }
  }
  return {
    tag: 'markdown', element_id: LARK_VERIFICATION_ELEMENT_ID, content,
    text_size: 'notation', margin: '4px 0px 0px 0px',
    icon: { tag: 'standard_icon', token: 'info_outlined', color: 'grey' }
  };
}
