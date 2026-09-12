import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface SkillReference {
  name: string;
  description: string;
  path: string;
  source: 'workspace' | 'user';
}

export interface DiscoverSkillsOptions {
  homeDirectory?: string;
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build']);

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
  const roots = [
    { path: join(workspaceRoot, '.agents', 'skills'), source: 'workspace' as const },
    { path: join(workspaceRoot, '.codex', 'skills'), source: 'workspace' as const },
    { path: join(homeRoot, '.agents', 'skills'), source: 'user' as const },
    { path: join(homeRoot, '.codex', 'skills'), source: 'user' as const }
  ];

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
