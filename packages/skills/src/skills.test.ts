import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCKMUX_BUILTIN_SKILLS,
  DOCKMUX_SKILL_PREFIX,
  PLUGIN_MANIFEST_CONTENT,
  atomicWriteFile,
  builtinSkill,
  builtinSkillNames,
  installSkillsToDir,
  installSkillsToPluginDir,
  isDockmuxSkillName,
  isGlobalSkillDir,
  isSafeSkillName,
  parseSkillFrontmatter,
  removeDockmuxSkills,
  validateSkillDef,
  type SkillDef,
} from './index.js';

const dirs: string[] = [];
async function tempDir(prefix = 'dockmux-skills-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const mtimeOf = async (path: string) => (await stat(path)).mtimeMs;

describe('skill 定义的 frontmatter 契约', () => {
  it('每个内置 skill 的 frontmatter 都有 name/description，且 name 与目录名一致', () => {
    expect(DOCKMUX_BUILTIN_SKILLS.length).toBeGreaterThan(0);
    for (const skill of DOCKMUX_BUILTIN_SKILLS) {
      const frontmatter = parseSkillFrontmatter(skill.content);
      expect(frontmatter.name, `${skill.name} 缺 name`).toBe(skill.name);
      expect(frontmatter.description, `${skill.name} 缺 description`).toBeTruthy();
      expect(frontmatter.description!.length).toBeGreaterThan(20);
    }
  });

  it('每个内置 skill 名都带 dockmux- 前缀且文件系统安全', () => {
    for (const skill of DOCKMUX_BUILTIN_SKILLS) {
      expect(skill.name.startsWith(DOCKMUX_SKILL_PREFIX), skill.name).toBe(true);
      expect(isSafeSkillName(skill.name), skill.name).toBe(true);
      expect(isDockmuxSkillName(skill.name), skill.name).toBe(true);
      expect(validateSkillDef(skill)).toEqual([]);
    }
  });

  it('内置 skill 名字唯一，正文以 frontmatter 开头', () => {
    const names = builtinSkillNames();
    expect(new Set(names).size).toBe(names.length);
    for (const skill of DOCKMUX_BUILTIN_SKILLS) expect(skill.content.startsWith('---\n')).toBe(true);
  });

  it('不教 CLI 调用 dockmux 里不存在的命令', () => {
    // dockmux 没有 send/ask/schedule/report/dispatch 这些 botmux 子命令。
    // 内置 skill 里出现它们就是在教 CLI 调不通的东西。
    const forbidden = [/dockmux\s+send\b/, /dockmux\s+ask\b/, /dockmux\s+schedule\b/, /dockmux\s+report\b/, /dockmux\s+dispatch\b/, /botmux/i];
    for (const skill of DOCKMUX_BUILTIN_SKILLS) {
      for (const pattern of forbidden) {
        expect(pattern.test(skill.content), `${skill.name} 命中 ${pattern}`).toBe(false);
      }
    }
  });

  it('builtinSkill 按名解析，未知名返回 undefined', () => {
    expect(builtinSkill('dockmux-bridge-session')?.name).toBe('dockmux-bridge-session');
    expect(builtinSkill('dockmux-nope')).toBeUndefined();
  });

  it('bridge-session 讲清无人值守的核心事实', () => {
    const content = builtinSkill('dockmux-bridge-session')!.content;
    expect(content).toContain('没有人坐在这个终端前面');
    expect(content).toContain('raw_terminal');
    expect(content).toContain('.dockmux/');
  });

  it('risk-guard 明确禁止绕过拦截', () => {
    const content = builtinSkill('dockmux-risk-guard')!.content;
    expect(content).toContain('高危操作已被 Dockmux 拦截');
    expect(content).toContain('规避匹配');
    expect(content).toMatch(/不要动|禁止/);
  });
});

describe('frontmatter 解析', () => {
  it('解出 name/description，剥掉引号', () => {
    expect(parseSkillFrontmatter('---\nname: "a-b"\ndescription: \'讲点什么\'\n---\n正文')).toEqual({ name: 'a-b', description: '讲点什么' });
  });
  it('没有 frontmatter 返回空对象', () => {
    expect(parseSkillFrontmatter('# 只有正文')).toEqual({});
    expect(parseSkillFrontmatter('---\nname: x\n还没闭合')).toEqual({});
  });
});

describe('skill 名安全性', () => {
  it('拒绝路径穿越与分隔符', () => {
    for (const bad of ['../evil', 'a/b', '.', '..', '', 'a\\b', 'a b', 'dockmux-a..b', 'trailing.']) {
      expect(isSafeSkillName(bad), bad).toBe(false);
    }
  });
  it('非 dockmux- 前缀不算 dockmux skill', () => {
    expect(isDockmuxSkillName('my-skill')).toBe(false);
    expect(isDockmuxSkillName('dockmux-ok')).toBe(true);
  });
  it('validateSkillDef 报出前缀/名字不一致/缺字段', () => {
    expect(validateSkillDef({ name: 'nope', content: '---\nname: nope\ndescription: d\n---\n' }).join()).toContain('dockmux-');
    expect(validateSkillDef({ name: 'dockmux-a', content: '---\nname: dockmux-b\ndescription: d\n---\n' }).join()).toContain('不一致');
    expect(validateSkillDef({ name: 'dockmux-a', content: '---\nname: dockmux-a\n---\n' }).join()).toContain('description');
  });
});

describe('installSkillsToDir', () => {
  it('写出 <dir>/<name>/SKILL.md，内容与定义逐字相同', async () => {
    const dir = await tempDir();
    const result = await installSkillsToDir(dir);
    expect(result.written.length).toBe(DOCKMUX_BUILTIN_SKILLS.length);
    expect(result.skipped).toEqual([]);
    for (const skill of DOCKMUX_BUILTIN_SKILLS) {
      expect(await readFile(join(dir, skill.name, 'SKILL.md'), 'utf8')).toBe(skill.content);
    }
  });

  it('幂等：第二次全部跳过，文件 mtime 不变', async () => {
    const dir = await tempDir();
    await installSkillsToDir(dir);
    const target = join(dir, 'dockmux-bridge-session', 'SKILL.md');
    const before = await mtimeOf(target);
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await installSkillsToDir(dir);
    expect(second.written).toEqual([]);
    expect(second.skipped.length).toBe(DOCKMUX_BUILTIN_SKILLS.length);
    expect(await mtimeOf(target)).toBe(before);
  });

  it('内容漂移时重写回定义内容', async () => {
    const dir = await tempDir();
    await installSkillsToDir(dir);
    const target = join(dir, 'dockmux-bridge-session', 'SKILL.md');
    await writeFile(target, '被改坏了');
    const result = await installSkillsToDir(dir);
    expect(result.written).toContain(target);
    expect(await readFile(target, 'utf8')).toBe(builtinSkill('dockmux-bridge-session')!.content);
  });

  it('命名空间隔离：只写 dockmux- 前缀目录，用户 skill 原样保留', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'my-own-skill'), { recursive: true });
    await writeFile(join(dir, 'my-own-skill', 'SKILL.md'), '用户自己的');
    await installSkillsToDir(dir);
    const entries = (await readdir(dir)).sort();
    expect(entries.filter(name => name !== 'my-own-skill').every(isDockmuxSkillName)).toBe(true);
    expect(await readFile(join(dir, 'my-own-skill', 'SKILL.md'), 'utf8')).toBe('用户自己的');
  });

  it('清理陈旧的 dockmux- 目录，但不碰用户目录与文件', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'dockmux-retired'), { recursive: true });
    await writeFile(join(dir, 'dockmux-retired', 'SKILL.md'), '上个版本的');
    await mkdir(join(dir, 'user-skill'), { recursive: true });
    await writeFile(join(dir, 'dockmux-notes.txt'), '文件不是目录，不该删');

    const result = await installSkillsToDir(dir);
    expect(result.removed).toEqual([join(dir, 'dockmux-retired')]);
    expect(await readdir(dir)).not.toContain('dockmux-retired');
    expect(await readdir(dir)).toContain('user-skill');
    expect(await readFile(join(dir, 'dockmux-notes.txt'), 'utf8')).toBe('文件不是目录，不该删');
  });

  it('pruneStale:false 时保留陈旧目录', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'dockmux-retired'), { recursive: true });
    const result = await installSkillsToDir(dir, { pruneStale: false });
    expect(result.removed).toEqual([]);
    expect(await readdir(dir)).toContain('dockmux-retired');
  });

  it('自定义 skill 集必须过校验，非法定义直接抛错且不写盘', async () => {
    const dir = await tempDir();
    const bad: SkillDef = { name: 'not-prefixed', content: '---\nname: not-prefixed\ndescription: d\n---\n' };
    await expect(installSkillsToDir(dir, { skills: [bad] })).rejects.toThrow(/dockmux-/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('重名定义被拒', async () => {
    const dir = await tempDir();
    const one: SkillDef = { name: 'dockmux-x', content: '---\nname: dockmux-x\ndescription: d\n---\n' };
    await expect(installSkillsToDir(dir, { skills: [one, one] })).rejects.toThrow(/重复/);
  });
});

describe('installSkillsToPluginDir', () => {
  it('写出 .claude-plugin/plugin.json + skills/<name>/SKILL.md', async () => {
    const dir = await tempDir();
    await installSkillsToPluginDir(dir);

    const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.name).toBe('dockmux');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.author).toEqual({ name: 'dockmux' });
    expect(manifest.description).toContain('不写入用户全局');
    expect(await readFile(manifestPath, 'utf8')).toBe(PLUGIN_MANIFEST_CONTENT);

    for (const skill of DOCKMUX_BUILTIN_SKILLS) {
      expect(await readFile(join(dir, 'skills', skill.name, 'SKILL.md'), 'utf8')).toBe(skill.content);
    }
    // 顶层只有清单目录和 skills/，没有别的散落文件
    expect((await readdir(dir)).sort()).toEqual(['.claude-plugin', 'skills']);
  });

  it('幂等：第二次不写任何文件，清单 mtime 不变', async () => {
    const dir = await tempDir();
    const first = await installSkillsToPluginDir(dir);
    expect(first.written.length).toBe(DOCKMUX_BUILTIN_SKILLS.length + 1);
    const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
    const before = await mtimeOf(manifestPath);
    await new Promise(resolve => setTimeout(resolve, 20));

    const second = await installSkillsToPluginDir(dir);
    expect(second.written).toEqual([]);
    expect(second.skipped.length).toBe(DOCKMUX_BUILTIN_SKILLS.length + 1);
    expect(await mtimeOf(manifestPath)).toBe(before);
  });

  it('清单被改坏时重写', async () => {
    const dir = await tempDir();
    await installSkillsToPluginDir(dir);
    const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
    await writeFile(manifestPath, '{}');
    const result = await installSkillsToPluginDir(dir);
    expect(result.written).toContain(manifestPath);
    expect(await readFile(manifestPath, 'utf8')).toBe(PLUGIN_MANIFEST_CONTENT);
  });

  it('陈旧 skill 在 skills/ 子目录下被清理', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'skills', 'dockmux-old'), { recursive: true });
    const result = await installSkillsToPluginDir(dir);
    expect(result.removed).toEqual([join(dir, 'skills', 'dockmux-old')]);
  });
});

describe('全局目录隔离', () => {
  it('识别已知的用户全局 skill 目录', () => {
    expect(isGlobalSkillDir(join(homedir(), '.claude', 'skills'))).toBe(true);
    expect(isGlobalSkillDir(join(homedir(), '.claude', 'skills', 'nested'))).toBe(true);
    expect(isGlobalSkillDir('~/.codex/skills')).toBe(true);
    expect(isGlobalSkillDir(join(homedir(), '.agents', 'skills'))).toBe(true);
    expect(isGlobalSkillDir(join(tmpdir(), 'session-plugin'))).toBe(false);
    // 前缀相近但不是同一目录，不能误判
    expect(isGlobalSkillDir(join(homedir(), '.claude', 'skills-backup'))).toBe(false);
  });

  it('默认拒绝写入全局目录（两种投递形态都拒绝）', async () => {
    // 同样用假 HOME：这两个断言在实现回归时会真的写盘，不能让它落在开发者的 ~ 下。
    const fakeHome = await tempDir('dockmux-guard-home-');
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const global = join(fakeHome, '.claude', 'skills');
      await expect(installSkillsToDir(global)).rejects.toThrow(/全局目录/);
      await expect(installSkillsToPluginDir(global)).rejects.toThrow(/全局目录/);
      expect(existsSync(join(global, DOCKMUX_BUILTIN_SKILLS[0]!.name))).toBe(false);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it('拒绝父目录形态：pluginDir 本身不是全局目录，但拼出的 skills 子目录是', async () => {
    // installSkillsToPluginDir 写的是 `<pluginDir>/skills/<name>/SKILL.md`。
    // 只校验入参会漏掉这一路：`~/.claude` 不在名单里，但它拼出来的
    // `~/.claude/skills` 正是要防的全局目录。
    //
    // 这条测试必须 hermetic：断言的是「拒绝写入」，一旦实现有回归它就会**真的写盘**。
    // 用假 HOME 让 homedir() 改指临时目录，回归时污染的是临时目录而不是开发者的 ~。
    const fakeHome = await tempDir('dockmux-guard-home-');
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await expect(installSkillsToPluginDir(join(fakeHome, '.claude'))).rejects.toThrow(/全局目录/);
      // 确实没写进 <home>/.claude/skills
      expect(existsSync(join(fakeHome, '.claude', 'skills', DOCKMUX_BUILTIN_SKILLS[0]!.name))).toBe(false);
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
    }
  });

  it('拒绝的原因确实是「全局目录」而非通用失败：同名布局放在非 home 下就能写入', async () => {
    const fakeHome = await tempDir('dockmux-fakehome-');
    // 同样是 `<root>/.claude/skills` 布局，但不在真实 homedir 下 —— 应当放行。
    // 这条与上一条构成对照，证明拦截是按 home 前缀判定的。
    const ok = await installSkillsToDir(join(fakeHome, '.claude', 'skills'));
    expect(ok.written.length).toBe(DOCKMUX_BUILTIN_SKILLS.length);
  });

  it('显式 allowGlobalDir 才放行', async () => {
    const dir = await tempDir();
    // 用真实临时目录验证开关本身可用（不往用户真 home 写任何东西）
    const result = await installSkillsToDir(dir, { allowGlobalDir: true });
    expect(result.written.length).toBe(DOCKMUX_BUILTIN_SKILLS.length);
  });
});

describe('removeDockmuxSkills', () => {
  it('只删 dockmux- 目录，保留用户内容', async () => {
    const dir = await tempDir();
    await installSkillsToDir(dir);
    await mkdir(join(dir, 'user-skill'), { recursive: true });

    const removed = await removeDockmuxSkills(dir);
    expect(removed.length).toBe(DOCKMUX_BUILTIN_SKILLS.length);
    expect(await readdir(dir)).toEqual(['user-skill']);
  });

  it('目录不存在时是 no-op', async () => {
    expect(await removeDockmuxSkills(join(tmpdir(), 'dockmux-does-not-exist-xyz'))).toEqual([]);
  });
});

describe('atomicWriteFile', () => {
  it('创建父目录并写入', async () => {
    const dir = await tempDir();
    const target = join(dir, 'a', 'b', 'SKILL.md');
    await atomicWriteFile(target, '内容');
    expect(await readFile(target, 'utf8')).toBe('内容');
  });

  it('覆盖写不留临时文件', async () => {
    const dir = await tempDir();
    const target = join(dir, 'f.md');
    await atomicWriteFile(target, '第一版');
    await atomicWriteFile(target, '第二版');
    expect(await readFile(target, 'utf8')).toBe('第二版');
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(await readdir(dir)).toEqual(['f.md']);
  });

  it('写失败时清掉临时文件，且不留下半个目标文件', async () => {
    const dir = await tempDir();
    const readonly = join(dir, 'ro');
    await mkdir(readonly);
    await chmod(readonly, 0o500); // 不可写：临时文件都建不出来
    try {
      await expect(atomicWriteFile(join(readonly, 'SKILL.md'), '内容')).rejects.toThrow();
      expect(await readdir(readonly)).toEqual([]);
    } finally {
      await chmod(readonly, 0o700);
    }
  });

  it('目标已存在时内容被整体替换，不会出现拼接残留', async () => {
    const dir = await tempDir();
    const target = join(dir, 'f.md');
    await atomicWriteFile(target, '很长很长的第一版内容内容内容');
    await atomicWriteFile(target, '短');
    expect(await readFile(target, 'utf8')).toBe('短');
  });

  it('并发写同一文件：结果是某一次的完整内容，且无临时文件残留', async () => {
    const dir = await tempDir();
    const target = join(dir, 'f.md');
    const contents = Array.from({ length: 12 }, (_, index) => `完整内容-${index}`);
    await Promise.all(contents.map(content => atomicWriteFile(target, content)));
    expect(contents).toContain(await readFile(target, 'utf8'));
    expect(await readdir(dir)).toEqual(['f.md']);
  });

  it('支持自定义 mode', async () => {
    const dir = await tempDir();
    const target = join(dir, 'f.md');
    await atomicWriteFile(target, 'x', 0o600);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });
});

describe('投递产物能被 dockmux 自己的发现逻辑读出来', () => {
  it('写出的 SKILL.md 用 skill-catalog 的同款 frontmatter 规则可解析', async () => {
    const dir = await tempDir();
    await installSkillsToDir(dir);
    for (const name of builtinSkillNames()) {
      const markdown = await readFile(join(dir, name, 'SKILL.md'), 'utf8');
      // 与 apps/server/src/skill-catalog.ts 的 frontmatterValue 同一套正则
      const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? '';
      const value = (key: string) => (frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '').replace(/^['"]|['"]$/g, '');
      expect(value('name')).toBe(name);
      expect(value('description')).not.toBe('');
    }
  });
});
