import { createHash } from 'node:crypto';
import type { PromptPart, PromptSourceDiagnostics } from '@dutydeck/shared';

export const promptDigest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
export const promptTemplateVersion = (mode: 'legacy' | 'optimized'): 'legacy-v1' | 'optimized-v1' => mode === 'optimized' ? 'optimized-v1' : 'legacy-v1';
export function promptPart(kind: PromptPart['kind'], content: string, metadata: Omit<PromptPart, 'kind' | 'content'>): PromptPart {
  return { kind, content, ...metadata };
}
/** A reference retains its own wrapper (identity, time, reason and coverage).
 * Only complete, explicitly versioned snapshots in one trust scope can share a body.
 */
export function assemblePrompt(parts: PromptPart[], legacyPrompt: string, policyVersion = 'legacy-v1'): { prompt: string; diagnostics: PromptSourceDiagnostics } {
  const optimized = policyVersion === 'optimized-v1';
  const groups = new Map<string, number[]>();
  for (const [index, part] of parts.entries()) {
    const identity = part.sourceId && (part.version || part.digest) && (!part.digest || part.digest === promptDigest(part.content)) && part.complete === true
      ? JSON.stringify([part.kind, part.sourceId, part.version ?? null, part.digest ?? null, part.trustScope, part.content]) : undefined;
    if (identity !== undefined) groups.set(identity, [...(groups.get(identity) ?? []), index]);
  }
  const replacements = new Map<number, string>();
  let deduplicated = 0;
  if (optimized) for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const first = indices[0]!;
    const label = `[同轮材料 ${first + 1}]\n`;
    const reference = `[正文见同轮材料 ${first + 1}；同来源与版本]`;
    // Include the first body's anchor in the savings calculation, even for a single duplicate.
    if (parts[first]!.content.length <= label.length + reference.length) continue;
    replacements.set(first, label + parts[first]!.content);
    for (const index of indices.slice(1)) { replacements.set(index, reference); deduplicated++; }
  }
  const rendered = parts.map((part, index) => `${part.prefix ?? ''}${replacements.get(index) ?? part.content}${part.suffix ?? ''}`);
  const candidate = rendered.join('');
  // The parts are allowed to optimize only the exact original representation.
  // A producer error preserves the established input rather than dropping material.
  const original = parts.map(part => `${part.prefix ?? ''}${part.content}${part.suffix ?? ''}`).join('');
  const fallbackReason = original !== legacyPrompt ? 'source_render_mismatch' : undefined;
  const prompt = optimized && !fallbackReason ? candidate : legacyPrompt;
  return { prompt, diagnostics: {
    templateVersion: policyVersion, beforeChars: legacyPrompt.length, afterChars: prompt.length,
    deduplicatedParts: fallbackReason ? 0 : deduplicated,
    ...(fallbackReason ? { fallbackReason } : {}),
    parts: parts.map(part => ({ kind: part.kind, chars: part.content.length, sha256: promptDigest(part.content),
      ...(part.sourceId ? { sourceIdDigest: promptDigest(part.sourceId) } : {}),
      ...(part.version ? { versionDigest: promptDigest(part.version) } : {}), complete: part.complete === true }))
  } };
}
export function deliveryPrompt(mode: { background?: boolean; reactionOnly?: boolean }): string {
  return mode.background ? '本轮最终内容直接输出，由后台调度器负责投递，不额外群发。'
    : mode.reactionOnly ? '本会话开启完成表情：普通请求成功时仅用表情提示完成；失败仍可能发结果卡。照常输出最终内容，不用群发绕过展示设置。'
    : '本轮最终答复直接输出，由运行时交付到原消息范围；不再用普通 group send 重复交付。';
}
