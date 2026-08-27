import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export interface SkillReference {
  name: string;
  description: string;
  path: string;
  source: 'workspace' | 'user';
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build']);

async function findSkillFiles(root: string, maxDepth = 5) {
  const found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'SKILL.md') found.push(join(directory, entry.name));
      else if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await visit(join(directory, entry.name), depth + 1);
    }
  };
  await visit(root, 0);
  return found;
}

function frontmatterValue(markdown: string, key: string) {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? '';
  const value = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? '';
  return value.replace(/^['"]|['"]$/g, '');
}

export async function discoverSkills(workspace?: string): Promise<SkillReference[]> {
  const workspaceRoot = resolve(workspace?.trim() || process.cwd());
  const roots = [
    { path: join(workspaceRoot, '.agents', 'skills'), source: 'workspace' as const },
    { path: join(workspaceRoot, '.codex', 'skills'), source: 'workspace' as const },
    { path: join(homedir(), '.agents', 'skills'), source: 'user' as const },
    { path: join(homedir(), '.codex', 'skills'), source: 'user' as const }
  ];
  const references = await Promise.all(roots.map(async root => Promise.all((await findSkillFiles(root.path)).map(async path => {
    const markdown = await readFile(path, 'utf8').catch(() => '');
    return {
      name: frontmatterValue(markdown, 'name') || basename(dirname(path)),
      description: frontmatterValue(markdown, 'description'),
      path,
      source: root.source
    } satisfies SkillReference;
  }))));
  const seen = new Set<string>();
  return references.flat().filter(skill => {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.name.localeCompare(right.name) || (left.source === 'workspace' ? -1 : 1));
}
