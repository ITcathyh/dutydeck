import { describe, expect, it } from 'vitest';
import { checkLark } from './checks.js';

describe('doctor Lark config check', () => {
  it('reports an unparseable bot entry and keeps checking the others', () => {
    const raw = JSON.stringify([
      { appId: 'cli_good', appSecret: 'secret', riskControlMode: 'off' },
      { appId: 'cli_bad', appSecret: 'secret', defaultAgentWeights: [{ agentId: 'codex', weight: 1, extra: true }] }
    ]);
    const result = checkLark({ raw }, false);
    expect(result.botCount).toBe(1);
    const invalid = result.checks.find(check => check.id === 'lark.config-invalid');
    expect(invalid).toMatchObject({ level: 'fail', detail: expect.stringContaining('cli_bad') });
    expect(invalid!.detail).not.toContain('secret');
    expect(result.checks.find(check => check.id === 'lark.config')).toMatchObject({ level: 'ok', detail: expect.stringContaining('cli_good') });
  });
});
