import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@dockmux/shared';
import {
  renderLarkCardElements,
  renderLarkProcessElements,
  renderLarkResultElements
} from './card-renderer.js';
import { boundLarkCardElements, buildLarkCard, larkCardSnapshotLimits, larkCardSafeLimits } from './service.js';

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
    expect(currentTool.content).toContain('运行测试');
    expect(currentTool.content).toContain('pnpm test');

    // 此前阶段直接展示在 body
    const historyLabelIndex = card.body.elements.findIndex((el: any) => el.element_id === 'history_label');
    expect(historyLabelIndex).toBeGreaterThan(0);
    const historyPanels = card.body.elements.slice(historyLabelIndex + 1).filter(
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
    const card = buildLarkCard({ state: 'running', elements: boundLarkCardElements(renderLarkProcessElements(events, config)) });
    const current = byId(card, 'trace_group_0');
    expect(current.elements).toHaveLength(2);
    expect(current.elements[0]).toMatchObject({ element_id: 'current_title', content: '消息量很大，继续翻页拉取。' });
    // 终端回显不是工具调用：24 条各自套一个工具面板会得到 24 个完全相同、
    // 零信息量的「运行命令 · terminal」标题，真正的输出反而被压进折叠层。
    const records = current.elements[1];
    expect(records).toMatchObject({
      tag: 'collapsible_panel', expanded: false,
      header: { title: { content: '终端输出（24 条）' } }
    });
    expect(records.elements).toHaveLength(1);
    expect(records.elements[0].content).toContain('终端输出 1');
    expect(records.elements[0].content).toContain('终端输出 24');
    expect(JSON.stringify(card)).not.toContain('terminal');
    expect(byId(card, 'task_status').text.content).toContain('执行中');
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
    expect(toolsInGroup1[0].header.title.content).toContain('读取文件');
    expect(toolsInGroup1[1].header.title.content).toContain('修改文件');
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

    // C: 单工具 + raw 组合历史：正常计为多动作阶段，保留独立展示
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
    expect(tools).toHaveLength(2);
    expect(JSON.stringify(group)).toContain('Build step succeeded');
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

  it('4b. evidence line: only failed steps get one, and terminal echo never counts as a step', () => {
    // 纯 raw 完成：无真实工具调用，绝不伪造证据
    const rawOnlyEvents = [
      makeEvent(1, 'raw_terminal', { text: 'Running automated bootstrap' }),
      makeEvent(2, 'text', { text: '初始化完成。' })
    ];
    const rawOnlyCard = buildLarkCard({ state: 'completed', elements: renderLarkCardElements(rawOnlyEvents, config, true) });
    expect(byId(rawOnlyCard, 'evidence')).toBeUndefined();

    // 真实工具全部成功 + 若干 raw：没有需要读者做点什么的信息，不占一行
    const mixedEvents = [
      makeEvent(1, 'raw_terminal', { text: 'pre-step raw log 1' }),
      makeEvent(2, 'tool_call', { id: 'real_tool', name: 'read', input: { path: 'a.txt' }, status: 'running' }),
      makeEvent(3, 'tool_result', { id: 'real_tool', name: 'read', output: 'content', status: 'completed' }),
      makeEvent(4, 'raw_terminal', { text: 'post-step raw log 2' }),
      makeEvent(5, 'raw_terminal', { text: 'post-step raw log 3' }),
      makeEvent(6, 'text', { text: '执行完成。' })
    ];
    const mixedCard = buildLarkCard({ state: 'completed', elements: renderLarkCardElements(mixedEvents, config, true) });
    expect(byId(mixedCard, 'evidence')).toBeUndefined();

    // 有失败：计数只算真实工具，raw_terminal 再多也不参与
    const failedEvents = [
      makeEvent(1, 'raw_terminal', { text: 'pre-step raw log 1' }),
      makeEvent(2, 'tool_result', { id: 'broken_tool', name: 'read', output: '文件不存在', status: 'failed' }),
      makeEvent(3, 'raw_terminal', { text: 'post-step raw log 2' }),
      makeEvent(4, 'raw_terminal', { text: 'post-step raw log 3' }),
      makeEvent(5, 'text', { text: '执行完成，但有步骤失败。' })
    ];
    const failedCard = buildLarkCard({ state: 'completed', elements: renderLarkCardElements(failedEvents, config, true) });
    expect(byId(failedCard, 'evidence').content).toContain('1 个步骤执行失败');
    expect(byId(failedCard, 'evidence').content).not.toContain('3 个步骤');
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
    expect(JSON.stringify(card)).toContain('另有 10 个阶段');
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
      webBaseUrl: 'https://dockmux.example.com'
    });

    expect(byId(card, 'interrupt')).toBeUndefined();
    expect(byId(card, 'retry')).toBeUndefined();
    expect(byId(card, 'cancel')).toBeUndefined();

    const footer = card.body.elements.at(-1);
    expect(JSON.stringify(footer)).toContain('[查看详情](https://dockmux.example.com/sessions/ses_secure_123)');
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
    expect(boundedToolContainer.elements[0].content).toContain('读取文件');
    expect(boundedToolContainer.elements[0].content).toContain('读取中文配置内容_1');

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
    expect(tool.elements[0].content).toContain('trace_success');
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

  it('16. 失败提示不把读者指向一份可能没有失败记录的执行记录', () => {
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

    const card = buildLarkCard({ state: 'completed', elements: renderLarkCardElements(events, config, true) });
    const evidence = byId(card, 'evidence');
    expect(evidence.content).toContain('1 个步骤执行失败');
    expect(evidence.content).not.toContain('执行记录');
    // 该失败的工具确实已经不在卡上，所以计数行不能声称详情可查。
    expect(JSON.stringify(card)).not.toContain('missing.json');
  });

  it('17. 终端输出掐中间时，被掐掉那段里的报错行单独保留', () => {
    // 一整屏 PASS 里那一行 FAIL 是读者唯一要读的东西。按字符位置连同翻页噪声
    // 一起丢掉，卡上就只剩「1 failed」而看不到失败在哪。
    const lines = ['> dockmux@0.1.0 test  (node:12345) ExperimentalWarning: tsx is experimental'];
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
    expect(body).toContain('> dockmux@0.1.0 test');
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
    // running 靠「此前阶段（另有 N 个…）」这一行承载；queued 走的是另一套布局。
    for (const state of ['running', 'queued'] as const) {
      expect(JSON.stringify(buildLarkCard({ state, elements, taskName: '多阶段任务', taskId: 'om_x', elapsedSeconds: 30 })))
        .toContain('个更早阶段未展示');
    }
  });
});
