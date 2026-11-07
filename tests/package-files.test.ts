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

// 打包产物验证依赖构建产物，不在默认 vitest 范围内；新增的验证脚本必须挂到 verify:package，否则没人会跑。
describe('发布产物验证入口', () => {
  it('verify:package 先构建，再运行每个打包验证脚本', () => {
    const { scripts } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(scripts['verify:package']).toMatch(/^pnpm build && pnpm verify:package:run$/);
    const verifiers = [
      ...readdirSync(join(process.cwd(), 'tests')).filter(file => /^package.*\.test\.ts$/.test(file)).map(file => `tests/${file}`),
      ...readdirSync(join(process.cwd(), 'scripts')).filter(file => /^verify-.*package.*\.test\.mjs$/.test(file)).map(file => `scripts/${file}`),
      ...readdirSync(join(process.cwd(), 'apps/server/scripts')).filter(file => /^verify-.*\.mjs$/.test(file)).map(file => `apps/server/scripts/${file}`)
    ];
    expect(verifiers.length).toBeGreaterThanOrEqual(4);
    expect(verifiers.filter(path => !scripts['verify:package:run']?.split(/\s+/).includes(path))).toEqual([]);
  });
});
