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

    // 当前命令摘要默认可见，I/O 可展开
    const currentTool = components(currentContainer).find(el => el.element_id?.startsWith('trace_tool_'));
    expect(currentTool).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    expect(currentTool.header.title.content).toContain('运行测试');
    expect(currentTool.header.title.content).toContain('pnpm test');
    expect(JSON.stringify(currentTool.elements)).toContain('pnpm test');

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
    expect(JSON.stringify(tool0Container)).toContain('输入');
    expect(JSON.stringify(tool0Container)).toContain('结果');
    // I/O 标签未加粗
    expect(JSON.stringify(tool0Container)).not.toContain('**输入**');
    expect(JSON.stringify(tool0Container)).not.toContain('**结果**');

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

    const evidence = byId(defaultCard, 'evidence');
    expect(evidence).toBeDefined();
    expect(JSON.stringify(evidence)).toContain('1 个工具已结束');

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

  it('4b. evidence calculation: raw-only completed result has no evidence, and real 1 tool + raw count is still 1', () => {
    // 纯 raw 完成：无真实工具调用，绝不伪造证据
    const rawOnlyEvents = [
      makeEvent(1, 'raw_terminal', { text: 'Running automated bootstrap' }),
      makeEvent(2, 'text', { text: '初始化完成。' })
    ];
    const rawOnlyElements = renderLarkCardElements(rawOnlyEvents, config, true);
    const rawOnlyCard = buildLarkCard({ state: 'completed', elements: rawOnlyElements });
    expect(byId(rawOnlyCard, 'evidence')).toBeUndefined();

    // 真实 1 工具 + 若干 raw：证据计数依然严格为 1，不把 raw_terminal 算成工具
    const mixedEvents = [
      makeEvent(1, 'raw_terminal', { text: 'pre-step raw log 1' }),
      makeEvent(2, 'tool_call', { id: 'real_tool', name: 'read', input: { path: 'a.txt' }, status: 'running' }),
      makeEvent(3, 'tool_result', { id: 'real_tool', name: 'read', output: 'content', status: 'completed' }),
      makeEvent(4, 'raw_terminal', { text: 'post-step raw log 2' }),
      makeEvent(5, 'raw_terminal', { text: 'post-step raw log 3' }),
      makeEvent(6, 'text', { text: '执行完成。' })
    ];
    const mixedElements = renderLarkCardElements(mixedEvents, config, true);
    const mixedCard = buildLarkCard({ state: 'completed', elements: mixedElements });
    const evidence = byId(mixedCard, 'evidence');
    expect(evidence).toBeDefined();
    expect(JSON.stringify(evidence)).toContain('1 个工具已结束');
    expect(JSON.stringify(evidence)).not.toContain('4 个工具已结束');
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
    expect(byId(resultCard, 'evidence')).toBeDefined();
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
        makeEvent(i * 3, 'text', { text: `阶段 ${i}：执行中文工具操作` }, t(i * 3)),
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
      makeEvent(i * 3 + 1, 'tool_call', { id: `t${i}`, name: 'Bash', input: { command: `command_${i} ${'中文参数'.repeat(100)}` }, status: 'running' }),
      makeEvent(i * 3 + 2, 'tool_result', { id: `t${i}`, name: 'Bash', output: '中文输出结果'.repeat(100), status: 'completed' })
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
    expect(tool.elements[0].content).toContain('1s');
    expect(byId(card, 'final_output').content).toBe(`最终结果。${padding}`);
  });
});
