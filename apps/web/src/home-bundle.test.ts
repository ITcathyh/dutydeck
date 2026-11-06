import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const sourceRoot = dirname(fileURLToPath(import.meta.url));
// 只认静态 import/export ... from；`import('./x')` 是懒加载，不进首页。
const staticImport = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

function resolveLocal(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  return ['', '.ts', '.tsx', '/index.ts', '/index.tsx'].map(suffix => `${base}${suffix}`).find(path => existsSync(path) && /\.tsx?$/.test(path));
}

/** 从入口出发沿静态 import 走到的本地文件，以及它们直接引用的第三方包。 */
function staticClosure(entry: string) {
  const files = new Set<string>(); const packages = new Map<string, string>();
  const pending = [resolve(sourceRoot, entry)];
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(staticImport)) {
      if (specifier!.startsWith('.')) { const next = resolveLocal(file, specifier!); if (next) pending.push(next); }
      else packages.set(specifier!, file.slice(sourceRoot.length + 1));
    }
  }
  return { files: [...files].map(file => file.slice(sourceRoot.length + 1)), packages };
}

it('keeps Markdown rendering and syntax highlighting out of the workspace home page', () => {
  // 首页 = main.tsx 加上它动态载入的 App.tsx；会话时间线（TimelineView）另行懒加载并自带渲染器。
  for (const entry of ['main.tsx', 'App.tsx']) {
    const { files, packages } = staticClosure(entry);
    expect(files, `${entry} statically reaches MarkdownContent`).not.toContain('MarkdownContent.tsx');
    for (const name of ['react-markdown', 'remark-gfm', 'remark-cjk-friendly', 'prism-react-renderer']) expect(packages.get(name), `${entry} statically imports ${name}`).toBeUndefined();
  }
  // 反向对照：确认遍历本身能找到渲染器，避免正则失效后测试空转。
  expect(staticClosure('components/TimelineView.tsx').packages.has('react-markdown')).toBe(true);
});
