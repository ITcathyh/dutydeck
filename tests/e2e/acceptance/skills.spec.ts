import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchIsolatedTestServer, type TestServerInstance } from './harness.js';

test('selecting a Claude skill in the browser delivers its body to the PTY and records the digest', async ({ page }) => {
  const instance: TestServerInstance = await launchIsolatedTestServer('dutydeck-acc-skills-');
  try {
    const skillDir = join(instance.sourceRepo, '.claude', 'skills', 'acceptance-skill');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    const skillBody = '---\nname: acceptance-skill\ndescription: Browser selection proof\n---\nCLAUDE_SKILL_BODY_DELIVERED';
    writeFileSync(skillPath, skillBody);

    const created = await instance.request('POST', '/api/sessions', {
      cwd: instance.sourceRepo,
      agentId: 'claude-code'
    });
    expect(created.status).toBe(200);
    const sessionId = created.json.id as string;

    await page.goto(`${instance.baseUrl}/sessions/${sessionId}`);
    const message = page.getByRole('textbox', { name: '消息', exact: true });
    await expect(message).toBeVisible();
    await message.fill('/acceptance-skill');
    const skillOption = page.getByRole('button', { name: new RegExp(`acceptance-skill.*${skillPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
    await expect(skillOption).toBeVisible();
    await skillOption.click();
    await expect(page.getByText('/skills acceptance-skill')).toBeVisible();
    await message.fill('VERIFY_CLAUDE_SKILL_DELIVERY');
    await page.getByRole('button', { name: '发送消息' }).click();

    const tasksUrl = `/api/sessions/${sessionId}/tasks`;
    await expect.poll(async () => {
      const response = await instance.request('GET', tasksUrl);
      return response.json?.[0]?.status;
    }, { timeout: 60_000 }).toBe('completed');

    const tasks = (await instance.request('GET', tasksUrl)).json;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].skillDeliveries).toMatchObject([{
      name: 'acceptance-skill',
      path: skillPath,
      source: 'workspace',
      mode: 'prompt',
      digest: createHash('sha256').update(skillBody).digest('hex')
    }]);

    await page.getByRole('button', { name: '工作目录、验证与自动化' }).click();
    const dialog = page.getByRole('dialog', { name: '工作目录与自动化' });
    await expect(dialog.getByText('Skill 投递记录')).toBeVisible();
    await dialog.getByText('VERIFY_CLAUDE_SKILL_DELIVERY · 1 项').click();
    await expect(dialog.getByText(skillPath, { exact: false })).toBeVisible();

    const projectDir = join(instance.dataDir, 'claude', 'projects');
    const transcript = readdirSync(projectDir).flatMap(project =>
      readdirSync(join(projectDir, project)).filter(file => file.endsWith('.jsonl'))
        .map(file => readFileSync(join(projectDir, project, file), 'utf8'))
    ).join('\n');
    expect(transcript).toContain('CLAUDE_SKILL_BODY_DELIVERED');
    expect(transcript).toContain('VERIFY_CLAUDE_SKILL_DELIVERY');
  } finally {
    await instance.cleanup();
  }
});
