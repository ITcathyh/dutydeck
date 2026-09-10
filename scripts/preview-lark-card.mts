// 飞书任务卡片的离线预览器。
//
// 卡片的「美观性」只能看出来，不能从 JSON 读出来，但把卡片发到真实会话里做目视对比
// 代价太高（要真机、要污染会话、改一行就得重发）。本脚本把 buildLarkCard 的真实产物
// 近似渲染成 HTML：结构、层级、密度、颜色对比都能直接看，改版前后各跑一次即可并排复核。
//
// 这是近似渲染，不是飞书渲染引擎：字号、圆角、行高按飞书取值对齐，最终像素以飞书客户端为准。
// 用它判断「层级对不对、噪声多不多」，不用它判断「差 1px」。
//
// 用法：
//   node --import tsx scripts/preview-lark-card.mts [输出目录]
//   node --import tsx scripts/preview-lark-card.mts [输出目录] --shot   顺带出 PNG
//
// 改版前后各跑一次到不同目录，preview.png（默认收起）和 preview-expanded.png
// （全部展开）同尺寸，可直接左右并排肉眼复核。

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentEvent } from '@dockmux/shared';
import {
  renderLarkProcessElements,
  renderLarkResultElements
} from '../apps/server/src/lark/card-renderer.js';
import { boundLarkCardElements, buildLarkCard } from '../apps/server/src/lark/service.js';
import { buildLarkTaskDashboard } from '../apps/server/src/lark/task-dashboard.js';

// 仍在执行的步骤没有 completedAt，耗时按 Date.now() 兜底计算——渲染结果因此依赖「现在」。
// 基线跟随当前时钟时，同一份数据两次跑图会得到不同的耗时（跨整分钟就变），并排复核时
// 那是一处每分钟都在动的假差异，比真实改动还显眼。所以基线和「现在」一起钉死：
// 整个预览完全确定，cards.json 可以直接 diff。
const base = Date.parse('2026-09-10T08:00:00.000Z');
// 「现在」取 base+75s，让运行态场景自洽：卡片头部写的任务已用时是 74s，
// 未结束步骤的耗时必须小于它，否则会渲染出「单步比整轮还久」这种不可能的读数。
// 脚本是一次性进程，渲染完即退出，不必还原 Date.now。
Date.now = () => base + 75_000;
const t = (seconds: number) => new Date(base + seconds * 1_000).toISOString();
const event = (sequence: number, type: AgentEvent['type'], seconds: number, data: Record<string, unknown>): AgentEvent =>
  ({ id: `e${sequence}`, sessionId: 'ses_preview', sequence, type, timestamp: t(seconds), data });

const config = { traceLimit: 50, hideTraceOnComplete: true };

const multiStage: AgentEvent[] = [
  event(1, 'thinking', 0, { text: '先看清楚卡片渲染链路。' }),
  event(2, 'text', 1, { role: 'assistant', text: '先定位飞书卡片的渲染入口，确认过程卡和结果卡分别由哪段代码组装。' }),
  event(3, 'tool_call', 1, { id: 't1', name: 'Bash', input: { command: "rg -n 'renderLarkCardElements' apps/server/src" }, status: 'running', startedAt: t(1) }),
  event(4, 'tool_result', 3, { id: 't1', name: 'Bash', output: 'apps/server/src/lark/card-renderer.ts:575\napps/server/src/lark/card-renderer.ts:664', status: 'completed', completedAt: t(3) }),
  event(5, 'text', 4, { role: 'assistant', text: '读取 card-renderer.ts 与 service.ts 里的卡片组装逻辑。' }),
  event(6, 'tool_call', 4, { id: 't2', name: 'read', input: { path: 'apps/server/src/lark/card-renderer.ts' }, status: 'running', startedAt: t(4) }),
  event(7, 'tool_result', 6, { id: 't2', name: 'read', output: 'import type { AgentEvent } from "@dockmux/shared";\n…683 行', status: 'completed', completedAt: t(6) }),
  event(8, 'tool_call', 6, { id: 't3', name: 'read', input: { path: 'apps/server/src/lark/service.ts' }, status: 'running', startedAt: t(6) }),
  event(9, 'tool_result', 8, { id: 't3', name: 'read', output: 'export function buildLarkCard(input: LarkCardInput = {}) {\n…1272 行', status: 'completed', completedAt: t(8) }),
  event(10, 'text', 9, { role: 'assistant', text: '跑一遍卡片相关的单元测试，确认当前基线是绿的。' }),
  event(11, 'tool_call', 9, { id: 't4', name: 'Bash', input: { command: 'pnpm vitest run apps/server/src/lark/card-layout.test.ts' }, status: 'running', startedAt: t(9) })
];

const completedRun: AgentEvent[] = [
  ...multiStage,
  event(12, 'tool_result', 21, { id: 't4', name: 'Bash', output: 'Test Files  1 passed (1)\n     Tests  17 passed (17)\n  Duration  11.84s', status: 'completed', completedAt: t(21) }),
  event(13, 'text', 22, { role: 'assistant', text: `卡片渲染链路已确认，测试全绿。

**渲染入口**

- 过程卡：\`renderLarkProcessElements\` → \`boundLarkCardElements\` → \`buildLarkCard\`
- 结果卡：\`renderLarkResultElements\` → \`sendLarkResult\`

**两处需要注意**

1. \`buildLarkCard\` 里的裁剪循环会在超预算时逐组剥离工具 I/O，最后才整组删除。
2. 结果卡走的是独立消息，超长答案会退化成 \`执行结果.md\` 附件。

\`card-layout.test.ts\` 的 17 项断言全部通过，未发现回归。` })
];

const failedRun: AgentEvent[] = [
  event(1, 'text', 0, { role: 'assistant', text: '开始安装依赖并构建服务端。' }),
  event(2, 'tool_call', 0, { id: 'f1', name: 'Bash', input: { command: 'pnpm install --frozen-lockfile' }, status: 'running', startedAt: t(0) }),
  event(3, 'tool_result', 12, { id: 'f1', name: 'Bash', output: 'Progress: resolved 1284, reused 1284, downloaded 0, added 0, done', status: 'completed', completedAt: t(12) }),
  event(4, 'text', 13, { role: 'assistant', text: '依赖就绪，执行构建。' }),
  event(5, 'tool_call', 13, { id: 'f2', name: 'Bash', input: { command: 'pnpm build' }, status: 'running', startedAt: t(13) }),
  event(6, 'tool_result', 41, { id: 'f2', name: 'Bash', output: 'ENOSPC: no space left on device, write', status: 'failed', completedAt: t(41) }),
  event(7, 'error', 42, { message: '构建失败：根分区已满（/dev/vda1 使用率 100%），无法写入 dist 产物。' })
];

const approvalRun: AgentEvent[] = [
  event(1, 'text', 0, { role: 'assistant', text: '准备清理构建缓存目录以释放根分区空间。' }),
  event(2, 'tool_call', 0, { id: 'a1', name: 'Bash', input: { command: 'du -sh ~/.cache/*' }, status: 'running', startedAt: t(0) }),
  event(3, 'tool_result', 2, { id: 'a1', name: 'Bash', output: '3.2G\t/home/user/.cache/pnpm\n880M\t/home/user/.cache/ms-playwright', status: 'completed', completedAt: t(2) }),
  event(4, 'permission_request', 3, { id: 'p1', title: '高危操作：删除 ~/.cache/pnpm 目录（3.2G）', status: 'pending', options: ['allow_once', 'reject_once'] })
];

const terminalHeavy: AgentEvent[] = [
  event(1, 'text', 0, { role: 'assistant', text: '会话消息量较大，继续翻页拉取。' }),
  ...Array.from({ length: 18 }, (_, index) =>
    event(index + 2, 'raw_terminal', index + 1, { text: `[page ${index + 1}] fetched 200 messages, cursor=om_${(index + 1).toString().padStart(4, '0')}` }))
];

type Scenario = { id: string; label: string; note: string; card: any };

const web = 'http://10.37.33.49:4310';
const liveCapabilities = { canCancelQueued: false, canInterrupt: true, canRetry: false, canRefresh: true, webUrl: `${web}/sessions/ses_preview` };
const doneCapabilities = { canCancelQueued: false, canInterrupt: false, canRetry: false, canRefresh: false, webUrl: `${web}/sessions/ses_preview` };

// workflow-interactions.ts 的审批/提问卡自己拼 elements 走 service.reply，不经过
// renderLarkProcessElements，也是唯一能真正落地审批的入口。它长期没进预览，
// 「statusLabel 被状态默认值吞掉」这类只发生在这条链路上的问题就没人看得见。
const workflowButton = (action: string, label: string) => ({
  tag: 'button', element_id: `workflow_${action}`, text: { tag: 'plain_text', content: label },
  type: action === 'approve' ? 'primary' : 'default',
  behaviors: [{ type: 'callback', value: { dockmux_workflow: action, request_id: 'wf_preview', generation: 'preview' } }]
});
const workflowCard = (kind: 'permission' | 'ask') => buildLarkCard({
  agentName: 'Claude Code', state: 'running', readOnly: true, awaitingHuman: true, permissionMode: 'ask',
  statusLabel: kind === 'ask' ? '等待回答' : '等待审批',
  taskId: `wf_preview_${kind}`, taskName: kind === 'ask' ? 'Agent 需要你的回答' : '确认本次操作',
  elements: [
    { tag: 'div', text: { tag: 'plain_text', content: kind === 'ask'
      ? '缓存目录里 pnpm 占 3.2G、playwright 占 880M。整个删掉，还是只清 pnpm？'
      : '高危操作：删除 ~/.cache/pnpm 目录（3.2G）' } },
    { tag: 'markdown', content: kind === 'ask'
      ? '回复此卡片即可回答。'
      : '仅对本次工具调用生效。' },
    ...(kind === 'permission' ? [workflowButton('approve', '批准一次'), workflowButton('reject', '拒绝')] : [])
  ]
});

// /tasks、/approve、/reject、/answer 和验收回执都由 coordinator 的 workflowReply 发出，
// 成功走 completed、需要读者再做点什么的走 failed。下面两张卡分别覆盖这两条分支，
// 按它的真实入参构造：没有 webBaseUrl、没有 capabilities、readOnly。
const commandReceiptCard = (taskName: string, elements: Array<Record<string, any>>) => buildLarkCard({
  agentName: 'Claude Code', state: 'completed', readOnly: true, permissionMode: 'ask',
  taskId: 'om_preview_cmd', taskName, elements
});

// 相对时间要看得出档位差别（分钟 / 小时 / 天），所以按固定偏移构造，并把同一个
// dashboardNow 传给渲染器——否则每次跑图这些值都在动，并排复核时全是假差异。
const dashboardNow = base;
const ago = (minutes: number) => new Date(dashboardNow - minutes * 60_000).toISOString();
const workspace = '/data00/home/huangyuhang.edu/ai/dockmux';
const appLink = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_preview';
const dashboardEntries = [
  { taskId: 't1', title: '看看发送的消息卡片能不能做大规模重构优化', workspace, status: 'waiting_for_permission', updatedAt: ago(12), url: appLink },
  { taskId: 't2', title: '拉取群会话历史消息', workspace, status: 'running', updatedAt: ago(3), url: appLink },
  { taskId: 't3', title: '构建并重启服务端', workspace, status: 'failed', updatedAt: ago(60 * 30), url: appLink },
  { taskId: 't4', title: '确认飞书卡片渲染链路', workspace, status: 'completed', updatedAt: ago(60 * 5), url: appLink }
];

const scenarios: Scenario[] = [
  {
    id: 'running-multi-stage',
    label: '过程卡 · 执行中（多阶段）',
    note: '最常见形态：一个当前阶段加若干历史阶段。看层级是否清楚、噪声是否可控。',
    card: buildLarkCard({
      agentName: 'Claude Code', state: 'running', taskName: '看看发送的消息卡片能不能做进一步优化，提高卡片美观性和信噪比',
      taskId: 'om_preview_running', elapsedSeconds: 74, sessionId: 'ses_preview', webBaseUrl: web,
      capabilities: liveCapabilities,
      elements: boundLarkCardElements(renderLarkProcessElements(multiStage, config))
    })
  },
  {
    id: 'running-terminal-heavy',
    label: '过程卡 · 执行中（终端刷屏）',
    note: 'PTY 形态 Agent 的高频回显，考察折叠是否兜住了日志墙。',
    card: buildLarkCard({
      agentName: 'Codex', state: 'running', taskName: '拉取群会话历史消息', taskId: 'om_preview_terminal',
      elapsedSeconds: 19, sessionId: 'ses_preview', webBaseUrl: web,
      capabilities: liveCapabilities,
      elements: boundLarkCardElements(renderLarkProcessElements(terminalHeavy, config))
    })
  },
  {
    id: 'approval',
    label: '过程卡 · 等待审批',
    note: '任务已暂停等人。这张卡唯一的任务是让人一眼看到要我做什么。',
    card: buildLarkCard({
      agentName: 'Claude Code', state: 'running', taskName: '清理构建缓存释放磁盘', taskId: 'om_preview_approval',
      elapsedSeconds: 8, sessionId: 'ses_preview', webBaseUrl: web,
      capabilities: liveCapabilities,
      elements: boundLarkCardElements(renderLarkProcessElements(approvalRun, config))
    })
  },
  {
    id: 'workflow-permission',
    label: '审批卡 · 独立回复（可点批准）',
    note: '任务卡只负责说「停下来等人了」，真正能批准的是这张。只读态下卡片自己不加按钮，正文里那两个才是入口。',
    card: workflowCard('permission')
  },
  {
    id: 'workflow-ask',
    label: '提问卡 · 独立回复',
    note: '同一条链路的另一种停：Agent 在问问题。状态字必须是「等待回答」，不能被写成「等待审批」。',
    card: workflowCard('ask')
  },
  {
    id: 'completed-process',
    label: '过程卡 · 已完成（冻结收据）',
    note: '终态过程卡。结果已由独立消息送达，这张卡只承担过程可查。',
    card: buildLarkCard({
      agentName: 'Claude Code', state: 'completed', taskName: '确认飞书卡片渲染链路', taskId: 'om_preview_done',
      elapsedSeconds: 142, sessionId: 'ses_preview', webBaseUrl: web, readOnly: true,
      capabilities: doneCapabilities,
      elements: boundLarkCardElements(renderLarkProcessElements(completedRun, config, true))
    })
  },
  {
    id: 'result',
    label: '结果卡 · 独立消息',
    note: '用户真正要读的那条消息。这里每一行外壳都在和答案抢注意力。',
    card: buildLarkCard({
      agentName: 'Claude Code', state: 'completed', taskName: '确认飞书卡片渲染链路', taskId: 'om_preview_done',
      elapsedSeconds: 142, sessionId: 'ses_preview', webBaseUrl: web, readOnly: true,
      capabilities: doneCapabilities,
      elements: renderLarkResultElements(completedRun)
    })
  },
  {
    id: 'failed',
    label: '过程卡 · 已失败',
    note: '失败卡是用户唯一的入口，重试必须留在上面，原因必须能读到。',
    card: buildLarkCard({
      agentName: 'Claude Code', state: 'failed', taskName: '构建并重启服务端', taskId: 'om_preview_failed',
      elapsedSeconds: 43, sessionId: 'ses_preview', webBaseUrl: web, retryable: true,
      capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: true, canRefresh: false, webUrl: `${web}/sessions/ses_preview` },
      elements: boundLarkCardElements(renderLarkProcessElements(failedRun, config, true))
    })
  },
  {
    id: 'command-tasks',
    label: '命令回执 · /tasks 任务导航',
    note: '一屏能扫完 4 个任务：每行只剩逐行不同的东西，工作区提到了表头。',
    card: commandReceiptCard('任务导航', buildLarkTaskDashboard(dashboardEntries, 1, dashboardNow).elements)
  },
  {
    id: 'command-error',
    label: '命令回执 · 权限被拒',
    note: '拒绝、报错和「命令可能没生效」都走这张卡，颜色必须和文字说的是同一件事。',
    card: buildLarkCard({
      agentName: 'Claude Code', state: 'failed', readOnly: true, retryable: false, permissionMode: 'ask',
      taskId: 'om_preview_cmd_error', taskName: '任务操作', markdown: '当前账号无权修改此任务。'
    })
  }
];

// ---- 近似渲染 ----

const template: Record<string, string> = {
  blue: '#3370FF', wathet: '#3370FF', turquoise: '#0FA9A9', green: '#34C724', yellow: '#FFC60A',
  orange: '#FF811A', red: '#F54A45', carmine: '#F5325B', violet: '#7F3BF5', purple: '#7F3BF5',
  indigo: '#4954E6', grey: '#646A73'
};
const tagColor: Record<string, [string, string]> = {
  neutral: ['#1F232910', '#1F2329'], blue: ['#3370FF14', '#245BDB'], wathet: ['#3370FF14', '#245BDB'],
  turquoise: ['#0FA9A914', '#067F7F'], green: ['#34C72414', '#2EA121'], yellow: ['#FFC60A24', '#8F6A00'],
  orange: ['#FF811A1F', '#A34D00'], red: ['#F54A4514', '#C93A38'], carmine: ['#F5325B14', '#C4304D'],
  violet: ['#7F3BF514', '#6425C4'], purple: ['#7F3BF514', '#6425C4'], indigo: ['#4954E614', '#3844B8'],
  grey: ['#1F232910', '#646A73']
};
const fontColor: Record<string, string> = {
  grey: '#8F959E', green: '#2EA121', red: '#C93A38', orange: '#A34D00', yellow: '#8F6A00',
  blue: '#245BDB', wathet: '#245BDB'
};
// 飞书内置字号档。heading-* 是 schema 2.0 的语义档，卡片可以在 config.style.text_size 里
// 给它们起自定义名（并为 PC 与移动端各取一档），正文再按那个名字引用。
const size: Record<string, string> = {
  'heading-0': '24px', 'heading-1': '20px', 'heading-2': '18px', 'heading-3': '16px', 'heading-4': '14px',
  heading: '18px', normal: '14px', normal_v2: '14px', small: '13px', notation: '12px', 'x-small': '11px'
};

/** 卡片自带的色板与字号表，随 config.style 逐卡解析。 */
type Theme = { color: Record<string, string>; textSize: Record<string, string> };

const esc = (value: string) => value.replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

/** 自定义字号名先查卡片自己的声明，再落到内置档，两者都没有时按正文字号处理。 */
const fontSize = (name: string | undefined, theme: Theme) =>
  theme.textSize[name ?? ''] ?? size[name ?? 'normal'] ?? '14px';

/** 自定义色名同理：卡片声明优先，其次内置语义色，最后当作原样的 CSS 颜色。 */
const tint = (name: string | undefined, theme: Theme) =>
  name ? theme.color[name] ?? fontColor[name] ?? name : undefined;

/**
 * 只覆盖卡片实际用到的 markdown 子集：font/text_tag/代码块/行内代码/加粗/链接/标题/列表。
 *
 * 代码块先抽走、渲染完再放回，占位符用 NUL 包住序号。分隔符必须是正文里不可能出现的
 * 字符：用空格包序号的话，正文里一句「17 项断言全部通过」会被当成第 17 个代码块，
 * 还原成 undefined。
 */
function markdown(input: string, theme: Theme): string {
  const blocks: string[] = [];
  let text = String(input ?? '').replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_match, code: string) => {
    blocks.push(`<pre class="code">${esc(code.replace(/\n$/, ''))}</pre>`);
    return `\0${blocks.length - 1}\0`;
  });
  text = esc(text);
  text = text
    .replace(/&lt;font color='([^']+)'&gt;([\s\S]*?)&lt;\/font&gt;/g,
      (_m, color: string, body: string) => `<span style="color:${tint(color, theme)}">${body}</span>`)
    .replace(/&lt;text_tag color='([^']+)'&gt;([\s\S]*?)&lt;\/text_tag&gt;/g, (_m, color: string, body: string) => {
      const [background, foreground] = tagColor[color] ?? tagColor.neutral!;
      return `<span class="tag" style="background:${background};color:${foreground}">${body}</span>`;
    })
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/^(\s*)[-*]\s+(.+)$/gm, '$1• $2')
    .split(IDEOGRAPHIC_SPACE).join('<span class="gap"></span>')
    .replace(/\n/g, '<br>');
  return text.replace(/\0(\d+)\0/g, (_m, index: string) => blocks[Number(index)]!);
}

const icon = (element: any, theme?: Theme) => element
  ? `<span class="icon" title="${esc(String(element.token ?? element.img_key ?? ''))}"${
      element.color && theme ? ` style="background:${tint(element.color, theme)}"` : ''}></span>`
  : '';

/** 纵向堆叠间距：飞书的 vertical_spacing 作用在容器上，这里落成 flex gap。 */
const stackStyle = (spacing: unknown) =>
  spacing ? `display:flex;flex-direction:column;gap:${spacing};` : '';

function renderElement(element: any, theme: Theme): string {
  if (!element || typeof element !== 'object') return '';
  const margin = String(element.margin ?? '0px');
  const align = element.text_align ? `text-align:${element.text_align};` : '';
  const wrap = (inner: string) => `<div style="margin:${margin};${align}">${inner}</div>`;
  switch (element.tag) {
    case 'markdown':
      return wrap(`${icon(element.icon, theme)}<span style="font-size:${fontSize(element.text_size, theme)}">${markdown(element.content, theme)}</span>`);
    case 'div': {
      const color = tint(element.text?.text_color, theme);
      return wrap(`${icon(element.icon, theme)}<span style="${color ? `color:${color};` : ''}font-size:${fontSize(element.text?.text_size, theme)}">${markdown(element.text?.content ?? '', theme)}</span>`);
    }
    case 'button': {
      const kind = element.type === 'danger' ? 'danger'
        : element.type === 'primary' ? 'primary'
          : element.type === 'text' ? 'text' : 'default';
      return `<button class="btn ${kind}"${element.disabled ? ' disabled' : ''}>${esc(element.text?.content ?? '')}</button>`;
    }
    case 'column_set': {
      const vertical = element.vertical_align === 'center' ? 'align-items:center;' : '';
      return wrap(`<div class="row" style="gap:${element.horizontal_spacing ?? '8px'};${vertical}">${(element.columns ?? [])
        .map((column: any) => {
          const flex = column.width === 'weighted' ? `flex:${column.weight ?? 1};`
            : typeof column.width === 'string' && column.width.endsWith('px') ? `flex:0 0 ${column.width};`
              : 'flex:0 0 auto;';
          return `<div class="col" style="${flex}${column.padding ? `padding:${column.padding};` : ''}${stackStyle(column.vertical_spacing)}">${(column.elements ?? []).map((child: any) => renderElement(child, theme)).join('')}</div>`;
        })
        .join('')}</div>`);
    }
    case 'collapsible_panel':
      return wrap(`<details class="panel"${element.expanded ? ' open' : ''}><summary>${renderElement({ ...element.header?.title, margin: '0px' }, theme)}<span class="chevron">v</span></summary><div class="panel-body" style="padding:${element.padding ?? '0px'};${stackStyle(element.vertical_spacing)}">${(element.elements ?? []).map((child: any) => renderElement(child, theme)).join('')}</div></details>`);
    case 'interactive_container': {
      const background = tint(element.background_style, theme);
      const border = element.has_border ? `border:1px solid ${tint(element.border_color, theme) ?? '#DEE0E3'};` : '';
      return wrap(`<div class="container" style="${background ? `background:${background};` : ''}${border}${stackStyle(element.vertical_spacing)}border-radius:${element.corner_radius ?? '0px'};padding:${element.padding ?? '0px'}">${(element.elements ?? []).map((child: any) => renderElement(child, theme)).join('')}</div>`);
    }
    case 'hr':
      return '<hr>';
    default:
      return wrap(`<span class="unknown">[${esc(String(element.tag ?? '?'))}]</span>`);
  }
}

export function renderCard(card: any): string {
  const theme: Theme = {
    color: Object.fromEntries(Object.entries(card.config?.style?.color ?? {})
      .map(([name, value]: [string, any]) => [name, value.light_mode])),
    // 一个自定义字号可以按端各取一档（default / pc / mobile）。预览是桌面宽度，取 pc。
    textSize: Object.fromEntries(Object.entries(card.config?.style?.text_size ?? {})
      .map(([name, value]: [string, any]) => [
        name,
        size[typeof value === 'string' ? value : value?.pc ?? value?.default] ?? '14px'
      ]))
  };
  // template 的默认值 default 就是「无色带」形态：白底、深色标题。改版把成功和运行中
  // 都收敛到了这一档，预览必须能如实画出来，否则改版前后最大的一处差别恰好看不见。
  // 整卡不带 header 也是合法形态，同样要能画。
  const band = String(card.header?.template ?? 'default');
  const plain = !template[band];
  const header = card.header ? `
  <div class="card-header${plain ? ' plain' : ''}"${plain ? '' : ` style="background:${template[band]}"`}>
    <div class="card-title">${esc(card.header.title?.content ?? '')}</div>
    ${card.header.subtitle?.content ? `<div class="card-subtitle">${esc(card.header.subtitle.content)}</div>` : ''}
  </div>` : '';
  return `<div class="card">${header}
  <div class="card-body" style="padding:${card.body?.padding ?? '12px'}">
    ${(card.body?.elements ?? []).map((element: any) => `<div class="stack" style="margin-bottom:${card.body?.vertical_spacing ?? '8px'}">${renderElement(element, theme)}</div>`).join('')}
  </div>
</div>`;
}

const countComponents = (value: any): number => {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  return (typeof value.tag === 'string' ? 1 : 0) + Object.values(value).reduce<number>((sum, item) => sum + countComponents(item), 0);
};

const positional = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
const outDir = resolve(positional[0] ?? 'docs/assets/card-preview');
await mkdir(outDir, { recursive: true });

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Dockmux 飞书卡片预览</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:24px; background:#F5F6F7; font:14px/1.5 -apple-system,"PingFang SC","Helvetica Neue",Arial,sans-serif; color:#1F2329; }
  h1 { font-size:18px; margin:0 0 4px; }
  .lede { color:#646A73; font-size:12px; margin:0 0 20px; max-width:960px; }
  .grid { display:flex; flex-wrap:wrap; gap:20px; align-items:flex-start; }
  .cell { width:420px; }
  .cell > h2 { font-size:13px; margin:0 0 2px; }
  .cell > p { font-size:11px; color:#8F959E; margin:0 0 8px; }
  .meta { font-size:11px; color:#8F959E; margin-top:6px; }
  .card { width:420px; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(31,35,41,.12); }
  .card-header { padding:10px 12px 8px; }
  .card-title { color:#fff; font-size:15px; font-weight:600; line-height:1.35; }
  .card-subtitle { color:rgba(255,255,255,.75); font-size:12px; margin-top:2px; }
  .stack:last-child { margin-bottom:0 !important; }
  .row { display:flex; align-items:center; }
  .col { min-width:0; }
  .tag { display:inline-block; padding:0 5px; border-radius:4px; font-size:11px; line-height:18px; }
  .gap { display:inline-block; width:9px; }
  .icon { display:inline-block; width:12px; height:12px; border-radius:2px; background:#DEE0E3; margin-right:4px; vertical-align:-1px; }
  code { background:#1F23290A; border-radius:3px; padding:0 3px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.92em; }
  pre.code { background:#F5F6F7; border-radius:4px; padding:6px 8px; margin:4px 0; overflow:auto; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; line-height:1.45; white-space:pre-wrap; word-break:break-all; }
  a { color:#245BDB; text-decoration:none; }
  .btn { border:1px solid #DEE0E3; background:#fff; border-radius:6px; padding:2px 10px; font-size:12px; line-height:20px; cursor:default; color:#1F2329; }
  .btn.primary { background:#3370FF; border-color:#3370FF; color:#fff; }
  .btn.danger { background:#fff; border-color:#F54A45; color:#F54A45; }
  .btn.text { border-color:transparent; background:transparent; color:#245BDB; padding:2px 6px; }
  .btn:disabled { opacity:.55; }
  .card-header.plain { background:#fff; padding:12px 12px 2px; }
  .card-header.plain .card-title { color:#1F2329; }
  .card-header.plain .card-subtitle { color:#8F959E; }
  details.panel > summary { display:flex; align-items:center; gap:6px; cursor:pointer; list-style:none; }
  details.panel > summary::-webkit-details-marker { display:none; }
  details.panel > summary > div { flex:1; min-width:0; }
  .chevron { color:#8F959E; font-size:11px; flex:0 0 auto; }
  hr { border:0; border-top:1px solid #DEE0E3; margin:6px 0; }
  .unknown { color:#F54A45; font-size:11px; }
</style></head><body>
<h1>Dockmux 飞书任务卡片预览</h1>
<p class="lede">近似渲染，非飞书渲染引擎：字号、圆角、颜色按飞书取值对齐，用于判断信息层级与视觉密度，不用于像素级验收。折叠面板默认收起，点击可展开。</p>
<div class="grid">
${scenarios.map(scenario => `<div class="cell">
  <h2>${esc(scenario.label)}</h2>
  <p>${esc(scenario.note)}</p>
  ${renderCard(scenario.card)}
  <div class="meta">${Buffer.byteLength(JSON.stringify(scenario.card), 'utf8')} 字节 · ${countComponents(scenario.card)} 组件</div>
</div>`).join('\n')}
</div>
</body></html>`;

await writeFile(resolve(outDir, 'index.html'), html, 'utf8');
await writeFile(resolve(outDir, 'cards.json'), `${JSON.stringify(scenarios, null, 2)}\n`, 'utf8');
console.log(`预览已写入 ${resolve(outDir, 'index.html')}`);
for (const scenario of scenarios) {
  console.log(`  ${scenario.id.padEnd(24)} ${String(Buffer.byteLength(JSON.stringify(scenario.card), 'utf8')).padStart(6)} bytes  ${String(countComponents(scenario.card)).padStart(3)} components`);
}

if (process.argv.includes('--shot')) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto(`file://${resolve(outDir, 'index.html')}`, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: resolve(outDir, 'preview.png'), fullPage: true });
  await page.evaluate(() => document.querySelectorAll('details').forEach(node => node.setAttribute('open', '')));
  await page.screenshot({ path: resolve(outDir, 'preview-expanded.png'), fullPage: true });
  await browser.close();
  console.log(`截图已写入 ${resolve(outDir, 'preview.png')} 与 preview-expanded.png`);
}
