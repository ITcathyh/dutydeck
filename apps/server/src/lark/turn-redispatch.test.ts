import { describe, expect, it } from 'vitest';
import { toAcpNotifications } from '@agentclientprotocol/claude-agent-acp';
import { normalizeAcpxEvent } from '@dutydeck/acp-client';
import type { AgentEvent } from '@dutydeck/shared';
import { isRestartInterruption, larkHeldReason, larkLastActivityAt, larkRedispatchAgentNote, larkReplayUnsafeReason } from './turn-redispatch.js';

let calls = 0;
const tool = (name: string, input?: unknown, type: 'tool_call' | 'tool_result' = 'tool_call', id = `call_${++calls}`): AgentEvent => ({
  id: `evt_${id}_${type}`, sessionId: 'ses', sequence: 1, type, timestamp: '2026-09-25T00:00:00.000Z',
  data: { id, name, status: 'running', ...(input === undefined ? {} : { input }) }
});
/**
 * 内置 Claude ACP 适配器为一次工具调用发出的通知（claude-agent-acp 的 toAcpNotifications，会话目录 /repo）：流式时先发一条参数为空的
 * tool_call，完整消息到了再补参数；streamed 为 false 时第一条就带完整参数（权限请求先发出、回放）。之后是工具结果。
 * 再按 acpx 0.13 createToolCallEvent 的转法（缺省标题 tool call，转发 rawInput）交给 normalizeAcpxEvent，得到落库的事件。
 */
const claudeAcp = (name: string, input: Record<string, unknown>, streamed = true): AgentEvent[] => {
  const id = `toolu_${++calls}`, cache = {}, emittedToolCalls = new Set<string>();
  const notify = (content: unknown[], role: 'assistant' | 'user') =>
    toAcpNotifications(content as any, role, 'ses', cache, {} as any, console, { registerHooks: false, cwd: '/repo', emittedToolCalls });
  const updates = [
    ...(streamed ? notify([{ type: 'tool_use', id, name, input: {} }], 'assistant') : []),
    ...notify([{ type: 'tool_use', id, name, input }], 'assistant'),
    ...notify([{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }], 'user')
  ].map(notification => notification.update as Record<string, any>);
  return updates.map((update, index) => ({
    id: `${id}_${index}`, sessionId: 'ses', sequence: index + 1, timestamp: '2026-09-25T00:00:00.000Z',
    ...normalizeAcpxEvent({ type: 'tool_call', tag: update.sessionUpdate, toolCallId: update.toolCallId, title: update.title || 'tool call',
      ...(update.status ? { status: update.status } : {}), ...(update.kind ? { kind: update.kind } : {}), ...('rawInput' in update ? { rawInput: update.rawInput } : {}) })!
  }) as AgentEvent);
};
const bash = (command: string) => tool('Bash', { command, description: '' });
const codex = (command: string) => tool(command, { command: ['/usr/bin/zsh', '-lc', command], cwd: '/work' });

describe('被重启切断的一轮能不能安全重投', () => {
  it('只认服务重启留下的两个原因码', () => {
    expect(isRestartInterruption('PREVIOUS_RUNTIME_RESULT_UNKNOWN')).toBe(true);
    expect(isRestartInterruption('DAEMON_SHUTDOWN')).toBe(true);
    for (const code of ['STOP_RESULT_UNKNOWN', 'DRIVER_RECOVERY_UNKNOWN', 'AGENT_IDLE_TIMEOUT', undefined]) expect(isRestartInterruption(code)).toBe(false);
  });

  it('只读工具与只读命令不算外部副作用', () => {
    const events: AgentEvent[] = [
      { ...tool('Read', { file_path: '/a' }), type: 'tool_result' }, tool('Grep', { pattern: 'x' }), tool('TodoWrite', { todos: [] }), tool('WebFetch', { url: 'https://example.com' }),
      tool("Read file '/work/a.ts'"), tool("Search for 'x' in work"), tool("List files in 'work'"),
      { id: 'text', sessionId: 'ses', sequence: 2, type: 'text', timestamp: '', data: { text: 'git push' } },
      bash('cd /work && git status && git log --oneline -3 | head -5'),
      bash("rg -n 'a|b' src 2>/dev/null | sort | uniq -c"),
      bash("sed -n '1,200p' src/index.ts; wc -l src/*.ts"),
      bash('find . -name "*.ts" -type f | head -20'),
      bash('curl -s https://example.com/api/items'),
      bash("curl -sSL -H 'Accept: application/json' https://example.com/api && curl -XGET https://example.com && curl --request HEAD https://example.com"),
      bash('curl -I https://example.com && curl -m 10 --retry 2 -A dutydeck https://example.com'),
      bash('git -C /work diff --stat && git branch --show-current'),
      codex("rg -n 'foo' apps && cat README.md"),
      codex('ls -la')
    ];
    expect(larkReplayUnsafeReason(events)).toBeUndefined();
  });

  it('内置 Claude ACP 适配器产生的只读工具调用（标题形如 Read /work/alerts.md）不算外部副作用', () => {
    const read = claudeAcp('Read', { file_path: '/work/alerts.md' });
    expect(read.map(event => event.data)).toMatchObject([{ name: 'Read File' }, { name: 'Read /work/alerts.md', input: { file_path: '/work/alerts.md' } }, { name: 'tool call' }]);
    const events = [
      ...read, ...claudeAcp('Read', { file_path: '/repo/a.ts', offset: 10, limit: 20 }),
      ...claudeAcp('Glob', { pattern: '**/*.ts', path: '/repo' }), ...claudeAcp('Grep', { pattern: 'alert', path: '/repo', output_mode: 'content', '-n': true }),
      ...claudeAcp('WebFetch', { url: 'https://example.com', prompt: 'summary' }), ...claudeAcp('WebSearch', { query: 'dutydeck' }),
      ...claudeAcp('Bash', { command: 'git status && git log --oneline -3', description: 'Show status' }),
      // Codex 的结果事件也只有缺省名，与开始事件同 id。
      tool("Read file '/work/a.ts'", undefined, 'tool_call', 'codex_read'), tool('tool call', undefined, 'tool_result', 'codex_read')
    ];
    expect(larkReplayUnsafeReason(events)).toBeUndefined();
  });

  it.each([
    [claudeAcp('Bash', { command: 'git push origin HEAD', description: 'Push' }), '执行过 git push'],
    [claudeAcp('Write', { file_path: '/repo/a.md', content: 'x' }), '调用过 Write'],
    [claudeAcp('Edit', { file_path: '/repo/a.md', old_string: 'a', new_string: 'b' }), '调用过 Edit'],
    [claudeAcp('mcp__lark__send_message', { text: 'hi' }), '调用过 mcp__lark__send_message'],
    // 子 Agent 的标题是它的描述，碰巧以 Read 开头也不能认成读文件。
    [claudeAcp('Agent', { description: 'Read the alerts and reply', prompt: 'do it', subagent_type: 'general-purpose' }, false), '调用过无法判断是否只读的工具']
  ])('内置 Claude ACP 适配器产生的可能对外生效的工具调用按不安全处理：%#', (events, reason) => {
    expect(larkReplayUnsafeReason(events)).toBe(reason);
  });

  it.each([
    [bash('cd /work && git push origin master'), '执行过 git push'],
    [bash('git commit -am "fix"'), '执行过 git commit'],
    [codex("git push origin HEAD"), '执行过 git push'],
    [bash("curl -X POST https://example.com/api -d '{}'"), '执行过 curl'],
    [bash('curl -sXPOST https://example.com/api'), '执行过 curl'],
    [bash('curl --data-raw x https://example.com/api'), '执行过 curl'],
    [bash('curl --request=POST https://example.com/api'), '执行过 curl'],
    [bash("curl -d'{}' https://example.com/api"), '执行过 curl'],
    [bash('curl -o/tmp/page.html https://example.com'), '执行过 curl'],
    [bash('curl --unknown-flag https://example.com'), '执行过 curl'],
    [bash('rm -rf dist'), '执行过 rm'],
    [bash('echo hi > notes.txt'), '执行过无法判断是否只读的命令'],
    [bash('cat <<EOF > a.txt\nx\nEOF'), '执行过无法判断是否只读的命令'],
    [bash('echo $(date)'), '执行过无法判断是否只读的命令'],
    [bash("sed -i 's/a/b/' file"), '执行过 sed'],
    [bash('find . -name "*.tmp" -delete'), '执行过 find'],
    [bash('pnpm test'), '执行过 pnpm'],
    [bash('ssh host ls'), '执行过 ssh'],
    [bash("python3 - <<'PY'\nprint(1)\nPY"), '执行过无法判断是否只读的命令'],
    [tool('SendMessage', { to: 'team', message: 'hi' }), '调用过 SendMessage'],
    [tool('Edit', { file_path: '/a' }), '调用过 Edit'],
    [tool('Agent', { prompt: 'do it' }), '调用过 Agent'],
    [tool('mcp__lark__send_message', { text: 'hi' }), '调用过 mcp__lark__send_message'],
    [tool('tool call'), '调用过无法判断是否只读的工具']
  ])('可能对外生效的操作按不安全处理：%#', (event, reason) => {
    expect(larkReplayUnsafeReason([bash('git status'), event])).toBe(reason);
  });

  it('原因里只有命令名，参数（可能带 token）不进说明', () => {
    const reason = larkReplayUnsafeReason([bash('TOKEN=secret-value curl -H "Authorization: Bearer secret-value" -d x https://example.com')]);
    expect(reason).toBe('执行过 curl');
    expect(reason).not.toContain('secret');
  });

  it('最后一次活动取这一轮最后一个事件，账本补记的 task / status 事件不算；没有事件用开始时间，都取不到返回 undefined', () => {
    const at = (type: string, timestamp: string): AgentEvent => ({ id: `${type}-${timestamp}`, sessionId: 'ses', sequence: 1, type, timestamp, data: {} });
    expect(larkLastActivityAt([at('tool_call', '2026-09-25T01:00:00.000Z'), at('text', '2026-09-25T01:05:00.000Z'), at('task', '2026-09-25T09:00:00.000Z'), at('status', '2026-09-25T09:00:00.000Z')], '2026-09-25T00:00:00.000Z'))
      .toBe(Date.parse('2026-09-25T01:05:00.000Z'));
    expect(larkLastActivityAt([at('task', '2026-09-25T09:00:00.000Z')], '2026-09-25T00:00:00.000Z')).toBe(Date.parse('2026-09-25T00:00:00.000Z'));
    expect(larkLastActivityAt([at('tool_call', '')], 'not a time')).toBeUndefined();
    expect(larkLastActivityAt([])).toBeUndefined();
  });

  it('停下的原因：副作用优先，其次中断时间较早或取不到，最后是重投满', () => {
    expect(larkHeldReason({ count: 0, unsafeReason: '执行过 git push', stale: 'old' })).toBe('这一轮执行过 git push，可能已产生外部副作用，没有自动重投。');
    expect(larkHeldReason({ count: 0, stale: 'old' })).toBe('中断时间较早，没有自动重投。');
    expect(larkHeldReason({ count: 1, stale: 'unknown' })).toBe('无法确认中断时间，没有自动重投。此前已重投 1 次。');
    expect(larkHeldReason({ count: 2 })).toBe('已重投 2 次仍被重启打断，不再自动重投。');
  });

  it('Agent 说明区分原会话续做与新会话重做', () => {
    const resumed = larkRedispatchAgentNote({ count: 1, resumed: true, auto: true });
    expect(resumed).toContain('服务重启打断了上一轮');
    expect(resumed).toContain('请从停下处继续');
    expect(resumed).toContain('重复任何对外操作');
    expect(resumed).toContain('第 1/2 次自动重投');
    const fresh = larkRedispatchAgentNote({ count: 2, resumed: false, auto: true });
    expect(fresh).toContain('之前的动作可能已经生效');
    expect(fresh).not.toContain('请从停下处继续');
  });
});
