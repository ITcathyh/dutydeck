import { afterEach, describe, expect, it } from 'vitest';
import { setLarkSessionShareSigner } from './detail-link.js';
import { buildLarkCard } from './service.js';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

describe('卡片「查看详情」指向只读分享页', () => {
  const inputs = [
    { cardKind: 'result', state: 'completed', readOnly: true, markdown: '已完成' },
    { cardKind: 'process', state: 'running' },
    { cardKind: 'process', state: 'failed' }
  ] as const;

  it('服务进程注册签名后，有会话的卡都链接到 /share/<会话>#<token>，不出现工作台深链', () => {
    disposers.push(setLarkSessionShareSigner(sessionId => `sig-${sessionId}`));
    for (const input of inputs) {
      const card = JSON.stringify(buildLarkCard({ ...input, taskId: 'om_task', sessionId: 'ses/1', webBaseUrl: 'https://dock.example' }));
      expect(card).toContain('[查看详情](https://dock.example/share/ses%2F1#sig-ses/1)');
      expect(card).not.toContain('/sessions/');
    }
  });

  it('没有会话的卡仍指向工作台首页；注销签名后退回工作台任务页', () => {
    const dispose = setLarkSessionShareSigner(sessionId => `sig-${sessionId}`);
    expect(JSON.stringify(buildLarkCard({ taskId: 'om_task', state: 'failed', readOnly: true, webBaseUrl: 'https://dock.example' }))).toContain('[查看详情](https://dock.example/)');
    dispose();
    expect(JSON.stringify(buildLarkCard({ taskId: 'om_task', sessionId: 'ses_1', state: 'completed', readOnly: true, webBaseUrl: 'https://dock.example' })))
      .toContain('[查看详情](https://dock.example/sessions/ses_1)');
  });

  it('没配 Web 地址时整卡没有「查看详情」', () => {
    disposers.push(setLarkSessionShareSigner(sessionId => `sig-${sessionId}`));
    for (const input of inputs) {
      const card = JSON.stringify(buildLarkCard({ ...input, taskId: 'om_task', sessionId: 'ses_1' }));
      expect(card).not.toContain('查看详情');
      expect(card).not.toContain('/share/');
      expect(card).not.toContain('undefined/');
    }
  });
});
