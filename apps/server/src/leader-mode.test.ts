import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryBundle, TaskRecord, WorkItem } from '@dutydeck/shared';
import { LEDGER_LIMIT, leaderDecisionsView, leaderLedger, parseLeaderRuling, resolveLeaderGuide, type LeaderModeRecord } from './leader-mode.js';
import { setPluginSkillRoots } from './skill-catalog.js';
import { workItemElements } from './lark/workbench.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function directories() {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-leader-guide-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), home = join(root, 'home');
  await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
  return { root, workspace, home };
}
async function skill(directory: string, name: string, body = '指引正文') {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试\n---\n${body}\n`);
  return join(directory, 'SKILL.md');
}
const parent = (cwd: string, appId = 'cli_bot') => ({ cwd, sourceId: `${appId}:oc_chat:p2p` });

describe('Leader 指引解析', () => {
  it('uses the built-in rules only when no guide is configured', async () => {
    const { workspace, home } = await directories();
    expect(await resolveLeaderGuide(parent(workspace), undefined, home)).toBeUndefined();
    expect(await resolveLeaderGuide(parent(workspace), '  ', home)).toBeUndefined();
  });

  it('finds a unique skill by name in the workspace or host user directory and keeps its path', async () => {
    const { workspace, home } = await directories();
    const path = await skill(join(home, '.claude', 'skills', 'my-leader'), 'my-leader', '上线前先问');
    const guide = await resolveLeaderGuide(parent(workspace), 'my-leader', home);
    expect(guide).toMatchObject({ name: 'my-leader', path });
    expect(guide!.block).toContain(`Path: ${path}`);
    expect(guide!.block).toContain('上线前先问');
  });

  it('rejects a name shared by several skills and lists the candidates', async () => {
    const { workspace, home } = await directories();
    const first = await skill(join(workspace, '.claude', 'skills', 'leader'), 'leader');
    const second = await skill(join(home, '.agents', 'skills', 'leader'), 'leader');
    await expect(resolveLeaderGuide(parent(workspace), 'leader', home)).rejects.toMatchObject({ code: 'LEADER_GUIDE_UNAVAILABLE', message: expect.stringMatching(/有 2 个同名技能/) });
    await expect(resolveLeaderGuide(parent(workspace), 'leader', home)).rejects.toThrow(first);
    await expect(resolveLeaderGuide(parent(workspace), 'leader', home)).rejects.toThrow(second);
    await expect(resolveLeaderGuide(parent(workspace), 'nobody', home)).rejects.toMatchObject({ code: 'LEADER_GUIDE_UNAVAILABLE', message: expect.stringContaining('都没有这个技能') });
  });

  it('inlines a plugin skill with its declared resources only for the Bot the plugin is bound to', async () => {
    const { root, workspace, home } = await directories();
    const plugin = join(root, 'plugin');
    await skill(join(plugin, 'skills', 'leader'), 'team-leader', '见引用文件');
    await writeFile(join(plugin, 'rules.md'), '发布窗口只在周二');
    cleanup.push(setPluginSkillRoots(context => context.botAppId === 'cli_bot' && context.workspaceRoot === workspace
      ? [{ path: join(plugin, 'skills'), plugin: 'team', version: '1.0.0', root: plugin, resources: { leader: [{ path: 'rules.md', maxBytes: 1024 }] } }] : []));
    const guide = await resolveLeaderGuide(parent(workspace), 'team/leader', home);
    expect(guide!.block).toContain('见引用文件');
    expect(guide!.block).toContain('# Reference: rules.md\n发布窗口只在周二');
    expect((await resolveLeaderGuide(parent(workspace), 'team-leader', home))!.name).toBe('team-leader');
    await expect(resolveLeaderGuide(parent(workspace, 'cli_other'), 'team/leader', home)).rejects.toMatchObject({ code: 'LEADER_GUIDE_UNAVAILABLE', message: expect.stringContaining('没找到这个插件技能') });
  });

  it('reads an absolute path to SKILL.md or its directory outside the skill roots, with the real path and without resources', async () => {
    const { root, workspace, home } = await directories();
    const real = join(root, 'agent-context', 'skills', '_custom', 'leader');
    const path = await skill(real, 'custom-leader', '个人指引');
    await mkdir(join(real, 'references'));
    await writeFile(join(real, 'references', 'escalate.md'), '上报格式');
    // 用户的技能目录常是软链到别处，技能目录查找会跳过这类软链接，绝对路径照样能用。
    await mkdir(join(home, '.claude', 'skills'), { recursive: true });
    await symlink(real, join(home, '.claude', 'skills', 'leader'));
    await expect(resolveLeaderGuide(parent(workspace), 'custom-leader', home)).rejects.toMatchObject({ code: 'LEADER_GUIDE_UNAVAILABLE' });
    for (const value of [real, path, join(home, '.claude', 'skills', 'leader'), '~/.claude/skills/leader/SKILL.md']) {
      const guide = await resolveLeaderGuide(parent(workspace), value, home);
      expect(guide).toMatchObject({ name: 'custom-leader', path });
      expect(guide!.block).toContain(`Path: ${path}\n`);
      expect(guide!.block).toContain('个人指引');
      expect(guide!.block).not.toContain('上报格式');
    }
  });

  it.each([
    ['a missing path', async (root: string) => join(root, 'missing'), '路径不存在'],
    ['a directory without SKILL.md', async (root: string) => { await mkdir(join(root, 'empty')); return join(root, 'empty'); }, '目录里没有 SKILL.md'],
    ['a file not named SKILL.md', async (root: string) => { await writeFile(join(root, 'guide.md'), '# 指引'); return join(root, 'guide.md'); }, '要填 SKILL.md 文件或包含它的目录'],
    ['an oversized SKILL.md', async (root: string) => { await mkdir(join(root, 'big')); await writeFile(join(root, 'big', 'SKILL.md'), 'x'.repeat(128 * 1024 + 1)); return join(root, 'big'); }, '超过 128 KiB'],
    ['a SKILL.md that is not UTF-8', async (root: string) => { await mkdir(join(root, 'binary')); await writeFile(join(root, 'binary', 'SKILL.md'), Buffer.from([0xff, 0xfe, 0x00])); return join(root, 'binary', 'SKILL.md'); }, '不是 UTF-8'],
    ['broken frontmatter', async (root: string) => { await mkdir(join(root, 'broken')); await writeFile(join(root, 'broken', 'SKILL.md'), '---\nname: [\n---\n'); return join(root, 'broken'); }, '元数据无效']
  ])('rejects %s with a clear reason', async (_name, arrange, reason) => {
    const { root, workspace, home } = await directories();
    await expect(resolveLeaderGuide(parent(workspace), await arrange(root), home)).rejects.toMatchObject({ code: 'LEADER_GUIDE_UNAVAILABLE', message: expect.stringContaining(reason) });
  });

  it('matches a plugin reference before a path before a name', async () => {
    const { root, workspace, home } = await directories();
    const plugin = join(root, 'plugin');
    const pluginSkill = await skill(join(plugin, 'skills', 'leader'), 'plugin-leader', '插件版');
    // 工作区里有一个名字就叫 team/leader 的技能，插件引用优先。
    const local = await skill(join(workspace, '.claude', 'skills', 'local'), 'team/leader', '工作区版');
    cleanup.push(setPluginSkillRoots(() => [{ path: join(plugin, 'skills'), plugin: 'team', root: plugin }]));
    expect((await resolveLeaderGuide(parent(workspace), 'team/leader', home))!.path).toBe(pluginSkill);
    expect((await resolveLeaderGuide(parent(workspace), '.claude/skills/local', home))!.path).toBe(local);
    expect((await resolveLeaderGuide(parent(workspace), 'plugin-leader', home))!.path).toBe(pluginSkill);
  });
});

describe('授权账本', () => {
  const task = (id: string, createdAt: string, prompt: string, actorId = 'ou_alice'): TaskRecord => ({ id, sessionId: 'ses_parent', prompt, status: 'completed', createdAt, updatedAt: createdAt, executionContext: { actorId, agentPrompt: `[注入材料]\n${prompt}` } });
  const repositories = (tasks: TaskRecord[]) => ({ tasks: { listBySession: async () => tasks } }) as unknown as RepositoryBundle;
  const scope = { parentSessionId: 'ses_parent', actorId: 'ou_alice', parentTaskId: 'task_origin' };

  it('quotes the trigger and the requester\'s later messages verbatim, skipping earlier turns and other people', async () => {
    const ledger = await leaderLedger(repositories([
      task('task_before', '2026-11-08T00:00:00.000Z', '更早的话'),
      task('task_origin', '2026-11-08T01:00:00.000Z', '修复登录，可以直接上线'),
      task('task_bob', '2026-11-08T02:00:00.000Z', '我也同意上线', 'ou_bob'),
      task('task_after', '2026-11-08T03:00:00.000Z', '算了，上线前先问我')
    ]), scope, [{ at: '2026-11-08T02:30:00.000Z', text: '卡片答复：批准工具调用「git push」' }]);
    expect(ledger.split('\n').slice(1, -1)).toEqual([
      '- 2026-11-08T01:00:00.000Z 消息：修复登录，可以直接上线',
      '- 2026-11-08T02:30:00.000Z 卡片答复：批准工具调用「git push」',
      '- 2026-11-08T03:00:00.000Z 消息：算了，上线前先问我'
    ]);
    expect(ledger).not.toContain('注入材料');
  });

  it(`keeps the newest entries within ${LEDGER_LIMIT} characters`, async () => {
    const tasks = Array.from({ length: 30 }, (_, index) => task(index ? `task_${index}` : 'task_origin', `2026-11-08T00:${String(index).padStart(2, '0')}:00.000Z`, `第 ${index} 条 ${'字'.repeat(400)}`));
    const ledger = await leaderLedger(repositories(tasks), scope);
    const lines = ledger.split('\n').slice(1, -1);
    expect(lines[0]).toMatch(/^（更早的 \d+ 条超出 8000 字，已省略）$/);
    expect(lines.at(-1)).toContain('第 29 条');
    expect(ledger).not.toContain('第 0 条');
    expect(lines.slice(1).join('\n').length).toBeLessThanOrEqual(LEDGER_LIMIT);
    const single = await leaderLedger(repositories([task('task_origin', '2026-11-08T00:00:00.000Z', `开头${'长'.repeat(9000)}结尾`)]), scope);
    expect(single).toContain('结尾');
    expect(single).not.toContain('开头');
  });
});

describe('代判输出与卡片', () => {
  it('accepts only the decisions that fit the request kind', () => {
    expect(parseLeaderRuling('```json\n{"decision":"answer","answer":"用 main","basis":"账本"}\n```', 'question')).toMatchObject({ decision: 'answer', answer: '用 main' });
    expect(() => parseLeaderRuling('{"decision":"answer","answer":"好","basis":"x"}', 'permission')).toThrow(/工具授权不能用 answer/);
    expect(() => parseLeaderRuling('{"decision":"escalate","problem":"要不要上线"}', 'permission')).toThrow(/suggestion/);
    expect(() => parseLeaderRuling('可以', 'question')).toThrow(/JSON/);
  });

  it('lists the latest five delivered decisions with the total, and shows the Leader note on escalated requests', () => {
    const rulings = Array.from({ length: 7 }, (_, index) => ({ key: `k${index}`, stepId: 'impl', kind: 'question' as const, question: `问题 ${index}`, at: '2026-11-08T00:00:00.000Z', decision: 'answer' as const, answer: `回答 ${index}`, basis: `依据 ${index}`, delivery: 'delivered' as const }));
    const record = { rulings: [...rulings, { ...rulings[0]!, key: 'escalated', decision: 'escalate' as const }, { ...rulings[0]!, key: 'unsent', delivery: 'pending' as const }] } as LeaderModeRecord;
    const decisions = leaderDecisionsView(record)!;
    expect(decisions.total).toBe(7);
    expect(decisions.recent.map(entry => entry.question)).toEqual(['问题 2', '问题 3', '问题 4', '问题 5', '问题 6']);
    const item: WorkItem = { id: 'work_1', parentSessionId: 'ses_1', title: '修复登录', goal: '修复登录', revision: 3, status: 'running',
      plan: { title: '修复登录', outputStepId: 'impl', steps: [{ id: 'impl', title: '实现', kind: 'agent', agentId: 'worker', instruction: '修复', dependsOn: [] }] },
      steps: [{ id: 'impl', status: 'running', attempts: [] }], createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', delivery: { status: 'pending', attempts: 0 } };
    const elements = workItemElements(item, [
      { stepId: 'impl', sessionId: 'ses_w', taskId: 'task_w', requestId: 'ask_1', kind: 'question', text: '用哪个分支？', leader: { problem: '换不换分支', suggestion: '留在 main', ifNoReply: '这一步一直等着' } },
      { stepId: 'impl', sessionId: 'ses_w', taskId: 'task_w', requestId: 'permit_1', kind: 'permission', text: 'git push', leader: { reason: 'Leader 代判超时' } }
    ], { leaderDecisions: decisions });
    const text = elements.map(element => element.content ?? '').join('\n');
    expect(text).toContain('**Leader 已替你定**（共 7 条，这里是最近 5 条）');
    expect(text).toContain('- 问题 6 → 回答 6 · 依据 6');
    expect(text).not.toContain('问题 1 →');
    expect(text).toContain('问题：换不换分支\n建议：留在 main\n不回复时：这一步一直等着');
    expect(text).toContain('说明：Leader 代判超时');
    expect(text.indexOf('Leader 已替你定')).toBeGreaterThan(text.indexOf('实现'));
    expect(elements.filter(element => element.tag === 'button' && /批准本次调用|拒绝本次调用/.test(element.text.content))).toHaveLength(2);
  });
});
