import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLeadingDirectives, prepareSkillPrompt } from './skill-delivery.js';

describe('skill-delivery', () => {
  let tempDir: string;
  let workspaceDir: string;
  let userHomeDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dutydeck-skill-delivery-test-'));
    workspaceDir = join(tempDir, 'workspace');
    userHomeDir = join(tempDir, 'user-home');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(userHomeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('parseLeadingDirectives', () => {
    it('parses leading standalone /skills NAME directive lines', () => {
      const prompt = '/skills review\n/skills deploy\n\nPlease review and deploy';
      const parsed = parseLeadingDirectives(prompt);
      expect(parsed.legacySkillNames).toEqual(['review', 'deploy']);
      expect(parsed.userPrompt).toBe('Please review and deploy');
    });

    it('handles empty lines before and between leading directives', () => {
      const prompt = '\n\n  /skills review  \n\n  /skills "deploy"  \n\nDo work';
      const parsed = parseLeadingDirectives(prompt);
      expect(parsed.legacySkillNames).toEqual(['review', 'deploy']);
      expect(parsed.userPrompt).toBe('Do work');
    });

    it('returns empty list and raw prompt when there are no directives', () => {
      const prompt = 'Regular message without directives';
      const parsed = parseLeadingDirectives(prompt);
      expect(parsed.legacySkillNames).toEqual([]);
      expect(parsed.userPrompt).toBe(prompt);
    });

    it('stops at first non-directive line and ignores embedded code fences', () => {
      const prompt = 'Here is how to use it:\n```sh\n/skills review\n```\nThanks.';
      const parsed = parseLeadingDirectives(prompt);
      expect(parsed.legacySkillNames).toEqual([]);
      expect(parsed.userPrompt).toBe(prompt);
    });

    it('ignores blockquotes containing directives', () => {
      const prompt = '> /skills review\nIs this a command?';
      const parsed = parseLeadingDirectives(prompt);
      expect(parsed.legacySkillNames).toEqual([]);
      expect(parsed.userPrompt).toBe(prompt);
    });

    it('returns empty userPrompt when prompt contains only directives', () => {
      const prompt = '/skills review\n/skills deploy';
      const parsed = parseLeadingDirectives(prompt);
      expect(parsed.legacySkillNames).toEqual(['review', 'deploy']);
      expect(parsed.userPrompt).toBe('');
    });
  });

  describe('prepareSkillPrompt', () => {
    it('returns unchanged prompt and empty deliveries when no requests are made', async () => {
      const prompt = 'Simple message with no skills';
      const result1 = await prepareSkillPrompt(workspaceDir, prompt, undefined, { homeDirectory: userHomeDir });
      expect(result1.agentPrompt).toBe(prompt);
      expect(result1.skillDeliveries).toEqual([]);

      const result2 = await prepareSkillPrompt(workspaceDir, prompt, [], { homeDirectory: userHomeDir });
      expect(result2.agentPrompt).toBe(prompt);
      expect(result2.skillDeliveries).toEqual([]);
    });

    it('delivers skill with actual body and exact SHA256 digest in prompt mode', async () => {
      const skillDir = join(workspaceDir, '.agents', 'skills', 'linter');
      await mkdir(skillDir, { recursive: true });
      const skillContent = '---\nname: linter\ndescription: Linting helper\n---\nRun eslint on target files';
      const skillPath = join(skillDir, 'SKILL.md');
      await writeFile(skillPath, skillContent, 'utf8');

      const expectedDigest = createHash('sha256').update(Buffer.from(skillContent, 'utf8')).digest('hex').toLowerCase();

      const userPrompt = 'Please lint the server code';
      const result = await prepareSkillPrompt(
        workspaceDir,
        userPrompt,
        [skillPath],
        { homeDirectory: userHomeDir }
      );

      expect(result.skillDeliveries).toHaveLength(1);
      const delivery = result.skillDeliveries[0]!;
      expect(delivery.name).toBe('linter');
      expect(delivery.path).toBe(skillPath);
      expect(delivery.source).toBe('workspace');
      expect(delivery.mode).toBe('prompt');
      expect(delivery.digest).toBe(expectedDigest);

      // Verify agentPrompt structure: skill content, name, path, explicit delimiter, and user prompt
      expect(result.agentPrompt).toContain('# Skill: linter');
      expect(result.agentPrompt).toContain(`Path: ${skillPath}`);
      expect(result.agentPrompt).toContain(skillContent);
      expect(result.agentPrompt).toContain('---');
      expect(result.agentPrompt).toContain(userPrompt);
    });

    it('supports selecting between same-name skills across workspace and user via explicit paths', async () => {
      const wsSkillDir = join(workspaceDir, '.agents', 'skills', 'compile');
      await mkdir(wsSkillDir, { recursive: true });
      const wsContent = '---\nname: compile\n---\nWorkspace compile procedure';
      const wsSkillPath = join(wsSkillDir, 'SKILL.md');
      await writeFile(wsSkillPath, wsContent, 'utf8');

      const userSkillDir = join(userHomeDir, '.codex', 'skills', 'compile');
      await mkdir(userSkillDir, { recursive: true });
      const userContent = '---\nname: compile\n---\nUser global compile procedure';
      const userSkillPath = join(userSkillDir, 'SKILL.md');
      await writeFile(userSkillPath, userContent, 'utf8');

      // Request the user-level compile skill explicitly
      const userResult = await prepareSkillPrompt(
        workspaceDir,
        'Compile the app',
        [userSkillPath],
        { homeDirectory: userHomeDir }
      );
      expect(userResult.skillDeliveries).toHaveLength(1);
      expect(userResult.skillDeliveries[0]!.source).toBe('user');
      expect(userResult.skillDeliveries[0]!.path).toBe(userSkillPath);
      expect(userResult.agentPrompt).toContain('User global compile procedure');

      // Request the workspace-level compile skill explicitly
      const wsResult = await prepareSkillPrompt(
        workspaceDir,
        'Compile the app',
        [wsSkillPath],
        { homeDirectory: userHomeDir }
      );
      expect(wsResult.skillDeliveries).toHaveLength(1);
      expect(wsResult.skillDeliveries[0]!.source).toBe('workspace');
      expect(wsResult.skillDeliveries[0]!.path).toBe(wsSkillPath);
      expect(wsResult.agentPrompt).toContain('Workspace compile procedure');
    });

    it('resolves legacy /skills directives with workspace precedence', async () => {
      // Both workspace and user have skill named "test"
      const wsSkillDir = join(workspaceDir, '.agents', 'skills', 'test');
      await mkdir(wsSkillDir, { recursive: true });
      const wsContent = '---\nname: test\n---\nWorkspace test runner';
      await writeFile(join(wsSkillDir, 'SKILL.md'), wsContent, 'utf8');

      const userSkillDir = join(userHomeDir, '.agents', 'skills', 'test');
      await mkdir(userSkillDir, { recursive: true });
      const userContent = '---\nname: test\n---\nUser test runner';
      await writeFile(join(userSkillDir, 'SKILL.md'), userContent, 'utf8');

      const prompt = '/skills test\n\nRun the test suite now';
      const result = await prepareSkillPrompt(workspaceDir, prompt, undefined, { homeDirectory: userHomeDir });

      expect(result.skillDeliveries).toHaveLength(1);
      // Legacy name resolution must choose workspace first
      expect(result.skillDeliveries[0]!.source).toBe('workspace');
      expect(result.skillDeliveries[0]!.name).toBe('test');
      expect(result.agentPrompt).toContain('Workspace test runner');
      expect(result.agentPrompt).toContain('Run the test suite now');
      expect(result.agentPrompt).not.toContain('/skills test');
    });

    it('resolves legacy /skills directives to user skill if not in workspace', async () => {
      const userSkillDir = join(userHomeDir, '.codex', 'skills', 'user-only');
      await mkdir(userSkillDir, { recursive: true });
      await writeFile(join(userSkillDir, 'SKILL.md'), '---\nname: user-only\n---\nUser-only instructions', 'utf8');

      const prompt = '/skills user-only\n\nRun user-only tool';
      const result = await prepareSkillPrompt(workspaceDir, prompt, undefined, { homeDirectory: userHomeDir });

      expect(result.skillDeliveries).toHaveLength(1);
      expect(result.skillDeliveries[0]!.source).toBe('user');
      expect(result.skillDeliveries[0]!.name).toBe('user-only');
      expect(result.agentPrompt).toContain('User-only instructions');
    });

    it('rejects unknown skill requested via legacy directive rather than silently dropping', async () => {
      const prompt = '/skills non-existent-skill\n\nDo something';
      await expect(prepareSkillPrompt(workspaceDir, prompt, undefined, { homeDirectory: userHomeDir })).rejects.toThrow(
        /Unknown skill "non-existent-skill"/
      );
    });

    it('rejects invalid path or arbitrary file request not in discovered catalog', async () => {
      // Trying to load an arbitrary file outside registered skill catalog
      const arbitraryFile = join(tempDir, 'arbitrary.txt');
      await writeFile(arbitraryFile, 'Arbitrary system file', 'utf8');

      await expect(
        prepareSkillPrompt(workspaceDir, 'Read this', [arbitraryFile], { homeDirectory: userHomeDir })
      ).rejects.toThrow(/does not match any discovered eligible skill in catalog/);
    });

    it('rejects ancestor symlink escape and outside symlink directory', async () => {
      const outsideDir = join(tempDir, 'secret-vault');
      await mkdir(outsideDir, { recursive: true });
      const secretFile = join(outsideDir, 'SKILL.md');
      await writeFile(secretFile, '---\nname: secret\n---\nSecret data', 'utf8');

      // Create symlink directory inside workspace skills pointing outside
      const wsSkillsDir = join(workspaceDir, '.agents', 'skills');
      await mkdir(wsSkillsDir, { recursive: true });
      const escapeLink = join(wsSkillsDir, 'escaped');
      await symlink(outsideDir, escapeLink);

      // Explicit request for symlinked file pointing outside allowed roots must fail
      await expect(
        prepareSkillPrompt(workspaceDir, 'Exploit', [join(escapeLink, 'SKILL.md')], { homeDirectory: userHomeDir })
      ).rejects.toThrow();
    });

    it('rejects unreadable or missing skill files', async () => {
      const skillDir = join(workspaceDir, '.agents', 'skills', 'unreadable');
      await mkdir(skillDir, { recursive: true });
      const skillPath = join(skillDir, 'SKILL.md');
      await writeFile(skillPath, '---\nname: unreadable\n---\nUnreadable body', 'utf8');

      // Make the file unreadable (mode 000)
      await chmod(skillPath, 0o000);

      try {
        await expect(
          prepareSkillPrompt(workspaceDir, 'Test unreadable', [skillPath], { homeDirectory: userHomeDir })
        ).rejects.toThrow(/Failed to open skill file/);
      } finally {
        // Restore permissions for cleanup
        await chmod(skillPath, 0o644).catch(() => {});
      }

      // Test missing file (e.g. deleted after catalog discovery)
      const missingDir = join(workspaceDir, '.agents', 'skills', 'missing');
      await mkdir(missingDir, { recursive: true });
      const missingPath = join(missingDir, 'SKILL.md');
      await writeFile(missingPath, '---\nname: missing\n---\nWill be deleted', 'utf8');
      await unlink(missingPath);

      await expect(
        prepareSkillPrompt(workspaceDir, 'Test missing', [missingPath], { homeDirectory: userHomeDir })
      ).rejects.toThrow();
    });

    it('rejects oversized skill files exceeding 128 KiB', async () => {
      const skillDir = join(workspaceDir, '.agents', 'skills', 'huge-skill');
      await mkdir(skillDir, { recursive: true });
      const skillPath = join(skillDir, 'SKILL.md');
      // Create 129 KiB content (> 128 KiB limit)
      const largeContent = '---\nname: huge\n---\n' + 'x'.repeat(129 * 1024);
      await writeFile(skillPath, largeContent, 'utf8');

      await expect(
        prepareSkillPrompt(workspaceDir, 'Huge skill', [skillPath], { homeDirectory: userHomeDir })
      ).rejects.toThrow(/exceeds maximum size of 128 KiB/);
    });

    it('rejects total skills size exceeding 512 KiB limit', async () => {
      const paths: string[] = [];
      // Create 5 skills of 110 KiB each (total 550 KiB > 512 KiB)
      for (let i = 0; i < 5; i++) {
        const skillDir = join(workspaceDir, '.agents', 'skills', `bulk-skill-${i}`);
        await mkdir(skillDir, { recursive: true });
        const skillPath = join(skillDir, 'SKILL.md');
        const content = `---\nname: bulk-${i}\n---\n` + 'b'.repeat(110 * 1024);
        await writeFile(skillPath, content, 'utf8');
        paths.push(skillPath);
      }

      await expect(
        prepareSkillPrompt(workspaceDir, 'Bulk skills', paths, { homeDirectory: userHomeDir })
      ).rejects.toThrow(/Total skills size exceeds maximum limit of 512 KiB/);
    });

    it('rejects more than 16 skill requests', async () => {
      const paths: string[] = [];
      for (let i = 0; i < 17; i++) {
        paths.push(`/some/fake/skill-${i}/SKILL.md`);
      }

      await expect(
        prepareSkillPrompt(workspaceDir, 'Too many skills', paths, { homeDirectory: userHomeDir })
      ).rejects.toThrow(/Maximum 16 skills allowed/);
    });

    it('deduplicates duplicate selections across structured requests and legacy directives', async () => {
      const skillDir = join(workspaceDir, '.agents', 'skills', 'dedupe-skill');
      await mkdir(skillDir, { recursive: true });
      const skillContent = '---\nname: dedupe-skill\n---\nDeduplicated content';
      const skillPath = join(skillDir, 'SKILL.md');
      await writeFile(skillPath, skillContent, 'utf8');

      // Request same skill via both skillRequests twice AND via /skills legacy directive
      const prompt = '/skills dedupe-skill\n\nRun deduplicated task';
      const result = await prepareSkillPrompt(
        workspaceDir,
        prompt,
        [skillPath, skillPath],
        { homeDirectory: userHomeDir }
      );

      // Must be deduplicated to exactly 1 delivery
      expect(result.skillDeliveries).toHaveLength(1);
      expect(result.skillDeliveries[0]!.name).toBe('dedupe-skill');
      expect(result.skillDeliveries[0]!.path).toBe(skillPath);

      // Content injected only once
      const count = (result.agentPrompt.match(/# Skill: dedupe-skill/g) || []).length;
      expect(count).toBe(1);
      expect(result.agentPrompt).toContain('Run deduplicated task');
    });

    it('rejects prior workspace-only selection when cwd changes to another workspace', async () => {
      const workspaceA = join(tempDir, 'workspace-a');
      const workspaceB = join(tempDir, 'workspace-b');
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      // Skill exists in workspaceA only
      const skillDir = join(workspaceA, '.agents', 'skills', 'ws-a-skill');
      await mkdir(skillDir, { recursive: true });
      const skillPath = join(skillDir, 'SKILL.md');
      await writeFile(skillPath, '---\nname: ws-a-skill\n---\nWorkspace A only skill', 'utf8');

      // In workspace A, it works
      const resA = await prepareSkillPrompt(workspaceA, 'Test A', [skillPath], { homeDirectory: userHomeDir });
      expect(resA.skillDeliveries).toHaveLength(1);

      // When cwd changes to workspace B, the selection from workspace A must be rejected
      await expect(
        prepareSkillPrompt(workspaceB, 'Test B with A skill', [skillPath], { homeDirectory: userHomeDir })
      ).rejects.toThrow(/does not match any discovered eligible skill in catalog/);
    });
  });
});
