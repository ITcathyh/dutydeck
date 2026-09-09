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

const base = Date.parse('2026-09-09T10:00:00.000Z');
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
const size: Record<string, string> = {
  heading: '18px', normal: '14px', normal_v2: '14px', small: '13px', notation: '12px', 'x-small': '11px'
};

const esc = (value: string) => value.replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

/** 只覆盖卡片实际用到的 markdown 子集：font/text_tag/代码块/行内代码/加粗/链接/标题/列表。 */
function markdown(input: string, styles: Record<string, string>): string {
  const blocks: string[] = [];
  let text = String(input ?? '').replace(/```(?:\w+)?\n([\s\S]*?)```/g, (_match, code: string) => {
    blocks.push(`<pre class="code">${esc(code.replace(/\n$/, ''))}</pre>`);
    return ` ${blocks.length - 1} `;
  });
  text = esc(text);
  text = text
    .replace(/&lt;font color='([^']+)'&gt;([\s\S]*?)&lt;\/font&gt;/g,
      (_m, color: string, body: string) => `<span style="color:${styles[color] ?? fontColor[color] ?? color}">${body}</span>`)
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
  return text.replace(/ (\d+) /g, (_m, index: string) => blocks[Number(index)]!);
}

const icon = (element: any) => element
  ? `<span class="icon" title="${esc(String(element.token ?? element.img_key ?? ''))}"></span>`
  : '';

function renderElement(element: any, styles: Record<string, string>): string {
  if (!element || typeof element !== 'object') return '';
  const margin = String(element.margin ?? '0px');
  const align = element.text_align ? `text-align:${element.text_align};` : '';
  const wrap = (inner: string) => `<div style="margin:${margin};${align}">${inner}</div>`;
  switch (element.tag) {
    case 'markdown':
      return wrap(`${icon(element.icon)}<span style="font-size:${size[element.text_size ?? 'normal'] ?? '14px'}">${markdown(element.content, styles)}</span>`);
    case 'div':
      return wrap(`${icon(element.icon)}<span style="font-size:${size[element.text?.text_size ?? 'normal'] ?? '14px'}">${markdown(element.text?.content ?? '', styles)}</span>`);
    case 'button': {
      const kind = element.type === 'danger' ? 'danger' : element.type === 'primary' ? 'primary' : 'default';
      return `<button class="btn ${kind}">${esc(element.text?.content ?? '')}</button>`;
    }
    case 'column_set':
      return wrap(`<div class="row" style="gap:${element.horizontal_spacing ?? '8px'}">${(element.columns ?? [])
        .map((column: any) => `<div class="col" style="${column.width === 'weighted' ? `flex:${column.weight ?? 1}` : 'flex:0 0 auto'}">${(column.elements ?? []).map((child: any) => renderElement(child, styles)).join('')}</div>`)
        .join('')}</div>`);
    case 'collapsible_panel':
      return wrap(`<details class="panel"${element.expanded ? ' open' : ''}><summary>${renderElement({ ...element.header?.title, margin: '0px' }, styles)}<span class="chevron">v</span></summary><div class="panel-body" style="padding:${element.padding ?? '0px'}">${(element.elements ?? []).map((child: any) => renderElement(child, styles)).join('')}</div></details>`);
    case 'interactive_container': {
      const background = element.background_style && styles[element.background_style]
        ? `background:${styles[element.background_style]};` : '';
      return wrap(`<div class="container" style="${background}border-radius:${element.corner_radius ?? '0px'};padding:${element.padding ?? '0px'}">${(element.elements ?? []).map((child: any) => renderElement(child, styles)).join('')}</div>`);
    }
    case 'hr':
      return '<hr>';
    default:
      return wrap(`<span class="unknown">[${esc(String(element.tag ?? '?'))}]</span>`);
  }
}

function renderCard(card: any): string {
  const styles: Record<string, string> = Object.fromEntries(
    Object.entries(card.config?.style?.color ?? {}).map(([name, value]: [string, any]) => [name, value.light_mode]));
  const bar = template[card.header?.template ?? 'blue'] ?? '#3370FF';
  return `<div class="card">
  <div class="card-header" style="background:${bar}">
    <div class="card-title">${esc(card.header?.title?.content ?? '')}</div>
    ${card.header?.subtitle?.content ? `<div class="card-subtitle">${esc(card.header.subtitle.content)}</div>` : ''}
  </div>
  <div class="card-body" style="padding:${card.body?.padding ?? '12px'}">
    ${(card.body?.elements ?? []).map((element: any) => `<div class="stack" style="margin-bottom:${card.body?.vertical_spacing ?? '8px'}">${renderElement(element, styles)}</div>`).join('')}
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
