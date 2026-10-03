import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema } from '@dutydeck/shared';
import { DutydeckRuntime, type RuntimeOptions } from './index.js';
import { assemblePrompt } from '../../../apps/server/src/prompt-context.js';
import { prepareSkillPrompt } from '../../../apps/server/src/skill-delivery.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-policy-'));
  const repos = createRepositories(join(directory, 'state.sqlite'), { newDatabaseAuthority: 'ledger_v1' });
  const agent = agentConfigSchema.parse({ id: 'mock', name: 'Mock', command: process.execPath, args: [resolve('tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd: directory,
    env: { mock_acp_steering: '1', mock_acp_agent_name: '@agentclientprotocol/claude-agent-acp' }, permissionMode: 'ask', timeout: 10 });
  let policy: 'legacy-v1' | 'optimized-v1' = 'optimized-v1';
  let authority = 'current-authority-one';
  let assemblies = 0;
  const options: RuntimeOptions = {
    driverIdleTimeoutMs: 0, probe: (() => ({ available: true, protocol: 'acp', acp: true })) as any,
    selectPromptPolicy: async () => ({ version: policy }),
    prepareTaskPrompt: (session, prompt, skills, context) => prepareSkillPrompt(session.cwd, prompt, skills, { ...context, homeDirectory: directory }),
    sessionPrompt: (_session, prompt, context) => {
      assemblies++;
      const prefix = `${context?.promptPolicyVersion}:${authority}\n`;
      return assemblePrompt([{ kind: 'dynamic_context', content: prefix, trustScope: 'host' }, ...(context?.promptParts ?? [{ kind: 'user_request', content: prompt, trustScope: 'user_request' }])], prefix + prompt, context?.promptPolicyVersion);
    }
  };
  let runtime = new DutydeckRuntime(repos, options);
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.initialize([agent]);
  const session = await runtime.start({ agentId: agent.id, cwd: directory });
  const texts = async () => (await runtime.getEvents(session.id)).filter(event => event.type === 'text').map(event => String((event.data as any).text));
  const status = async (taskId: string) => (await runtime.getTasks(session.id)).find(task => task.id === taskId)?.status;
  return { runtime, repos, session, directory, texts, status, restart: async () => { await runtime.shutdown(); runtime = new DutydeckRuntime(repos, options); runtime.setQueueHeld(true); await runtime.initialize([agent]); return runtime; }, setPolicy: (value: typeof policy) => { policy = value; }, setAuthority: (value: string) => { authority = value; }, assemblies: () => assemblies };
}
describe('frozen prompt policy with real ACP submissions', () => {
  it('freezes queued Skill bytes and policy while using current execution authority, then changes new tasks', async () => {
    const h = await fixture();
    const skill = join(h.directory, '.agents/skills/check/SKILL.md');
    await mkdir(join(h.directory, '.agents/skills/check'), { recursive: true });
    await writeFile(skill, '---\nname: check\ndescription: check\n---\nOriginal full Skill');
    h.runtime.setQueueHeld(true);
    const queued = await h.runtime.dispatch(h.session.id, 'queued request', 'queue', 'queued request', undefined, undefined, 'queued-one', [skill]);
    h.setPolicy('legacy-v1'); h.setAuthority('current-authority-two');
    await writeFile(skill, '---\nname: check\ndescription: check\n---\nChanged full Skill');
    h.runtime.setQueueHeld(false);
    await expect.poll(() => h.status(queued.id), { timeout: 10000 }).toBe('completed');
    const answer = (await h.texts()).find(text => text.startsWith('Mock reply:'))!;
    expect(answer).toContain('optimized-v1:current-authority-two');
    expect(answer).toContain('Original full Skill'); expect(answer).not.toContain('Changed full Skill');
    expect(h.repos.execution.getAcceptedTask(queued.id)?.input.executionContext.promptPolicyVersion).toBe('optimized-v1');
    const assemblyCount = h.assemblies();
    const replayed = await h.runtime.dispatch(h.session.id, 'queued request', 'queue', 'queued request', undefined, undefined, 'queued-one', [skill]);
    expect(replayed.replayed).toBe(true); expect(h.assemblies()).toBe(assemblyCount);
    const next = await h.runtime.send(h.session.id, 'next request');
    expect(h.repos.execution.getAcceptedTask(next.id)?.input.executionContext.promptPolicyVersion).toBe('legacy-v1');
    const events = (await h.runtime.getEvents(h.session.id)).filter(event => (event.data as any)?.state === 'prompt_assembly');
    expect(JSON.stringify(events)).not.toContain('Original full Skill'); expect(JSON.stringify(events)).not.toContain('current-authority-two');
    expect(events.some(event => (event.data as any).sources?.parts.some((part: any) => part.kind === 'skill'))).toBe(true);
  });
  it('restores queued frozen policy and source snapshots after Runtime restart without rereading a Skill', async () => {
    const h = await fixture();
    const skill = join(h.directory, '.agents/skills/recover/SKILL.md');
    await mkdir(join(h.directory, '.agents/skills/recover'), { recursive: true });
    await writeFile(skill, '---\nname: recover\ndescription: recover\n---\nFrozen recovery Skill');
    h.runtime.setQueueHeld(true);
    const queued = await h.runtime.dispatch(h.session.id, 'recover queued', 'queue', 'recover queued', undefined, undefined, 'recovery-one', [skill]);
    const digest = h.repos.execution.getAcceptedTask(queued.id)!.input.digest;
    h.setPolicy('legacy-v1'); h.setAuthority('authority-after-restart');
    await rm(skill);
    const restored = await h.restart();
    expect(h.repos.execution.getAcceptedTask(queued.id)!.input.digest).toBe(digest);
    restored.setQueueHeld(false);
    await expect.poll(() => h.status(queued.id), { timeout: 10000 }).toBe('completed');
    expect((await h.texts()).some(text => text.includes('optimized-v1:authority-after-restart') && text.includes('Frozen recovery Skill'))).toBe(true);
    expect(h.repos.execution.getTaskExecution(queued.id)?.attempts).toHaveLength(1);
  });
  it('uses the running task policy for optimized steering and never assembles an already submitted steer twice', async () => {
    const h = await fixture();
    await h.runtime.dispatch(h.session.id, 'wait for steering');
    await expect.poll(h.texts, { timeout: 10000 }).toContain('waiting for steering');
    h.setPolicy('legacy-v1'); h.setAuthority('current-steer-authority');
    const queued = await h.runtime.dispatch(h.session.id, 'followup');
    expect(h.repos.execution.getAcceptedTask(queued.id)?.input.executionContext.promptPolicyVersion).toBe('legacy-v1');
    await expect(h.runtime.injectQueued(h.session.id, queued.id, 'installation_owner', 'frozen-steer')).resolves.toMatchObject({ outcome: 'injected' });
    await expect.poll(h.texts, { timeout: 10000 }).toContain('Steered: optimized-v1:current-steer-authority\nfollowup');
    const assemblies = h.assemblies();
    await h.runtime.injectQueued(h.session.id, queued.id, 'installation_owner', 'frozen-steer');
    expect(h.assemblies()).toBe(assemblies);
  });
});
