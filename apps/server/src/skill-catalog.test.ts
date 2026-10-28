import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverSkills, isPathInside } from './skill-catalog.js';

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe('skill-catalog', () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dutydeck-skill-catalog-test-'));
    workspaceDir = join(tempDir, 'workspace');
    userHomeDir = join(tempDir, 'user-home');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(userHomeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('isPathInside', () => {
    it('returns true for same path and subpaths', () => {
      expect(isPathInside('/a/b', '/a/b')).toBe(true);
      expect(isPathInside('/a/b/c', '/a/b')).toBe(true);
      expect(isPathInside('/a/b/c/d.txt', '/a/b')).toBe(true);
      expect(isPathInside('/a/b/..internal', '/a/b')).toBe(true);
    });

    it('returns false for ancestor and outside paths', () => {
      expect(isPathInside('/a', '/a/b')).toBe(false);
      expect(isPathInside('/other', '/a/b')).toBe(false);
      expect(isPathInside('/a/b_sibling', '/a/b')).toBe(false);
    });
  });

  describe('discoverSkills', () => {
    it('discovers a skill whose directory starts with two dots', async () => {
      const dir = join(workspaceDir, '.agents', 'skills', '..internal');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), '---\nname: internal\n---\nInstructions');
      expect(await discoverSkills(workspaceDir, { homeDirectory: userHomeDir })).toEqual([
        { name: 'internal', description: '', path: join(dir, 'SKILL.md'), source: 'workspace' }
      ]);
    });

    it('discovers skills across workspace and user roots with frontmatter', async () => {
      // workspace .agents/skills
      const wsAgentSkillDir = join(workspaceDir, '.agents', 'skills', 'deploy');
      await mkdir(wsAgentSkillDir, { recursive: true });
      await writeFile(
        join(wsAgentSkillDir, 'SKILL.md'),
        '---\nname: deploy-service\ndescription: "Deploy the service"\n---\nDeploy instructions'
      );

      // workspace .codex/skills
      const wsCodexSkillDir = join(workspaceDir, '.codex', 'skills', 'test-suite');
      await mkdir(wsCodexSkillDir, { recursive: true });
      await writeFile(
        join(wsCodexSkillDir, 'SKILL.md'),
        '---\nname: run-tests\ndescription: Run all tests\n---\nTest instructions'
      );

      // user .agents/skills
      const userAgentSkillDir = join(userHomeDir, '.agents', 'skills', 'global-tool');
      await mkdir(userAgentSkillDir, { recursive: true });
      await writeFile(
        join(userAgentSkillDir, 'SKILL.md'),
        '---\nname: global-helper\ndescription: A global helper\n---\nGlobal instructions'
      );

      // user .codex/skills (no frontmatter name, fallback to dirname)
      const userCodexSkillDir = join(userHomeDir, '.codex', 'skills', 'fallback-name');
      await mkdir(userCodexSkillDir, { recursive: true });
      await writeFile(
        join(userCodexSkillDir, 'SKILL.md'),
        '# Some skill without frontmatter\nBody'
      );

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });

      expect(skills).toHaveLength(4);
      expect(skills.map(s => s.name)).toEqual([
        'deploy-service',
        'fallback-name',
        'global-helper',
        'run-tests',
      ]);

      const deploySkill = skills.find(s => s.name === 'deploy-service');
      expect(deploySkill).toMatchObject({
        name: 'deploy-service',
        description: 'Deploy the service',
        source: 'workspace',
      });
      expect(deploySkill?.path).toContain('SKILL.md');

      const fallbackSkill = skills.find(s => s.name === 'fallback-name');
      expect(fallbackSkill).toMatchObject({
        name: 'fallback-name',
        description: '',
        source: 'user',
      });
    });

    it('exposes all eligible same-name files with workspace precedence in deterministic order', async () => {
      // Workspace has "review"
      const wsSkillDir = join(workspaceDir, '.agents', 'skills', 'review');
      await mkdir(wsSkillDir, { recursive: true });
      await writeFile(
        join(wsSkillDir, 'SKILL.md'),
        '---\nname: review\ndescription: Workspace review\n---\nWorkspace code review'
      );

      // User also has "review"
      const userSkillDir = join(userHomeDir, '.codex', 'skills', 'review');
      await mkdir(userSkillDir, { recursive: true });
      await writeFile(
        join(userSkillDir, 'SKILL.md'),
        '---\nname: review\ndescription: User review\n---\nUser personal code review'
      );

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });

      // Both must be exposed so UI can choose
      expect(skills).toHaveLength(2);
      expect(skills[0].name).toBe('review');
      expect(skills[0].source).toBe('workspace');
      expect(skills[0].description).toBe('Workspace review');

      expect(skills[1].name).toBe('review');
      expect(skills[1].source).toBe('user');
      expect(skills[1].description).toBe('User review');
    });

    it('discovers Claude skills alongside existing roots and keeps same-name paths distinct', async () => {
      const roots = [
        { base: workspaceDir, provider: '.agents', source: 'workspace' },
        { base: workspaceDir, provider: '.claude', source: 'workspace' },
        { base: workspaceDir, provider: '.codex', source: 'workspace' },
        { base: userHomeDir, provider: '.agents', source: 'user' },
        { base: userHomeDir, provider: '.claude', source: 'user' },
        { base: userHomeDir, provider: '.codex', source: 'user' }
      ] as const;

      for (const root of roots) {
        const dir = join(root.base, root.provider, 'skills', 'shared');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'SKILL.md'), `---\nname: shared\ndescription: ${root.source} ${root.provider}\n---\n${root.provider}`);
      }

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });
      expect(skills).toHaveLength(6);
      expect(skills.map(skill => skill.path)).toEqual(roots.map(root => join(root.base, root.provider, 'skills', 'shared', 'SKILL.md')));
      expect(skills.map(skill => skill.source)).toEqual(roots.map(root => root.source));
      expect(skills.map(skill => skill.description)).toEqual(roots.map(root => `${root.source} ${root.provider}`));
    });

    it('deduplicates the same Claude skill reached through an existing root symlink', async () => {
      const claudeDir = join(workspaceDir, '.claude', 'skills', 'shared');
      await mkdir(claudeDir, { recursive: true });
      await writeFile(join(claudeDir, 'SKILL.md'), '---\nname: shared\n---\nShared content');
      await mkdir(join(workspaceDir, '.agents'), { recursive: true });
      await symlink(join(workspaceDir, '.claude', 'skills'), join(workspaceDir, '.agents', 'skills'));

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });
      expect(skills).toHaveLength(1);
      expect(skills[0]?.path).toBe(join(claudeDir, 'SKILL.md'));
      expect(vi.mocked(fs.open).mock.calls.filter(([path]) => path === join(claudeDir, 'SKILL.md'))).toHaveLength(1);
    });

    it('reads shared canonical paths once and keeps workspace source ahead of user roots', async () => {
      const skillRoot = join(workspaceDir, '.claude', 'skills');
      const skillFile = join(skillRoot, 'shared', 'SKILL.md');
      await mkdir(join(skillRoot, 'shared'), { recursive: true });
      await writeFile(skillFile, '---\nname: shared\ndescription: Shared content\n---\nBody');
      await mkdir(join(userHomeDir, '.agents'), { recursive: true });
      await symlink(skillRoot, join(userHomeDir, '.agents', 'skills'));

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });
      expect(skills).toEqual([{ name: 'shared', description: 'Shared content', path: skillFile, source: 'workspace' }]);
      expect(vi.mocked(fs.open).mock.calls.filter(([path]) => path === skillFile)).toHaveLength(1);
    });

    it('does not crawl symlink directories pointing outside registered root', async () => {
      // Create outside directory with a secret SKILL.md
      const outsideDir = join(tempDir, 'outside-secret-dir');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(
        join(outsideDir, 'SKILL.md'),
        '---\nname: secret-skill\ndescription: Should not be crawled\n---\nSecret body'
      );

      // Symlink the outside directory into workspace .agents/skills
      const skillsRoot = join(workspaceDir, '.agents', 'skills');
      await mkdir(skillsRoot, { recursive: true });
      await symlink(outsideDir, join(skillsRoot, 'escaped-symlink-dir'));

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });
      expect(skills.find(s => s.name === 'secret-skill')).toBeUndefined();
      expect(skills).toHaveLength(0);
    });

    it('ignores SKILL.md symlinks pointing outside registered root', async () => {
      const outsideFile = join(tempDir, 'outside-skill.md');
      await writeFile(
        outsideFile,
        '---\nname: outside-file-skill\ndescription: Escape\n---\nOutside'
      );

      const skillDir = join(workspaceDir, '.agents', 'skills', 'symlink-file');
      await mkdir(skillDir, { recursive: true });
      await symlink(outsideFile, join(skillDir, 'SKILL.md'));

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });
      expect(skills.find(s => s.name === 'outside-file-skill')).toBeUndefined();
      expect(skills).toHaveLength(0);
    });

    it('rejects Claude skill symlinks pointing outside its root', async () => {
      const outsideDir = join(tempDir, 'outside-claude');
      await mkdir(outsideDir, { recursive: true });
      await writeFile(join(outsideDir, 'SKILL.md'), '---\nname: secret\n---\nOutside');
      const claudeRoot = join(userHomeDir, '.claude', 'skills');
      await mkdir(claudeRoot, { recursive: true });
      await symlink(outsideDir, join(claudeRoot, 'escaped'));

      expect(await discoverSkills(workspaceDir, { homeDirectory: userHomeDir })).toEqual([]);
    });

    it('avoids circular symlink traversal loops inside registered root', async () => {
      const skillsRoot = join(workspaceDir, '.agents', 'skills');
      const subDir = join(skillsRoot, 'sub');
      await mkdir(subDir, { recursive: true });
      await writeFile(
        join(subDir, 'SKILL.md'),
        '---\nname: normal-skill\n---\nNormal'
      );

      // Create a symlink loop inside the root: sub/loop -> skillsRoot
      await symlink(skillsRoot, join(subDir, 'loop'));

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('normal-skill');
    });

    it('ignores standard ignored directories like node_modules and .git', async () => {
      const ignoredNodeModules = join(workspaceDir, '.agents', 'skills', 'node_modules', 'evil');
      await mkdir(ignoredNodeModules, { recursive: true });
      await writeFile(join(ignoredNodeModules, 'SKILL.md'), '---\nname: node-modules-skill\n---\nContent');

      const ignoredGit = join(workspaceDir, '.agents', 'skills', '.git', 'hooks');
      await mkdir(ignoredGit, { recursive: true });
      await writeFile(join(ignoredGit, 'SKILL.md'), '---\nname: git-skill\n---\nContent');

      const skills = await discoverSkills(workspaceDir, { homeDirectory: userHomeDir });
      expect(skills).toHaveLength(0);
    });

    it('gracefully returns empty array when roots do not exist', async () => {
      const nonExistentWorkspace = join(tempDir, 'does-not-exist');
      const nonExistentHome = join(tempDir, 'home-does-not-exist');
      const skills = await discoverSkills(nonExistentWorkspace, { homeDirectory: nonExistentHome });
      expect(skills).toEqual([]);
    });
  });
});

describe('bounded skill catalog', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dutydeck-catalog-budget-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const add = async (root: string, name: string, body: string) => { const path = join(root, '.agents/skills', name, 'SKILL.md'); await mkdir(join(root, '.agents/skills', name), { recursive: true }); await writeFile(path, body); return path; };

  it('diagnoses bad optional YAML separately and never includes it as a valid unnamed skill', async () => {
    const bad = await add(root, 'bad', '---\nname: bad\nname: duplicate\n---\nbody');
    await add(root, 'good', '---\nname: good\n---\nbody');
    const { discoverSkillCatalog } = await import('./skill-catalog.js');
    const catalog = await discoverSkillCatalog(root, { homeDirectory: root });
    expect(catalog.skills.map(skill => skill.name)).toEqual(['good']);
    expect(catalog.partial).toBe(false);
    expect(catalog.diagnostics).toEqual([expect.objectContaining({ path: bad, code: 'SKILL_METADATA_INVALID' })]);
  });

  it('bounds enumeration and candidate counts, reporting truncation explicitly', async () => {
    await add(root, 'first', '# first'); await add(root, 'second', '# second');
    const { discoverSkillCatalog } = await import('./skill-catalog.js');
    for (const limits of [{ entries: 1 }, { candidates: 1 }]) {
      const catalog = await discoverSkillCatalog(root, { homeDirectory: root, limits });
      expect(catalog.partial).toBe(true);
      expect(catalog.budget.entries).toBeLessThanOrEqual(limits.entries ?? 8192);
      expect(catalog.budget.candidates).toBeLessThanOrEqual(limits.candidates ?? 512);
      expect(catalog.diagnostics.some(item => item.code === 'SKILL_CATALOG_BUDGET_EXCEEDED')).toBe(true);
    }
  });

  it('never reads a huge body in discovery and rejects an incomplete metadata prefix', async () => {
    await add(root, 'huge-body', `---\nname: huge\n---\n${'x'.repeat(2 * 1024 * 1024)}`);
    const bad = await add(root, 'huge-header', `---\ndescription: ${'x'.repeat(64 * 1024)}\n---\nbody`);
    const { discoverSkillCatalog } = await import('./skill-catalog.js');
    const catalog = await discoverSkillCatalog(root, { homeDirectory: root });
    expect(catalog.skills.map(skill => skill.name)).toEqual(['huge']);
    expect(catalog.diagnostics).toEqual([expect.objectContaining({ path: bad, code: 'SKILL_METADATA_SIZE_EXCEEDED' })]);
    expect(catalog.budget.bytes).toBeLessThanOrEqual(32 * 1024);
    expect(catalog.budget.concurrentReads).toBe(1);
  });

  it('enforces the shared total read budget even when malformed candidates fail parsing', async () => {
    for (const name of ['a', 'b', 'c']) await add(root, name, `---\nname: a\nname: b\n---\n${'x'.repeat(100)}`);
    const { discoverSkillCatalog } = await import('./skill-catalog.js');
    const catalog = await discoverSkillCatalog(root, { homeDirectory: root, limits: { metadataBytes: 40, totalBytes: 65 } });
    expect(catalog.budget.bytes).toBeLessThanOrEqual(65);
    expect(catalog.partial).toBe(true);
    expect(catalog.skills).toEqual([]);
  });

  it('keeps duplicate plugin references fatal even when one candidate has invalid metadata', async () => {
    const paths = [];
    for (const parent of ['a', 'b']) { const path = join(root, parent, 'same'); await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), parent === 'a' ? '---\nname: a\nname: b\n---' : '# valid'); paths.push(join(root, parent)); }
    const { discoverSkillCatalog } = await import('./skill-catalog.js');
    await expect(discoverSkillCatalog(root, { homeDirectory: root, pluginRoots: paths.map(path => ({ path, plugin: 'sample' })) })).rejects.toMatchObject({ code: 'SKILL_REF_DUPLICATE' });
  });
});

it.skipIf(process.platform === 'win32')('diagnoses named pipes without blocking discovery', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-skill-pipe-'));
  try {
    const path = join(root, '.agents/skills/pipe'); await mkdir(path, { recursive: true }); execFileSync('mkfifo', [join(path, 'SKILL.md')]);
    const { discoverSkillCatalog } = await import('./skill-catalog.js');
    const catalog = await discoverSkillCatalog(root, { homeDirectory: root });
    expect(catalog.skills).toEqual([]); expect(catalog.diagnostics).toEqual([expect.objectContaining({ code: 'INVALID_SKILL_FILE' })]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


it('preserves the original depth eligibility without falsely marking an otherwise complete catalog partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-skill-depth-'));
  try {
    const path = join(root, '.agents/skills', 'a/b/c/d/e/f'); await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), '# too deep');
    const { discoverSkillCatalog } = await import('./skill-catalog.js');
    expect(await discoverSkillCatalog(root, { homeDirectory: root })).toMatchObject({ skills: [], diagnostics: [], partial: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});
