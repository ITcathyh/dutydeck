import { prepareTokenPromptFixture } from '../../../scripts/fixtures/token-prompt-fixture.mjs';
import { describe, expect, it } from 'vitest';
import type { PromptPart } from '@dutydeck/shared';
import { acceptedTaskInputV1Schema } from '@dutydeck/shared';
import { assemblePrompt, promptDigest } from './prompt-context.js';
import { readTokenEfficiencyPolicy } from './token-efficiency.js';
import { renderWorkUpstream } from './work-items.js';

const render = (parts: PromptPart[]) => parts.map(part => `${part.prefix ?? ''}${part.content}${part.suffix ?? ''}`).join('');
const material = (overrides: Partial<PromptPart> = {}): PromptPart => ({ kind: 'reference', sourceId: 'message:one', digest: promptDigest('Complete evidence.'.repeat(30)), complete: true,
  content: 'Complete evidence.'.repeat(30), trustScope: 'reference:group-one', prefix: 'Alice at 10:00, quoted for comparison:\n', suffix: '\n[coverage: complete]\n', ...overrides });

describe('same-turn source assembly', () => {
  it('keeps complete evidence once and both attribution/coverage wrappers', () => {
    const parts = [material(), material({ prefix: 'Alice at 10:00, cited in history:\n' })];
    const result = assemblePrompt(parts, render(parts), 'optimized-v1');
    expect(result.prompt.split(parts[0]!.content)).toHaveLength(2);
    expect(result.prompt).toContain('[同轮材料 1]');
    expect(result.prompt).toContain('[正文见同轮材料 1；同来源与版本]');
    expect(result.prompt).toContain('quoted for comparison');
    expect(result.prompt).toContain('cited in history');
    expect(result.prompt.match(/coverage: complete/g)).toHaveLength(2);
    expect(result.diagnostics).toMatchObject({ deduplicatedParts: 1, beforeChars: render(parts).length, afterChars: result.prompt.length });
    expect(JSON.stringify(result.diagnostics)).not.toContain('Complete evidence');
    expect(JSON.stringify(result.diagnostics)).not.toContain('message:one');
  });
  it.each([
    { sourceId: 'message:two' }, { trustScope: 'reference:group-two' }, { version: 'different' },
    { digest: undefined }, { sourceId: undefined }, { complete: false }, { content: 'different evidence' }
  ])('preserves independent or unknown origins %j', overrides => {
    const parts = [material(), material(overrides)];
    expect(assemblePrompt(parts, render(parts), 'optimized-v1').prompt).toBe(render(parts));
  });
  it('keeps short duplicate bodies unchanged when reference and anchor would increase input', () => {
    const parts = [material({ content: '短文本', digest: promptDigest('短文本') }), material({ content: '短文本', digest: promptDigest('短文本') })];
    expect(assemblePrompt(parts, render(parts), 'optimized-v1')).toMatchObject({ prompt: render(parts), diagnostics: { deduplicatedParts: 0 } });
  });
  it('never uses prior-round digests to omit a Skill or reference', () => {
    const parts = [material({ kind: 'skill', trustScope: 'explicit_skill' })];
    const first = assemblePrompt(parts, render(parts), 'optimized-v1');
    const second = assemblePrompt(parts, render(parts), 'optimized-v1');
    expect(second.prompt).toBe(first.prompt);
    expect(second.prompt).toContain(parts[0]!.content);
  });
  it('preserves legacy bytes and falls back if source rendering does not match', () => {
    const parts = [material(), material()];
    expect(assemblePrompt(parts, render(parts)).prompt).toBe(render(parts));
    expect(assemblePrompt(parts, 'unknown original', 'optimized-v1')).toMatchObject({ prompt: 'unknown original', diagnostics: { fallbackReason: 'source_render_mismatch', deduplicatedParts: 0 } });
  });
  it('uses real task-context document builders for both full-source entry points', async () => {
    const fixture = await prepareTokenPromptFixture();
    expect(fixture.diagnostics.deduplicatedParts).toBe(1);
    expect(fixture.optimizedPrompt.length).toBeLessThan(fixture.legacyPrompt.length);
    const documents = fixture.parts.filter(part => part.sourceId?.includes('document:'));
    expect(documents).toHaveLength(2);
    expect(documents[0]!.content).toBe(documents[1]!.content);
    expect(fixture.optimizedPrompt).toContain(documents[0]!.content);
    for (const part of fixture.parts) {
      if (part.prefix) expect(fixture.optimizedPrompt).toContain(part.prefix);
      if (part.suffix) expect(fixture.optimizedPrompt).toContain(part.suffix);
    }
  });
  it('accepts old strict task inputs and validates optional frozen sources', () => {
    const old = { version: 1, prompt: 'request', executionContext: { agentPrompt: 'request' }, contentSources: [], digest: 'a'.repeat(64) };
    expect(acceptedTaskInputV1Schema.parse(old)).toEqual(old);
    const next = { ...old, executionContext: { agentPrompt: 'request', promptPolicyVersion: 'optimized-v1', promptParts: [material()] } };
    expect(acceptedTaskInputV1Schema.parse(next)).toEqual(next);
    expect(() => acceptedTaskInputV1Schema.parse({ ...next, executionContext: { ...next.executionContext, accidental: true } })).toThrow();
  });
});

describe('installation policy', () => {
  const config = (raw?: string) => ({ get: async () => raw, set: async () => {} });
  it('requires explicit valid configuration and keeps capacity as measured characters', async () => {
    expect(await readTokenEfficiencyPolicy(config())).toEqual({ mode: 'legacy', memoryProfiles: [] });
    const value = { mode: 'optimized', memoryProfiles: [{ agentId: 'agent', protocol: 'acp', model: 'model', reasoningEffort: 'high', maxInputChars: 220000, verificationRef: 'replay:one' }] };
    expect(await readTokenEfficiencyPolicy(config(JSON.stringify(value)))).toEqual(value);
  });
  it.each(['{}', 'null', '{', '{"mode":"optimized","memoryProfiles":[],"guessTokens":2}', '{"mode":"optimized","memoryProfiles":[{"agentId":"a","maxInputChars":0,"verificationRef":""}]}'])('fails closed for %s', async raw => {
    expect(await readTokenEfficiencyPolicy(config(raw))).toEqual({ mode: 'legacy', memoryProfiles: [], diagnosticReason: 'invalid_configuration' });
  });
  it('requires the actual protocol and keeps exact model/reasoning coverage separate', async () => {
    const profile = { agentId: 'a', protocol: 'acp', model: 'one', reasoningEffort: 'high', maxInputChars: 100, verificationRef: 'replay' };
    const value = { mode: 'optimized', memoryProfiles: [profile, { ...profile, model: 'two' }, { ...profile, protocol: 'pty-cli' }, { ...profile, reasoningEffort: 'low' }] };
    expect(await readTokenEfficiencyPolicy(config(JSON.stringify(value)))).toEqual(value);
    expect(await readTokenEfficiencyPolicy(config(JSON.stringify({ mode: 'optimized', memoryProfiles: [{ ...profile, protocol: 'auto' }] })))).toMatchObject({ mode: 'legacy', diagnosticReason: 'invalid_configuration' });
    const { protocol: _protocol, ...missing } = profile;
    expect(await readTokenEfficiencyPolicy(config(JSON.stringify({ mode: 'optimized', memoryProfiles: [missing] })))).toMatchObject({ mode: 'legacy', diagnosticReason: 'invalid_configuration' });
  });
  it('fails closed on configuration reads and duplicate capacity profiles', async () => {
    expect(await readTokenEfficiencyPolicy({ get: async () => { throw Error('secret'); }, set: async () => {} })).toMatchObject({ mode: 'legacy', diagnosticReason: 'configuration_unavailable' });
    const profile = { agentId: 'a', protocol: 'acp', maxInputChars: 10, verificationRef: 'one' };
    expect(await readTokenEfficiencyPolicy(config(JSON.stringify({ mode: 'optimized', memoryProfiles: [profile, profile] })))).toMatchObject({ mode: 'legacy', diagnosticReason: 'invalid_configuration' });
  });
});

describe('complete collaboration handoff', () => {
  it('shares exact attempt bodies while retaining every dependency version and workspace', () => {
    const output = { text: 'complete artifact', digest: promptDigest('complete artifact') };
    const inputs = [
      { stepId: 'first', status: 'completed', attemptId: 'attempt_one', generatedResult: output, workspace: { cwd: '/workspace/one' } },
      { stepId: 'alias', status: 'completed', attemptId: 'attempt_one', generatedResult: output, workspace: { cwd: '/workspace/alias' } },
      { stepId: 'independent', status: 'completed', attemptId: 'attempt_two', generatedResult: output }
    ];
    const parsed = JSON.parse(renderWorkUpstream(inputs));
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.dependencies).toHaveLength(3);
    expect(parsed.dependencies[0].generatedResult.artifactId).toBe(parsed.dependencies[1].generatedResult.artifactId);
    for (const input of inputs) expect(parsed.dependencies.find((row: any) => row.stepId === input.stepId)).toMatchObject({ stepId: input.stepId, attemptId: input.attemptId, generatedResult: { digest: output.digest }, ...(input.workspace ? { workspace: input.workspace } : {}) });
    expect(parsed.artifacts.every((artifact: any) => artifact.text === output.text)).toBe(true);
  });
  it('keeps unknown or stale artifact versions intact', () => {
    const inputs = [{ stepId: 'old', status: 'completed', attemptId: 'a', generatedResult: { text: 'changed', digest: 'a'.repeat(64) } }];
    expect(JSON.parse(renderWorkUpstream(inputs))).toEqual(inputs);
  });
});
