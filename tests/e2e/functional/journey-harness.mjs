/**
 * 功能 e2e 的共享基建：真实浏览器 → HTTP → 服务端 → SQLite → Agent 进程 → SSE → 界面。
 *
 * ## 这一层要补的洞
 *
 * apps/web/src 有 510 条 dom 测试，但它们**全部 mock 掉 api 层**（`vi.spyOn(api, 'send')`）。
 * 它们证明的是「点了按钮会调用 api.send」，证明不了「指令真的到了 Agent 并且回复真的
 * 流回了界面」。tests/e2e/integration-contracts 是后端策略契约，零 UI 覆盖。中间这段真实链路
 * 由本目录负责。
 *
 * ## 与 scripts/e2e-harness.mjs 的关系
 *
 * 进程编排（临时端口 / 临时数据目录 / 前台 server / 假 CLI / 清理栈）完全复用那一份，
 * 一行都不重写——那套约定已经被两个冒烟脚本验证过，包括「先确认端口空闲，再确认
 * /health 是自己拉起的进程在应答」这条救命的检查。本文件只加**界面旅程**特有的东西：
 * 页面级选择器、旅程级别的等待谓词、以及「内容真的换了」这类跨会话断言。
 *
 * ## 为什么断言写成「内容跟着换」而不是「URL 变了」
 *
 * commit b2b6ccc 修过一次 transcript 串台：同 cwd 的多个会话按 mtime 抢同一份
 * transcript 文件。那个 bug 最恶心的地方是**串台的一支表现为「成功」**——三条会话
 * 全报 completed，其中两条显示的是第三条的回答。只看状态码、只看 URL、只看「有没有
 * 报错」都抓不到它。唯一抓得住的办法是给每条会话一个独一无二的标记，然后断言
 * 「A 的详情页里有 A 的标记，且**没有** B 的标记」。本目录所有涉及多会话的断言都
 * 遵守这条：正向断言 + 反向排除，缺一不可。
 */
import { createRequire } from 'node:module';
import {
  assertPortFree, createCleanupStack, createDataDir, createHttp, createReporter,
  mockAgentsJson, startServer, waitFor, writeMockCli
} from '../../../scripts/e2e-harness.mjs';

const require = createRequire(import.meta.url);
/** @playwright/test 是 CJS，具名导入会失败——必须走 createRequire。 */
export const { chromium } = require('@playwright/test');

export { assertPortFree, createCleanupStack, createDataDir, createHttp, createReporter, mockAgentsJson, startServer, waitFor, writeMockCli };

export const DESKTOP_VIEWPORT = { width: 1440, height: 960 };
/** 390x844 = iPhone 12/13/14 的逻辑分辨率，低于 768px 断点，移动端分支生效。 */
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** 界面文案的单一来源。改文案时只改这里，用例不必逐个搜。 */
export const UI = {
  nav: 'Dutydeck 工作台导航',
  navOpen: '打开工作台导航',
  navClose: '关闭工作台导航',
  overviewTitle: '今天需要推进什么？',
  createTask: '创建任务',
  createFirstTask: '创建第一个任务',
  newTaskDialog: '创建新任务',
  taskGoalField: '任务目标',
  submitTask: '创建并执行',
  composer: '消息',
  send: '发送消息',
  interrupt: '中断当前任务',
  archive: '归档任务',
  archiveDialog: '归档此任务？',
  archiveConfirm: '确认归档',
  archivedReadOnly: '该任务已归档，只能查看历史记录。',
  politeToasts: '[aria-label="操作结果通知"]',
  assertiveToasts: '[aria-label="失败与注意事项通知"]',
  undoCancelledCommand: '恢复这条指令',
  palette: '搜索任务与命令',
  settingsEntry: /Agent 与设置/,
  themeGroup: '界面外观',
};

/** 四个可深链浮层：URL ↔ dialog 名称。见 apps/web/src/app-route.ts。 */
export const OVERLAYS = [
  { panel: 'settings', search: '?panel=settings&section=agents', dialog: 'Dutydeck 设置与接入' },
  { panel: 'lark-setup', search: '?panel=lark-setup', dialog: '绑定飞书 Bot' },
  { panel: 'groups', search: '?panel=groups', dialog: '群配置与权限' },
  { panel: 'automation', search: '?panel=automation', dialog: '任务自动化' },
];

/**
 * 起一个完全隔离的实例：临时端口 + 临时 SQLite + 假 CLI。
 *
 * 绝不碰开发者的 4310 实例、~/.dutydeck 或 ~/.claude——用户的真实工作跑在那上面。
 */
export async function bootIsolatedStack({ port, onCleanup, verbose = false }) {
  await assertPortFree(port);
  const dirs = createDataDir({ onCleanup, prefix: 'dutydeck-journey-' });
  const agentsJson = mockAgentsJson({ mockPath: writeMockCli(dirs.binDir), dirs });
  const base = `http://127.0.0.1:${port}`;
  const server = startServer({ port, dirs, agentsJson, onCleanup, verbose });
  await server.waitUntilReady({ base });
  return { dirs, base, server, request: createHttp(base) };
}

/**
 * 造一条跑完一轮的会话，直接走 HTTP（不经界面）。
 *
 * 用于「给界面准备既有数据」的场景：旅程要测的是切换 / 检索 / 归档，
 * 而不是每次都重跑一遍创建流程。创建流程本身由旅程 2 单独覆盖。
 */
export async function seedCompletedSession(request, { cwd, prompt, agentId = 'claude-code' }) {
  const created = await request('POST', '/api/sessions', { agentId, cwd });
  if (created.status !== 200) throw new Error(`造会话失败：${created.status} ${created.text}`);
  const id = created.json.id;
  const sent = await request('POST', `/api/sessions/${id}/send`, { prompt, mode: 'queue' });
  if (sent.status !== 202) throw new Error(`派发失败：${sent.status} ${sent.text}`);
  await waitFor(`会话 ${id} 跑完一轮`, async () => {
    const session = (await request('GET', `/api/sessions/${id}`)).json;
    if (session?.state === 'failed') throw new Error(`会话进入 failed：${prompt}`);
    return session?.state === 'completed';
  }, { timeoutMs: 60_000, intervalMs: 300 });
  return id;
}

/**
 * 详情页主区的可见文本。
 *
 * 刻意排除侧栏：侧栏里同时列着所有会话的标题，拿整页 innerText 去断言
 * 「没有 B 的标记」永远会失败——B 的标题就明晃晃写在侧栏上。串台断言必须
 * 只看主区，否则它要么恒假、要么被迫放宽到抓不住 bug 的程度。
 */
export async function mainRegionText(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('[aria-label="Dutydeck 工作台导航"]');
    const main = document.querySelector('main') ?? document.body;
    if (!nav || !main.contains(nav)) return main.innerText;
    // 侧栏在 main 里时先摘掉再读，读完放回去（不改变最终 DOM）。
    const placeholder = document.createComment('nav');
    nav.replaceWith(placeholder);
    const text = main.innerText;
    placeholder.replaceWith(nav);
    return text;
  });
}

/** 等主区里出现某个标记，超时报错时把实际文本带出来，便于归因。 */
export async function waitForMainText(page, marker, { timeoutMs = 20_000, label } = {}) {
  return waitFor(label ?? `主区出现「${marker}」`, async () => {
    const text = await mainRegionText(page);
    if (text.includes(marker)) return text;
    return undefined;
  }, { timeoutMs, intervalMs: 250 }).catch(async error => {
    const text = (await mainRegionText(page)).slice(0, 1200);
    throw new Error(`${error.message}\n实际主区文本：\n${text}`);
  });
}

/**
 * 停一条会话，但**绝不让清理拖垮整轮**。
 *
 * 为什么需要它：`POST /stop`（以及 archive / restart）在会话处于忙碌轮次、且当前
 * 没有任何 SSE 订阅者时会**永久挂起**——runtime.stop 走 waitForTurn(id)，而那一轮的
 * 完成回调挂在事件消费链上，没人消费就永远不 resolve。实测：有 SSE 订阅者时
 * archive 117ms 返回，没有时 20s 打满仍未返回。详见交付报告里的缺陷 2。
 *
 * 清理阶段恰好就是「浏览器已经关掉、SSE 订阅者已经没了」的时刻，所以每一次对忙碌
 * 会话的清理性 stop 都会挂死，把整轮 e2e 拖到看门狗超时。这里给它一个上限：
 * 超时就放弃并说明，让进程组 SIGKILL 去收尾（startServer 的清理本来就杀整个进程组）。
 *
 * 这是**测试侧的止损，不是对缺陷的掩盖**：缺陷单独报告，且旅程 4 会正面断言
 * 「中断能让状态正确回落」——那条路径没有这个问题（interrupt 11ms 就返回）。
 */
export async function stopSessionBestEffort(base, sessionId, { timeoutMs = 8_000 } = {}) {
  try {
    const response = await fetch(`${base}/api/sessions/${sessionId}/stop`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
    return `stop -> ${response.status}`;
  } catch (error) {
    if (error?.name === 'TimeoutError') return `stop 超时放弃（已知缺陷：忙碌会话且无 SSE 订阅者时 stop 会挂起），交由进程组清理`;
    return `stop 失败：${error?.message ?? String(error)}（交由进程组清理）`;
  }
}

/** 新建一个 page，并把未捕获异常收集起来（旅程末尾统一断言）。 */
export async function openPage(browser, { viewport = DESKTOP_VIEWPORT, mobile = false } = {}) {
  const context = await browser.newContext({ viewport, ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  return { page, context, pageErrors };
}
