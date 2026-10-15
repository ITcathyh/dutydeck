import { describe, expect, it } from 'vitest';
import { COLLABORATION_LIST_LIMIT, listWindowIncomplete } from '@dutydeck/shared';
import { createRepositories } from './index.js';

const scope = { appId: 'cli_app_a', chatId: 'oc_chat_a' };
const at = (index: number) => new Date(Date.parse('2026-10-15T03:00:00.000Z') + index * 1000).toISOString();

describe('协作列表查询的截断标记', () => {
  it('库里还有更早的记录时标 truncated，正好读完时不标；标记不进 JSON 和相等比较', async () => {
    const repos = createRepositories(':memory:');
    try {
      const collab = repos.collaboration;
      for (let index = 0; index < 3; index++) {
        await collab.recordDecision({ id: `decision_${index}`, scope, contextRevision: index, policyVersion: 'v1', action: 'silent', reason: 'r', evidenceIds: [], status: 'candidate', inputSnapshot: {}, createdAt: at(index) });
        await collab.beginAction({ id: `action_${index}`, scope, kind: 'participation.reply', requesterId: 'owner', inputDigest: `action_${index}` });
      }
      const two = await collab.listDecisions(scope, 2);
      expect(two.map(item => item.id)).toEqual(['decision_2', 'decision_1']);
      expect(two.truncated).toBe(true);
      expect((await collab.listDecisions(scope, 3)).truncated).toBe(false);
      expect((await collab.listActions(scope, 2)).truncated).toBe(true);
      expect((await collab.listActions(scope, 3)).truncated).toBe(false);
      expect((await collab.listActions(undefined, 2)).truncated).toBe(true);
      expect((await collab.listActivities(scope, 2)).truncated).toBe(false);
      expect(JSON.parse(JSON.stringify(two))).toHaveLength(2);
      expect(Object.keys(two)).toEqual(['0', '1']);
      expect(two).toEqual([...two]);
    } finally {
      repos.close();
    }
  });

  it('请求超过存储上限时按上限截断，并据此判断统计窗口有没有读全', async () => {
    const repos = createRepositories(':memory:');
    try {
      const collab = repos.collaboration;
      for (let index = 0; index < COLLABORATION_LIST_LIMIT; index++) {
        await collab.recordDecision({ id: `decision_${index}`, scope, contextRevision: index, policyVersion: 'v1', action: 'silent', reason: 'r', evidenceIds: [], status: 'candidate', inputSnapshot: {}, createdAt: at(index) });
      }
      const exact = await collab.listDecisions(scope, 1000);
      expect(exact).toHaveLength(COLLABORATION_LIST_LIMIT);
      expect(exact.truncated).toBe(false);
      expect(listWindowIncomplete(exact, Date.parse(at(0)))).toBe(false);
      await collab.recordDecision({ id: 'decision_more', scope, contextRevision: 9999, policyVersion: 'v1', action: 'silent', reason: 'r', evidenceIds: [], status: 'candidate', inputSnapshot: {}, createdAt: at(COLLABORATION_LIST_LIMIT) });
      const over = await collab.listDecisions(scope, 1000);
      expect(over).toHaveLength(COLLABORATION_LIST_LIMIT);
      expect(over.truncated).toBe(true);
      // 最旧一条仍在窗口内：没读全；最旧一条已在窗口外：读全了。
      expect(listWindowIncomplete(over, Date.parse(at(0)))).toBe(true);
      expect(listWindowIncomplete(over, Date.parse(at(2)))).toBe(false);
    } finally {
      repos.close();
    }
  });
});
