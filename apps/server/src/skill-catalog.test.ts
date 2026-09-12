import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoverSkills, isPathInside } from './skill-catalog.js';

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
    });

    it('returns false for ancestor and outside paths', () => {
      expect(isPathInside('/a', '/a/b')).toBe(false);
      expect(isPathInside('/other', '/a/b')).toBe(false);
      expect(isPathInside('/a/b_sibling', '/a/b')).toBe(false);
    });
  });

  describe('discoverSkills', () => {
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
