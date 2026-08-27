import { describe, expect, it } from 'vitest';
import { cardInputFromCli } from './cli.js';

describe('Lark CLI card input', () => {
  it('passes Markdown through with custom agent branding', () => {
    expect(cardInputFromCli('### 业务自定义\n\n🟡 执行中', {
      state: 'running', agentName: 'My Agent', taskName: 'Debug', taskId: '1', elapsedSeconds: '12', readOnly: true
    })).toEqual({
      state: 'running', agentName: 'My Agent', taskName: 'Debug', taskId: '1', elapsedSeconds: 12, readOnly: true,
      markdown: '### 业务自定义\n\n🟡 执行中'
    });
  });

  it('rejects invalid state', () => {
    expect(() => cardInputFromCli('x', { state: 'waiting' })).toThrow(/state must be one of/);
  });
});
