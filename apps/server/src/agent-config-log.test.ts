import { describe, expect, it } from 'vitest';
import { logDroppedAgents } from './agent-config-log.js';

describe('logDroppedAgents', () => {
  it('每个被丢弃的 Agent 一条告警，写出 id、命令和用绝对路径的修法', () => {
    const lines: Array<{ details: object; message: string }> = [];
    logDroppedAgents({ warn: (details, message) => lines.push({ details, message }) }, [
      { id: 'ghost', name: 'Ghost', command: 'ghost-cli', reason: 'command_not_found' },
      { id: 'other', name: 'Other', command: '/opt/missing/agent', reason: 'command_not_found' }
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.details).toEqual({ agentId: 'ghost', command: 'ghost-cli' });
    expect(lines[0]!.message).toContain('ghost-cli');
    expect(lines[0]!.message).toContain('绝对路径');
    expect(lines[1]!.message).toContain('/opt/missing/agent');
  });

  it('没有被丢弃的 Agent 时不输出', () => {
    const lines: string[] = [];
    logDroppedAgents({ warn: (_details, message) => lines.push(message) }, []);
    expect(lines).toEqual([]);
  });
});
