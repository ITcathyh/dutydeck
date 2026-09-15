import { describe, expect, it } from 'vitest';
import {
  checkFullTrustScopeCoverage,
  coversFullTrustScopeEntry,
  isFullTrustScopeCovered,
  normalizeFullTrustScope
} from './bot-configuration-scope.js';
import type { FullTrustScopeEntry, FullTrustScopeV1 } from './bot-configuration.js';

describe('FullTrustScope Coverage and Normalization', () => {
  const baseExecutionDigest = 'e'.repeat(64);
  const baseDirectoryDigest = 'd'.repeat(64);

  const baseEntry: FullTrustScopeEntry = {
    entry: { kind: 'p2p' },
    subject: { kind: 'human', rule: { mode: 'owner_only' } },
    actions: ['task.create', 'turn.append', 'task.view_result'],
    operateScope: 'own_runs',
    executionDigest: baseExecutionDigest,
    directoryIdentityDigest: baseDirectoryDigest,
    gates: { terminalWrite: false, highRisk: false, groupToolsSend: false },
    expiresAt: '2026-10-01T00:00:00.000Z'
  };

  const baseScope: FullTrustScopeV1 = {
    version: 1,
    channelBotId: 'bot_1',
    externalAppId: 'cli_app_1',
    brand: 'feishu',
    entries: [baseEntry]
  };

  describe('1. 基础覆盖与身份域匹配', () => {
    it('identical scope is fully covered', () => {
      expect(isFullTrustScopeCovered(baseScope, baseScope)).toBe(true);
      const res = checkFullTrustScopeCoverage(baseScope, baseScope);
      expect(res.covered).toBe(true);
      expect(res.mismatches).toHaveLength(0);
    });

    it('rejects when channelBotId mismatches', () => {
      const candidate: FullTrustScopeV1 = { ...baseScope, channelBotId: 'bot_2' };
      expect(isFullTrustScopeCovered(candidate, baseScope)).toBe(false);
    });

    it('rejects when externalAppId mismatches', () => {
      const candidate: FullTrustScopeV1 = { ...baseScope, externalAppId: 'cli_app_2' };
      expect(isFullTrustScopeCovered(candidate, baseScope)).toBe(false);
    });

    it('rejects when brand mismatches (feishu vs lark)', () => {
      const candidate: FullTrustScopeV1 = { ...baseScope, brand: 'lark' };
      expect(isFullTrustScopeCovered(candidate, baseScope)).toBe(false);
    });
  });

  describe('2. 执行与目录身份摘要匹配（拒绝变更，展示无关字段不影响）', () => {
    it('rejects when executionDigest changes (e.g. command/args/riskControlMode modified)', () => {
      const candidateEntry: FullTrustScopeEntry = {
        ...baseEntry,
        executionDigest: 'f'.repeat(64)
      };
      const candidateScope: FullTrustScopeV1 = { ...baseScope, entries: [candidateEntry] };
      expect(isFullTrustScopeCovered(candidateScope, baseScope)).toBe(false);
    });

    it('rejects when directoryIdentityDigest changes', () => {
      const candidateEntry: FullTrustScopeEntry = {
        ...baseEntry,
        directoryIdentityDigest: '1'.repeat(64)
      };
      const candidateScope: FullTrustScopeV1 = { ...baseScope, entries: [candidateEntry] };
      expect(isFullTrustScopeCovered(candidateScope, baseScope)).toBe(false);
    });

    it('presentation fields do not enter scope digests and keep coverage intact', () => {
      // Presentation and model-display changes don't alter executionDigest/directoryIdentityDigest
      const candidateScope: FullTrustScopeV1 = { ...baseScope };
      expect(isFullTrustScopeCovered(candidateScope, baseScope)).toBe(true);
    });
  });

  describe('3. Entry 形式与 Group Binding 范围覆盖', () => {
    it('p2p cannot cover group, and group cannot cover p2p', () => {
      const groupConfirmed: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: 'all_verified' }
      };
      const p2pCandidate: FullTrustScopeEntry = { ...baseEntry, entry: { kind: 'p2p' } };

      expect(coversFullTrustScopeEntry(groupConfirmed, p2pCandidate)).toBe(false);
      expect(coversFullTrustScopeEntry(p2pCandidate, groupConfirmed)).toBe(false);
    });

    it('rejects profile mismatch (managed_group vs new_group)', () => {
      const confirmed: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: 'all_verified' }
      };
      const candidate: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'new_group', bindingIds: 'all_verified' }
      };
      expect(coversFullTrustScopeEntry(confirmed, candidate)).toBe(false);
    });

    it('all_verified covers specific binding IDs subset and all_verified', () => {
      const confirmed: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: 'all_verified' }
      };
      const candidateSubset: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['bind_1', 'bind_2'] }
      };
      const candidateAll: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: 'all_verified' }
      };

      expect(coversFullTrustScopeEntry(confirmed, candidateSubset)).toBe(true);
      expect(coversFullTrustScopeEntry(confirmed, candidateAll)).toBe(true);
    });

    it('specific binding IDs can cover a subset, but cannot cover superset or all_verified', () => {
      const confirmed: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['bind_1', 'bind_2'] }
      };
      const candidateSubset: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['bind_1'] }
      };
      const candidateSuperset: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['bind_1', 'bind_3'] }
      };
      const candidateAll: FullTrustScopeEntry = {
        ...baseEntry,
        entry: { kind: 'group', profile: 'managed_group', bindingIds: 'all_verified' }
      };

      expect(coversFullTrustScopeEntry(confirmed, candidateSubset)).toBe(true);
      expect(coversFullTrustScopeEntry(confirmed, candidateSuperset)).toBe(false);
      expect(coversFullTrustScopeEntry(confirmed, candidateAll)).toBe(false);
    });
  });

  describe('4. 主体与规则覆盖（Human & Bot）', () => {
    describe('Human rules', () => {
      it('open covers open, allowlist, and owner_only', () => {
        const confirmed: FullTrustScopeEntry = {
          ...baseEntry,
          subject: { kind: 'human', rule: { mode: 'open' } }
        };
        const candOpen: FullTrustScopeEntry = { ...baseEntry, subject: { kind: 'human', rule: { mode: 'open' } } };
        const candOwner: FullTrustScopeEntry = { ...baseEntry, subject: { kind: 'human', rule: { mode: 'owner_only' } } };
        const candAllow: FullTrustScopeEntry = {
          ...baseEntry,
          subject: { kind: 'human', rule: { mode: 'allowlist', selectors: [{ kind: 'principal_id', principalId: 'principal_u1' }] } }
        };

        expect(coversFullTrustScopeEntry(confirmed, candOpen)).toBe(true);
        expect(coversFullTrustScopeEntry(confirmed, candOwner)).toBe(true);
        expect(coversFullTrustScopeEntry(confirmed, candAllow)).toBe(true);
      });

      it('owner_only covers owner_only, but rejects allowlist and open', () => {
        const confirmed: FullTrustScopeEntry = {
          ...baseEntry,
          subject: { kind: 'human', rule: { mode: 'owner_only' } }
        };
        const candOwner: FullTrustScopeEntry = { ...baseEntry, subject: { kind: 'human', rule: { mode: 'owner_only' } } };
        const candOpen: FullTrustScopeEntry = { ...baseEntry, subject: { kind: 'human', rule: { mode: 'open' } } };
        const candAllow: FullTrustScopeEntry = {
          ...baseEntry,
          subject: { kind: 'human', rule: { mode: 'allowlist', selectors: [{ kind: 'principal_id', principalId: 'principal_u1' }] } }
        };

        expect(coversFullTrustScopeEntry(confirmed, candOwner)).toBe(true);
        expect(coversFullTrustScopeEntry(confirmed, candOpen)).toBe(false);
        expect(coversFullTrustScopeEntry(confirmed, candAllow)).toBe(false);
      });

      it('allowlist covers subset allowlist, but rejects superset and open', () => {
        const confirmed: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'human',
            rule: {
              mode: 'allowlist',
              selectors: [
                { kind: 'principal_id', principalId: 'principal_u1' },
                { kind: 'principal_id', principalId: 'principal_u2' }
              ]
            }
          }
        };

        const candSubset: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'human',
            rule: { mode: 'allowlist', selectors: [{ kind: 'principal_id', principalId: 'principal_u1' }] }
          }
        };
        const candSuperset: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'human',
            rule: {
              mode: 'allowlist',
              selectors: [
                { kind: 'principal_id', principalId: 'principal_u1' },
                { kind: 'principal_id', principalId: 'principal_u3' }
              ]
            }
          }
        };
        const candOpen: FullTrustScopeEntry = { ...baseEntry, subject: { kind: 'human', rule: { mode: 'open' } } };

        expect(coversFullTrustScopeEntry(confirmed, candSubset)).toBe(true);
        expect(coversFullTrustScopeEntry(confirmed, candSuperset)).toBe(false);
        expect(coversFullTrustScopeEntry(confirmed, candOpen)).toBe(false);
      });

      it('owner_only is covered only by explicit principal_installation_owner, NOT principal_owner alias', () => {
        const allowWithInstallationOwner: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'human',
            rule: {
              mode: 'allowlist',
              selectors: [{ kind: 'principal_id', principalId: 'principal_installation_owner' }]
            }
          }
        };

        const allowWithPrincipalOwnerAlias: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'human',
            rule: {
              mode: 'allowlist',
              selectors: [{ kind: 'principal_id', principalId: 'principal_owner' }]
            }
          }
        };

        const allowWithoutInstallationOwner: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'human',
            rule: {
              mode: 'allowlist',
              selectors: [{ kind: 'principal_id', principalId: 'principal_regular_user' }]
            }
          }
        };

        const candOwner: FullTrustScopeEntry = {
          ...baseEntry,
          subject: { kind: 'human', rule: { mode: 'owner_only' } }
        };

        expect(coversFullTrustScopeEntry(allowWithInstallationOwner, candOwner)).toBe(true);
        expect(coversFullTrustScopeEntry(allowWithPrincipalOwnerAlias, candOwner)).toBe(false);
        expect(coversFullTrustScopeEntry(allowWithoutInstallationOwner, candOwner)).toBe(false);
      });
    });

    describe('Bot rules', () => {
      it('peerEnabled cannot be expanded (peerEnabled=false confirmed rejects candidate peerEnabled=true)', () => {
        const confirmed: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'bot',
            rule: {
              mode: 'allowlist',
              selectors: [{ kind: 'open_id', externalAppId: 'cli_app_1', openId: 'ou_bot1' }],
              peerEnabled: false
            }
          }
        };

        const candPeerExpanded: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'bot',
            rule: {
              mode: 'allowlist',
              selectors: [{ kind: 'open_id', externalAppId: 'cli_app_1', openId: 'ou_bot1' }],
              peerEnabled: true // Expansion!
            }
          }
        };

        expect(coversFullTrustScopeEntry(confirmed, candPeerExpanded)).toBe(false);
      });

      it('peerEnabled can be narrowed (confirmed peerEnabled=true allows candidate peerEnabled=false)', () => {
        const confirmed: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'bot',
            rule: {
              mode: 'allowlist',
              selectors: [{ kind: 'open_id', externalAppId: 'cli_app_1', openId: 'ou_bot1' }],
              peerEnabled: true
            }
          }
        };

        const candPeerNarrowed: FullTrustScopeEntry = {
          ...baseEntry,
          subject: {
            kind: 'bot',
            rule: {
              mode: 'allowlist',
              selectors: [{ kind: 'open_id', externalAppId: 'cli_app_1', openId: 'ou_bot1' }],
              peerEnabled: false // Narrowed!
            }
          }
        };

        expect(coversFullTrustScopeEntry(confirmed, candPeerNarrowed)).toBe(true);
      });

      it('rejects cross-kind mismatch between human and bot', () => {
        const humanConfirmed: FullTrustScopeEntry = {
          ...baseEntry,
          subject: { kind: 'human', rule: { mode: 'open' } }
        };
        const botCandidate: FullTrustScopeEntry = {
          ...baseEntry,
          subject: { kind: 'bot', rule: { mode: 'open' } }
        };
        expect(coversFullTrustScopeEntry(humanConfirmed, botCandidate)).toBe(false);
      });
    });
  });

  describe('5. 动作与 operateScope 级别覆盖', () => {
    it('actions expansion is rejected', () => {
      const confirmed: FullTrustScopeEntry = {
        ...baseEntry,
        actions: ['task.create', 'turn.append']
      };
      const candExpanded: FullTrustScopeEntry = {
        ...baseEntry,
        actions: ['task.create', 'turn.append', 'high_risk.execute'] // Expansion
      };
      expect(coversFullTrustScopeEntry(confirmed, candExpanded)).toBe(false);
    });

    it('actions narrowing is accepted', () => {
      const confirmed: FullTrustScopeEntry = {
        ...baseEntry,
        actions: ['task.create', 'turn.append', 'task.view_result']
      };
      const candNarrowed: FullTrustScopeEntry = {
        ...baseEntry,
        actions: ['task.create'] // Narrowed
      };
      expect(coversFullTrustScopeEntry(confirmed, candNarrowed)).toBe(true);
    });

    it('operateScope hierarchy: none <= own_runs <= group_runs <= bot_runs', () => {
      const makeEntry = (scope: FullTrustScopeEntry['operateScope']): FullTrustScopeEntry => ({
        ...baseEntry,
        operateScope: scope
      });

      const confirmedGroup = makeEntry('group_runs');

      expect(coversFullTrustScopeEntry(confirmedGroup, makeEntry('none'))).toBe(true);
      expect(coversFullTrustScopeEntry(confirmedGroup, makeEntry('own_runs'))).toBe(true);
      expect(coversFullTrustScopeEntry(confirmedGroup, makeEntry('group_runs'))).toBe(true);
      expect(coversFullTrustScopeEntry(confirmedGroup, makeEntry('bot_runs'))).toBe(false); // Expanded!
    });
  });

  describe('6. Action Gates 与有效期 (expiresAt) 覆盖', () => {
    it('gates cannot flip from false to true', () => {
      const confirmed: FullTrustScopeEntry = {
        ...baseEntry,
        gates: { terminalWrite: false, highRisk: false, groupToolsSend: true }
      };

      const candTerminalWriteTrue: FullTrustScopeEntry = {
        ...baseEntry,
        gates: { terminalWrite: true, highRisk: false, groupToolsSend: true }
      };
      const candHighRiskTrue: FullTrustScopeEntry = {
        ...baseEntry,
        gates: { terminalWrite: false, highRisk: true, groupToolsSend: true }
      };
      const candGroupToolsSendFalse: FullTrustScopeEntry = {
        ...baseEntry,
        gates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
      };

      expect(coversFullTrustScopeEntry(confirmed, candTerminalWriteTrue)).toBe(false);
      expect(coversFullTrustScopeEntry(confirmed, candHighRiskTrue)).toBe(false);
      expect(coversFullTrustScopeEntry(confirmed, candGroupToolsSendFalse)).toBe(true); // Gate narrowed
    });

    it('expiresAt cannot be extended', () => {
      const confirmed: FullTrustScopeEntry = {
        ...baseEntry,
        expiresAt: '2026-10-01T00:00:00.000Z'
      };

      // Shorter expiration is allowed
      const candShorter: FullTrustScopeEntry = {
        ...baseEntry,
        expiresAt: '2026-09-20T00:00:00.000Z'
      };
      expect(coversFullTrustScopeEntry(confirmed, candShorter)).toBe(true);

      // Longer expiration is rejected
      const candLonger: FullTrustScopeEntry = {
        ...baseEntry,
        expiresAt: '2026-11-01T00:00:00.000Z'
      };
      expect(coversFullTrustScopeEntry(confirmed, candLonger)).toBe(false);

      // Perpetual candidate against bounded confirmed is rejected
      const candPerpetual: FullTrustScopeEntry = {
        ...baseEntry,
        expiresAt: undefined
      };
      expect(coversFullTrustScopeEntry(confirmed, candPerpetual)).toBe(false);

      // Bounded candidate against perpetual confirmed is allowed
      const confirmedPerpetual: FullTrustScopeEntry = {
        ...baseEntry,
        expiresAt: undefined
      };
      expect(coversFullTrustScopeEntry(confirmedPerpetual, candShorter)).toBe(true);
    });
  });

  describe('7. 防交叉维度拼合（Alice/GroupA/PolicyX + Bob/GroupB/PolicyY !== Alice/GroupB/PolicyX）', () => {
    it('strictly prevents combining dimensions across multiple confirmed entries', () => {
      const entry1: FullTrustScopeEntry = {
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['group_A'] },
        subject: {
          kind: 'human',
          rule: { mode: 'allowlist', selectors: [{ kind: 'principal_id', principalId: 'principal_alice' }] }
        },
        actions: ['task.create'],
        operateScope: 'own_runs',
        executionDigest: 'a'.repeat(64),
        directoryIdentityDigest: baseDirectoryDigest,
        gates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
      };

      const entry2: FullTrustScopeEntry = {
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['group_B'] },
        subject: {
          kind: 'human',
          rule: { mode: 'allowlist', selectors: [{ kind: 'principal_id', principalId: 'principal_bob' }] }
        },
        actions: ['task.create'],
        operateScope: 'own_runs',
        executionDigest: 'b'.repeat(64),
        directoryIdentityDigest: baseDirectoryDigest,
        gates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
      };

      const confirmedScope: FullTrustScopeV1 = {
        version: 1,
        channelBotId: 'bot_1',
        externalAppId: 'cli_app_1',
        brand: 'feishu',
        entries: [entry1, entry2]
      };

      // Candidate tries to cross: Alice + Group B + Policy A
      const crossCandidateEntry: FullTrustScopeEntry = {
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['group_B'] },
        subject: {
          kind: 'human',
          rule: { mode: 'allowlist', selectors: [{ kind: 'principal_id', principalId: 'principal_alice' }] }
        },
        actions: ['task.create'],
        operateScope: 'own_runs',
        executionDigest: 'a'.repeat(64),
        directoryIdentityDigest: baseDirectoryDigest,
        gates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
      };

      const candidateScope: FullTrustScopeV1 = {
        version: 1,
        channelBotId: 'bot_1',
        externalAppId: 'cli_app_1',
        brand: 'feishu',
        entries: [crossCandidateEntry]
      };

      expect(isFullTrustScopeCovered(candidateScope, confirmedScope)).toBe(false);
      const res = checkFullTrustScopeCoverage(candidateScope, confirmedScope);
      expect(res.covered).toBe(false);
      expect(res.mismatches).toHaveLength(1);
    });
  });

  describe('8. 规范化纯函数 normalizeFullTrustScope 确定性与安全性', () => {
    it('deterministically sorts and deduplicates selectors, actions, bindingIds, and entries', () => {
      const dirtyEntry: FullTrustScopeEntry = {
        entry: { kind: 'group', profile: 'managed_group', bindingIds: ['bind_z', 'bind_a', 'bind_z'] },
        subject: {
          kind: 'human',
          rule: {
            mode: 'allowlist',
            selectors: [
              { kind: 'principal_id', principalId: 'principal_z' },
              { kind: 'principal_id', principalId: 'principal_a' },
              { kind: 'principal_id', principalId: 'principal_z' }
            ]
          }
        },
        actions: ['turn.append', 'task.create', 'turn.append'],
        operateScope: 'own_runs',
        executionDigest: baseExecutionDigest,
        directoryIdentityDigest: baseDirectoryDigest,
        gates: { terminalWrite: false, highRisk: false, groupToolsSend: false }
      };

      const normalized = normalizeFullTrustScope({
        version: 1,
        channelBotId: 'bot_1',
        externalAppId: 'cli_app_1',
        brand: 'feishu',
        entries: [dirtyEntry]
      });

      const entry = normalized.entries[0];
      expect((entry.entry as Extract<FullTrustScopeEntry['entry'], { kind: 'group' }>).bindingIds).toEqual([
        'bind_a',
        'bind_z'
      ]);
      expect(entry.actions).toEqual(['task.create', 'turn.append']);

      const humanRule = (entry.subject as Extract<FullTrustScopeEntry['subject'], { kind: 'human' }>).rule as Extract<
        FullTrustScopeEntry['subject']['rule'],
        { mode: 'allowlist' }
      >;
      expect(humanRule.selectors).toEqual([
        { kind: 'principal_id', principalId: 'principal_a' },
        { kind: 'principal_id', principalId: 'principal_z' }
      ]);
    });

    it('reversing entry order yields identical serialization (deterministic canonical sorting)', () => {
      const entryA: FullTrustScopeEntry = {
        ...baseEntry,
        subject: { kind: 'human', rule: { mode: 'allowlist', selectors: [{ kind: 'email', email: 'alice@example.com' }] } }
      };
      const entryB: FullTrustScopeEntry = {
        ...baseEntry,
        subject: { kind: 'human', rule: { mode: 'allowlist', selectors: [{ kind: 'email', email: 'bob@example.com' }] } }
      };

      const scopeAB: FullTrustScopeV1 = { ...baseScope, entries: [entryA, entryB] };
      const scopeBA: FullTrustScopeV1 = { ...baseScope, entries: [entryB, entryA] };

      const normAB = normalizeFullTrustScope(scopeAB);
      const normBA = normalizeFullTrustScope(scopeBA);

      expect(JSON.stringify(normAB)).toBe(JSON.stringify(normBA));
    });

    it('normalizes email selectors case-insensitively and canonicalizes email string', () => {
      const entryUpper: FullTrustScopeEntry = {
        ...baseEntry,
        subject: { kind: 'human', rule: { mode: 'allowlist', selectors: [{ kind: 'email', email: 'Alice@Example.COM' }] } }
      };
      const entryLower: FullTrustScopeEntry = {
        ...baseEntry,
        subject: { kind: 'human', rule: { mode: 'allowlist', selectors: [{ kind: 'email', email: 'alice@example.com' }] } }
      };

      const scopeUpper: FullTrustScopeV1 = { ...baseScope, entries: [entryUpper] };
      const scopeLower: FullTrustScopeV1 = { ...baseScope, entries: [entryLower] };

      const normUpper = normalizeFullTrustScope(scopeUpper);
      const normLower = normalizeFullTrustScope(scopeLower);

      expect(JSON.stringify(normUpper)).toBe(JSON.stringify(normLower));
    });

    it('deduplicates identical entries while strictly keeping different authorization entries', () => {
      const entry1: FullTrustScopeEntry = {
        ...baseEntry,
        operateScope: 'own_runs'
      };
      const duplicateEntry1: FullTrustScopeEntry = {
        ...baseEntry,
        operateScope: 'own_runs'
      };
      const entry2: FullTrustScopeEntry = {
        ...baseEntry,
        operateScope: 'group_runs' // Different scope! Must be kept!
      };

      const scope: FullTrustScopeV1 = { ...baseScope, entries: [entry1, duplicateEntry1, entry2] };
      const normalized = normalizeFullTrustScope(scope);

      expect(normalized.entries).toHaveLength(2); // Deduped 1 duplicate, preserved entry2
      expect(normalized.entries.some(e => e.operateScope === 'own_runs')).toBe(true);
      expect(normalized.entries.some(e => e.operateScope === 'group_runs')).toBe(true);
    });

    it('is strictly idempotent and does not mutate input', () => {
      const originalEntries = [
        {
          ...baseEntry,
          actions: ['turn.append' as const, 'task.create' as const],
          subject: {
            kind: 'human' as const,
            rule: {
              mode: 'allowlist' as const,
              selectors: [
                { kind: 'email' as const, email: 'Zoe@example.com' },
                { kind: 'email' as const, email: 'amy@example.com' }
              ]
            }
          }
        }
      ];
      const scope: FullTrustScopeV1 = { ...baseScope, entries: originalEntries };
      const originalJson = JSON.stringify(scope);

      const norm1 = normalizeFullTrustScope(scope);
      const norm2 = normalizeFullTrustScope(norm1);

      // Input was not mutated
      expect(JSON.stringify(scope)).toBe(originalJson);

      // Idempotent
      expect(JSON.stringify(norm1)).toBe(JSON.stringify(norm2));
    });
  });
});
