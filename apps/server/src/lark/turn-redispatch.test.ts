import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@dutydeck/shared';
import { isRestartInterruption, larkHeldReason, larkLastActivityAt, larkRedispatchAgentNote, larkReplayUnsafeReason } from './turn-redispatch.js';

const tool = (name: string, input?: unknown, type: 'tool_call' | 'tool_result' = 'tool_call'): AgentEvent => ({
  id: `evt_${name}`, sessionId: 'ses', sequence: 1, type, timestamp: '2026-09-25T00:00:00.000Z',
  data: { id: 'call', name, status: 'running', ...(input === undefined ? {} : { input }) }
});
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
      bash('git -C /work diff --stat && git branch --show-current'),
      codex("rg -n 'foo' apps && cat README.md"),
      codex('ls -la')
    ];
    expect(larkReplayUnsafeReason(events)).toBeUndefined();
  });

  it.each([
    [bash('cd /work && git push origin master'), '执行过 git push'],
    [bash('git commit -am "fix"'), '执行过 git commit'],
    [codex("git push origin HEAD"), '执行过 git push'],
    [bash("curl -X POST https://example.com/api -d '{}'"), '执行过 curl'],
    [bash('curl -sXPOST https://example.com/api'), '执行过 curl'],
    [bash('curl --data-raw x https://example.com/api'), '执行过 curl'],
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
