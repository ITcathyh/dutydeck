import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import {
  renderLarkCardElements,
  renderLarkProcessElements,
  renderLarkRecordExport,
  renderLarkResultElements
} from './card-renderer.js';
import { boundLarkCardElements, buildLarkCard, larkCardFinalOutputText, larkCardSnapshotLimits, larkCardSafeLimits, splitLongResult } from './service.js';

const t = (seconds: number) => new Date(1725753600000 + seconds * 1000).toISOString();

const makeEvent = (sequence: number, type: AgentEvent['type'], data: any, timestamp = t(sequence)): AgentEvent => ({
  id: `evt_${sequence}`,
  sessionId: 'ses_layout_test',
  sequence,
  type,
  data,
  timestamp
});

const config = { traceLimit: 20, hideTraceOnComplete: true };

const components = (value: any): any[] => {
  if (Array.isArray(value)) return value.flatMap(components);
  if (!value || typeof value !== 'object') return [];
  return [...(typeof value.tag === 'string' ? [value] : []), ...Object.values(value).flatMap(components)];
};

const byId = (card: any, elementId: string) => components(card).find(el => el.element_id === elementId);

describe('Lark card layout renderer->bound->build integration', () => {
  it('1. running state: current stage in front without overview wrapper, exactly 1 spinner, elapsed time in running history but not completed', () => {
    const events: AgentEvent[] = [
      makeEvent(1, 'text', { text: '阶段 1：先读取配置文件' }, t(1)),
      makeEvent(2, 'tool_call', { id: 't1', name: 'read', input: { path: 'config.json' }, status: 'running', startedAt: t(1) }, t(1)),
      makeEvent(3, 'tool_result', { id: 't1', name: 'read', output: '{"port": 8080}', status: 'completed', completedAt: t(4) }, t(4)),
      makeEvent(4, 'text', { text: '阶段 2：检查数据库连接' }, t(5)),
      makeEvent(5, 'tool_call', { id: 't2', name: 'exec', input: { command: 'nc -z db 5432' }, status: 'running', startedAt: t(5) }, t(5)),
      makeEvent(6, 'tool_result', { id: 't2', name: 'exec', output: 'Connected', status: 'completed', completedAt: t(7) }, t(7)),
      makeEvent(7, 'text', { text: '阶段 3：正在执行集成测试' }, t(8)),
      makeEvent(8, 'tool_call', { id: 't3', name: 'vitest', input: { command: 'pnpm test' }, status: 'running', startedAt: t(8) }, t(8))
    ];

    const elements = renderLarkCardElements(events, config, false);
    const bounded = boundLarkCardElements(elements);
    const card = buildLarkCard({
      state: 'running',
      taskId: 'task_running_1',
      taskName: '自动化构建流水线',
      elapsedSeconds: 25,
      elements: bounded
    });

    // 运行态顶层绝无 trace_overview 折叠外壳
    expect(components(card.body.elements).some(el => el.element_id === 'trace_overview')).toBe(false);

    // 顶部为任务状态与操作栏
    expect(card.body.elements[0]).toMatchObject({ tag: 'column_set', element_id: 'task_action_row' });
    expect(byId(card, 'interrupt')).toBeDefined();

    // 整张卡片 spinner 恰好为 1（仅位于 task_status）
    const spinners = components(card).filter(el => el.token === 'loading_outlined');
    expect(spinners).toHaveLength(1);
    expect(byId(card, 'task_status').icon).toMatchObject({ token: 'loading_outlined' });

    // 当前阶段使用 interactive_container 置前，标题为纯文字不带 spinner，符合合法 schema
    const currentContainer = card.body.elements.find(
      (el: any) => el.tag === 'interactive_container' && el.element_id?.startsWith('trace_group_')
    );
    expect(currentContainer).toBeDefined();
    expect(currentContainer).toMatchObject({
      tag: 'interactive_container',
      behaviors: [],
      background_style: 'current_bg',
      has_border: false,
      corner_radius: '8px'
    });
    expect(Array.isArray(currentContainer.behaviors)).toBe(true);
    expect(currentContainer.behaviors).toHaveLength(0);

    const currentTitle = byId(card, 'current_title');
    expect(currentTitle.content).toContain('阶段 3：正在执行集成测试');
    expect(currentTitle.icon).toBeUndefined();

    // 当前命令摘要默认可见。标题已经完整给出命令、又还没有结果时不套折叠面板——
    // 点开只会看到「暂无内容」，那是个空承诺。
    expect(byId(currentContainer, 'current_records')).toBeUndefined();
    const currentTool = currentContainer.elements.find((el: any) => el.element_id?.startsWith('trace_tool_'));
    expect(currentTool.tag).toBe('markdown');
    // 摘要行写这一步实际跑的命令，不写「运行测试」这类分类名——分类已经由左边的
    // 图标表达，用四个汉字复述一遍只会把命令挤到后半行。
    expect(currentTool.content).toContain('pnpm test');
    expect(currentTool.content).not.toContain('运行测试');
    expect(currentTool.icon).toMatchObject({ token: 'doc-checklist_outlined' });

    // 历史阶段直接排在当前阶段后面的 body 里，中间不再插一行「此前阶段」——
    // 位置本身就说明了它们是历史。没有省略时这一段完全没有标签行。
    expect(JSON.stringify(card)).not.toContain('此前阶段');
    const currentIndex = card.body.elements.findIndex((el: any) => el === currentContainer);
    expect(currentIndex).toBeGreaterThan(0);
    const historyPanels = card.body.elements.slice(currentIndex + 1).filter(
      (el: any) => el.tag === 'collapsible_panel' && el.element_id?.startsWith('trace_group_')
    );
    expect(historyPanels).toHaveLength(2);
    expect(JSON.stringify(historyPanels)).toContain('阶段 1');
    expect(JSON.stringify(historyPanels)).toContain('阶段 2');
    expect(JSON.stringify(historyPanels)).not.toContain('阶段 3');

    // 阶段耗时对比：运行态历史阶段显示已知耗时（t1 到 t4 = 3s）
    expect(historyPanels[0].header.title.content).toContain("<font color='grey'>3s</font>");

    // 完成态下阶段标题统一不显示阶段耗时
    const completedElements = renderLarkCardElements(events, config, true);
    const completedCard = buildLarkCard({ state: 'completed', elements: completedElements });
    const completedGroup0 = components(completedCard).find(el => el.element_id === 'trace_group_0');
    expect(completedGroup0.header.title.content).not.toContain("<font color='grey'>3s</font>");
  });

  it('merges consecutive terminal echo into one block instead of one fake tool per line', () => {
    const events = [
      makeEvent(1, 'text', { text: '消息量很大，继续翻页拉取。' }),
      ...Array.from({ length: 24 }, (_, index) => makeEvent(index + 2, 'raw_terminal', { text: `终端输出 ${index + 1}` }))
    ];
    const card = buildLarkCard({ state: 'running', elapsedSeconds: 31, elements: boundLarkCardElements(renderLarkProcessElements(events, config)) });
    const current = byId(card, 'trace_group_0');
    expect(current.elements).toHaveLength(2);
    expect(current.elements[0]).toMatchObject({ element_id: 'current_title', content: '消息量很大，继续翻页拉取。' });
    // 终端回显不是工具调用：24 条各自套一个工具面板会得到 24 个完全相同、
    // 零信息量的「运行命令 · terminal」标题，真正的输出反而被压进折叠层。
    const records = current.elements[1];
    // 标题不写条数：帧合并去重之后，「多少条事件」和面板里实际有多少内容不再是一回事。
    expect(records).toMatchObject({
      tag: 'collapsible_panel', expanded: false,
      header: { title: { content: '终端输出' } }
    });
    expect(records.elements).toHaveLength(1);
    expect(records.elements[0].content).toContain('终端输出 1');
    expect(records.elements[0].content).toContain('终端输出 24');
    expect(JSON.stringify(card)).not.toContain('terminal');
    // 执行中的状态由 loading 图标承担，状态行不再重复一个「执行中」标签。
    expect(byId(card, 'task_status').text.content).toContain('已用时');
    expect(byId(card, 'task_status').icon).toBeDefined();
  });

  it('keeps failures and approvals visible outside collapsed running records', () => {
    const events = [
      makeEvent(1, 'text', { text: '检查配置' }),
      makeEvent(2, 'tool_result', { id: 'failed', name: 'read', output: '文件不存在', status: 'failed' }),
      makeEvent(3, 'tool_call', { id: 'running', name: 'exec', input: { command: 'pnpm test' }, status: 'running' }),
      makeEvent(4, 'permission_request', { id: 'approval', title: '允许修改配置', status: 'pending' }),
      makeEvent(5, 'error', { message: '配置读取失败' })
    ];
    const card = buildLarkCard({ state: 'running', elements: boundLarkCardElements(renderLarkProcessElements(events, config)) });
    const current = byId(card, 'trace_group_0');
    expect(current.elements[0].content).toContain('失败');
    expect(current.elements[1]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(JSON.stringify(current.elements[1])).toContain('文件不存在');
    expect(JSON.stringify(current.elements[1])).toContain('pnpm test');
    expect(card.body.elements.some((element: any) => element.element_id?.startsWith('risk_alert_pending_'))).toBe(true);
    expect(card.body.elements.some((element: any) => element.element_id?.startsWith('execution_alert_'))).toBe(true);
    expect(byId(card, 'task_status').text.content).toContain('等待审批');
  });

  it('2. history stage: single tool flattens I/O without extra folding, multi-tool preserves tool panels', () => {
    const events: AgentEvent[] = [
      makeEvent(1, 'text', { text: '单工具阶段' }, t(1)),
      makeEvent(2, 'tool_call', { id: 'single_tool', name: 'read', input: { path: 'single.ts' }, status: 'running' }, t(1)),
      makeEvent(3, 'tool_result', { id: 'single_tool', name: 'read', output: 'content of single.ts', status: 'completed' }, t(2)),
      makeEvent(4, 'text', { text: '多工具阶段' }, t(3)),
      makeEvent(5, 'tool_call', { id: 'multi_1', name: 'read', input: { path: 'a.ts' }, status: 'running' }, t(3)),
      makeEvent(6, 'tool_result', { id: 'multi_1', name: 'read', output: 'content a', status: 'completed' }, t(4)),
      makeEvent(7, 'tool_call', { id: 'multi_2', name: 'apply_patch', input: { path: 'b.ts' }, status: 'running' }, t(5)),
      makeEvent(8, 'tool_result', { id: 'multi_2', name: 'apply_patch', output: 'content b', status: 'completed' }, t(6)),
      makeEvent(9, 'text', { text: '全部完成。' }, t(7))
    ];

    const elements = renderLarkCardElements(events, config, true);
    const card = buildLarkCard({ state: 'completed', elements });
    const traceOverview = byId(card, 'trace_overview');
    expect(traceOverview).toBeDefined();

    // 单工具阶段：转换为非折叠容器，子元素含工具标题和 I/O，无二次折叠
    const group0 = components(traceOverview).find(el => el.element_id === 'trace_group_0');
    expect(group0).toMatchObject({ tag: 'collapsible_panel' });
    const tool0Container = group0.elements.find((el: any) => el.element_id === 'trace_tool_0_0');
    expect(tool0Container).toMatchObject({ tag: 'interactive_container', behaviors: [], has_border: false });
    expect(Array.isArray(tool0Container.behaviors)).toBe(true);
    expect(tool0Container.behaviors).toHaveLength(0);
    expect(tool0Container.tag).not.toBe('collapsible_panel');
    expect(JSON.stringify(tool0Container)).toContain('content of single.ts');
    // 标题已经写着 single.ts，展开区不再把同一个路径用 JSON 包一层显示第二遍；
    // 只剩一段内容时也不需要「结果」标签——面板标题已经说明这是哪个工具。
    expect(JSON.stringify(tool0Container)).not.toContain('path');
    expect(JSON.stringify(tool0Container)).not.toContain('输入');
    expect(JSON.stringify(tool0Container)).not.toContain('结果');

    // 多工具阶段：保留独立折叠
    const group1 = components(traceOverview).find(el => el.element_id === 'trace_group_1');
    const toolsInGroup1 = group1.elements.filter((el: any) => el.element_id?.startsWith('trace_tool_1_'));
    expect(toolsInGroup1).toHaveLength(2);
    expect(toolsInGroup1[0]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(toolsInGroup1[1]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    // 同上：标题给出被读写的真实路径，分类由图标表达。
    expect(toolsInGroup1[0].header.title.content).toContain('a.ts');
    expect(toolsInGroup1[0].header.title.icon).toMatchObject({ token: 'file-link-text_outlined' });
    expect(toolsInGroup1[1].header.title.icon).toMatchObject({ token: 'edit_outlined' });
  });

  it('3. raw_terminal normalization: raw-only running, raw-only history, tool+raw history', () => {
    // A: raw-only 在当前运行组
    const runningRawEvents = [
      makeEvent(1, 'raw_terminal', { text: 'Starting server on port 3000 with token=secret123' })
    ];
    const runningRawElements = renderLarkCardElements(runningRawEvents, config, false);
    const runningRawCard = buildLarkCard({ state: 'running', elements: runningRawElements });
    expect(JSON.stringify(runningRawCard)).toContain('Starting server on port 3000');
    expect(JSON.stringify(runningRawCard)).toContain('token=[REDACTED]');
    expect(JSON.stringify(runningRawCard)).not.toContain('secret123');

    // B: raw-only 在历史阶段：不谎称“内部分析已完成”，呈现终端工具且脱敏
    const historyRawEvents = [
      makeEvent(1, 'raw_terminal', { text: 'Building assets with password=rawpassword456' }, t(1)),
      makeEvent(2, 'text', { text: '下一阶段' }, t(2)),
      makeEvent(3, 'tool_call', { id: 't2', name: 'read', input: { path: 'next.ts' }, status: 'running' }, t(2))
    ];
    const historyRawElements = renderLarkCardElements(historyRawEvents, config, false);
    const historyRawCard = buildLarkCard({ state: 'running', elements: historyRawElements });
    const historyGroup = byId(historyRawCard, 'trace_group_0');
    expect(JSON.stringify(historyGroup)).not.toContain('内部分析已完成');
    expect(JSON.stringify(historyGroup)).toContain('Building assets with password=[REDACTED]');
    expect(JSON.stringify(historyGroup)).not.toContain('rawpassword456');

    // C: 工具记录 + 屏幕回显落在同一阶段：只留结构化的那份。
    // 两路讲的是同一批事实——pty-driver 在 transcript 之外还发一路整屏快照做兜底
    // （packages/pty-driver/src/driver.ts:42-48）。一次工具调用在结构化那份里是命令加结果，
    // 在屏幕那份里是几十帧带 TUI 边框的重绘：真实会话实测屏幕行重复率 88–90%，其中 43%
    // 是状态栏和转圈动画。两份都留，等于把这些噪声原样搬进卡片。
    const mixedEvents = [
      makeEvent(1, 'tool_call', { id: 't1', name: 'read', input: { path: 'file.txt' }, status: 'running' }, t(1)),
      makeEvent(2, 'tool_result', { id: 't1', name: 'read', output: 'content', status: 'completed' }, t(2)),
      makeEvent(3, 'raw_terminal', { text: 'Build step succeeded' }, t(3)),
      makeEvent(4, 'text', { text: '完成。' }, t(4))
    ];
    const mixedElements = renderLarkCardElements(mixedEvents, config, true);
    const mixedCard = buildLarkCard({ state: 'completed', elements: mixedElements });
    const group = components(mixedCard).find(el => el.element_id === 'trace_group_0');
    const tools = group.elements.filter((el: any) => el.element_id?.startsWith('trace_tool_'));
    expect(tools).toHaveLength(1);
    // 工具那份记录一个字都不能少。
    expect(JSON.stringify(group)).toContain('file.txt');
    expect(JSON.stringify(group)).toContain('content');
    // 屏幕那份不再单独成块。它在 Dutydeck Web 的完整记录里仍然保留。
    expect(JSON.stringify(group)).not.toContain('Build step succeeded');
    // 降级路径不能一起丢：同一阶段一个工具记录都没有时（transcript 缺席或中途断开），
    // 屏幕回显仍然是唯一的可见性来源，必须照常渲染——由上面 B 段守着。
  });

  it('4. completed state: no result_header, normal_v2 final_output, default collapsed vs hideTraceOnComplete=false expanded', () => {
    const events: AgentEvent[] = [
      makeEvent(1, 'tool_call', { id: 't1', name: 'Bash', input: { command: 'ls' }, status: 'running' }),
      makeEvent(2, 'tool_result', { id: 't1', name: 'Bash', output: 'file.txt', status: 'completed' }),
      makeEvent(3, 'text', { text: '这是任务最终结论，应当常显。' })
    ];

    // 默认 hideTraceOnComplete: true
    const defaultElements = renderLarkCardElements(events, { ...config, hideTraceOnComplete: true }, true);
    const defaultCard = buildLarkCard({ state: 'completed', elapsedSeconds: 88, elements: defaultElements });

    expect(byId(defaultCard, 'result_header')).toBeUndefined();
    expect(byId(defaultCard, 'final_output')).toMatchObject({
      tag: 'markdown',
      text_size: 'normal_v2',
      content: '这是任务最终结论，应当常显。'
    });

    // 全部成功时不挂计数行：任务进入终态本身就意味着步骤都结束了，
    // 「N 个工具已结束」不改变任何判断，却压在最终结论正下方跟结论抢注意力。
    expect(byId(defaultCard, 'evidence')).toBeUndefined();

    const defaultOverview = byId(defaultCard, 'trace_overview');
    expect(defaultOverview).toMatchObject({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { content: '执行记录' } }
    });

    // hideTraceOnComplete: false
    const expandedElements = renderLarkCardElements(events, { ...config, hideTraceOnComplete: false }, true);
    const expandedCard = buildLarkCard({ state: 'completed', elements: expandedElements });
    expect(byId(expandedCard, 'trace_overview')).toMatchObject({
      tag: 'collapsible_panel',
      expanded: true
    });
  });

  it('4b. 步骤数只算真实工具；最后失败的步骤只上失败卡，完成卡不再挂失败计数', () => {
    const stepsOf = (elements: any[]) => byId(elements, 'trace_steps')?.content;
    // 纯 raw 完成：没有真实工具调用，不写步数，更不伪造失败
    const rawOnlyEvents = [
      makeEvent(1, 'raw_terminal', { text: 'Running automated bootstrap' }),
      makeEvent(2, 'text', { text: '初始化完成。' })
    ];
    const rawOnly = renderLarkProcessElements(rawOnlyEvents, config, true);
    expect(stepsOf(rawOnly)).toBeUndefined();
    expect(byId(rawOnly, 'failure_step')).toBeUndefined();

    // 真实工具全部成功 + 若干 raw：终端回显不算步骤
    const mixedEvents = [
      makeEvent(1, 'raw_terminal', { text: 'pre-step raw log 1' }),
      makeEvent(2, 'tool_call', { id: 'real_tool', name: 'read', input: { path: 'a.txt' }, status: 'running' }),
      makeEvent(3, 'tool_result', { id: 'real_tool', name: 'read', output: 'content', status: 'completed' }),
      makeEvent(4, 'raw_terminal', { text: 'post-step raw log 2' }),
      makeEvent(5, 'raw_terminal', { text: 'post-step raw log 3' }),
      makeEvent(6, 'text', { text: '执行完成。' })
    ];
    const mixed = renderLarkProcessElements(mixedEvents, config, true);
    expect(stepsOf(mixed)).toBe('共 1 步');
    expect(byId(mixed, 'failure_step')).toBeUndefined();

    const failedEvents = [
      makeEvent(1, 'raw_terminal', { text: 'pre-step raw log 1' }),
      makeEvent(2, 'tool_result', { id: 'broken_tool', name: 'read', input: { path: 'missing.json' }, output: '文件不存在', status: 'failed' }),
      makeEvent(3, 'raw_terminal', { text: 'post-step raw log 2' }),
      makeEvent(4, 'raw_terminal', { text: 'post-step raw log 3' }),
      makeEvent(5, 'text', { text: '执行完成，但有步骤失败。' })
    ];
    const failedElements = renderLarkProcessElements(failedEvents, config, true);
    expect(stepsOf(failedElements)).toBe('共 1 步');
    // 失败卡：最后失败的步骤排在正文第一块，写出是哪一步、输出的最后一行
    const failedCard: any = buildLarkCard({ cardKind: 'process', state: 'failed', elements: failedElements });
    const failure = failedCard.body.elements[0];
    expect(failure).toMatchObject({ element_id: 'failure_step', background_style: 'failure_bg' });
    expect(JSON.stringify(failure)).toContain('最后失败的步骤');
    expect(JSON.stringify(failure)).toContain('missing.json');
    expect(JSON.stringify(failure)).toContain('输出末行 `文件不存在`');
    // 完成卡：任务已经成功收尾，早先失败过的步骤不再单独挂一行
    for (const cardKind of ['process', 'result'] as const) {
      const card = buildLarkCard({ cardKind, state: 'completed', elements: cardKind === 'process' ? failedElements : renderLarkResultElements(failedEvents, config) });
      expect(byId(card, 'failure_step')).toBeUndefined();
      expect(byId(card, 'evidence')).toBeUndefined();
      expect(JSON.stringify(card)).not.toContain('个步骤失败');
    }
    // 旧快照里的失败计数行在重绘时一并丢掉
    const legacy = buildLarkCard({ cardKind: 'result', state: 'completed', elements: [
      { tag: 'markdown', element_id: 'final_output', content: '完成。' },
      { tag: 'markdown', element_id: 'evidence', content: '执行中曾有 1 个步骤失败，历史记录不代表仍有未解决问题。' }
    ] });
    expect(JSON.stringify(legacy)).not.toContain('执行中曾有');
  });

  it('does not add a generic missing-result instruction when a concrete error is present', () => {
    const elements = renderLarkCardElements([
      makeEvent(1, 'error', { message: 'Claude 启动尚未就绪，请打开终端处理启动确认后再发送任务。' }),
    ], config, true);
    const card = buildLarkCard({ state: 'failed', elements });
    expect(byId(card, 'execution_alert_0').content).toContain('Claude 启动尚未就绪');
    expect(byId(card, 'result_missing')).toBeUndefined();
  });

  it('5. process vs result view separation: process has no final_output/evidence, result has no trace', () => {
    const longConclusion = '详细执行报告：\n' + 'line '.repeat(1000);
    const events: AgentEvent[] = [
      makeEvent(1, 'tool_call', { id: 't1', name: 'Bash', input: { command: 'whoami' }, status: 'running' }),
      makeEvent(2, 'tool_result', { id: 't1', name: 'Bash', output: 'root', status: 'completed' }),
      makeEvent(3, 'text', { text: longConclusion })
    ];

    const processElements = renderLarkProcessElements(events, config, true);
    const processCard = buildLarkCard({ state: 'completed', elements: processElements });
    expect(byId(processCard, 'final_output')).toBeUndefined();
    expect(byId(processCard, 'result_missing')).toBeUndefined();
    expect(byId(processCard, 'evidence')).toBeUndefined();
    expect(byId(processCard, 'trace_overview')).toBeDefined();

    const resultElements = renderLarkResultElements(events);
    const resultCard = buildLarkCard({ state: 'completed', elements: resultElements });
    const resultFinal = byId(resultCard, 'final_output');
    expect(resultFinal).toBeDefined();
    expect(resultFinal.content).toBe(longConclusion.trim());
    // 结果卡就是答案本身：全部成功时结论下面不再跟一行工具计数。
    expect(byId(resultCard, 'evidence')).toBeUndefined();
    expect(byId(resultCard, 'trace_overview')).toBeUndefined();
  });

  it('6. realistic long final output: code blocks, changes and caveats intact at normal_v2 without being folded', () => {
    const fullConclusion = `### 最终执行结论

\`\`\`typescript
export function restoreSession(sessionId: string) {
  return registry.get(sessionId) ?? registry.create(sessionId);
}
\`\`\`

**变更项**：
1. 修复断网重连退避算法
2. 增加持久化会话同步校验机制
3. 移除重复状态轮询

**未验证事项**：
- 跨地域多机房双活网络抖动待灰度验证
- 离线消息拉取在极端超时条件下的重试待 E2E 压测覆盖`;

    const events: AgentEvent[] = [
      makeEvent(1, 'tool_call', { id: 't1', name: 'read', input: { path: 'session.ts' }, status: 'running' }),
      makeEvent(2, 'tool_result', { id: 't1', name: 'read', output: 'ok', status: 'completed' }),
      makeEvent(3, 'text', { text: fullConclusion })
    ];

    const elements = renderLarkCardElements(events, config, true);
    const card = buildLarkCard({ state: 'completed', elements });

    const finalOutput = byId(card, 'final_output');
    expect(finalOutput).toMatchObject({
      tag: 'markdown',
      text_size: 'normal_v2',
      content: fullConclusion
    });
    // 未验证事项未被折叠进 trace_overview 内部
    const overview = byId(card, 'trace_overview');
    expect(JSON.stringify(overview)).not.toContain('未验证事项');
    expect(JSON.stringify(card)).toContain('跨地域多机房双活网络抖动');
  });

  it('7. secrets redaction: prevents leaking credentials and PEM private keys while preserving normal text', () => {
    const events: AgentEvent[] = [
      makeEvent(1, 'thinking', { text: 'PRIVATE_THINKING_PROCESS: 用户凭据为 sk-secret1234567890' }),
      makeEvent(2, 'tool_call', {
        id: 't_sec',
        name: 'curl',
        input: { command: 'curl -H "Authorization: Bearer my-secret-token-abc" https://api.example.com --api-key=secret_key_123' },
        status: 'running'
      }),
      makeEvent(3, 'tool_result', {
        id: 't_sec',
        name: 'curl',
        output: 'response: {"private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----"}',
        status: 'completed'
      }),
      makeEvent(4, 'text', { text: '正常结论文本：任务已完成。' })
    ];

    const elements = renderLarkCardElements(events, config, true);
    const card = buildLarkCard({ state: 'completed', elements });
    const rendered = JSON.stringify(card);

    expect(rendered).not.toContain('PRIVATE_THINKING_PROCESS');
    expect(rendered).not.toContain('my-secret-token-abc');
    expect(rendered).not.toContain('secret_key_123');
    expect(rendered).not.toContain('MIIEvgIBADANBgkqhkiG9w0BAQEFAASC');
    expect(rendered).toContain('Authorization: [REDACTED]');
    expect(rendered).toContain('api-key=[REDACTED]');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).toContain('正常结论文本：任务已完成。');
  });

  it.each(['--turn scoped_turn_secret', '--turn=scoped_turn_secret', '--turn "scoped_turn_secret"', "--turn='scoped_turn_secret'"])('hides collaboration capability %s in tool cards', flag => {
    const command = `dutydeck collaborate ${flag} status`;
    const events = [
      makeEvent(1, 'tool_call', { id: 'collaborate', name: command, input: { command }, status: 'running' }),
      makeEvent(2, 'tool_result', { id: 'collaborate', name: command, output: command, status: 'completed' })
    ];
    const rendered = JSON.stringify(buildLarkCard({ state: 'completed', elements: renderLarkCardElements(events, { ...config, hideTraceOnComplete: false }, true) }));
    expect(rendered).not.toContain('scoped_turn_secret');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).toContain('dutydeck collaborate');
  });

  it('8. budget bounds on multi-group cards: assert input exceeds snapshot limits, then assert bounded limits and key data preservation', () => {
    const manyEvents: AgentEvent[] = [
      makeEvent(1, 'permission_request', { id: 'perm_important', title: '核心权限保留', status: 'approved' })
    ];

    // 每阶段多个工具并附带大量输入输出，确保原始元素显著超出快照限额
    for (let i = 1; i <= 15; i++) {
      manyEvents.push(
        makeEvent(i * 4, 'text', { text: `第 ${i} 阶段执行过程描述 ${'long_text '.repeat(30)}` }),
        makeEvent(i * 4 + 1, 'tool_call', { id: `t_${i}_1`, name: 'Bash', input: { command: `cmd_1_${i} ${'arg '.repeat(100)}` }, status: 'running' }),
        makeEvent(i * 4 + 2, 'tool_result', { id: `t_${i}_1`, name: 'Bash', output: `out_1_${i}: ${'data '.repeat(100)}`, status: 'completed' }),
        makeEvent(i * 4 + 3, 'tool_call', { id: `t_${i}_2`, name: 'Bash', input: { command: `cmd_2_${i} ${'arg '.repeat(100)}` }, status: 'running' }),
        makeEvent(i * 4 + 4, 'tool_result', { id: `t_${i}_2`, name: 'Bash', output: `out_2_${i}: ${'data '.repeat(100)}`, status: 'completed' })
      );
    }
    manyEvents.push(makeEvent(100, 'text', { text: '最终总结结论：压力测试执行完毕。' }));

    const rawElements = renderLarkCardElements(manyEvents, { traceLimit: 50 }, true);

    // 必须首先证明原始输入确实超过了快照限制
    const rawBytes = Buffer.byteLength(JSON.stringify(rawElements), 'utf8');
    const rawComps = components(rawElements).length;
    expect(rawBytes > larkCardSnapshotLimits.bytes || rawComps > larkCardSnapshotLimits.components).toBe(true);

    // 修剪后严格符合快照上限
    const bounded = boundLarkCardElements(rawElements);
    const boundedBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
    const boundedComps = components(bounded).length;
    expect(boundedBytes).toBeLessThanOrEqual(larkCardSnapshotLimits.bytes);
    expect(boundedComps).toBeLessThanOrEqual(larkCardSnapshotLimits.components);

    // 组装最终卡片符合安全上限（24KB / 180 组件）
    const card = buildLarkCard({ state: 'completed', elements: bounded });
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(components(card).length).toBeLessThanOrEqual(larkCardSafeLimits.components);

    // 终态结论、风险权限、最新阶段、省略提示均得到保全
    expect(byId(card, 'final_output')?.content).toContain('最终总结结论');
    expect(JSON.stringify(card)).toContain('核心权限保留');
    expect(JSON.stringify(card)).toContain('第 15 阶段');
    expect(JSON.stringify(card)).toContain('另有 10 个更早阶段未展示');
  });

  it('9. budget bounds on single running group with many tools: does not silently drop latest command', () => {
    // 构造单组包含 25 个工具调用，组件数与体积超标
    const singleGroupEvents: AgentEvent[] = [
      makeEvent(1, 'text', { text: '当前正在执行单组大量动作' })
    ];
    for (let i = 1; i <= 25; i++) {
      singleGroupEvents.push(
        makeEvent(i * 2, 'tool_call', {
          id: `single_tool_${i}`,
          name: 'Bash',
          input: { command: `heavy_step_${i} ${'arg '.repeat(80)}` },
          status: i === 25 ? 'running' : 'completed'
        })
      );
      if (i < 25) {
        singleGroupEvents.push(
          makeEvent(i * 2 + 1, 'tool_result', {
            id: `single_tool_${i}`,
            name: 'Bash',
            output: `result_${i}: ${'output '.repeat(80)}`,
            status: 'completed'
          })
        );
      }
    }

    const rawElements = renderLarkCardElements(singleGroupEvents, config, false);
    const rawComps = components(rawElements).length;
    expect(rawComps).toBeGreaterThan(larkCardSnapshotLimits.components);

    const bounded = boundLarkCardElements(rawElements);
    expect(components(bounded).length).toBeLessThanOrEqual(larkCardSnapshotLimits.components);

    const card = buildLarkCard({ state: 'running', elements: bounded });
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(components(card).length).toBeLessThanOrEqual(larkCardSafeLimits.components);

    // 最新正在执行的命令 heavy_step_25 绝不丢失
    expect(JSON.stringify(card)).toContain('heavy_step_25');
    // 当前阶段标题保留
    expect(byId(card, 'current_title')).toBeDefined();
    const records = byId(card, 'current_records');
    expect(records).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(records.header.title.content).toBe(`执行记录（${records.elements.length} 条）`);
    expect(records.elements.length).toBeGreaterThan(1);
    expect(JSON.stringify(records.elements.at(-1))).toContain('heavy_step_25');
  });

  it('10. readOnly card security: clears action buttons while keeping footer web link', () => {
    const card: any = buildLarkCard({
      state: 'running',
      taskId: 'readonly_task',
      readOnly: true,
      sessionId: 'ses_secure_123',
      webBaseUrl: 'https://dutydeck.example.com'
    });

    expect(byId(card, 'interrupt')).toBeUndefined();
    expect(byId(card, 'retry')).toBeUndefined();
    expect(byId(card, 'cancel')).toBeUndefined();

    const footer = card.body.elements.at(-1);
    expect(JSON.stringify(footer)).toContain('[查看详情](https://dutydeck.example.com/sessions/ses_secure_123)');
  });

  it('11. P2-1 regression: bounds oversized narrative body before pruning stages when followed by error/permission', () => {
    const hugeAssistantText = '这是一段非常长的部分答复文本，用于重现 18KB 阶段正文超限场景。'.repeat(600); // >18KB
    expect(hugeAssistantText.length).toBeGreaterThan(15000);
    expect(Buffer.byteLength(hugeAssistantText, 'utf8')).toBeGreaterThan(18000);

    const events: AgentEvent[] = [
      makeEvent(1, 'text', { text: '阶段 1：已读取初始配置' }, t(1)),
      makeEvent(2, 'tool_call', { id: 't1', name: 'read', input: { path: 'init.json' }, status: 'running' }, t(1)),
      makeEvent(3, 'tool_result', { id: 't1', name: 'read', output: 'ok', status: 'completed' }, t(2)),
      makeEvent(4, 'text', { text: hugeAssistantText }, t(3)),
      makeEvent(5, 'permission_request', { id: 'perm_critical', title: '高危权限审批：覆盖关键配置', status: 'pending' }, t(4)),
      makeEvent(6, 'error', { message: '下游执行器未响应' }, t(5))
    ];

    const rawElements = renderLarkCardElements(events, config, true);
    const bounded = boundLarkCardElements(rawElements);
    const card = buildLarkCard({ state: 'failed', elements: bounded });

    // 符合预算上限
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(larkCardSnapshotLimits.bytes);
    expect(components(bounded).length).toBeLessThanOrEqual(larkCardSnapshotLimits.components);
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(components(card).length).toBeLessThanOrEqual(larkCardSafeLimits.components);

    // 先前阶段摘要、阶段正文截断提示、审批风险与错误提醒均完整保留，绝未被整组抹掉
    expect(JSON.stringify(card)).toContain('阶段 1：已读取初始配置');
    expect(JSON.stringify(card)).toContain('内容过长，已截断');
    expect(JSON.stringify(card)).toContain('高危权限审批');
    expect(JSON.stringify(card)).toContain('下游执行器未响应');
  });

  it('12. P2-2 regression: preserves flattened single-tool summary when pruning Chinese I/O across 5 stages', () => {
    const events: AgentEvent[] = [];
    for (let i = 1; i <= 5; i++) {
      events.push(
        makeEvent(i * 3, 'text', { text: `阶段 ${i}：执行中文工具操作，${'并逐项核对配置项与依赖版本'.repeat(6)}` }, t(i * 3)),
        makeEvent(i * 3 + 1, 'tool_call', {
          id: `tool_${i}`,
          name: 'read',
          input: { path: `重要配置_${i}.json`, command: `读取中文配置内容_${i} ${'参数 '.repeat(100)}` },
          status: 'running'
        }, t(i * 3 + 1)),
        makeEvent(i * 3 + 2, 'tool_result', {
          id: `tool_${i}`,
          name: 'read',
          output: `执行结果数据返回_${i}：${'详细中文输出内容，体积较大，用于促使裁剪器剥离工具输入输出。 '.repeat(100)}`,
          status: 'completed'
        }, t(i * 3 + 2))
      );
    }
    events.push(makeEvent(20, 'text', { text: '终态：全部完成。' }, t(20)));

    const rawElements = renderLarkCardElements(events, { traceLimit: 10 }, true);

    // 验证输入确实超出了快照限制，能够触发裁剪
    expect(Buffer.byteLength(JSON.stringify(rawElements), 'utf8')).toBeGreaterThan(larkCardSnapshotLimits.bytes);

    // 覆盖快照裁剪器 boundLarkCardElements
    const bounded = boundLarkCardElements(rawElements);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(larkCardSnapshotLimits.bytes);

    // 验证裁剪后保留下来的单工具阶段，展开容器中依然包含工具标题/命令摘要，而非变成空壳
    const boundedGroup0 = bounded.find((el: any) => el.element_id === 'trace_group_0') as Record<string, unknown>;
    expect(boundedGroup0).toBeDefined();
    const boundedToolContainer = (boundedGroup0.elements as any[]).find(el => el.element_id?.startsWith('trace_tool_'));
    expect(boundedToolContainer).toBeDefined();
    expect(boundedToolContainer.elements).toHaveLength(1); // 仅保留 elements[0] 工具标题摘要
    expect(boundedToolContainer.elements[0].content).toContain('读取中文配置内容_1');
    expect(boundedToolContainer.elements[0].icon).toMatchObject({ token: 'file-link-text_outlined' });

  });

  it('preserves flattened summaries when the full card independently exceeds its byte budget', () => {
    const events = Array.from({ length: 5 }, (_, i) => [
      makeEvent(i * 3, 'text', { text: `阶段 ${i} 检查配置` }),
      makeEvent(i * 3 + 1, 'tool_call', { id: `t${i}`, name: 'Bash', input: { command: `command_${i} ${'中文参数'.repeat(100)}` }, status: 'running' }, t(i * 3 + 1)),
      // 4s 的步骤耗时高于「值得注意」阈值，因此摘要行里应当保留耗时。
      makeEvent(i * 3 + 2, 'tool_result', { id: `t${i}`, name: 'Bash', output: '中文输出结果'.repeat(100), status: 'completed' }, t(i * 3 + 5))
    ]).flat();
    events.push(makeEvent(20, 'text', { text: '最终结果。' }));
    const source = renderLarkCardElements(events, { traceLimit: 50 }, true);
    const baseline = buildLarkCard({ state: 'completed', elements: structuredClone(source) });
    const baselineBytes = Buffer.byteLength(JSON.stringify(baseline));
    expect(baselineBytes).toBeLessThan(larkCardSafeLimits.bytes);
    const padding = 'a'.repeat(larkCardSafeLimits.bytes + 128 - baselineBytes);
    source.find(e => e.element_id === 'final_output')!.content += padding;
    byId(baseline, 'final_output').content += padding;
    expect(Buffer.byteLength(JSON.stringify(baseline))).toBeGreaterThan(larkCardSafeLimits.bytes);

    // No snapshot bounding first: buildLarkCard must perform this trim itself.
    const card = buildLarkCard({ state: 'completed', elements: source });
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    const tool = byId(card, 'trace_tool_0_0');
    expect(tool.elements).toHaveLength(1);
    expect(tool.elements[0].content).toContain('command_0');
    // 成功的步骤不点灯：绿灯只是把「没有异常」重复一遍，还会淹掉真正的失败灯。
    expect(tool.elements[0].content).not.toContain('trace_success');
    expect(tool.elements[0].content).toContain('4s');
    expect(byId(card, 'final_output').content).toBe(`最终结果。${padding}`);
  });

  it('13. 省略输入只在标题真的把输入说清楚时发生，字段名本身有信息的不省', () => {
    const rendered = (input: unknown, name = 'Bash') => JSON.stringify(renderLarkCardElements([
      makeEvent(1, 'tool_result', { id: 'probe', name, input, output: 'ok', status: 'completed' })
    ], config, true));

    // 标题写着「运行命令 · pnpm test」，展开区再放一份 {"command":"pnpm test"} 是负信噪比。
    expect(rendered({ command: 'pnpm test' })).not.toContain('输入');
    // cwd 是工作目录，不是被执行的命令。标题会渲染成「运行命令 · /srv/repo」，
    // 此时那层 JSON 是唯一能说清「这是 cwd」的东西，必须留。
    expect(rendered({ cwd: '/srv/repo' })).toContain('输入');
    expect(rendered({ cwd: '/srv/repo' })).toContain('cwd');
    // 多字段、数组、嵌套对象都不算「标题说清楚了」。
    expect(rendered({ command: 'ls', timeout: 30 })).toContain('输入');
    expect(rendered(['ls', '-la'])).toContain('输入');
    expect(rendered({ args: { command: 'ls -la' } })).toContain('输入');
    // 零参工具的输入序列化成 `{}`，展开只会看到一对括号。
    expect(rendered({}, 'git_status')).not.toContain('输入');
    // 标题被截断时，完整命令必须还能在展开区拿到。
    const long = `deploy --target ${'a'.repeat(200)}`;
    expect(rendered({ command: long })).toContain('输入');
  });

  it('14a. 终端回显合并后头尾都保留，只省略中间', () => {
    // 只出现一次的关键行几乎总在开头：命令回显、第一条报错。只留尾部会把它彻底丢掉。
    const noisy = [
      makeEvent(1, 'raw_terminal', { text: 'FAIL src/critical.test.ts > 用户支付链路断裂' }),
      ...Array.from({ length: 40 }, (_, index) =>
        makeEvent(index + 2, 'raw_terminal', { text: `覆盖率行 ${index + 1}：${'统计数据 '.repeat(12)}` })),
      makeEvent(60, 'raw_terminal', { text: '最后一行：Coverage 78.4%' })
    ];
    const merged = JSON.stringify(renderLarkCardElements(noisy, config, true));
    expect(merged).toContain('critical.test.ts');
    expect(merged).toContain('Coverage 78.4%');
    expect(merged).toContain('已省略中间');
  });

  it('14b. 终端回显先拼接再脱敏，跨条目的私钥体不会漏进卡片', () => {
    // stderr 是逐行发事件的，一份多行私钥必然被切成多条 raw_terminal。逐条脱敏时
    // 只有带 BEGIN 标记的那一条被替换，密钥体所在的几条一个规则都不命中。
    const dumped = JSON.stringify(renderLarkCardElements([
      makeEvent(1, 'raw_terminal', { text: '-----BEGIN PRIVATE KEY-----' }),
      makeEvent(2, 'raw_terminal', { text: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj' }),
      makeEvent(3, 'raw_terminal', { text: '-----END PRIVATE KEY-----' })
    ], config, true));
    expect(dumped).toContain('[REDACTED_PRIVATE_KEY]');
    expect(dumped).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEF');

    // 代价写在断言里：一条含 BEGIN 字样、又没等到 END 的输出会把后面的内容一起吞掉。
    // 宁可让读者去 Web 看全文，也不能把密钥发进群。
    const truncated = JSON.stringify(renderLarkCardElements([
      makeEvent(1, 'raw_terminal', { text: 'error: file starts with -----BEGIN PRIVATE KEY-----' }),
      makeEvent(2, 'raw_terminal', { text: 'deploy step 2 finished' })
    ], config, true));
    expect(truncated).toContain('[REDACTED_PRIVATE_KEY]');
    expect(truncated).not.toContain('deploy step 2 finished');
  });

  it('14c. 空白回显不占面板也不算条数，单条终端记录与单个工具一样被摊平', () => {
    const blanks = renderLarkCardElements([
      makeEvent(1, 'raw_terminal', { text: '\n' }),
      makeEvent(2, 'raw_terminal', { text: '   ' }),
      makeEvent(3, 'raw_terminal', { text: '真实输出' }),
      makeEvent(4, 'raw_terminal', { text: '\n' })
    ], config, true);
    const panels = components(blanks).filter(element => String(element.element_id ?? '').startsWith('trace_tool_'));
    expect(panels).toHaveLength(1);
    expect(JSON.stringify(panels)).not.toContain('（4 条）');

    // 阶段本身已经是一层折叠，单条记录再套一层意味着读者要点三次才看到内容。
    const single = buildLarkCard({ state: 'completed', elements: renderLarkCardElements([
      makeEvent(1, 'text', { text: '继续翻页拉取。' }),
      makeEvent(2, 'raw_terminal', { text: 'fetched 200 messages' }),
      makeEvent(3, 'raw_terminal', { text: 'fetched 200 messages' }),
      makeEvent(4, 'text', { text: '拉取完成。' })
    ], config, true) });
    const flattened = byId(single, 'trace_group_0').elements
      .find((element: any) => String(element.element_id ?? '').startsWith('trace_tool_'));
    expect(flattened.tag).toBe('interactive_container');
    expect(JSON.stringify(flattened)).toContain('fetched 200 messages');
  });

  it('15. 裁剪器把折叠面板剥到只剩一段，绝不剥成点开无内容的空壳', () => {
    // 元素手工构造而不是走渲染器：这条断言只在「剥一次刚好回到预算内」的窗口里成立，
    // 用真实事件去凑那个字节窗口，任何渲染改动都会让它悄悄失去覆盖。
    // 两段各 9000 字节，剥掉一段（约 -9KB）就从 ~18.6KB 回到 16KB 预算内。
    const section = (marker: string) => ({ tag: 'markdown', content: `${marker}${'x'.repeat(9_000)}`, text_size: 'notation', margin: '0px' });
    const elements = [
      { tag: 'markdown', element_id: 'final_output', content: '最终结论。', text_align: 'left', text_size: 'normal_v2', margin: '0px' },
      {
        tag: 'collapsible_panel', element_id: 'trace_group_0', expanded: false,
        header: { title: { tag: 'markdown', content: '终端输出（20 条）' } },
        elements: [{
          tag: 'collapsible_panel', element_id: 'trace_tool_0_0', expanded: false,
          header: { title: { tag: 'markdown', content: '终端输出（20 条）' } },
          elements: [section('KEPT_'), section('DROPPED_')]
        }]
      }
    ];
    expect(Buffer.byteLength(JSON.stringify(elements), 'utf8')).toBeGreaterThan(larkCardSnapshotLimits.bytes);

    const bounded = boundLarkCardElements(elements);
    expect(Buffer.byteLength(JSON.stringify(bounded), 'utf8')).toBeLessThanOrEqual(larkCardSnapshotLimits.bytes);
    // 面板还在，所以它必须还有内容：一个点开什么都没有的箭头承诺了内容却不给，
    // 比整组删掉更糟——整组删掉至少会附上省略提示。
    const panel = components(bounded).find(element => element.element_id === 'trace_tool_0_0');
    expect(panel).toBeDefined();
    expect(panel.elements).toHaveLength(1);
    expect(panel.elements[0].content).toContain('KEPT_');
  });

  it('16. 失败的步骤所在阶段已不在卡上时，失败卡仍直接写出这一步，不把读者指到执行记录', () => {
    // 失败发生在第一个阶段，而卡片只渲染最近五个阶段。
    const events: AgentEvent[] = [
      makeEvent(1, 'text', { text: '阶段 0：检查配置' }),
      makeEvent(2, 'tool_result', { id: 'broken', name: 'read', input: { path: 'missing.json' }, output: '文件不存在', status: 'failed' })
    ];
    for (let stage = 1; stage <= 7; stage++) {
      events.push(
        makeEvent(stage * 2 + 1, 'text', { text: `阶段 ${stage}：继续执行` }),
        makeEvent(stage * 2 + 2, 'tool_result', { id: `ok_${stage}`, name: 'Bash', input: { command: `step_${stage}` }, output: 'ok', status: 'completed' })
      );
    }
    events.push(makeEvent(100, 'text', { text: '执行完成。' }));
    const elements = renderLarkCardElements(events, config, true);
    expect(JSON.stringify(elements.filter(element => element.element_id !== 'failure_step'))).not.toContain('missing.json');

    const failed = buildLarkCard({ cardKind: 'process', state: 'failed', elements });
    const failure = JSON.stringify(byId(failed, 'failure_step'));
    expect(failure).toContain('missing.json');
    expect(failure).toContain('文件不存在');
    expect(failure).not.toContain('执行记录');
    // 步数按全部阶段算，包括卡上省略掉的更早阶段。
    expect(byId(elements, 'trace_steps').content).toBe('共 8 步');

    const completed = buildLarkCard({ cardKind: 'process', state: 'completed', elements });
    expect(JSON.stringify(completed)).not.toContain('missing.json');
    expect(byId(completed, 'task_overview').header.title.content).toContain('共 8 步');
  });

  it('17. 终端输出掐中间时，被掐掉那段里的报错行单独保留', () => {
    // 一整屏 PASS 里那一行 FAIL 是读者唯一要读的东西。按字符位置连同翻页噪声
    // 一起丢掉，卡上就只剩「1 failed」而看不到失败在哪。
    const lines = ['> dutydeck@0.1.0 test  (node:12345) ExperimentalWarning: tsx is experimental'];
    for (let index = 0; index < 6; index++) lines.push(`PASS  packages/core/src/module_${index}/index.test.ts (8 tests | 0 skipped) 120ms`);
    lines.push('FAIL  packages/pay/src/payment.test.ts > 支付回调签名校验失败');
    for (let index = 0; index < 20; index++) lines.push(`PASS  packages/other/src/feature_${index}/deep/nested/index.test.ts (5 tests) 90ms`);
    lines.push('Tests  1 failed | 123 passed');

    const rendered = renderLarkCardElements([
      makeEvent(1, 'text', { text: '跑测试' }),
      ...lines.map((line, index) => makeEvent(index + 2, 'raw_terminal', { text: `${line}\n` }))
    ], config, true);
    const body = components(rendered)
      .map(element => String(element.content ?? ''))
      .find(content => content.startsWith('```text'))!;
    expect(body).toContain('已省略中间');
    expect(body).toContain('其中的报错行保留如下');
    expect(body).toContain('FAIL  packages/pay/src/payment.test.ts');
    // 头尾照旧保留，报错行是额外捞回来的，不是靠放大窗口蒙到的。
    expect(body).toContain('> dutydeck@0.1.0 test');
    expect(body).toContain('Tests  1 failed | 123 passed');
    expect(body).not.toContain('feature_10/deep');
  });

  it('18. 什么都没留下的阶段退化成一行标题，不是点开是空的折叠面板', () => {
    // PTY 起手的换行和提示符是纯空白回显，被跳过后这个阶段一条记录都不剩。
    const rendered = renderLarkCardElements([
      makeEvent(1, 'raw_terminal', { text: '\r\n' }),
      makeEvent(2, 'raw_terminal', { text: '   ' }),
      makeEvent(3, 'text', { text: '完成' })
    ], config, true);
    const groups = components(rendered).filter(element => String(element.element_id ?? '').startsWith('trace_group_'));
    expect(groups).toHaveLength(1);
    expect(groups[0].tag).toBe('markdown');
    expect(groups[0].content).toContain('执行过程');
    expect(components(rendered).some(element => element.tag === 'collapsible_panel' && !element.elements?.length)).toBe(false);
  });

  it('19. 非运行态把所有阶段收进执行记录时，省略提示不会整行消失', () => {
    const events: AgentEvent[] = [];
    for (let stage = 0; stage < 8; stage++) {
      events.push(
        makeEvent(stage * 2 + 1, 'text', { text: `第 ${stage + 1} 步` }),
        makeEvent(stage * 2 + 2, 'tool_result', { id: `t${stage}`, name: 'Bash', input: { command: `echo step${stage}` }, output: 'ok', status: 'completed' })
      );
    }
    const elements = renderLarkProcessElements(events, config, false);
    // 两种布局各自取一条 trace_omission，措辞相同。
    for (const state of ['running', 'queued'] as const) {
      expect(JSON.stringify(buildLarkCard({ state, elements, taskName: '多阶段任务', taskId: 'om_x', elapsedSeconds: 30 })))
        .toContain('个更早阶段未展示');
    }
  });

  it('20. 工具摘要行永远有字：空工具名和零输入都不会退化成一行空白', () => {
    // 摘要行改成「优先写命令、分类名退到兜底」之后，任何一环取到空串都会让整行只剩
    // 一个图标。`{ name: '' }` 是真实存在的形态——空串不是 undefined，`??` 兜不住它。
    const blank = renderLarkProcessElements(
      [makeEvent(1, 'tool_result', { id: 'blank', name: '', output: 'ok', status: 'completed' })], config, true);
    const zeroArg = renderLarkProcessElements(
      [makeEvent(1, 'tool_result', { id: 'zero', name: 'tool', input: {}, output: 'ok', status: 'completed' })], config, true);
    const summaryOf = (elements: Record<string, any>[]) => {
      const node = components(elements).find(element => String(element.element_id ?? '').startsWith('trace_tool_'))!;
      return String(node.header?.title?.content ?? node.content ?? node.elements?.[0]?.content ?? '');
    };
    for (const elements of [blank, zeroArg]) {
      expect(summaryOf(elements).replace(/<[^>]+>|[●　\s]/g, '')).not.toBe('');
    }
  });

  it('21. 只有 cwd 的工具保留分类名：工作目录不能被读成被执行的命令', () => {
    // cwd 和 file_path 会被归并成同一个 detail，但语义相反。detail 独占标题时，
    // `{ cwd: '/srv/repo' }` 会显示成一行孤零零的「/srv/repo」，读起来像执行了它。
    const withCwd = renderLarkProcessElements(
      [makeEvent(1, 'tool_result', { id: 'c', name: 'Bash', input: { cwd: '/srv/repo' }, output: 'ok', status: 'completed' })], config, true);
    const withCommand = renderLarkProcessElements(
      [makeEvent(1, 'tool_result', { id: 'r', name: 'Bash', input: { command: 'ls -la' }, output: 'ok', status: 'completed' })], config, true);
    const summaryOf = (elements: Record<string, any>[]) => {
      const node = components(elements).find(element => String(element.element_id ?? '').startsWith('trace_tool_'))!;
      return String(node.header?.title?.content ?? node.content ?? node.elements?.[0]?.content ?? '');
    };
    // firstValue 先扫顶层再递归子对象，所以 detail 取到的是顶层的 cwd，而「detail 能不能
    // 独占标题」的判定如果各查各的，会递归到嵌套的 file_path 判成 true，保护就失效了。
    const nested = renderLarkProcessElements(
      [makeEvent(1, 'tool_result', { id: 'n', name: 'Bash', input: { cwd: '/srv/repo', args: { file_path: 'a.ts' } }, output: 'ok', status: 'completed' })], config, true);
    expect(summaryOf(withCwd)).toContain('运行命令');
    expect(summaryOf(withCwd)).toContain('/srv/repo');
    expect(summaryOf(nested)).toContain('运行命令');
    // 命令本身是自解释的，此时分类名要让位，否则又变回「四个汉字挤掉命令」。
    expect(summaryOf(withCommand)).toContain('ls -la');
    expect(summaryOf(withCommand)).not.toContain('运行命令');
  });

  it('23. 屏幕回显：整屏快照按重叠重建、TUI 装饰不进卡片、滤干净后不留空面板', () => {
    // raw_terminal 是每 200ms 一帧的整屏快照，不是增量输出。首尾相接会把同一屏抄很多遍，
    // 所以要按「新帧与已输出尾部的最长重叠」重建成一份连续输出：每行只出现一次，
    // 已经滚出视口的行也不能因此丢掉。
    const frames = [
      makeEvent(1, 'raw_terminal', { text: '$ pnpm build\ncompiling…' }, t(1)),
      makeEvent(2, 'raw_terminal', { text: '$ pnpm build\ncompiling…\ndone in 3s' }, t(2)),
      makeEvent(3, 'raw_terminal', { text: 'compiling…\ndone in 3s\nPASS 12 tests' }, t(3))
    ];
    const rebuilt = JSON.stringify(buildLarkCard({ state: 'running', elements: renderLarkProcessElements(frames, config) }));
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
    expect(occurrences(rebuilt, 'compiling…')).toBe(1);
    expect(occurrences(rebuilt, 'done in 3s')).toBe(1);
    expect(rebuilt).toContain('$ pnpm build');
    expect(rebuilt).toContain('PASS 12 tests');

    // TUI 把自己的界面画在屏幕上，快照连装饰一起收下。这些行每帧都在变，躲得过 driver
    // 那道「屏幕文本没变就不发」的闸，对读者却是零信息量。
    const chrome = [makeEvent(1, 'raw_terminal', { text: [
      '● Bash(pnpm test)',
      'Thought for 2s (ctrl+o to expand)',
      '✻ Seasoning… (2s · ⚒ 1.6k tokens)',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents',
      '⎿  Tip: Use /memory to view and manage Claude memory',
      'PASS src/app.test.ts'
    ].join('\n') }, t(1))];
    const filtered = JSON.stringify(buildLarkCard({ state: 'running', elements: renderLarkProcessElements(chrome, config) }));
    expect(filtered).toContain('PASS src/app.test.ts');
    expect(filtered).toContain('Bash(pnpm test)');
    for (const noise of ['Thought for 2s', 'Seasoning', 'bypass permissions', 'Tip: Use /memory']) {
      expect(filtered).not.toContain(noise);
    }

    // 一屏全是装饰时过滤后什么都不剩。那样的记录不能留下一个点开是空的折叠箭头。
    const allChrome = [makeEvent(1, 'raw_terminal', {
      text: '⏵⏵ bypass permissions on (shift+tab to cycle)\nThought for 1s (ctrl+o to expand)'
    }, t(1))];
    expect(JSON.stringify(buildLarkCard({
      state: 'running', elements: renderLarkProcessElements(allChrome, config)
    }))).not.toContain('终端输出');
  });

  it('24. 阶段标题写这一步在做什么：工具自带的描述优先于命令，环境变量前缀不占标题', () => {
    // 真实会话里 86–94% 的工具调用自带一句中文描述，阶段标题此前一直跳过它，
    // 退化成「分类名 · 原始命令」；命令又常以一串开关开头，于是三个不同的阶段
    // 渲染出三行一模一样的标题。
    const events = [
      makeEvent(1, 'tool_call', { id: 't1', name: 'Bash', status: 'running', input: {
        command: 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli im +chat-messages-list --chat-id oc_f34138da',
        description: '拉取群内 9月8日以来的全部消息'
      } }, t(1)),
      makeEvent(2, 'tool_result', { id: 't1', name: 'Bash', output: 'ok', status: 'completed' }, t(3)),
      makeEvent(3, 'text', { text: '下一步' }, t(4)),
      makeEvent(4, 'tool_call', { id: 't2', name: 'Bash', input: { command: 'ls' }, status: 'running' }, t(4))
    ];
    const card = buildLarkCard({ state: 'running', elements: renderLarkProcessElements(events, config) });
    const group = byId(card, 'trace_group_0');
    const title = String(group.header?.title?.content ?? group.content ?? '');
    expect(title).toContain('拉取群内 9月8日以来的全部消息');
    // 描述已经把这一步说清楚了，命令不再拼在后面把标题撑成两行。
    expect(title).not.toContain('lark-cli');
    expect(title).not.toContain('LARKSUITE_CLI_NO_UPDATE_NOTIFIER');
    // 命令没有丢，它在展开区的输入里——要排查时点开就有。
    expect(JSON.stringify(group)).toContain('lark-cli im +chat-messages-list');
  });

  it('25. 没有描述时：命令剥掉环境变量前缀、文件路径留两段、分类不被管道词带偏', () => {
    const rendered = (input: any, name = 'Bash') => JSON.stringify(buildLarkCard({
      state: 'completed',
      elements: renderLarkProcessElements([
        makeEvent(1, 'tool_call', { id: 'x', name, input, status: 'running' }, t(1)),
        makeEvent(2, 'tool_result', { id: 'x', name, output: 'ok', status: 'completed' }, t(2))
      ], config, true)
    }));
    // 标题从第一个真实命令词开始，而不是从一串开关开始。
    expect(rendered({ command: 'FOO=1 BAR=2 rg -n needle src' })).toContain('rg -n needle src');
    // 文件路径留最后两段：SKILL.md、index.ts 这类名字一个仓库里能有几十份，
    // 上一层目录往往正是区分它们的那一段。完整路径退到展开区。
    const file = rendered({ file_path: '/home/u/.claude/skills/lark-shared/SKILL.md' }, 'Read');
    expect(file).toContain('lark-shared/SKILL.md');
    expect(file).toContain('/home/u/.claude/skills/lark-shared/SKILL.md');
    // 末尾的 head 只是把输出截短，不能让这一步的图标和分类名指向「读取文件」。
    const piped = rendered({ command: 'lark-cli im +chat-messages-list --help 2>&1 | head -60' });
    expect(piped).not.toContain('读取文件');
    expect(piped).toContain('运行命令');
  });

  it('26. 展开区的输入按原样成段：多行脚本不被压成一行字面 \\n', () => {
    // JSON.stringify 把换行写成字面 `\n`，一段 20 行的 heredoc 会挤成一行长字符串，
    // 读者得在脑子里反转义一遍才能看懂自己刚跑过的脚本。
    const script = "cd /tmp && python3 - <<'EOF'\nimport json\nprint(json.dumps({'ok': True}))\nEOF";
    const card = buildLarkCard({ state: 'completed', elements: renderLarkProcessElements([
      makeEvent(1, 'tool_call', { id: 's', name: 'Bash', input: { command: script, description: '跑一段脚本' }, status: 'running' }, t(1)),
      makeEvent(2, 'tool_result', { id: 's', name: 'Bash', output: '{"ok": true}', status: 'completed' }, t(2))
    ], config, true) });
    const shown = components(card).map(element => String(element.content ?? '')).find(content => content.includes('python3')) ?? '';
    expect(shown).toContain('\nimport json');
    expect(shown).not.toContain('\\nimport json');
    // 字段名仍然在——它区分 command 和 description，只是不再由一层 JSON 括号来承担。
    expect(shown).not.toContain('"command"');
  });

  it('27. 工具输入的脱敏不因为改成可读文本而失效', () => {
    // redactTraceValue 有两条规则：按字段名整值替换（sensitiveTraceKey），和按文本形状替换。
    // 前者只在对象形态下生效。输入一旦先被拍成可读文本再脱敏，就只剩后者，而文本正则的
    // 值形状停在第一个空白或逗号处——密钥里带空格、逗号、换行，或者干脆是个数组时，
    // 会有一截明文跟着卡片发进群。
    const leaked = (input: unknown, secret: string) => JSON.stringify(renderLarkProcessElements([
      makeEvent(1, 'tool_call', { id: 't', name: 'Bash', input, status: 'running' }, t(1)),
      makeEvent(2, 'tool_result', { id: 't', name: 'Bash', output: 'ok', status: 'completed' }, t(2))
    ], config, true)).includes(secret);
    expect(leaked({ endpoint: 'https://x', method: 'POST', password: 'S3cret Pass Phrase' }, 'Pass Phrase')).toBe(false);
    expect(leaked({ name: 'rotate', access_token: ['tok_AAA', 'tok_BBB', 'tok_CCC'] }, 'tok_BBB')).toBe(false);
    expect(leaked({ note: 'x', api_key: 'AKIA111\nSECONDLINE222' }, 'SECONDLINE222')).toBe(false);
    expect(leaked({ secret: 'a,b,c,d' }, 'b,c,d')).toBe(false);
  });

  it('28. 屏幕流的两种形态：整屏快照去重、逐行输出原样保留、装饰规则不误伤真实输出', () => {
    const screen = (lines: string[], done = false) => JSON.stringify(buildLarkCard({
      state: done ? 'completed' : 'running',
      elements: renderLarkProcessElements(lines.map((line, index) => makeEvent(index + 1, 'raw_terminal', { text: line }, t(index + 1))), config, done)
    }));
    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    // 整屏快照：破坏帧间重叠的正是每帧都在变的装饰行，所以必须先滤再合并。
    // 顺序反了的话，下面这 5 帧会把正文原样重复 5 遍。
    const spinner = '✢✳✶✻✽'.split('').map((glyph, index) =>
      `$ pnpm test\nNow running the test suite\nPASS src/app.test.ts\n${glyph} Seasoning… (${index}s · ⚒ 1.2k tokens)`);
    expect(occurrences(screen(spinner), 'Now running the test suite')).toBe(1);

    // 逐行输出（transports 的 stdio stderr 每行发一条）：连着两行相同的告警是两次真实告警，
    // 不是重复帧。按重叠合并会把第二行当成重复吞掉。
    expect(occurrences(screen(['npm warn deprecated foo@1.0.0', 'npm warn deprecated foo@1.0.0', 'done']),
      'npm warn deprecated')).toBe(2);

    // 装饰规则作用在 agent 的真实输出上，宽一分就吃掉别人的日志。
    const survives = (line: string) => screen([`前一行\n${line}`]).includes(line.slice(0, 14));
    for (const kept of ['* Building…', '· 正在同步…', 'README says: press esc to interrupt the run', 'Compiled main.ts (ctrl+c to expand)']) {
      expect(survives(kept), kept).toBe(true);
    }
    for (const dropped of ['⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt', 'Thought for 2s (ctrl+o to expand)', '✻ Seasoning… (2s · ⚒ 1.6k tokens)']) {
      expect(survives(dropped), dropped).toBe(false);
    }
  });

  it('29. 任务已收尾而工具没等到结果时，屏幕回显是唯一线索，不能一起丢掉', () => {
    // CLI 崩了、卡在交互授权、鉴权失败都是这个形状：tool_call 发出去了，tool_result 永远
    // 不来。结构化记录此时只有一行「执行中」，原因全在屏幕上那两行。
    const stuck = [
      makeEvent(1, 'text', { text: '我来看一下服务状态' }, t(1)),
      makeEvent(2, 'tool_call', { id: 't1', name: 'Bash', status: 'running',
        input: { command: 'kubectl get pods', description: '查看 Pod 状态' } }, t(2)),
      makeEvent(3, 'raw_terminal', { text: 'error: You must be logged in to the server (Unauthorized)' }, t(3))
    ];
    expect(JSON.stringify(renderLarkProcessElements(stuck, config, true))).toContain('Unauthorized');
    // 运行态不走这条：那时「还没拿到结果」是正常的，留下屏幕流等于把 TUI 录像搬回卡片。
    expect(JSON.stringify(renderLarkProcessElements(stuck, config, false))).not.toContain('Unauthorized');
  });

  it('22. 告警块永远有正文：空的错误原因和空的审批标题都不会渲染出空 content', () => {
    // ACP 侧的 message 可以是空串（acp-client 里是 `event.message ?? event.error?.message ?? 'Agent error'`，
    // 第三方 agent 回 `{"error":{"message":""}}` 就得到空串）。`??` 兜不住空串，
    // truncateTrace 里的 trim 又把纯空白压成空串——schema 2.0 下 content 为空的 markdown
    // 要么被判非法让整卡更新失败，要么渲染成一块只有红色图标、一个字都没有的区域。
    const contentOf = (elements: Record<string, any>[], prefix: string) =>
      String(components(elements).find(element => String(element.element_id ?? '').startsWith(prefix))?.content ?? '');
    for (const message of ['', '   ', undefined]) {
      const elements = renderLarkProcessElements([makeEvent(1, 'error', { message })], config, true);
      expect(contentOf(elements, 'execution_alert_').trim()).not.toBe('');
    }
    for (const title of ['', '   ', undefined]) {
      const elements = renderLarkProcessElements(
        [makeEvent(1, 'permission_request', { id: 'p1', title, status: 'pending', options: [] })], config);
      expect(contentOf(elements, 'risk_alert_').replace(/<[^>]+>|\s/g, '')).not.toBe('');
    }
  });
});

describe('Lark process/result 双卡布局（cardKind）', () => {
  const runningEvents: AgentEvent[] = [
    makeEvent(1, 'text', { role: 'assistant', text: '阶段 1：读取配置' }, t(1)),
    makeEvent(2, 'tool_call', { id: 't1', name: 'read', input: { path: 'config.json' }, status: 'running', startedAt: t(1) }, t(1)),
    makeEvent(3, 'tool_result', { id: 't1', name: 'read', output: '{"port":8080}', status: 'completed', completedAt: t(4) }, t(4)),
    makeEvent(4, 'text', { role: 'assistant', text: '阶段 2：执行测试' }, t(5)),
    makeEvent(5, 'tool_call', { id: 't2', name: 'vitest', input: { command: 'pnpm test' }, status: 'running', startedAt: t(5) }, t(5))
  ];
  const completedEvents: AgentEvent[] = [
    makeEvent(1, 'thinking', { text: '先跑测试' }, t(0)),
    makeEvent(2, 'tool_call', { id: 't1', name: 'Bash', input: { command: 'pnpm test' }, status: 'running', startedAt: t(1) }, t(1)),
    makeEvent(3, 'tool_result', { id: 't1', name: 'Bash', output: '125 passed', status: 'completed', completedAt: t(16) }, t(16)),
    makeEvent(4, 'text', { role: 'assistant', text: '全部通过。' }, t(16))
  ];

  it('P1. process 运行态：状态在标题栏标签里，正文从当前阶段开始，耗时和步数在底部一行，会话列表摘要写进度', () => {
    const elements = boundLarkCardElements(renderLarkProcessElements(runningEvents, config));
    const card: any = buildLarkCard({
      cardKind: 'process', state: 'running', taskName: '自动化流水线', agentName: 'Claude Code',
      taskId: 'om_p1', elapsedSeconds: 16.224, elements
    });
    expect(card.header.title).toMatchObject({ tag: 'plain_text', content: '自动化流水线' });
    expect(card.header.subtitle).toMatchObject({ tag: 'plain_text', content: 'Claude Code' });
    expect(card.header.template).toBe('blue');
    expect(card.header.text_tag_list).toEqual([{ tag: 'text_tag', text: { tag: 'plain_text', content: '执行中' }, color: 'blue' }]);
    // 不再有「执行记录 · 执行中 · 用时」那一行：当前阶段直接是正文第一块，且不套底色。
    expect(byId(card, 'task_overview')).toBeUndefined();
    expect(card.body.elements[0]).toMatchObject({ tag: 'interactive_container', element_id: 'trace_group_1' });
    expect(card.body.elements[0].background_style).toBeUndefined();
    expect(byId(card, 'current_title').icon).toEqual({ tag: 'standard_icon', token: 'loading_outlined', color: 'blue' });
    // 刚结束的阶段紧跟在当前阶段下面。
    expect(card.body.elements[1].element_id).toBe('trace_group_0');
    const row = card.body.elements.at(-1);
    expect(row.element_id).toBe('task_action_row');
    expect(byId(row, 'task_meta').content).toBe("<font color='grey'>已运行 16s</font><font color='grey'> · </font><font color='grey'>共 2 步</font>");
    expect(JSON.stringify(card)).not.toContain('16.224');
    expect(card.config.summary.content).toBe('执行中 · 阶段 2：执行测试');
  });

  it('P1b. process 操作行：左边耗时/步数，无边框按钮靠右收成一排，每个按钮一列、宽度随内容', () => {
    const elements = boundLarkCardElements(renderLarkProcessElements(runningEvents, config));
    const card: any = buildLarkCard({
      cardKind: 'process', state: 'running', taskId: 'om_p1b', elapsedSeconds: 16, elements,
      capabilities: { canCancelQueued: false, canInterrupt: true, canRetry: false, canRefresh: true }
    });
    const row = byId(card, 'task_action_row');
    expect(card.body.elements.at(-1)).toBe(row);
    const shape = (actionRow: any) => actionRow.columns.map((column: any) => [column.width, column.elements.map((el: any) => el.element_id)]);
    expect(shape(row)).toEqual([['weighted', ['task_meta']], ['auto', ['interrupt']], ['auto', ['refresh']]]);
    expect(row.columns.slice(1).map((column: any) => column.elements[0].type)).toEqual(['text', 'text']);

    const failed: any = buildLarkCard({
      cardKind: 'process', state: 'failed', taskId: 'om_p1b', elements,
      capabilities: { canCancelQueued: false, canInterrupt: false, canRetry: true, canRefresh: false }
    });
    expect(shape(byId(failed, 'task_action_row'))).toEqual([['weighted', []], ['auto', ['retry']]]);
    expect(byId(failed, 'retry').type).toBe('primary_text');

    const queued: any = buildLarkCard({
      cardKind: 'process', state: 'queued', taskId: 'om_p1b', turn: 1,
      capabilities: { canCancelQueued: true, canInterrupt: false, canRetry: false, canRefresh: false }
    });
    expect(shape(byId(queued, 'task_action_row'))).toEqual([['weighted', []], ['auto', ['cancel']]]);

    // 非过程卡：状态占左侧，按钮同样每个一列、宽度随内容。
    const plain: any = buildLarkCard({
      state: 'running', taskId: 'om_p1b', elapsedSeconds: 16,
      capabilities: { canCancelQueued: false, canInterrupt: true, canRetry: false, canRefresh: true }
    });
    expect(shape(byId(plain, 'task_action_row'))).toEqual([['weighted', ['task_status']], ['auto', ['interrupt']], ['auto', ['refresh']]]);
  });

  it('P2. process 完成态：不带标题栏，收成一行回执；单阶段摊平进回执的折叠里', () => {
    const elements = boundLarkCardElements(renderLarkProcessElements(completedEvents, config, true));
    const build = (resultFollows?: boolean): any => buildLarkCard({
      cardKind: 'process', state: 'completed', taskName: '构建', agentName: 'Codex',
      taskId: 'om_p2', elapsedSeconds: 20, elements, ...(resultFollows === undefined ? {} : { resultFollows })
    });
    const card = build(true);
    expect(card.header).toBeUndefined();
    const receipt = card.body.elements[0];
    expect(receipt).toMatchObject({ tag: 'collapsible_panel', element_id: 'task_overview', expanded: false });
    expect(receipt.header.title).toMatchObject({
      tag: 'markdown',
      content: "<font color='green'>已完成</font><font color='grey'> · 共 1 步</font><font color='grey'> · 结果见下条</font>",
      icon: { tag: 'standard_icon', token: 'done_outlined', color: 'green' }
    });
    // 唯一的阶段被摊平：回执里直接是阶段标题和它的内容，不再套一层阶段折叠。
    expect(receipt.elements.some((el: any) => String(el.element_id ?? '').startsWith('trace_group_'))).toBe(false);
    expect(JSON.stringify(receipt)).toContain('125 passed');
    expect(byId(card, 'trace_overview')).toBeUndefined();
    expect(byId(card, 'task_elapsed')).toBeUndefined();
    expect(byId(card, 'task_meta')).toBeUndefined();
    expect(card.config.summary.content).toBe('已完成 · 构建');
    // 调用方没说会另发结果（只贴表情的模式）时，回执不能写「结果见下条」。
    expect(JSON.stringify(build())).not.toContain('结果见下条');
    expect(JSON.stringify(build(false))).not.toContain('结果见下条');
  });

  it('P3. hideTraceOnComplete=false 的终态仍保留总面板展开', () => {
    const elements = renderLarkProcessElements(completedEvents, { traceLimit: 20, hideTraceOnComplete: false }, true);
    const card: any = buildLarkCard({ cardKind: 'process', state: 'completed', taskName: '构建', elements });
    expect(card.body.elements[0]).toMatchObject({ element_id: 'task_overview', expanded: true });
  });

  it('P4. 中断/失败卡：阶段直接列在正文里；执行记录里没有失败的步骤时不凭空补一块失败说明', () => {
    const elements = boundLarkCardElements(renderLarkProcessElements(completedEvents, config, true));
    const interrupted: any = buildLarkCard({ cardKind: 'process', state: 'interrupted', taskName: '构建', elapsedSeconds: 5, elements });
    expect(interrupted.header.text_tag_list[0]).toMatchObject({ text: { content: '已中断' }, color: 'neutral' });
    expect(byId(interrupted, 'task_overview')).toBeUndefined();
    expect(byId(interrupted, 'failure_step')).toBeUndefined();
    expect(String(interrupted.body.elements[0].element_id)).toMatch(/^trace_group_/);
    expect(byId(interrupted, 'task_meta').content).toBe("<font color='grey'>用时 5s</font>");

    const failed: any = buildLarkCard({ cardKind: 'process', state: 'failed', taskName: '构建', elements });
    expect(failed.header.text_tag_list[0]).toMatchObject({ text: { content: '已失败' }, color: 'red' });
    expect(byId(failed, 'failure_step')).toBeUndefined();
    expect(String(failed.body.elements[0].element_id)).toMatch(/^trace_group_/);

    const queued: any = buildLarkCard({ cardKind: 'process', state: 'queued', taskName: '构建', elements });
    expect(queued.header.text_tag_list[0]).toMatchObject({ text: { content: '排队中' }, color: 'neutral' });
    expect(byId(queued, 'task_overview')).toBeUndefined();
  });

  it('P5. 无 trace 的首帧/异常卡：标题栏照常，没有折叠箭头，不编造等待文案', () => {
    // queued 首帧：有普通等待正文，但没有 trace，不应渲染可展开面板。
    const queued: any = buildLarkCard({
      cardKind: 'process', state: 'queued', taskName: '拉取消息', agentName: 'Codex', elapsedSeconds: 16.224,
      elements: [{ tag: 'markdown', content: '任务已接收，正在准备执行…', text_size: 'normal', margin: '0px' }]
    });
    expect(queued.header.title).toMatchObject({ tag: 'plain_text', content: '拉取消息' });
    expect(queued.header.subtitle).toMatchObject({ tag: 'plain_text', content: 'Codex' });
    expect(queued.body.elements[0]).toMatchObject({ tag: 'markdown', content: '任务已接收，正在准备执行…' });
    expect(byId(queued, 'task_meta').content).toBe("<font color='grey'>排队等待 16s</font>");
    expect(JSON.stringify(queued)).not.toContain('16.224');
    expect(JSON.stringify(queued)).not.toContain('down-small-ccm');

    // 只有一条 error 的 failed：报错本身就是第一块，不追加「正在思考中」。
    const errorElements = renderLarkProcessElements([makeEvent(1, 'error', { message: '连接失败' })], config, true);
    const failed: any = buildLarkCard({ cardKind: 'process', state: 'failed', taskName: '看不懂', agentName: 'Codex', elements: errorElements });
    expect(failed.header.title).toMatchObject({ tag: 'plain_text', content: '看不懂' });
    expect(failed.header.subtitle).toMatchObject({ tag: 'plain_text', content: 'Codex' });
    expect(failed.body.elements[0].element_id).toBe('execution_alert_0');
    expect(byId(failed, 'failure_step')).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain('正在思考中');
  });

  it('P6. 任务名/Agent 名中的 markdown 与 at 标签在根 header plain_text 标题中原样保留，不被解释', () => {
    const card: any = buildLarkCard({
      cardKind: 'process', state: 'queued', taskName: '**bold** [x](https://a) <at id=all></at>',
      agentName: 'Agent <font color=red>red</font>',
      elements: [{ tag: 'markdown', content: '任务已接收，正在准备执行…', text_size: 'normal', margin: '0px' }]
    });
    expect(card.header.title).toMatchObject({ tag: 'plain_text', content: '**bold** [x](https://a) <at id=all></at>' });
    expect(card.header.subtitle).toMatchObject({ tag: 'plain_text', content: 'Agent <font color=red>red</font>' });
    expect(card.header.text_tag_list[0].text).toEqual({ tag: 'plain_text', content: '排队中' });
    expect(JSON.stringify(card.body)).not.toContain('bold');
  });

  it('P6b. 过程卡/结果卡标题只占一行：按显示宽度截断（汉字算两格），通用卡不截', () => {
    const long = '详细总结下地狱焚决 Agent 群这周的聊天内容，排除情感生活类的闲聊';
    for (const cardKind of ['process', 'result'] as const) {
      const card: any = buildLarkCard({ cardKind, state: 'running', taskName: long });
      expect(card.header.title.content).toBe('详细总结下地狱焚决 Agent 群这周的聊天内容…');
      // 会话列表摘要不截：它本身就是单行预览，由客户端决定截在哪。
      expect(card.config.summary.content).toContain(long);
    }
    expect(buildLarkCard({ cardKind: 'process', state: 'running', taskName: '部署服务' }).header.title.content).toBe('部署服务');
    expect(buildLarkCard({ state: 'running', taskName: long }).header.title.content).toBe(long);
  });

  it('P7. result 卡：标题就是原任务名，状态标签「本轮结束」，短结论不折叠', () => {
    const elements = renderLarkResultElements([
      ...completedEvents,
      makeEvent(5, 'text', { role: 'assistant', text: '**最终答复**\n\n结论如下' }, t(17))
    ]);
    const card: any = buildLarkCard({
      cardKind: 'result', state: 'completed', taskName: '原任务名', agentName: 'Codex',
      taskId: 'om_r', elapsedSeconds: 9, elements
    });
    expect(card.header.title).toMatchObject({ tag: 'plain_text', content: '原任务名' });
    expect(card.header.text_tag_list).toEqual([{ tag: 'text_tag', text: { tag: 'plain_text', content: '本轮结束' }, color: 'green' }]);
    expect(card.config.summary.content).toBe('本轮结束 · 原任务名');
    const final = card.body.elements.find((el: any) => el.element_id === 'final_output');
    expect(final.content).toContain('**最终答复**');
    expect(byId(card, 'final_output_more')).toBeUndefined();
    expect(byId(card, 'task_overview')).toBeUndefined();
    expect(byId(card, 'task_elapsed').content).toContain('用时 9s');
  });

  it('P7b. result 卡长结论：开头一段露在外面，其余收进折叠；拼回去与原文逐字一致', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `### 第 ${index + 1} 点\n\n${'这一段是结论的展开说明。'.repeat(8)}`);
    const text = paragraphs.join('\n\n');
    const card: any = buildLarkCard({ cardKind: 'result', state: 'completed', taskName: '周报', elements: [
      { tag: 'markdown', element_id: 'final_output', content: text, text_size: 'normal_v2', margin: '0px' }
    ] });
    const head = byId(card, 'final_output');
    const more = byId(card, 'final_output_more');
    expect(more).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(head.content.length).toBeGreaterThanOrEqual(500);
    expect(head.content.length).toBeLessThanOrEqual(1200);
    expect(head.content + byId(card, 'final_output_rest').content).toBe(text);
    expect(larkCardFinalOutputText(card.body.elements)).toBe(text);
    expect(more.header.title.content).toMatch(/其余内容 · 约 [\d,]+ 字/);

    // 代码块里的空行不是切点：切在代码块中间会让两半都渲染错。
    // 代码块内的空行落在 500 字附近，切点只能落在代码块结束之后。
    const code = Array.from({ length: 30 }, (_, index) => `const a${index} = ${index};\n`).join('\n');
    const fenced = `${'开头说明。'.repeat(20)}\n\n\`\`\`ts\n${code}\`\`\`\n\n${'结尾说明。'.repeat(60)}`;
    const parts = splitLongResult(fenced)!;
    expect(parts[0] + parts[1]).toBe(fenced);
    expect(parts[0].endsWith('```\n\n')).toBe(true);
    expect((parts[0].match(/```/g) ?? []).length % 2).toBe(0);
    // 短结论、找不到段落边界的长结论都原样整段展示。
    expect(splitLongResult('短结论')).toBeUndefined();
    expect(splitLongResult('没有空行的一整段'.repeat(200))).toBeUndefined();
    // 通用卡不折叠结论。
    const plain: any = buildLarkCard({ state: 'completed', elements: [{ tag: 'markdown', element_id: 'final_output', content: text }] });
    expect(byId(plain, 'final_output_more')).toBeUndefined();
  });

  it('P8. 待审批/报错/裁剪提示都在正文顶层，要人处理的提示紧跟当前阶段；旧快照的失败计数行丢弃', () => {
    const externalIds = [
      'risk_alert_pending_1', 'execution_alert_0',
      'dutydeck_rejected_delta', 'dockmux_rejected_delta',
      'dutydeck_snapshot_omission', 'dockmux_snapshot_omission',
      'dutydeck_omission', 'trace_omission'
    ];
    const elements = [
      ...boundLarkCardElements(renderLarkProcessElements(runningEvents, config)),
      ...[...externalIds, 'evidence'].map(id => ({ tag: 'markdown', element_id: id, content: `提示 ${id}`, text_size: 'x-small', margin: '0px' })),
      { tag: 'markdown', content: "<font color='orange'>原运行卡片未能更新，Dutydeck 已补发终态结果。</font>", text_size: 'notation', margin: '0px' }
    ];
    const card: any = buildLarkCard({ cardKind: 'process', state: 'running', taskName: '构建', elements });
    const topIds = card.body.elements.map((el: any) => el.element_id).filter(Boolean);
    for (const id of externalIds) expect(topIds, `${id} 应在正文顶层`).toContain(id);
    expect(byId(card, 'evidence')).toBeUndefined();
    expect(card.body.elements.some((el: any) => String(el.content ?? '').includes('原运行卡片未能更新'))).toBe(true);
    expect(topIds.slice(0, 3)).toEqual(['trace_group_1', 'risk_alert_pending_1', 'execution_alert_0']);
    // 有待审批时标题栏换成橙色「等待审批」，当前阶段的加载图标换成提示图标。
    expect(card.header.template).toBe('orange');
    expect(card.header.text_tag_list[0]).toMatchObject({ text: { content: '等待审批' }, color: 'orange' });
    expect(byId(card, 'current_title').icon).toMatchObject({ token: 'warning_outlined', color: 'orange' });
    expect(card.config.summary.content).toBe('等待审批 · 构建');
  });

  it('P9. 终态 process 多 trace 组保留阶段折叠（不摊平）', () => {
    const events: AgentEvent[] = [];
    for (let stage = 0; stage < 3; stage++) {
      events.push(
        makeEvent(stage * 2 + 1, 'text', { role: 'assistant', text: `第 ${stage + 1} 步` }, t(stage * 2 + 1)),
        makeEvent(stage * 2 + 2, 'tool_result', { id: `t${stage}`, name: 'Bash', input: { command: `echo ${stage}` }, output: 'ok', status: 'completed', completedAt: t(stage * 2 + 2) }, t(stage * 2 + 2))
      );
    }
    const elements = boundLarkCardElements(renderLarkProcessElements(events, config, true));
    const card: any = buildLarkCard({ cardKind: 'process', state: 'completed', taskName: '多阶段', elements });
    const overview = card.body.elements[0];
    const groups = overview.elements.filter((el: any) => String(el.element_id ?? '').startsWith('trace_group_'));
    expect(groups.length).toBeGreaterThan(1);
  });

  it('P10. buildLarkCard 不原地修改调用方 elements', () => {
    const elements = boundLarkCardElements(renderLarkProcessElements(runningEvents, config));
    const snapshot = JSON.stringify(elements);
    buildLarkCard({ cardKind: 'process', state: 'running', taskName: '构建', elements });
    expect(JSON.stringify(elements)).toBe(snapshot);
  });

  it('P11. 超预算 process 裁剪/兜底后仍 ≤24KiB/180，且保留任务名、Agent、状态', () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 12; i++) {
      events.push(makeEvent(i * 3 + 1, 'text', { role: 'assistant', text: `第 ${i + 1} 阶段` }, t(i)));
      events.push(makeEvent(i * 3 + 2, 'tool_call', { id: `t${i}`, name: 'Bash', input: { command: `cmd ${i}` }, status: 'running', startedAt: t(i) }, t(i)));
      events.push(makeEvent(i * 3 + 3, 'tool_result', { id: `t${i}`, name: 'Bash', output: 'X'.repeat(4000), status: 'completed', completedAt: t(i + 1) }, t(i + 1)));
    }
    const elements = boundLarkCardElements(renderLarkProcessElements(events, { traceLimit: 200, hideTraceOnComplete: true }, true));
    for (const state of ['completed', 'failed'] as const) {
      const card: any = buildLarkCard({ cardKind: 'process', state, taskName: '大任务', agentName: 'Codex', elapsedSeconds: 99, elements });
      expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
      expect(components(card).length).toBeLessThanOrEqual(larkCardSafeLimits.components);
      expect(card.config.summary.content).toBe(`${state === 'completed' ? '已完成' : '已失败'} · 大任务`);
      if (state === 'completed') {
        expect(card.header).toBeUndefined();
        expect(byId(card, 'task_overview').header.title.content).toContain('共 12 步');
      } else {
        expect(card.header).toMatchObject({ title: { content: '大任务' }, subtitle: { content: 'Codex' } });
      }
    }

    // 触发正文兜底：无 trace 组的超大正文，裁剪循环无组可删，走截断兜底。
    // （硬安全网是为第三方 schema 额外开销预留的，常规有界输入不可达；此路径验证
    // 真实可达的兜底同样保留 Agent/状态/耗时并给稳定裁剪提示 ID。）
    const huge = [{ tag: 'markdown', content: 'A'.repeat(40_000), text_size: 'normal_v2', margin: '0px' }];
    const fallback: any = buildLarkCard({ cardKind: 'process', state: 'failed', taskName: '超大', agentName: 'AgentX', elapsedSeconds: 3, elements: huge });
    expect(Buffer.byteLength(JSON.stringify(fallback), 'utf8')).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(fallback.header).toMatchObject({
      title: { tag: 'plain_text', content: '超大' },
      subtitle: { tag: 'plain_text', content: 'AgentX' },
      text_tag_list: [{ text: { content: '已失败' }, color: 'red' }]
    });
    expect(fallback.config.summary.content).toBe('已失败 · 超大');
    expect(byId(fallback, 'task_meta').content).toBe("<font color='grey'>用时 3s</font>");
    expect(fallback.body.elements.some((el: any) =>
      el.element_id === 'dutydeck_fallback_omission' || el.element_id === 'dutydeck_hard_fallback_omission')).toBe(true);

    // 兜底时最后失败的步骤照样带上，不能因为记录被收起就说「没有失败的步骤」。
    const failedStep = renderLarkProcessElements([
      makeEvent(1, 'tool_result', { id: 'x', name: 'Bash', input: { command: 'pnpm build' }, output: 'Error: ENOSPC', status: 'failed' })
    ], config, true).find(element => element.element_id === 'failure_step')!;
    const fallbackWithStep: any = buildLarkCard({ cardKind: 'process', state: 'failed', taskName: '超大', elements: [...huge, failedStep] });
    expect(fallbackWithStep.body.elements[0].element_id).toBe('failure_step');
    expect(JSON.stringify(fallbackWithStep)).toContain('ENOSPC');
    expect(JSON.stringify(fallbackWithStep)).not.toContain('没有失败的步骤');
  });

  it('P11b. 兜底：步骤总数和最后失败的步骤跟着走，且不会被当成正文', () => {
    const steps = { tag: 'markdown', element_id: 'trace_steps', content: '共 3 步', text_size: 'notation', margin: '0px' };
    const failedStep = renderLarkProcessElements([
      makeEvent(1, 'tool_result', { id: 'x', name: 'Bash', input: { command: 'pnpm build' }, output: 'Error: ENOSPC', status: 'failed' })
    ], config, true).find(element => element.element_id === 'failure_step')!;
    const huge = { tag: 'markdown', content: 'A'.repeat(40_000), text_size: 'normal_v2', margin: '0px' };

    const bounded = boundLarkCardElements([steps, failedStep, huge]);
    expect(bounded.map(element => element.element_id)).toEqual(['trace_steps', 'failure_step', 'final_output', 'dutydeck_snapshot_omission']);
    expect(String(bounded[2]!.content).startsWith('AAA')).toBe(true);

    const card: any = buildLarkCard({ cardKind: 'process', state: 'running', taskName: '超大', elapsedSeconds: 3, elements: [steps, huge] });
    expect(byId(card, 'task_meta').content).toContain('共 3 步');
    expect(card.body.elements.filter((el: any) => el.content === '共 3 步')).toHaveLength(0);
    expect(JSON.stringify(card)).toContain('AAA');
  });

  it('P13. 用运行中那一帧重绘的终态卡：去掉加载图标、「正在」和底色，不补「没有失败的步骤」', () => {
    const running = boundLarkCardElements(renderLarkProcessElements([
      makeEvent(1, 'text', { role: 'assistant', text: '跑测试' }, t(1)),
      makeEvent(2, 'tool_result', { id: 'a', name: 'Bash', input: { command: 'pnpm test' }, output: '1 failed', status: 'failed', startedAt: t(1), completedAt: t(2) }, t(2)),
      makeEvent(3, 'tool_call', { id: 'b', name: 'Bash', input: { command: 'pnpm test --retry' }, status: 'running', startedAt: t(3) }, t(3))
    ], { ...config, compactTrace: true }, false));
    expect(byId(running, 'current_now')).toBeDefined();
    for (const state of ['failed', 'interrupted', 'completed'] as const) {
      const card: any = buildLarkCard({ cardKind: 'process', state, taskName: '测试', elements: running });
      const json = JSON.stringify(card);
      expect(json, state).not.toContain('loading_outlined');
      expect(byId(card, 'current_now'), state).toBeUndefined();
      expect(components(card).some(el => el.background_style === 'current_bg'), state).toBe(false);
      expect(json, state).not.toContain('没有失败的步骤');
      expect(byId(card, 'current_title').content, state).toBe('**跑测试**');
    }
  });

  it('P14. 失败卡先放报错，再放最后失败的步骤', () => {
    const elements = renderLarkProcessElements([
      makeEvent(1, 'tool_result', { id: 'a', name: 'Bash', input: { command: 'grep foo' }, output: '', status: 'failed' }),
      makeEvent(2, 'error', { message: '额度已用完' })
    ], config, true);
    const card: any = buildLarkCard({ cardKind: 'process', state: 'failed', taskName: '构建', elements });
    expect(card.body.elements.slice(0, 2).map((el: any) => el.element_id)).toEqual(['execution_alert_0', 'failure_step']);
  });

  it('P15. 没有任何步骤的完成任务：回执不在没有下一条时说「结果见单独的结果消息」', () => {
    const elements = renderLarkProcessElements([makeEvent(1, 'text', { role: 'assistant', text: '答复' })], config, true);
    expect(byId(elements, 'trace_empty')).toBeDefined();
    const quiet: any = buildLarkCard({ cardKind: 'process', state: 'completed', taskName: '问答', elements });
    expect(JSON.stringify(quiet)).not.toContain('结果见');
    expect(quiet.body.elements[0]).toMatchObject({ tag: 'markdown', element_id: 'task_overview', content: "<font color='green'>已完成</font>" });
    const follows: any = buildLarkCard({ cardKind: 'process', state: 'completed', taskName: '问答', resultFollows: true, elements });
    expect(JSON.stringify(follows)).toContain('结果见下条');
    expect(JSON.stringify(follows)).not.toContain('结果见单独的结果消息');
  });

  it('P12. 未设置 cardKind 时保持原卡布局（有 header、无 task_overview）', () => {
    const elements = boundLarkCardElements(renderLarkProcessElements(runningEvents, config));
    const card: any = buildLarkCard({ state: 'running', taskName: '普通任务', agentName: 'A', elapsedSeconds: 5, elements });
    expect(card.header).toBeDefined();
    expect(byId(card, 'task_overview')).toBeUndefined();
    expect(card.body.elements[0]).toMatchObject({ tag: 'column_set', element_id: 'task_action_row' });
  });

  it('截图形态真实 raw_terminal：process 当前阶段不套底色、无兜底 current_title，终端记录仍保留；generic 保留原形态', () => {
    const rawEvents: AgentEvent[] = [
      makeEvent(1, 'raw_terminal', { text: '$ git status\nOn branch master\nnothing to commit' })
    ];

    const processElements = renderLarkProcessElements(rawEvents, config, false);
    const processCard: any = buildLarkCard({
      cardKind: 'process', state: 'running', taskName: '检查状态', agentName: 'Codex', elements: processElements
    });
    expect(processCard.header.title.content).toBe('检查状态');
    expect(components(processCard).some(el => el.background_style === 'current_bg')).toBe(false);
    expect(byId(processCard, 'current_title')).toBeUndefined();
    expect(JSON.stringify(processCard)).toContain('On branch master');

    // 同一 events 的 generic 视图（保持原行为）
    const genericElements = renderLarkCardElements(rawEvents, config, false);
    const genericCard: any = buildLarkCard({
      state: 'running', taskName: '检查状态', agentName: 'Codex', elements: genericElements
    });
    expect(components(genericCard).some(el => el.background_style === 'current_bg')).toBe(true);
    const genericTitle = byId(genericCard, 'current_title');
    expect(genericTitle).toBeDefined();
    expect(genericTitle.content).toContain('正在执行…');
    expect(genericCard.header.text_tag_list).toBeUndefined();
    expect(JSON.stringify(genericCard)).toContain('On branch master');
  });

  it('真实旁白即使用词为“正在执行…”，依然作为有效旁白保留 current_title', () => {
    const narrativeEvents: AgentEvent[] = [
      makeEvent(1, 'text', { role: 'assistant', text: '正在执行…' }),
      makeEvent(2, 'raw_terminal', { text: '$ pnpm build\nDone.' })
    ];
    const processElements = renderLarkProcessElements(narrativeEvents, config, false);
    const processCard: any = buildLarkCard({
      cardKind: 'process', state: 'running', taskName: '构建任务', agentName: 'Codex', elements: processElements
    });
    // 有真实旁白时，即便内容就是“正在执行…”，也要保留该 current_title，且在 process 中被摊平进总面板
    const currentTitle = byId(processCard, 'current_title');
    expect(currentTitle).toBeDefined();
    expect(currentTitle.content).toBe('正在执行…');
    expect(JSON.stringify(processCard)).toContain('Done.');
  });
});


describe('公开执行记录的可执行入口', () => {
  it('卡片不渲染导出按钮；未配置 Web 时裁剪、旧审核快照与硬预算回退都不指向不存在的入口', () => {
    const sources = [
      [{ tag: 'markdown', element_id: 'trace_omission', content: '另有 6 个更早阶段未展示，完整记录见 Dutydeck Web' }],
      [{ tag: 'markdown', element_id: 'dutydeck_rejected_delta', content: '新增内容未通过飞书审核；完整增量请在 Dutydeck Web 查看。' }],
      [{ tag: 'markdown', element_id: 'final_output', content: '超长输出'.repeat(10000) }]
    ];
    for (const elements of sources) {
      const card = buildLarkCard({ state: 'completed', cardKind: 'process', taskId: 'om_original', turn: 3, readOnly: true, elements });
      expect(byId(card, 'export_trace')).toBeUndefined();
      expect(JSON.stringify(card)).not.toMatch(/Dutydeck Web|导出执行记录|查看详情/);
      expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
      expect(components(card).length).toBeLessThanOrEqual(larkCardSafeLimits.components);
    }
    const withWeb = buildLarkCard({ cardKind: 'process', elements: sources[0], sessionId: 'ses_1', webBaseUrl: 'https://dock.example' });
    expect(JSON.stringify(withWeb)).toContain('完整记录见「查看详情」');
    expect(JSON.stringify(withWeb)).toContain('https://dock.example/sessions/ses_1');
    // 硬兜底卡没有页脚，提示里必须自带链接，否则「查看详情」无处可点。
    const hardFallback = buildLarkCard({
      cardKind: 'result', state: 'completed', sessionId: 'ses_1', webBaseUrl: 'https://dock.example',
      elements: [{ tag: 'markdown', element_id: 'group_mention', content: '<at id=ou_x></at>'.repeat(3000) }]
    });
    expect(byId(hardFallback, 'dutydeck_hard_fallback_omission').content).toContain('[查看详情](https://dock.example/sessions/ses_1)');
  });

  it('重试成功后：结果卡不挂失败计数，失败卡才讲最后失败的步骤；完整公开记录保留失败证据', () => {
    const events = [
      makeEvent(1, 'tool_result', { id: 'first', name: 'test', output: 'temporary failure', status: 'failed' }),
      makeEvent(2, 'text', { text: '重试检查' }),
      makeEvent(3, 'tool_result', { id: 'retry', name: 'test', output: 'all passed', status: 'completed' }),
      makeEvent(4, 'text', { text: '测试已通过，待用户扫码。' })
    ];
    const card = buildLarkCard({ cardKind: 'result', state: 'completed', elements: renderLarkResultElements(events, config) });
    expect(byId(card, 'evidence')).toBeUndefined();
    expect(byId(card, 'failure_step')).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('temporary failure');
    expect(JSON.stringify(card)).toContain('本轮结束');
    expect(JSON.stringify(card)).toContain('待用户扫码');
    expect(renderLarkRecordExport(events)).toContain('temporary failure');
  });
});
