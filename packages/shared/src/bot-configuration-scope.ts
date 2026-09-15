import {
  areIdentitySelectorsEqual,
  normalizeIdentitySelector,
  type AccessRules,
  type BotAccessRules,
  type FullTrustScopeEntry,
  type FullTrustScopeV1,
  type IdentitySelector
} from './bot-configuration.js';
import type { PolicyAction } from './group-policy.js';

export interface FullTrustCoverageMismatch {
  candidateIndex: number;
  candidateEntry: FullTrustScopeEntry;
  reason: string;
}

export interface FullTrustCoverageResult {
  covered: boolean;
  mismatches: FullTrustCoverageMismatch[];
}

const operateScopeRanks: Record<FullTrustScopeEntry['operateScope'], number> = {
  none: 0,
  own_runs: 1,
  group_runs: 2,
  bot_runs: 3
};

function hasInstallationPrincipalSelector(selectors: IdentitySelector[]): boolean {
  return selectors.some(
    sel => sel.kind === 'principal_id' && sel.principalId === 'principal_installation_owner'
  );
}

function areSelectorsSubset(candidateSelectors: IdentitySelector[], confirmedSelectors: IdentitySelector[]): boolean {
  return candidateSelectors.every(candSel =>
    confirmedSelectors.some(confSel => areIdentitySelectorsEqual(candSel, confSel))
  );
}

function areHumanRulesCovered(confirmedRule: AccessRules, candidateRule: AccessRules): boolean {
  if (confirmedRule.mode === 'open') {
    return true;
  }
  if (confirmedRule.mode === 'owner_only') {
    return candidateRule.mode === 'owner_only';
  }
  if (confirmedRule.mode === 'allowlist') {
    if (candidateRule.mode === 'open') {
      return false;
    }
    if (candidateRule.mode === 'owner_only') {
      // owner_only 仅被真实同安装者 owner_only/open/显式 installation principal 覆盖
      return hasInstallationPrincipalSelector(confirmedRule.selectors);
    }
    if (candidateRule.mode === 'allowlist') {
      return areSelectorsSubset(candidateRule.selectors, confirmedRule.selectors);
    }
  }
  return false;
}

function areBotRulesCovered(confirmedRule: BotAccessRules, candidateRule: BotAccessRules): boolean {
  if (confirmedRule.mode === 'open') {
    return true;
  }
  if (confirmedRule.mode === 'allowlist') {
    if (candidateRule.mode === 'open') {
      return false;
    }
    if (candidateRule.mode === 'allowlist') {
      // peerEnabled 只可收窄不可扩大：若 confirmed 禁用 peer，candidate 必须禁用 peer
      if (!confirmedRule.peerEnabled && candidateRule.peerEnabled) {
        return false;
      }
      return areSelectorsSubset(candidateRule.selectors, confirmedRule.selectors);
    }
  }
  return false;
}

/**
 * 严格判断单个 confirmedEntry 是否能完整覆盖 candidateEntry。
 * 必须在同一个 confirmedEntry 内同时满足所有维度的安全子集/等价条件，禁止跨条目拼合。
 */
export function coversFullTrustScopeEntry(confirmed: FullTrustScopeEntry, candidate: FullTrustScopeEntry): boolean {
  // 1. 执行摘要与目录身份摘要必须完全一致
  if (confirmed.executionDigest !== candidate.executionDigest) return false;
  if (confirmed.directoryIdentityDigest !== candidate.directoryIdentityDigest) return false;

  // 2. 入口匹配
  if (confirmed.entry.kind !== candidate.entry.kind) return false;
  if (confirmed.entry.kind === 'group') {
    const candGroup = candidate.entry as Extract<FullTrustScopeEntry['entry'], { kind: 'group' }>;
    if (confirmed.entry.profile !== candGroup.profile) return false;

    if (confirmed.entry.bindingIds !== 'all_verified') {
      if (candGroup.bindingIds === 'all_verified') {
        return false;
      }
      const confirmedBindingSet = new Set(confirmed.entry.bindingIds);
      const isSubset = candGroup.bindingIds.every(id => confirmedBindingSet.has(id));
      if (!isSubset) return false;
    }
  }

  // 3. 主体匹配
  if (confirmed.subject.kind !== candidate.subject.kind) return false;
  if (confirmed.subject.kind === 'human') {
    const candHumanRule = (candidate.subject as Extract<FullTrustScopeEntry['subject'], { kind: 'human' }>).rule;
    if (!areHumanRulesCovered(confirmed.subject.rule, candHumanRule)) {
      return false;
    }
  } else {
    const candBotRule = (candidate.subject as Extract<FullTrustScopeEntry['subject'], { kind: 'bot' }>).rule;
    if (!areBotRulesCovered(confirmed.subject.rule, candBotRule)) {
      return false;
    }
  }

  // 4. 动作集合子集检查（动作不增加）
  const confirmedActionsSet = new Set(confirmed.actions);
  const actionsCovered = candidate.actions.every(action => confirmedActionsSet.has(action));
  if (!actionsCovered) return false;

  // 5. 操作范围等级检查（operateScope 不增加）
  if (operateScopeRanks[candidate.operateScope] > operateScopeRanks[confirmed.operateScope]) {
    return false;
  }

  // 6. Action Gates 检查（gates 不从 false 升 true）
  if (candidate.gates.terminalWrite && !confirmed.gates.terminalWrite) return false;
  if (candidate.gates.highRisk && !confirmed.gates.highRisk) return false;
  if (candidate.gates.groupToolsSend && !confirmed.gates.groupToolsSend) return false;

  // 7. 有效期检查（有效期不延长）
  if (confirmed.expiresAt) {
    if (!candidate.expiresAt) return false;
    if (Date.parse(candidate.expiresAt) > Date.parse(confirmed.expiresAt)) return false;
  }

  return true;
}

/**
 * 诊断函数：检查 candidate 是否被 confirmationScope 完整覆盖，并列出未满足项。
 */
export function checkFullTrustScopeCoverage(
  candidate: FullTrustScopeV1,
  confirmationScope: FullTrustScopeV1
): FullTrustCoverageResult {
  const mismatches: FullTrustCoverageMismatch[] = [];

  if (candidate.version !== 1 || confirmationScope.version !== 1) {
    return {
      covered: false,
      mismatches: [{ candidateIndex: -1, candidateEntry: candidate.entries[0] as FullTrustScopeEntry, reason: 'Scope version mismatch' }]
    };
  }

  if (
    candidate.channelBotId !== confirmationScope.channelBotId ||
    candidate.externalAppId !== confirmationScope.externalAppId ||
    candidate.brand !== confirmationScope.brand
  ) {
    return {
      covered: false,
      mismatches: [
        {
          candidateIndex: -1,
          candidateEntry: candidate.entries[0] as FullTrustScopeEntry,
          reason: `Identity domain mismatch (channelBotId, externalAppId, or brand)`
        }
      ]
    };
  }

  candidate.entries.forEach((candEntry, idx) => {
    const isCovered = confirmationScope.entries.some(confEntry =>
      coversFullTrustScopeEntry(confEntry, candEntry)
    );
    if (!isCovered) {
      mismatches.push({
        candidateIndex: idx,
        candidateEntry: candEntry,
        reason: `Candidate entry at index ${idx} is not covered by any single confirmed scope entry`
      });
    }
  });

  return {
    covered: mismatches.length === 0,
    mismatches
  };
}

/**
 * 纯布尔覆盖判断：candidate 中的每一项必须被 confirmationScope 中的某一独立项完整覆盖。
 */
export function isFullTrustScopeCovered(
  candidate: FullTrustScopeV1,
  confirmationScope: FullTrustScopeV1
): boolean {
  if (
    candidate.version !== 1 ||
    confirmationScope.version !== 1 ||
    candidate.channelBotId !== confirmationScope.channelBotId ||
    candidate.externalAppId !== confirmationScope.externalAppId ||
    candidate.brand !== confirmationScope.brand
  ) {
    return false;
  }

  return candidate.entries.every(candEntry =>
    confirmationScope.entries.some(confEntry => coversFullTrustScopeEntry(confEntry, candEntry))
  );
}

// ============================================================================
// 规范化纯函数（确定性排序与去重，不改变授权关系，不使用 node:crypto）
// ============================================================================

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalSelectorJson(sel: IdentitySelector): string {
  switch (sel.kind) {
    case 'principal_id':
      return JSON.stringify({ kind: sel.kind, principalId: sel.principalId });
    case 'open_id':
      return JSON.stringify({ externalAppId: sel.externalAppId, kind: sel.kind, openId: sel.openId });
    case 'email':
      return JSON.stringify({ email: sel.email.trim().toLowerCase(), kind: sel.kind });
    case 'mobile':
      return JSON.stringify({ kind: sel.kind, mobile: sel.mobile.trim() });
    case 'union_id':
      return JSON.stringify({ externalAppId: sel.externalAppId, kind: sel.kind, unionId: sel.unionId });
  }
}

function deduplicateAndSortSelectors(selectors: IdentitySelector[]): IdentitySelector[] {
  const normalized = selectors.map(normalizeIdentitySelector);
  const deduped: IdentitySelector[] = [];
  for (const sel of normalized) {
    if (!deduped.some(existing => areIdentitySelectorsEqual(existing, sel))) {
      deduped.push(sel);
    }
  }
  return deduped.sort((a, b) => codeUnitCompare(canonicalSelectorJson(a), canonicalSelectorJson(b)));
}

function normalizeScopeEntry(entry: FullTrustScopeEntry): FullTrustScopeEntry {
  const actions = Array.from(new Set(entry.actions)).sort(codeUnitCompare) as PolicyAction[];

  let subject: FullTrustScopeEntry['subject'];
  if (entry.subject.kind === 'human') {
    if (entry.subject.rule.mode === 'allowlist') {
      subject = {
        kind: 'human',
        rule: {
          mode: 'allowlist',
          selectors: deduplicateAndSortSelectors(entry.subject.rule.selectors)
        }
      };
    } else {
      subject = {
        kind: 'human',
        rule: { mode: entry.subject.rule.mode }
      };
    }
  } else {
    if (entry.subject.rule.mode === 'allowlist') {
      subject = {
        kind: 'bot',
        rule: {
          mode: 'allowlist',
          peerEnabled: entry.subject.rule.peerEnabled,
          selectors: deduplicateAndSortSelectors(entry.subject.rule.selectors)
        }
      };
    } else {
      subject = {
        kind: 'bot',
        rule: { mode: 'open' }
      };
    }
  }

  let entryLoc: FullTrustScopeEntry['entry'];
  if (entry.entry.kind === 'p2p') {
    entryLoc = { kind: 'p2p' };
  } else {
    const bindingIds = entry.entry.bindingIds === 'all_verified'
      ? 'all_verified'
      : Array.from(new Set(entry.entry.bindingIds)).sort(codeUnitCompare);
    entryLoc = {
      kind: 'group',
      profile: entry.entry.profile,
      bindingIds
    };
  }

  return {
    entry: entryLoc,
    subject,
    actions,
    operateScope: entry.operateScope,
    executionDigest: entry.executionDigest,
    directoryIdentityDigest: entry.directoryIdentityDigest,
    gates: {
      terminalWrite: Boolean(entry.gates.terminalWrite),
      highRisk: Boolean(entry.gates.highRisk),
      groupToolsSend: Boolean(entry.gates.groupToolsSend)
    },
    ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {})
  };
}

function canonicalEntryJson(norm: FullTrustScopeEntry): string {
  const obj: Record<string, unknown> = {
    actions: norm.actions,
    directoryIdentityDigest: norm.directoryIdentityDigest,
    entry: norm.entry,
    executionDigest: norm.executionDigest
  };
  if (norm.expiresAt !== undefined) {
    obj.expiresAt = norm.expiresAt;
  }
  obj.gates = norm.gates;
  obj.operateScope = norm.operateScope;
  obj.subject = norm.subject;
  return JSON.stringify(obj);
}

/**
 * 确定性规范化 FullTrustScopeV1：
 * 排序与去重 actions、selectors、bindingIds，确定性排序 entries。
 * 按全部维度规范编码排序与去重，不得合并不同授权条目，不改变任何授权关系。
 */
export function normalizeFullTrustScope(scope: FullTrustScopeV1): FullTrustScopeV1 {
  const normalizedEntries: FullTrustScopeEntry[] = [];
  for (const rawEntry of scope.entries) {
    const norm = normalizeScopeEntry(rawEntry);
    const json = canonicalEntryJson(norm);
    if (!normalizedEntries.some(existing => canonicalEntryJson(existing) === json)) {
      normalizedEntries.push(norm);
    }
  }
  normalizedEntries.sort((a, b) => codeUnitCompare(canonicalEntryJson(a), canonicalEntryJson(b)));

  return {
    version: 1,
    channelBotId: scope.channelBotId,
    externalAppId: scope.externalAppId,
    brand: scope.brand,
    entries: normalizedEntries
  };
}
