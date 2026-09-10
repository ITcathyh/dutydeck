import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLegacyEnv, migrateLegacyBrandDirs } from './legacy-brand.js';

const workspace = () => mkdtempSync(join(tmpdir(), 'dutydeck-legacy-'));

const seedLegacy = (root: string, files: string[] = []) => {
  const dir = join(root, '.dockmux');
  mkdirSync(dir, { recursive: true });
  for (const file of files) writeFileSync(join(dir, file), file);
  return dir;
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
});

describe('migrateLegacyBrandDirs', () => {
  it('顶层 db 及其 -wal/-shm/备份一起改名', () => {
    const root = workspace();
    seedLegacy(root, ['dockmux.db', 'dockmux.db-wal', 'dockmux.db-shm', 'dockmux.db.pre-v10.bak']);
    expect(migrateLegacyBrandDirs(root, root)).toEqual([join(root, '.dutydeck')]);
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

  it('保留子目录本身的名字', () => {
    const root = workspace();
    const legacy = seedLegacy(root, ['dockmux.db']);
    mkdirSync(join(legacy, 'secrets'));
    mkdirSync(join(legacy, 'daemon'));
    migrateLegacyBrandDirs(root, root);
    expect(readdirSync(join(root, '.dutydeck')).sort()).toEqual(['daemon', 'dutydeck.db', 'secrets']);
  });

  it('新目录已存在时整体跳过，不合并也不覆盖', () => {
    const root = workspace();
    seedLegacy(root, ['dockmux.db']);
    mkdirSync(join(root, '.dutydeck'));
    writeFileSync(join(root, '.dutydeck', 'dutydeck.db'), 'new');
    expect(migrateLegacyBrandDirs(root, root)).toEqual([]);
    expect(readdirSync(join(root, '.dockmux'))).toEqual(['dockmux.db']);
  });

  it('没有旧目录时什么都不做', () => {
    const root = workspace();
    expect(migrateLegacyBrandDirs(root, root)).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it('cwd 和 home 各自迁移', () => {
    const cwd = workspace();
    const home = workspace();
    seedLegacy(cwd, ['dockmux.db']);
    seedLegacy(home, ['last-daemon-dir']);
    expect(migrateLegacyBrandDirs(cwd, home).sort())
      .toEqual([join(cwd, '.dutydeck'), join(home, '.dutydeck')].sort());
    expect(readdirSync(join(cwd, '.dutydeck'))).toEqual(['dutydeck.db']);
    expect(readdirSync(join(home, '.dutydeck'))).toEqual(['last-daemon-dir']);
  });

  it('cwd 就是 home 时只迁一次，不重复上报', () => {
    const root = workspace();
    seedLegacy(root, ['dockmux.db']);
    expect(migrateLegacyBrandDirs(root, root)).toEqual([join(root, '.dutydeck')]);
  });
});

describe('迁移后改写仍指向旧位置的绝对路径', () => {
  it('last-daemon-dir 指向迁移后的目录', () => {
    const root = workspace();
    const legacy = seedLegacy(root);
    writeFileSync(join(legacy, 'last-daemon-dir'), '/srv/app/.dockmux/daemon\n');
    migrateLegacyBrandDirs(root, root);
    expect(readFileSync(join(root, '.dutydeck', 'last-daemon-dir'), 'utf8'))
      .toBe('/srv/app/.dutydeck/daemon\n');
  });

  it('state.json 的目录名和库文件名一起改写', () => {
    const root = workspace();
    const legacy = seedLegacy(root);
    mkdirSync(join(legacy, 'daemon'));
    writeFileSync(join(legacy, 'daemon', 'dockmux.state.json'), JSON.stringify({
      pid: 42, cwd: '/srv/app', database: '/srv/app/.dockmux/dockmux.db'
    }));
    migrateLegacyBrandDirs(root, root);
    const state = JSON.parse(readFileSync(join(root, '.dutydeck', 'daemon', 'dutydeck.state.json'), 'utf8'));
    expect(state.database).toBe('/srv/app/.dutydeck/dutydeck.db');
    expect(state.cwd).toBe('/srv/app');
    expect(state.pid).toBe(42);
  });

  it('不改写与旧目录无关的相似路径', () => {
    const root = workspace();
    const legacy = seedLegacy(root);
    writeFileSync(join(legacy, 'last-daemon-dir'), '/srv/dockmuxer/daemon\n');
    migrateLegacyBrandDirs(root, root);
    expect(readFileSync(join(root, '.dutydeck', 'last-daemon-dir'), 'utf8'))
      .toBe('/srv/dockmuxer/daemon\n');
  });
});
