import { describe, expect, it } from 'vitest';
import { collaborationSnapshotSchema, collaborationSettingsSchema, collaborationFollowupSchema, collaborationMandateSchema, type CollaborationObservation, type CollaborationSnapshot } from '@dutydeck/shared';
import { participationInput } from './lark/readonly-decider.js';
import { boundCollaborationSnapshot } from './collaboration-context.js';

const scope = { appId: 'cli_context', chatId: 'oc_context' };
const stamp = '2026-09-18T01:00:00.000Z';
const settings = collaborationSettingsSchema.parse({ scope, updatedAt: stamp });
const observation = (sequence: number): CollaborationObservation => ({ id: `obs_${sequence}`, scope, sequence, source: 'lark.message', eventId: `om_${sequence}`,
  occurredAt: stamp, receivedAt: stamp, senderId: 'ou_alice', senderKind: 'human', messageId: `om_${sequence}`, text: '已提交初稿', refs: [`om_${sequence}`], origin: 'live', missing: [], revision: 1 });
const followup = (id: string) => collaborationFollowupSchema.parse({ id, scope, revision: 3, goal: '完成文档', status: 'open', progress: '初稿完成，审核中', steps: [{ id: 'draft', label: '初稿', status: 'done' }, { id: 'review', label: '审核', status: 'open' }], sourceRefs: ['obs_499'], createdBy: 'ou_alice', updatedBy: 'ou_alice', provenance: 'inferred', createdAt: stamp, updatedAt: stamp });
const mandate = (id: string) => collaborationMandateSchema.parse({ id, scope, revision: 2, goal: '关注进展', status: 'active', requesterId: 'ou_alice', scheduleDefinitionId: `schedule_${id}`, mode: 'agent', prompt: '查看最新材料', condition: 'followup_open', catchupPolicy: 'coalesce', createdAt: stamp, updatedAt: stamp });
const small = (): CollaborationSnapshot => ({ scope, contextRevision: 19, settings, observations: [observation(1)], followups: [followup('linked')], mandates: [mandate('m1')] });
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

describe('bounded collaboration model context', () => {
  it('bounds team sources and text independently without displacing the local trigger', () => {
    const source = small();
    const sources = Array.from({ length: 10 }, (_, i) => ({ scope: { ...scope, chatId: `team_${i}` }, name: `群${i}`, status: 'complete' as const, missing: [] }));
    source.teamContext = { query: '我的待办', searchedAt: stamp, sources,
      observations: Array.from({ length: 100 }, (_, i) => ({ ...observation(10000 + i), id: `team_obs_${i}`, scope: sources[i % 10]!.scope, text: '中文🙂'.repeat(3000), origin: 'history' })) };
    const original = structuredClone(source);
    const result = participationInput(source);
    expect(result.observations).toEqual(source.observations);
    expect(result.teamContext!.sources).toHaveLength(8);
    expect(result.teamContext!.observations).toHaveLength(80);
    expect(result.teamContext!.observations.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(20000);
    expect(result.teamContext!.observations.every(item => item.text.length <= 4000 && result.teamContext!.sources.some(group => group.scope.chatId === item.scope.chatId))).toBe(true);
    expect(result.teamContext!.sources.every(item => item.status === 'partial' && item.missing.includes('team_context_truncated'))).toBe(true);
    expect(result.bootstrap!.missing.join(';')).toContain('teamContext.sources=2');
    expect(size(result)).toBeLessThanOrEqual(512 * 1024);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
    expect(source).toEqual(original);
  });

  it('keeps the full byte bound with escaped team metadata and a nearly full local snapshot', () => {
    const source = small();
    source.followups = Array.from({ length: 90 }, (_, i) => ({ ...followup(`f${i}`), progress: '\u0000'.repeat(8000) }));
    const local = boundCollaborationSnapshot(source);
    source.teamContext = { query: '\u0000'.repeat(2000), searchedAt: stamp,
      sources: [{ scope, name: '\u0000'.repeat(256), status: 'complete', missing: Array(100).fill('\u0000'.repeat(256)) }],
      observations: Array.from({ length: 80 }, (_, i) => ({ ...observation(10000 + i), text: '\u0000'.repeat(16000), missing: Array(100).fill('\u0000'.repeat(256)) })) };
    const result = boundCollaborationSnapshot(source);
    expect(result.observations).toEqual(local.observations);
    expect(result.followups).toEqual(local.followups);
    expect(size(result)).toBeLessThanOrEqual(512 * 1024);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
    expect(result.bootstrap!.missing.join(';')).toContain('teamContext');
  });

  it('preserves a small snapshot without invented gaps and returns independent nested copies', () => {
    const source = small(); const original = structuredClone(source);
    const result = boundCollaborationSnapshot(source, 'linked');
    expect(result).toEqual(source); expect(result.bootstrap).toBeUndefined();
    result.followups[0]!.steps[0]!.status = 'open'; result.observations[0]!.scope.chatId = 'changed';
    expect(source).toEqual(original);
  });

  it('keeps linked state and pinned sources under 512 KiB despite 500 Chinese messages and many records', () => {
    const source = small();
    source.observations = Array.from({ length: 500 }, (_, i) => ({ ...observation(i + 1), text: '中文🙂'.repeat(4000) }));
    source.observations.unshift({ ...observation(1), id: 'description', source: 'lark.description', text: '群说明' }, { ...observation(2), id: 'memory', source: 'lark.memory', text: '历史记忆' });
    source.followups = Array.from({ length: 90 }, (_, i) => ({ ...followup(`f${i}`), fields: Object.fromEntries(Array.from({ length: 30 }, (_, j) => [`field_${j}`, '材料'.repeat(1000)])) }));
    const linked = { ...followup('linked'), updatedAt: '2020-01-01T00:00:00.000Z', fields: { large: '重要材料'.repeat(500) }, externalRefs: Array(100).fill('链接'.repeat(100)) };
    source.followups.push(linked);
    source.mandates = Array.from({ length: 90 }, (_, i) => ({ ...mandate(`m${i}`), prompt: '处理材料'.repeat(2000) }));
    source.bootstrap = { scope, status: 'complete', missing: ['history_permission_limited'], updatedAt: stamp };
    const originalLinked = structuredClone(linked);
    const result = boundCollaborationSnapshot(source, 'linked');
    expect(size(result)).toBeLessThanOrEqual(512 * 1024);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
    expect(result.contextRevision).toBe(source.contextRevision); expect(result.settings).toEqual(source.settings);
    expect(result.followups[0]).toMatchObject({ id: 'linked', revision: 3, status: linked.status, progress: linked.progress, steps: linked.steps, sourceRefs: ['obs_499'] });
    expect(result.observations.some(item => item.id === 'obs_500')).toBe(true);
    expect(result.observations.some(item => item.id === 'obs_1')).toBe(false);
    expect(result.observations.map(item => item.source)).toEqual(expect.arrayContaining(['lark.description', 'lark.memory']));
    expect(result.observations.find(item => item.id === 'obs_500')!.missing).toContain('context_text_truncated');
    for (const item of [...result.observations, ...result.followups, ...result.mandates]) expect(item.scope).toEqual(scope);
    expect(result.bootstrap).toMatchObject({ status: 'partial', missing: expect.arrayContaining(['history_permission_limited']) });
    expect(result.bootstrap!.missing.join('\n')).toMatch(/context_omitted:.*observations=450/);
    expect(result.bootstrap!.missing.join('\n')).toContain('followups=');
    expect(result.bootstrap!.missing.join('\n')).toContain('mandates=');
    expect(result.bootstrap!.missing.join('\n')).toContain('followups.externalRefs=');
    expect(result.bootstrap!.missing.every(marker => marker.length <= 256)).toBe(true);
    expect(source.followups.at(-1)).toEqual(originalLinked);
    expect(source.observations.at(-1)!.text).toBe('中文🙂'.repeat(4000));
    expect(source.bootstrap.status).toBe('complete');
  });

  it('counts JSON escapes and UTF-8 bytes while preserving maximal linked progress and step states', () => {
    const source = small(); const escaped = '\u0000';
    source.settings = { ...settings, instructions: escaped.repeat(8000) };
    source.bootstrap = { scope, status: 'complete', missing: Array(100).fill(escaped.repeat(256)), updatedAt: stamp };
    const linked = { ...followup('linked'), goal: escaped.repeat(2000), progress: escaped.repeat(8000), result: escaped.repeat(8000),
      steps: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, label: escaped.repeat(500), status: i % 2 ? 'done' as const : 'open' as const })),
      fields: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, '中文'.repeat(1000)])) };
    source.followups = [linked];
    source.observations = [ { ...observation(1), source: 'lark.description', text: '说明'.repeat(8000) }, { ...observation(2), source: 'lark.memory', text: '记忆'.repeat(8000) } ];
    const result = boundCollaborationSnapshot(source, 'linked');
    expect(size(result)).toBeLessThanOrEqual(512 * 1024);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
    expect(result.followups[0]!.steps).toEqual(linked.steps);
    expect(result.followups[0]!.progress).toBe(linked.progress);
    expect(result.observations).toHaveLength(2);
    expect(result.bootstrap!.missing).toContain('missing_details_omitted=2');
    expect(result.bootstrap!.missing.length).toBeLessThanOrEqual(100);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
    expect(result.bootstrap!.missing.join('\n')).toContain('followups.fields=');
  });

  it('keeps the participation text budget after applying the shared byte bound', () => {
    const source = small();
    source.observations = Array.from({ length: 50 }, (_, i) => ({ ...observation(i + 1), text: 'a'.repeat(4000) }));
    source.observations.unshift({ ...observation(1), id: 'memory', source: 'lark.memory', text: 'memory' });
    const result = participationInput(source);
    expect(result.observations.filter(item => item.source === 'lark.message').reduce((sum, item) => sum + item.text.length, 0)).toBe(40000);
    expect(result.observations.find(item => item.source === 'lark.memory')!.text).toBe('memory');
    expect(result.observations.find(item => item.id === 'obs_1')!.missing).toContain('decision_text_truncated');
    expect(result.bootstrap!.status).toBe('partial');
    expect(result.bootstrap!.missing.join('; ')).toContain('observations.text=40');
    expect(size(result)).toBeLessThanOrEqual(512 * 1024);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
  });

  it('packs short missing details and explicitly reports discarded long details within the schema', () => {
    const source = small();
    source.bootstrap = { scope, status: 'complete', missing: Array.from({ length: 100 }, (_, i) => `gap_${i}`), updatedAt: stamp };
    source.observations[0]!.missing = Array.from({ length: 100 }, (_, i) => `gap_${i}_${'中'.repeat(240)}`);
    source.observations[0]!.text = '中'.repeat(16000);
    const original = structuredClone(source);
    const result = participationInput(source);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
    expect(result.observations[0]!.missing).toContain('decision_text_truncated');
    expect(result.observations[0]!.missing.some(value => value.startsWith('missing_details_omitted='))).toBe(true);
    expect(result.bootstrap!.status).toBe('partial');
    expect(result.bootstrap!.missing.join('; ')).toContain('gap_99');
    expect(result.bootstrap!.missing.some(value => value.startsWith('missing_details_omitted='))).toBe(false);
    expect(size(result)).toBeLessThanOrEqual(512 * 1024);
    expect(collaborationSnapshotSchema.parse(result)).toEqual(result);
    expect(source).toEqual(original);
  });

  it('samples other records by recency and marks a missing linked record instead of inventing it', () => {
    const source = small();
    source.followups = [ { ...followup('old'), updatedAt: '2020-01-01T00:00:00.000Z' }, followup('new') ];
    const result = boundCollaborationSnapshot(source, 'absent');
    expect(result.followups.map(item => item.id)).toEqual(['new', 'old']);
    expect(result.bootstrap!.missing).toContain('context_omitted:related_followup=1');
  });
});
