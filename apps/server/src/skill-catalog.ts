import { parseDocument } from 'yaml';
import { RuntimeError } from '@dutydeck/shared';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PluginSkillRoot { path: string; plugin?: string; version?: string; root?: string; resources?: Record<string, Array<{ path: string; maxBytes: number }>> }

export interface SkillReference {
  ref?: string;
  plugin?: string;
  version?: string;
  root?: string;
  resources?: Array<{ path: string; maxBytes: number }>;
  name: string;
  description: string;
  path: string;
  source: 'workspace' | 'user' | 'plugin';
}

export interface DiscoverSkillsOptions {
  homeDirectory?: string;
  pluginWorkspaceRoot?: string;
  pluginRoots?: PluginSkillRoot[];
  /** 会话所属飞书机器人；限定在某个机器人的插件 skills 只对它生效。 */
  botAppId?: string;
  chatId?: string;
}

const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build']);

/** 已启用插件的 skills 根目录，由插件宿主在启动时登记；按工作区和机器人过滤。 */
export type PluginSkillRootProvider = (context: { workspaceRoot: string; botAppId?: string; chatId?: string }) => Array<string | PluginSkillRoot>;
let pluginSkillRoots: PluginSkillRootProvider = () => [];
export function setPluginSkillRoots(provider: PluginSkillRootProvider): () => void {
  pluginSkillRoots = provider;
  return () => { if (pluginSkillRoots === provider) pluginSkillRoots = () => []; };
}

/** 目录与投递共用的唯一根定义：工作区、用户目录，再加插件。 */
export function skillRoots(workspaceRoot: string, homeRoot: string, botAppId?: string, pluginWorkspaceRoot?: string, chatId?: string, providedPluginRoots?: PluginSkillRoot[]): Array<PluginSkillRoot & { source: SkillReference['source'] }> {
  return [
    { path: join(workspaceRoot, '.agents', 'skills'), source: 'workspace' },
    { path: join(workspaceRoot, '.codex', 'skills'), source: 'workspace' },
    { path: join(workspaceRoot, '.claude', 'skills'), source: 'workspace' },
    { path: join(homeRoot, '.agents', 'skills'), source: 'user' },
    { path: join(homeRoot, '.codex', 'skills'), source: 'user' },
    { path: join(homeRoot, '.claude', 'skills'), source: 'user' },
    ...(providedPluginRoots ?? pluginSkillRoots({ workspaceRoot: pluginWorkspaceRoot ?? workspaceRoot, ...(botAppId ? { botAppId } : {}), ...(chatId ? { chatId } : {}) })).map(root => ({ ...(typeof root === 'string' ? { path: root } : root), source: 'plugin' as const }))
  ];
}

export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

export function skillFrontmatter(markdown: string): { name?: string; description?: string } {
  const text = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!text) return {};
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new RuntimeError('SKILL_METADATA_INVALID', 'Invalid skill YAML frontmatter', 400);
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('SKILL_METADATA_INVALID', 'Skill metadata must be a mapping', 400);
  const metadata = value as Record<string, unknown>;
  for (const key of ['name', 'description']) if (metadata[key] !== undefined && typeof metadata[key] !== 'string') throw new RuntimeError('SKILL_METADATA_INVALID', `Skill ${key} must be text`, 400);
  return { ...(typeof metadata.name === 'string' ? { name: metadata.name.trim() } : {}), ...(typeof metadata.description === 'string' ? { description: metadata.description.trim() } : {}) };
}

export async function discoverSkills(
  workspace?: string,
  options?: DiscoverSkillsOptions
): Promise<SkillReference[]> {
  const workspaceRoot = resolve(workspace?.trim() || process.cwd());
  const homeRoot = resolve(options?.homeDirectory?.trim() || homedir());
  const roots = skillRoots(workspaceRoot, homeRoot, options?.botAppId, options?.pluginWorkspaceRoot, options?.chatId, options?.pluginRoots);

  const references = await Promise.all(roots.map(async root =>
    (await findSkillFiles(root.path)).map(path => ({ ...root, path }))
  ));
  const files = new Map<string, PluginSkillRoot & { source: SkillReference['source'] }>();
  for (const skill of references.flat()) {
    if (!files.has(skill.path)) files.set(skill.path, skill);
  }
  const uniqueSkills = await Promise.all([...files].map(async ([path, root]) => {
    const markdown = await readFile(path, 'utf8').catch(() => '');
    const metadata = skillFrontmatter(markdown);
    const id = basename(dirname(path));
    return {
      name: metadata.name || id,
      description: metadata.description ?? '',
      path,
      source: root.source,
      ...(root.plugin ? { ref: `${root.plugin}/${id}`, plugin: root.plugin, version: root.version, root: root.root, resources: root.resources?.[id] } : {})
    } satisfies SkillReference;
  }));

  const refs = new Set<string>();
  for (const skill of uniqueSkills) if (skill.ref) { if (refs.has(skill.ref)) throw new RuntimeError('SKILL_REF_DUPLICATE', `Duplicate skill reference ${skill.ref}`, 409); refs.add(skill.ref); }
  return uniqueSkills.sort((left, right) => {
    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) return nameCompare;
    if (left.source !== right.source) {
      return ({ workspace: 0, user: 1, plugin: 2 }[left.source]) - ({ workspace: 0, user: 1, plugin: 2 }[right.source]);
    }
    return left.path.localeCompare(right.path);
  });
}
