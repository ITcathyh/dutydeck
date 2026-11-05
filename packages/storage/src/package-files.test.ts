import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('@dutydeck/storage 发布清单', () => {
  it('包含每个运行时模块的源码与构建产物，不带测试文件', () => {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })) as Array<{ files: Array<{ path: string }> }>;
    const packed = new Set(pack!.files.map(file => file.path));
    const modules = readdirSync(join(root, 'src')).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => name.slice(0, -3));
    const expected = modules.flatMap(name => [`src/${name}.ts`,
      ...['js', 'js.map', 'd.ts'].map(extension => `dist/${name}.${extension}`).filter(path => existsSync(join(root, path)))]);
    expect(expected.filter(path => !packed.has(path))).toEqual([]);
    expect([...packed].filter(path => path.includes('.test.'))).toEqual([]);
  });
});
