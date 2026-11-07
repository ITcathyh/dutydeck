import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const packagesRoot = join(process.cwd(), 'packages');

type Manifest = { files?: string[]; exports?: unknown };
const manifests = readdirSync(packagesRoot)
  .filter(name => existsSync(join(packagesRoot, name, 'package.json')))
  .map(name => ({ name, manifest: JSON.parse(readFileSync(join(packagesRoot, name, 'package.json'), 'utf8')) as Manifest }))
  .filter(({ manifest }) => manifest.files);

const exportTargets = (value: unknown): string[] => typeof value === 'string' ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(exportTargets) : [];

// 只看 dry-run 清单，不触发 prepack 构建；dist 由 build:packages 产出，未构建时只校验源码与导出目标。
describe('工作区包发布清单', () => {
  it.each(manifests)('$name 包含每个运行时模块与导出目标，不带测试文件', async ({ name, manifest }) => {
    const root = join(packagesRoot, name);
    const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });
    const [pack] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const packed = new Set(pack!.files.map(file => file.path));
    const targets = exportTargets(manifest.exports).map(target => posix.normalize(target));
    const shipsSource = targets.some(target => target.startsWith('src/'));
    const modules = readdirSync(join(root, 'src'))
      .filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.includes('.test.'))
      .map(file => file.slice(0, -3));
    const expected = [...targets, ...modules.flatMap(module => [...(shipsSource ? [`src/${module}.ts`] : []),
      ...['js', 'js.map', 'd.ts'].map(extension => `dist/${module}.${extension}`)])].filter(path => existsSync(join(root, path)));
    expect(expected.filter(path => !packed.has(path))).toEqual([]);
    expect([...packed].filter(path => path.includes('.test.'))).toEqual([]);
  }, 60_000);
});
