import { describe, expect, it } from 'vitest';
import { createRepositories } from './index.js';

describe('ChannelMappingRepository.compareAndSetExtra', () => {
  it('匹配成功：changes===1，返回 true 并更新 extra，其他列保持不变', async () => {
    const repos = createRepositories(':memory:');
    try {
      const mapping = {
        id: 'map_1',
        channel: 'lark-card:test',
        externalId: 'ext_1',
        sessionId: 'ses_1',
        extra: '{"turn":1}',
        createdAt: '2026-09-17T00:00:00.000Z'
      };
      await repos.channelMappings.save(mapping);

      const success = await repos.channelMappings.compareAndSetExtra('map_1', '{"turn":1}', '{"turn":2}');
      expect(success).toBe(true);

      const current = await repos.channelMappings.get('lark-card:test', 'ext_1');
      expect(current?.extra).toBe('{"turn":2}');
      // 其他列保持不变
      expect(current?.id).toBe('map_1');
      expect(current?.channel).toBe('lark-card:test');
      expect(current?.externalId).toBe('ext_1');
      expect(current?.sessionId).toBe('ses_1');
      expect(current?.createdAt).toBe('2026-09-17T00:00:00.000Z');
    } finally {
      repos.close();
    }
  });

  it('旧 expected 失败：changes===0，返回 false 且不改变现有值', async () => {
    const repos = createRepositories(':memory:');
    try {
      const mapping = {
        id: 'map_2',
        channel: 'lark-card:test',
        externalId: 'ext_2',
        sessionId: 'ses_2',
        extra: '{"turn":2}',
        createdAt: '2026-09-17T00:00:00.000Z'
      };
      await repos.channelMappings.save(mapping);

      // 传入过期的 expected "{"turn":1}"
      const success = await repos.channelMappings.compareAndSetExtra('map_2', '{"turn":1}', '{"turn":3}');
      expect(success).toBe(false);

      const current = await repos.channelMappings.get('lark-card:test', 'ext_2');
      expect(current?.extra).toBe('{"turn":2}'); // 保持原值不变
    } finally {
      repos.close();
    }
  });

  it('null 初始：当 extra 初始为 null 时，expectedExtra 传入 null 或 undefined 均能匹配成功', async () => {
    const repos = createRepositories(':memory:');
    try {
      const mapping1 = {
        id: 'map_null_1',
        channel: 'lark-card:test',
        externalId: 'ext_null_1',
        sessionId: 'ses_null_1',
        extra: null,
        createdAt: '2026-09-17T00:00:00.000Z'
      };
      await repos.channelMappings.save(mapping1);

      // 传入 null 匹配
      const success1 = await repos.channelMappings.compareAndSetExtra('map_null_1', null, '{"turn":1}');
      expect(success1).toBe(true);
      const current1 = await repos.channelMappings.get('lark-card:test', 'ext_null_1');
      expect(current1?.extra).toBe('{"turn":1}');

      const mapping2 = {
        id: 'map_null_2',
        channel: 'lark-card:test',
        externalId: 'ext_null_2',
        sessionId: 'ses_null_2',
        extra: null,
        createdAt: '2026-09-17T00:00:00.000Z'
      };
      await repos.channelMappings.save(mapping2);

      // 传入 undefined 匹配
      const success2 = await repos.channelMappings.compareAndSetExtra('map_null_2', undefined, '{"turn":1}');
      expect(success2).toBe(true);
      const current2 = await repos.channelMappings.get('lark-card:test', 'ext_null_2');
      expect(current2?.extra).toBe('{"turn":1}');
    } finally {
      repos.close();
    }
  });

  it('missing id：记录不存在时返回 false', async () => {
    const repos = createRepositories(':memory:');
    try {
      const success = await repos.channelMappings.compareAndSetExtra('non_existent_id', '{"turn":1}', '{"turn":2}');
      expect(success).toBe(false);
    } finally {
      repos.close();
    }
  });
});
