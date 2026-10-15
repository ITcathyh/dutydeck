import { describe, expect, it } from 'vitest';
import { collaborationParticipationModes, LEGACY_MENTION_POLICY, NEW_BOT_MENTION_POLICY, participationLevelOf, resolveParticipation } from './collaboration.js';

const policies = [undefined, 'always', 'topic', 'never', 'ambient'] as const;

describe('resolveParticipation', () => {
  it('旧配置缺唤醒方式读成 always，新建机器人另存为 topic，两者不同', () => {
    expect(LEGACY_MENTION_POLICY).toBe('always');
    expect(NEW_BOT_MENTION_POLICY).toBe('topic');
    expect(resolveParticipation({})).toEqual({ level: 'mention', mentionPolicy: 'always', participation: 'off', source: { mentionPolicy: 'legacy_default', participation: 'group' } });
    expect(resolveParticipation({ mentionPolicy: 'topic' }).source.mentionPolicy).toBe('configured');
  });

  it('档位与旧的 participationLevelOf 逐条一致', () => {
    for (const mentionPolicy of policies) for (const participation of collaborationParticipationModes) {
      expect(resolveParticipation({ mentionPolicy, participation }).level).toBe(participationLevelOf(mentionPolicy, participation));
    }
  });

  it('继承时取机器人默认参与模式，缺省为 off', () => {
    expect(resolveParticipation({ participation: 'eager', inheritParticipation: true, botDefaultParticipation: 'selective' })).toMatchObject({ participation: 'selective', level: 'selective', source: { participation: 'inherited' } });
    expect(resolveParticipation({ participation: 'eager', inheritParticipation: true })).toMatchObject({ participation: 'off', source: { participation: 'inherited' } });
    expect(resolveParticipation({ participation: 'eager', inheritParticipation: false, botDefaultParticipation: 'off' })).toMatchObject({ participation: 'eager', source: { participation: 'group' } });
  });

  it('负责范围只在参与模式为 off 且唤醒方式不需要 @ 时改成积极参与', () => {
    for (const mentionPolicy of policies) for (const participation of collaborationParticipationModes) for (const roleScope of [undefined, '', '  ', '发布和告警']) {
      const resolved = resolveParticipation({ mentionPolicy, participation, roleScope });
      const raised = participation === 'off' && Boolean(roleScope?.trim()) && (mentionPolicy === 'never' || mentionPolicy === 'ambient');
      expect(resolved.participation).toBe(raised ? 'eager' : participation);
      expect(resolved.source.participation).toBe(raised ? 'role_scope' : 'group');
      expect(resolved.level).toBe(participationLevelOf(mentionPolicy, raised ? 'eager' : participation));
    }
  });
});
