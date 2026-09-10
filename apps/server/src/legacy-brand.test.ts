import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyEnv, migrateLegacyBrandDirs } from './legacy-brand.js';

const created: string[] = [];
const workspace = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dutydeck-legacy-'));
  created.push(dir);
  return dir;
};

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true });
});

const seedLegacy = (root: string, files: string[] = []) => {
  const dir = join(root, '.dockmux');
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), file);
  return dir;
};

const seedPointer = (home: string, target: string) => {
  const dir = join(home, '.dockmux');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-daemon-dir'), `${target}\n`);
};

describe('adoptLegacyEnv', () => {
  it('把 DOCKMUX_ 前缀补成 DUTYDECK_', () => {
    const env = { DOCKMUX_PORT: '4310', DOCKMUX_HOST: '0.0.0.0', PATH: '/bin' } as NodeJS.ProcessEnv;
    expect(adoptLegacyEnv(env).sort()).toEqual(['DOCKMUX_HOST', 'DOCKMUX_PORT']);
    expect(env.DUTYDECK_PORT).toBe('4310');
    expect(env.DUTYDECK_HOST).toBe('0.0.0.0');
  });

  it('新名已设置时不覆盖，旧名不算被接管', () => {
    const env = { DOCKMUX_PORT: '4310', DUTYDECK_PORT: '4400' } as NodeJS.ProcessEnv;
    expect(adoptLegacyEnv(env)).toEqual([]);
    expect(env.DUTYDECK_PORT).toBe('4400');
  });

  it('不碰前缀不完整的同形变量', () => {
    const env = { PORT: '3000', DOCKMUXER: 'x' } as NodeJS.ProcessEnv;
    expect(adoptLegacyEnv(env)).toEqual([]);
    expect(env).toEqual({ PORT: '3000', DOCKMUXER: 'x' });
  });

  it('值里指向旧状态目录的路径一并改写（.env.example 默认就带这一条）', () => {
    const root = workspace();
    mkdirSync(join(root, '.dutydeck'));
    writeFileSync(join(root, '.dutydeck', 'dutydeck.db'), 'db');
    const env = { DOCKMUX_DATABASE_URL: './.dockmux/dockmux.db' } as NodeJS.ProcessEnv;
    adoptLegacyEnv(env, root);
    expect(env.DUTYDECK_DATABASE_URL).toBe('./.dutydeck/dutydeck.db');
  });

  it('改写后的路径不存在就保留原值，不把用户指离真实数据', () => {
    const root = workspace();
    const env = { DOCKMUX_DATABASE_URL: './.dockmux/dockmux.db' } as NodeJS.ProcessEnv;
    adoptLegacyEnv(env, root);
    expect(env.DUTYDECK_DATABASE_URL).toBe('./.dockmux/dockmux.db');
  });

  it('不改写只是名字里带 dockmux 的普通路径', () => {
    const root = workspace();
    const env = { DOCKMUX_DEFAULT_CWD: '/srv/dockmuxer/app' } as NodeJS.ProcessEnv;
    adoptLegacyEnv(env, root);
    expect(env.DUTYDECK_DEFAULT_CWD).toBe('/srv/dockmuxer/app');
  });
});

describe('migrateLegacyBrandDirs', () => {
  it('顶层 db 及其 -wal/-shm/备份一起改名', () => {
    const root = workspace();
    seedLegacy(root, ['dockmux.db', 'dockmux.db-wal', 'dockmux.db-shm', 'dockmux.db.pre-v10.bak']);
    expect(migrateLegacyBrandDirs(root, root).migrated).toEqual([join(root, '.dutydeck')]);
    expect(readdirSync(join(root, '.dutydeck')).sort()).toEqual([
      'dutydeck.db', 'dutydeck.db-shm', 'dutydeck.db-wal', 'dutydeck.db.pre-v10.bak'
    ]);
  });

  it('daemon/ 下的 pid、log、state.json 一并改名', () => {
    const root = workspace();
    const legacy = seedLegacy(root);
    mkdirSync(join(legacy, 'daemon'));
    for (const f of ['dockmux.pid', 'dockmux.log', 'dockmux.state.json']) {
      writeFileSync(join(legacy, 'daemon', f), '{}');
    }
    migrateLegacyBrandDirs(root, root);
    expect(readdirSync(join(root, '.dutydeck', 'daemon')).sort()).toEqual([
      'dutydeck.log', 'dutydeck.pid', 'dutydeck.state.json'
    ]);
  });

  it('归档目录里的旧品牌文件原样保留，不被改名', () => {
    const root = workspace();
    const legacy = seedLegacy(root, ['dockmux.db']);
    const archive = join(legacy, 'verification', 'run-1', 'before-public');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'dockmux.svg'), '<svg/>');
    mkdirSync(join(legacy, 'secrets'));
    writeFileSync(join(legacy, 'secrets', 'dockmux.key'), 'k');
    migrateLegacyBrandDirs(root, root);
    expect(readdirSync(join(root, '.dutydeck', 'verification', 'run-1', 'before-public'))).toEqual(['dockmux.svg']);
    expect(readdirSync(join(root, '.dutydeck', 'secrets'))).toEqual(['dockmux.key']);
  });

  it('新目录已存在时跳过并如实上报，不合并也不覆盖', () => {
    const root = workspace();
    seedLegacy(root, ['dockmux.db']);
    mkdirSync(join(root, '.dutydeck'));
    writeFileSync(join(root, '.dutydeck', 'dutydeck.db'), 'new');
    const result = migrateLegacyBrandDirs(root, root);
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([join(root, '.dockmux')]);
    expect(readdirSync(join(root, '.dockmux'))).toEqual(['dockmux.db']);
  });

  it('没有旧目录时什么都不做', () => {
    const root = workspace();
    expect(migrateLegacyBrandDirs(root, root)).toEqual({ migrated: [], skipped: [] });
    expect(readdirSync(root)).toEqual([]);
  });

  it('cwd 和 home 各自迁移', () => {
    const cwd = workspace();
    const home = workspace();
    seedLegacy(cwd, ['dockmux.db']);
    seedLegacy(home, ['whatever']);
    expect(migrateLegacyBrandDirs(cwd, home).migrated.sort())
      .toEqual([join(cwd, '.dutydeck'), join(home, '.dutydeck')].sort());
    expect(readdirSync(join(cwd, '.dutydeck'))).toEqual(['dutydeck.db']);
  });

  it('cwd 就是 home 时只迁一次，不重复上报', () => {
    const root = workspace();
    seedLegacy(root, ['dockmux.db']);
    expect(migrateLegacyBrandDirs(root, root).migrated).toEqual([join(root, '.dutydeck')]);
  });
});

describe('指针记录的项目目录', () => {
  it('状态目录既不在 cwd 也不在 home 时，跟着指针把它一起迁移', () => {
    const home = workspace();
    const project = workspace();
    const elsewhere = workspace();
    seedLegacy(project, ['dockmux.db']);
    mkdirSync(join(project, '.dockmux', 'daemon'), { recursive: true });
    seedPointer(home, join(project, '.dockmux', 'daemon'));

    const result = migrateLegacyBrandDirs(elsewhere, home);
    expect(result.migrated.sort()).toEqual([join(home, '.dutydeck'), join(project, '.dutydeck')].sort());
    expect(readdirSync(join(project, '.dutydeck'))).toContain('dutydeck.db');
    expect(readFileSync(join(home, '.dutydeck', 'last-daemon-dir'), 'utf8').trim())
      .toBe(join(project, '.dutydeck', 'daemon'));
  });

  it('指针指向的目录没能迁移时，宁可不改写也不指向一个不存在的路径', () => {
    const home = workspace();
    const project = workspace();
    seedLegacy(project, ['dockmux.db']);
    mkdirSync(join(project, '.dockmux', 'daemon'), { recursive: true });
    // 项目下已经有一份 .dutydeck，迁移会跳过它
    mkdirSync(join(project, '.dutydeck'));
    seedPointer(home, join(project, '.dockmux', 'daemon'));

    const result = migrateLegacyBrandDirs(workspace(), home);
    expect(result.skipped).toContain(join(project, '.dockmux'));
    expect(readFileSync(join(home, '.dutydeck', 'last-daemon-dir'), 'utf8').trim())
      .toBe(join(project, '.dockmux', 'daemon'));
  });

  it('state.json 的目录名和库文件名一起改写', () => {
    const root = workspace();
    const legacy = seedLegacy(root, ['dockmux.db']);
    mkdirSync(join(legacy, 'daemon'));
    writeFileSync(join(legacy, 'daemon', 'dockmux.state.json'), JSON.stringify({
      pid: 42, cwd: root, database: join(root, '.dockmux', 'dockmux.db')
    }));
    migrateLegacyBrandDirs(root, root);
    const state = JSON.parse(readFileSync(join(root, '.dutydeck', 'daemon', 'dutydeck.state.json'), 'utf8'));
    expect(state.database).toBe(join(root, '.dutydeck', 'dutydeck.db'));
    expect(state.cwd).toBe(root);
    expect(state.pid).toBe(42);
  });

  it('不改写与旧状态目录无关的形近路径', () => {
    const home = workspace();
    mkdirSync(join(home, '.dockmux'), { recursive: true });
    writeFileSync(join(home, '.dockmux', 'last-daemon-dir'), '/srv/dockmuxer/daemon\n');
    migrateLegacyBrandDirs(home, home);
    expect(readFileSync(join(home, '.dutydeck', 'last-daemon-dir'), 'utf8')).toBe('/srv/dockmuxer/daemon\n');
  });
});
