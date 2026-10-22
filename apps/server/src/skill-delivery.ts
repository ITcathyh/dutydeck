import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { RuntimeError, type PromptPart } from '@dutydeck/shared';
import { assemblePrompt } from './prompt-context.js';
import { discoverSkills, isPathInside, skillRoots, type SkillReference } from './skill-catalog.js';

export interface SkillDelivery {
  name: string;
  path: string;
  source: SkillReference['source'];
  digest: string;
  mode: 'prompt';
  ref?: string;
  status?: 'included' | 'replaced';
  required?: boolean;
  resources?: Array<{ path: string; digest: string }>;
  binding?: { id: string; revision: number };
}

export interface PrepareSkillPromptResult {
  agentPrompt: string;
  skillDeliveries: SkillDelivery[];
  /** Ephemeral material used to verify post-hook delivery; not stored in metadata. */
  deliveryTexts?: string[];
  promptParts?: PromptPart[];
  promptDiagnostics?: import('@dutydeck/shared').PromptSourceDiagnostics;
}

export interface PrepareSkillPromptOptions {
  homeDirectory?: string;
  pluginWorkspaceRoot?: string;
  pluginRoots?: import('./skill-catalog.js').PluginSkillRoot[];
  botAppId?: string;
  chatId?: string;
  requiredSkills?: Array<{ ref: string; binding?: { id: string; revision: number } }>;
  promptPolicyVersion?: 'legacy-v1' | 'optimized-v1';
  promptParts?: PromptPart[];
}

export interface ParsedLeadingDirectives {
  legacySkillNames: string[];
  userPrompt: string;
}

export function parseLeadingDirectives(rawPrompt: string): ParsedLeadingDirectives {
  const lines = rawPrompt.split(/\r?\n/);
  const legacySkillNames: string[] = [];
  let index = 0;

  for (; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const match = trimmed.match(/^\/skills\s+(["']?)([^\s"']+)\1$/);
    if (match) {
      legacySkillNames.push(match[2]!);
    } else {
      break;
    }
  }

  if (legacySkillNames.length === 0) {
    return {
      legacySkillNames: [],
      userPrompt: rawPrompt,
    };
  }

  const userPrompt = lines.slice(index).join('\n').trim();
  return {
    legacySkillNames,
    userPrompt,
  };
}

const MAX_SKILL_SIZE = 128 * 1024; // 128 KiB
const MAX_TOTAL_SKILL_SIZE = 512 * 1024; // 512 KiB
const MAX_SKILL_REQUESTS = 16;

export async function prepareSkillPrompt(
  cwd: string,
  prompt: string,
  skillRequests?: string[],
  options?: PrepareSkillPromptOptions
): Promise<PrepareSkillPromptResult> {
  if (skillRequests !== undefined && !Array.isArray(skillRequests)) throw new RuntimeError('INVALID_SKILL_REQUESTS', 'skillRequests must be an array', 400);
  const requested = [...new Set([...(skillRequests ?? []), ...(options?.requiredSkills ?? []).map(skill => skill.ref)])];
  const rawPrompt = typeof prompt === 'string' ? prompt : '';
  const { legacySkillNames, userPrompt } = parseLeadingDirectives(rawPrompt);

  const hasExplicitRequests = requested.length > 0;
  const hasLegacyRequests = legacySkillNames.length > 0;

  if (requested.length > MAX_SKILL_REQUESTS) {
    throw new RuntimeError('INVALID_SKILL_REQUESTS', `Maximum ${MAX_SKILL_REQUESTS} skills allowed`, 400);
  }
  for (const req of requested) {
    if (typeof req !== 'string' || !req.trim()) {
      throw new RuntimeError('INVALID_SKILL_REQUESTS', 'Invalid skill request path', 400);
    }
  }

  // No requests -> prompt unchanged & empty deliveries
  if (!hasExplicitRequests && !hasLegacyRequests) {
    return {
      agentPrompt: rawPrompt,
      skillDeliveries: [],
      ...(options?.promptParts ? { promptParts: options.promptParts, promptDiagnostics: assemblePrompt(options.promptParts, rawPrompt, options.promptPolicyVersion).diagnostics } : {}),
    };
  }

  const workspaceRoot = resolve(cwd?.trim() || process.cwd());
  const homeRoot = resolve(options?.homeDirectory?.trim() || homedir());

  const roots = skillRoots(workspaceRoot, homeRoot, options?.botAppId, options?.pluginWorkspaceRoot, options?.chatId, options?.pluginRoots);

  const canonicalRoots = (
    await Promise.all(roots.map(root => realpath(root.path).catch(() => null)))
  ).filter((r): r is string => Boolean(r));

  const catalog = await discoverSkills(workspaceRoot, { homeDirectory: homeRoot, pluginRoots: options?.pluginRoots, pluginWorkspaceRoot: options?.pluginWorkspaceRoot, chatId: options?.chatId, ...(options?.botAppId ? { botAppId: options.botAppId } : {}) });

  const matchedFromRequests: SkillReference[] = [];
  if (hasExplicitRequests) {
    for (const reqPath of requested) {
      const resolvedReq = resolve(reqPath);
      const realReq = await realpath(resolvedReq).catch(() => null);

      const matched = catalog.find(
        s => s.ref === reqPath || s.path === reqPath || s.path === resolvedReq || (realReq !== null && s.path === realReq)
      );

      if (!matched) {
        throw new RuntimeError(
          'SKILL_NOT_FOUND',
          `Skill request "${reqPath}" does not match any discovered eligible skill in catalog`,
          404
        );
      }
      matchedFromRequests.push(matched);
    }
  }

  const matchedFromLegacy: SkillReference[] = [];
  if (hasLegacyRequests) {
    for (const name of legacySkillNames) {
      const matches = catalog.filter(s => s.name === name);
      if (matches.length === 0) {
        throw new RuntimeError(
          'SKILL_NOT_FOUND',
          `Unknown skill "${name}" requested via legacy directive`,
          404
        );
      }
      if (matches.length > 1) throw new RuntimeError('SKILL_AMBIGUOUS', `Skill ${name} is ambiguous; choose ${matches.map(skill => skill.ref ?? skill.path).join(', ')}`, 409);
      const chosen = matches[0]!;
      matchedFromLegacy.push(chosen);
    }
  }

  const totalRawCount = requested.length + legacySkillNames.length;
  if (totalRawCount > MAX_SKILL_REQUESTS) {
    throw new RuntimeError('INVALID_SKILL_REQUESTS', `Maximum ${MAX_SKILL_REQUESTS} skill requests allowed`, 400);
  }

  const seenPaths = new Set<string>();
  const deduplicatedSkills: SkillReference[] = [];
  for (const skill of [...matchedFromRequests, ...matchedFromLegacy]) {
    if (seenPaths.has(skill.path)) continue;
    seenPaths.add(skill.path);
    deduplicatedSkills.push(skill);
  }

  let totalBytes = 0;
  const skillDeliveries: SkillDelivery[] = [];
  const loadedSkills: Array<{ name: string; path: string; content: string }> = [];

  for (const skill of deduplicatedSkills) {
    let handle;
    try {
      handle = await open(skill.path, 'r');
    } catch (err: any) {
      throw new RuntimeError(
        'SKILL_READ_ERROR',
        `Failed to open skill file "${skill.path}": ${err?.message || String(err)}`,
        400
      );
    }

    try {
      const fdStat = await handle.stat();
      if (!fdStat.isFile()) {
        throw new RuntimeError('INVALID_SKILL_FILE', `Skill path "${skill.path}" is not a regular file`, 400);
      }
      if (fdStat.size > MAX_SKILL_SIZE) {
        throw new RuntimeError(
          'SKILL_SIZE_EXCEEDED',
          `Skill file "${skill.path}" exceeds maximum size of 128 KiB (${fdStat.size} bytes)`,
          400
        );
      }
      if (totalBytes + fdStat.size > MAX_TOTAL_SKILL_SIZE) {
        throw new RuntimeError(
          'SKILL_SIZE_EXCEEDED',
          `Total skills size exceeds maximum limit of 512 KiB (${totalBytes + fdStat.size} bytes)`,
          400
        );
      }

      // Check for path replacement race and ancestor symlink escape
      let fdRealPath: string | null = null;
      try {
        fdRealPath = await realpath(`/proc/self/fd/${handle.fd}`);
      } catch {
        fdRealPath = null;
      }

      const diskRealPath = await realpath(skill.path).catch(() => null);
      if (!diskRealPath) {
        throw new RuntimeError('SKILL_NOT_FOUND', `Skill file "${skill.path}" could not be resolved`, 404);
      }

      const diskStat = await stat(diskRealPath).catch(() => null);
      if (diskStat && (diskStat.ino !== fdStat.ino || diskStat.dev !== fdStat.dev)) {
        throw new RuntimeError('SKILL_RACE_DETECTED', `Path replacement race detected for skill file "${skill.path}"`, 400);
      }

      const effectiveRealPath = fdRealPath || diskRealPath;

      const isInsideAllowedRoot = canonicalRoots.some(root => isPathInside(effectiveRealPath, root));
      if (!isInsideAllowedRoot) {
        throw new RuntimeError(
          'SKILL_SECURITY_VIOLATION',
          `Symlink escape detected for skill file "${effectiveRealPath}"`,
          403
        );
      }

      const buffer = await handle.readFile();
      if (buffer.length > MAX_SKILL_SIZE) {
        throw new RuntimeError(
          'SKILL_SIZE_EXCEEDED',
          `Skill file "${skill.path}" exceeds maximum size of 128 KiB (${buffer.length} bytes)`,
          400
        );
      }
      totalBytes += buffer.length;
      if (totalBytes > MAX_TOTAL_SKILL_SIZE) {
        throw new RuntimeError(
          'SKILL_SIZE_EXCEEDED',
          `Total skills size exceeds maximum limit of 512 KiB (${totalBytes} bytes)`,
          400
        );
      }

      const digest = createHash('sha256').update(buffer).digest('hex').toLowerCase();
      let content = buffer.toString('utf8');
      const resources: Array<{ path: string; digest: string }> = [];
      for (const resource of skill.resources ?? []) {
        if (!skill.root) throw new RuntimeError('SKILL_RESOURCE_INVALID', 'Resource root is missing', 400);
        const root = await realpath(skill.root);
        const path = await realpath(resolve(root, resource.path)).catch(() => { throw new RuntimeError('SKILL_RESOURCE_INVALID', `Required text resource ${resource.path} is unavailable`, 400); });
        if (!isPathInside(path, root)) throw new RuntimeError('SKILL_RESOURCE_INVALID', 'Resource escapes package', 403);
        const file = await open(path, 'r');
        try {
          const actual = await realpath(`/proc/self/fd/${file.fd}`).catch(() => realpath(path));
          const info = await file.stat();
          const disk = await stat(path);
          if (disk.ino !== info.ino || disk.dev !== info.dev) throw new RuntimeError('SKILL_RESOURCE_INVALID', 'Resource changed while opening', 400);
          if (!isPathInside(actual, root) || !info.isFile() || info.size > resource.maxBytes) throw new RuntimeError('SKILL_RESOURCE_INVALID', 'Resource is outside the package or exceeds its limit', 400);
          const bytes = await file.readFile();
          totalBytes += bytes.length;
          if (bytes.length > resource.maxBytes || totalBytes > MAX_TOTAL_SKILL_SIZE || bytes.includes(0)) throw new RuntimeError('SKILL_RESOURCE_INVALID', 'Resource is not bounded text', 400);
          let text: string;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new RuntimeError('SKILL_RESOURCE_INVALID', 'Resource must be UTF-8 text', 400); }
          resources.push({ path: resource.path, digest: createHash('sha256').update(bytes).digest('hex') });
          content += `\n\n# Reference: ${resource.path}\n${text}`;
        } finally { await file.close(); }
      }
      const required = options?.requiredSkills?.find(request => request.ref === skill.ref || request.ref === skill.path);

      skillDeliveries.push({
        name: skill.name,
        path: effectiveRealPath,
        source: skill.source,
        digest,
        mode: 'prompt',
        status: 'included',
        ...(skill.ref ? { ref: skill.ref } : {}),
        ...(required ? { required: true, ...(required.binding ? { binding: required.binding } : {}) } : {}),
        ...(resources.length ? { resources } : {}),
      });

      loadedSkills.push({
        name: skill.name,
        path: effectiveRealPath,
        content,
      });
    } finally {
      await handle.close().catch(() => {});
    }
  }

  const skillBlocks = loadedSkills.map(skill => (
    `# Skill: ${skill.name}\n` +
    `Path: ${skill.path}\n\n` +
    `${skill.content}`
  )).join('\n\n');

  const promptBody = hasLegacyRequests ? userPrompt : rawPrompt.trim();
  const agentPrompt = promptBody.length > 0
    ? `${skillBlocks}\n\n---\n\n${promptBody}`
    : skillBlocks;

  const promptParts: PromptPart[] = loadedSkills.map((skill, index) => ({
    kind: 'skill', sourceId: skill.path, digest: skillDeliveries[index]!.digest, trustScope: 'explicit_skill', complete: true,
    content: skill.content, prefix: `${index ? '\n\n' : ''}# Skill: ${skill.name}\nPath: ${skill.path}\n\n`
  }));
  if (promptBody) {
    // Leading directives/trim can change the caller's source layout; retain unknown user text intact.
    const original = options?.promptParts?.map(part => `${part.prefix ?? ''}${part.content}${part.suffix ?? ''}`).join('');
    const userParts = original === promptBody ? options!.promptParts! : [{ kind: 'user_request' as const, content: promptBody, trustScope: 'user_request' }];
    promptParts.push(...userParts.map((part, index) => ({ ...part, prefix: `${index === 0 ? '\n\n---\n\n' : ''}${part.prefix ?? ''}` })));
  }
  const assembled = assemblePrompt(promptParts, agentPrompt, options?.promptPolicyVersion);
  return { agentPrompt, skillDeliveries, deliveryTexts: loadedSkills.map(skill => skill.content), promptParts, promptDiagnostics: { ...assembled.diagnostics, afterChars: agentPrompt.length, deduplicatedParts: 0 } };
}
