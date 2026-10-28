import { constants } from 'node:fs';
import { readBoundedBytes } from './bounded-file.js';
import { parseDocument } from 'yaml';
import { RuntimeError } from '@dutydeck/shared';
import { open, opendir, realpath, stat } from 'node:fs/promises';
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
  /** Internal policy override for isolated tests; not a user setting. */
  limits?: Partial<Omit<typeof SKILL_CATALOG_LIMITS, 'concurrentReads'>>;
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

export const SKILL_CATALOG_LIMITS = { entries: 8192, candidates: 512, metadataBytes: 16 * 1024, totalBytes: 2 * 1024 * 1024, concurrentReads: 1 };
export interface SkillDiagnostic { path: string; ref?: string; code: string; message: string }
export interface SkillCatalog {
  skills: SkillReference[];
  diagnostics: SkillDiagnostic[];
  partial: boolean;
  budget: { entries: number; candidates: number; bytes: number; concurrentReads: number };
}

/** Read only a bounded metadata prefix; the delivery path validates the complete selected file. */
export async function readSkillMetadata(path: string, maxBytes = SKILL_CATALOG_LIMITS.metadataBytes, allowedRoot?: string): Promise<{ metadata: ReturnType<typeof skillFrontmatter>; bytes: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => { throw new RuntimeError('SKILL_READ_ERROR', `Failed to open skill file "${path}"`, 400); });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new RuntimeError('INVALID_SKILL_FILE', 'Skill must be a regular file', 400);
    if (allowedRoot) {
      const actual = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => realpath(path));
      const disk = await stat(path);
      if (!isPathInside(actual, allowedRoot) || info.ino !== disk.ino || info.dev !== disk.dev) throw new RuntimeError('SKILL_SECURITY_VIOLATION', 'Skill changed or escaped its registered root while opening', 403);
    }
    const buffer = await readBoundedBytes(handle, maxBytes);
    const bytesRead = buffer.length;
    const markdown = buffer.toString('utf8');
    if (/^---\r?\n/.test(markdown) && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(markdown)) {
      throw new RuntimeError('SKILL_METADATA_SIZE_EXCEEDED', 'Skill metadata is incomplete or exceeds the discovery byte limit', 400);
    }
    return { metadata: skillFrontmatter(markdown), bytes: bytesRead };
  } finally { await handle.close(); }
}

export function skillReference(path: string, root: PluginSkillRoot & { source: SkillReference['source'] }, metadata: ReturnType<typeof skillFrontmatter>): SkillReference {
  const id = basename(dirname(path));
  return { name: metadata.name || id, description: metadata.description ?? '', path, source: root.source,
    ...(root.plugin ? { ref: `${root.plugin}/${id}`, plugin: root.plugin, version: root.version, root: root.root, resources: root.resources?.[id] } : {}) };
}

/** Explicit paths may be checked after truncation, but never expand the original roots/depth/ignore policy. */
export async function skillAtPath(path: string, roots: ReturnType<typeof skillRoots>): Promise<SkillReference | undefined> {
  const canonical = await realpath(path).catch(() => undefined);
  if (!canonical || basename(path) !== 'SKILL.md') return undefined;
  for (const root of roots) {
    const canonicalRoot = await realpath(root.path).catch(() => undefined);
    if (!canonicalRoot || !isPathInside(canonical, canonicalRoot)) continue;
    const parts = relative(canonicalRoot, canonical).split(sep);
    if (parts.length > 6 || parts.slice(0, -1).some(part => ignoredDirectories.has(part))) continue;
    const { metadata } = await readSkillMetadata(canonical, SKILL_CATALOG_LIMITS.metadataBytes, canonicalRoot);
    return skillReference(canonical, root, metadata);
  }
  return undefined;
}

export function skillFrontmatter(markdown: string): { name?: string; description?: string } {
  const text = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (/^---\r?\n/.test(markdown) && text === undefined) throw new RuntimeError('SKILL_METADATA_INVALID', 'Skill YAML frontmatter is incomplete', 400);
  if (!text) return {};
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new RuntimeError('SKILL_METADATA_INVALID', 'Invalid skill YAML frontmatter', 400);
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('SKILL_METADATA_INVALID', 'Skill metadata must be a mapping', 400);
  const metadata = value as Record<string, unknown>;
  for (const key of ['name', 'description']) if (metadata[key] !== undefined && typeof metadata[key] !== 'string') throw new RuntimeError('SKILL_METADATA_INVALID', `Skill ${key} must be text`, 400);
  return { ...(typeof metadata.name === 'string' ? { name: metadata.name.trim() } : {}), ...(typeof metadata.description === 'string' ? { description: metadata.description.trim() } : {}) };
}

export async function discoverSkillCatalog(workspace?: string, options?: DiscoverSkillsOptions): Promise<SkillCatalog> {
  const workspaceRoot = resolve(workspace?.trim() || process.cwd());
  const homeRoot = resolve(options?.homeDirectory?.trim() || homedir());
  const roots = skillRoots(workspaceRoot, homeRoot, options?.botAppId, options?.pluginWorkspaceRoot, options?.chatId, options?.pluginRoots);
  const limits = { ...SKILL_CATALOG_LIMITS, ...options?.limits };
  const result: SkillCatalog = { skills: [], diagnostics: [], partial: false, budget: { entries: 0, candidates: 0, bytes: 0, concurrentReads: 1 } };
  const files = new Set<string>();
  const refs = new Set<string>();
  const visited = new Set<string>();
  const truncate = (path: string, code: string) => { result.partial = true; result.diagnostics.push({ path, code, message: 'Skill catalog is incomplete; use an explicit eligible path or reduce the directory size' }); };
  const visit = async (directory: string, root: typeof roots[number], canonicalRoot: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    const canonicalDir = await realpath(directory).catch(error => { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) truncate(directory, 'SKILL_CATALOG_UNREADABLE'); return undefined; });
    if (!canonicalDir || !isPathInside(canonicalDir, canonicalRoot) || visited.has(canonicalDir)) return;
    visited.add(canonicalDir);
    let dir;
    try { dir = await opendir(canonicalDir, { bufferSize: 32 }); }
    catch { truncate(directory, 'SKILL_CATALOG_UNREADABLE'); return; }
    for await (const entry of dir) {
      if (result.budget.entries >= limits.entries || result.budget.candidates >= limits.candidates || result.budget.bytes >= limits.totalBytes) { truncate(directory, 'SKILL_CATALOG_BUDGET_EXCEEDED'); return; }
      result.budget.entries++;
      const entryPath = join(canonicalDir, entry.name);
      if (entry.name === 'SKILL.md') {
        const path = await realpath(entryPath).catch(() => undefined);
        if (!path || !isPathInside(path, canonicalRoot) || files.has(path)) continue;
        files.add(path);
        result.budget.candidates++;
        const ref = root.plugin ? `${root.plugin}/${basename(dirname(path))}` : undefined;
        if (ref && refs.has(ref)) throw new RuntimeError('SKILL_REF_DUPLICATE', `Duplicate skill reference ${ref}`, 409);
        if (ref) refs.add(ref);
        const readLimit = Math.min(limits.metadataBytes, limits.totalBytes - result.budget.bytes);
        // Reserve the whole read allowance, including failed parses, so malformed entries cannot bypass the total budget.
        result.budget.bytes += readLimit;
        try {
          const { metadata, bytes } = await readSkillMetadata(path, readLimit, canonicalRoot);
          result.budget.bytes -= readLimit - bytes;
          result.skills.push(skillReference(path, root, metadata));
        } catch (error) {
          result.diagnostics.push({ path, ...(ref ? { ref } : {}), code: error instanceof RuntimeError ? error.code : 'SKILL_READ_ERROR', message: error instanceof RuntimeError ? error.message : 'Skill metadata could not be read' });
        }
      } else if ((entry.isDirectory() || entry.isSymbolicLink()) && !ignoredDirectories.has(entry.name)) {
        await visit(entryPath, root, canonicalRoot, depth + 1);
      }
    }
  };
  for (const root of roots) {
    if (result.budget.entries >= limits.entries || result.budget.candidates >= limits.candidates || result.budget.bytes >= limits.totalBytes) { truncate(root.path, 'SKILL_CATALOG_BUDGET_EXCEEDED'); break; }
    result.budget.entries++;
    const canonical = await realpath(root.path).catch(error => { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) truncate(root.path, 'SKILL_CATALOG_UNREADABLE'); return undefined; });
    if (canonical && (await stat(canonical).catch(() => { truncate(root.path, 'SKILL_CATALOG_UNREADABLE'); return undefined; }))?.isDirectory()) await visit(canonical, root, canonical, 0);
  }
  result.skills.sort((left, right) => left.name.localeCompare(right.name) || ({ workspace: 0, user: 1, plugin: 2 }[left.source] - { workspace: 0, user: 1, plugin: 2 }[right.source]) || left.path.localeCompare(right.path));
  return result;
}

/** Compatibility API. New consumers use discoverSkillCatalog to show diagnostics and completeness. */
export async function discoverSkills(workspace?: string, options?: DiscoverSkillsOptions): Promise<SkillReference[]> {
  return (await discoverSkillCatalog(workspace, options)).skills;
}
