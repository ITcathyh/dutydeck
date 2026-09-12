import { open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RuntimeError } from '@dutydeck/shared';
import { discoverSkills, isPathInside, type DiscoverSkillsOptions, type SkillReference } from './skill-catalog.js';

export interface SkillDelivery {
  name: string;
  path: string;
  source: 'workspace' | 'user';
  digest: string;
  mode: 'prompt';
}

export interface PrepareSkillPromptResult {
  agentPrompt: string;
  skillDeliveries: SkillDelivery[];
}

export interface PrepareSkillPromptOptions {
  homeDirectory?: string;
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
  const rawPrompt = typeof prompt === 'string' ? prompt : '';
  const { legacySkillNames, userPrompt } = parseLeadingDirectives(rawPrompt);

  const hasExplicitRequests = Array.isArray(skillRequests) && skillRequests.length > 0;
  const hasLegacyRequests = legacySkillNames.length > 0;

  if (skillRequests !== undefined) {
    if (!Array.isArray(skillRequests)) {
      throw new RuntimeError('INVALID_SKILL_REQUESTS', 'skillRequests must be an array', 400);
    }
    if (skillRequests.length > MAX_SKILL_REQUESTS) {
      throw new RuntimeError('INVALID_SKILL_REQUESTS', `Maximum ${MAX_SKILL_REQUESTS} skills allowed`, 400);
    }
    for (const req of skillRequests) {
      if (typeof req !== 'string' || !req.trim()) {
        throw new RuntimeError('INVALID_SKILL_REQUESTS', 'Invalid skill request path', 400);
      }
    }
  }

  // No requests -> prompt unchanged & empty deliveries
  if (!hasExplicitRequests && !hasLegacyRequests) {
    return {
      agentPrompt: rawPrompt,
      skillDeliveries: [],
    };
  }

  const workspaceRoot = resolve(cwd?.trim() || process.cwd());
  const homeRoot = resolve(options?.homeDirectory?.trim() || homedir());

  const roots = [
    join(workspaceRoot, '.agents', 'skills'),
    join(workspaceRoot, '.codex', 'skills'),
    join(homeRoot, '.agents', 'skills'),
    join(homeRoot, '.codex', 'skills'),
  ];

  const canonicalRoots = (
    await Promise.all(roots.map(r => realpath(r).catch(() => null)))
  ).filter((r): r is string => Boolean(r));

  const catalog = await discoverSkills(workspaceRoot, { homeDirectory: homeRoot });

  const matchedFromRequests: SkillReference[] = [];
  if (hasExplicitRequests) {
    for (const reqPath of skillRequests!) {
      const resolvedReq = resolve(reqPath);
      const realReq = await realpath(resolvedReq).catch(() => null);

      const matched = catalog.find(
        s => s.path === reqPath || s.path === resolvedReq || (realReq !== null && s.path === realReq)
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
      // Workspace precedence for legacy directive resolution
      const chosen = matches.find(s => s.source === 'workspace') ?? matches[0]!;
      matchedFromLegacy.push(chosen);
    }
  }

  const totalRawCount = (skillRequests?.length ?? 0) + legacySkillNames.length;
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

  if (deduplicatedSkills.length > MAX_SKILL_REQUESTS) {
    throw new RuntimeError('INVALID_SKILL_REQUESTS', `Maximum ${MAX_SKILL_REQUESTS} skills allowed`, 400);
  }

  if (deduplicatedSkills.length === 0) {
    return {
      agentPrompt: rawPrompt,
      skillDeliveries: [],
    };
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
      const content = buffer.toString('utf8');

      skillDeliveries.push({
        name: skill.name,
        path: effectiveRealPath,
        source: skill.source,
        digest,
        mode: 'prompt',
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

  return {
    agentPrompt,
    skillDeliveries,
  };
}
