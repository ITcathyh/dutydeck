import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface SkillReference {
  name: string;
  description: string;
  path: string;
  source: 'workspace' | 'user' | 'plugin';
}

export interface DiscoverSkillsOptions {
  homeDirectory?: string;
  /** 会话所属飞书机器人；限定在某个机器人的插件 skills 只对它生效。 */
  botAppId?: string;
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build']);

/** 已启用插件的 skills 根目录，由插件宿主在启动时登记；按工作区和机器人过滤。 */
export type PluginSkillRootProvider = (context: { workspaceRoot: string; botAppId?: string }) => string[];
let pluginSkillRoots: PluginSkillRootProvider = () => [];
export function setPluginSkillRoots(provider: PluginSkillRootProvider): () => void {
  pluginSkillRoots = provider;
  return () => { if (pluginSkillRoots === provider) pluginSkillRoots = () => []; };
}

/** 目录与投递共用的唯一根定义：工作区、用户目录，再加插件。 */
export function skillRoots(workspaceRoot: string, homeRoot: string, botAppId?: string): Array<{ path: string; source: SkillReference['source'] }> {
  return [
    { path: join(workspaceRoot, '.agents', 'skills'), source: 'workspace' },
    { path: join(workspaceRoot, '.codex', 'skills'), source: 'workspace' },
    { path: join(workspaceRoot, '.claude', 'skills'), source: 'workspace' },
    { path: join(homeRoot, '.agents', 'skills'), source: 'user' },
    { path: join(homeRoot, '.codex', 'skills'), source: 'user' },
    { path: join(homeRoot, '.claude', 'skills'), source: 'user' },
    ...pluginSkillRoots({ workspaceRoot, ...(botAppId ? { botAppId } : {}) }).map(path => ({ path, source: 'plugin' as const }))
  ];
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function findSkillFiles(rootPath: string, maxDepth = 5): Promise<string[]> {
  const canonicalRoot = await realpath(rootPath).catch(() => null);
  if (!canonicalRoot) return [];
  const rootStat = await stat(canonicalRoot).catch(() => null);
  if (!rootStat?.isDirectory()) return [];

  const found: string[] = [];
  const visitedCanonicalDirs = new Set<string>();

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const canonicalDir = await realpath(directory).catch(() => null);
    if (!canonicalDir) return;
    // Do not crawl directories outside registered root
    if (!isPathInside(canonicalDir, canonicalRoot)) return;
    if (visitedCanonicalDirs.has(canonicalDir)) return;
    visitedCanonicalDirs.add(canonicalDir);

    let entries;
    try {
      entries = await readdir(canonicalDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = join(canonicalDir, entry.name);
      if (entry.name === 'SKILL.md') {
        const canonicalFile = await realpath(entryPath).catch(() => null);
        if (!canonicalFile) continue;
        if (!isPathInside(canonicalFile, canonicalRoot)) continue;
        const fileStat = await stat(canonicalFile).catch(() => null);
        if (!fileStat?.isFile()) continue;
        found.push(canonicalFile);
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(entryPath, depth + 1);
        }
      }
    }
  };

  await visit(canonicalRoot, 0);
  return found;
}

function frontmatterValue(markdown: string, key: string): string {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
  return value.replace(/^['"]|['"]$/g, '');
}

export async function discoverSkills(
  workspace?: string,
  options?: DiscoverSkillsOptions
): Promise<SkillReference[]> {
  const workspaceRoot = resolve(workspace?.trim() || process.cwd());
  const homeRoot = resolve(options?.homeDirectory?.trim() || homedir());
  const roots = skillRoots(workspaceRoot, homeRoot, options?.botAppId);

  const references = await Promise.all(
    roots.map(async root => {
      const files = await findSkillFiles(root.path);
      return Promise.all(
        files.map(async filePath => {
          const markdown = await readFile(filePath, 'utf8').catch(() => '');
          return {
            name: frontmatterValue(markdown, 'name') || basename(dirname(filePath)),
            description: frontmatterValue(markdown, 'description'),
            path: filePath,
            source: root.source
          } satisfies SkillReference;
        })
      );
    })
  );

  const seenPaths = new Set<string>();
  const uniqueSkills: SkillReference[] = [];
  for (const skill of references.flat()) {
    if (seenPaths.has(skill.path)) continue;
    seenPaths.add(skill.path);
    uniqueSkills.push(skill);
  }

  return uniqueSkills.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) return nameCompare;
    if (left.source !== right.source) {
      return left.source === 'workspace' ? -1 : 1;
    }
    return left.path.localeCompare(right.path);
  });
}
