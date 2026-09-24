/**
 * 工作区整理分组：纯展示配置，与 session 的 cwd / worktree / runtime 完全隔离。
 * 解析逻辑只有这一份，api / web / server / CLI 共用，避免语义漂移。
 */

export interface WorkspaceOrganizationGroup {
  id: string;
  name: string;
}

export interface WorkspaceOrganization {
  /** 用户自定义组；自动目录组不在此列，按目录即时聚合。 */
  groups: WorkspaceOrganizationGroup[];
  /** 规范化源目录 -> 自定义组 id。未来同目录新任务自动继承。 */
  directoryGroups: Record<string, string>;
  /** session id -> 自定义组 id。单任务覆盖，优先于目录规则。 */
  sessionGroups: Record<string, string>;
}

export interface WorkspaceGroupSummary {
  /** 自定义组为 wg_<uuid>；自动目录组为规范化完整目录路径。 */
  id: string;
  name: string;
  /** 命中该组的目录：自定义组含目录规则绑定的目录与成员实际源目录。 */
  directories: string[];
  sessionIds: string[];
  /** false = 按目录自动生成的组。 */
  custom: boolean;
}

export interface WorkspaceOrganizationSnapshot {
  organization: WorkspaceOrganization;
  workspaces: WorkspaceGroupSummary[];
  createdGroupId?: string;
}

export const WORKSPACE_GROUP_NAME_MAX_LENGTH = 80;

export function emptyWorkspaceOrganization(): WorkspaceOrganization {
  return { groups: [], directoryGroups: {}, sessionGroups: {} };
}

/** 只 trim 与去尾斜杠（POSIX 根 `/`、Windows 盘根 `C:\` 均保留），不做任何磁盘操作。 */
export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  // Windows 盘根 C:\ 或 C:/（含多个尾分隔符）统一规范成 C:\：
  // 直接去尾分隔符会退化成 C:，被目录校验误判为相对路径；两种写法也必须归一，
  // 否则同一盘根的 session 源目录与目录规则会得到不同的 key。
  const driveRoot = /^([a-zA-Z]:)[\\/]+$/.exec(trimmed);
  if (driveRoot) return `${driveRoot[1]}\\`;
  const stripped = trimmed.replace(/[\\/]+$/, '');
  return stripped || trimmed;
}

export function workspaceName(cwd: string): string {
  const normalized = normalizeWorkspacePath(cwd);
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || cwd || '未命名工作区';
}

/**
 * Session 的项目源目录：worktree 任务优先取 workspaceSourceCwd（其所基于的源仓库目录），
 * 兜底取 cwd（共享工作区或旧 session）。
 */
export function sessionWorkspaceDirectory(session: { cwd: string; workspaceSourceCwd?: string }): string {
  const raw = session.workspaceSourceCwd?.trim() || session.cwd;
  return normalizeWorkspacePath(raw);
}

export function createWorkspaceGroupId(): string {
  return `wg_${crypto.randomUUID()}`;
}

/** trim 后 1..80；非法抛 Error，调用方负责转成 400。 */
export function normalizeWorkspaceGroupName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('组名不能为空');
  if (trimmed.length > WORKSPACE_GROUP_NAME_MAX_LENGTH) throw new Error(`组名最长 ${WORKSPACE_GROUP_NAME_MAX_LENGTH} 个字符`);
  return trimmed;
}

/** 服务端目录入参校验：规范化后必须是绝对路径（POSIX 或 Windows 盘符）。 */
export function normalizeWorkspaceDirectoryInput(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  if (!/^(?:\/|[a-zA-Z]:[\\/])/.test(normalized)) throw new Error('目录必须是绝对路径');
  return normalized;
}

function hasMapping(record: Record<string, string>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function isPlainOrganization(value: unknown): value is WorkspaceOrganization {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.groups)
    && typeof candidate.directoryGroups === 'object' && candidate.directoryGroups !== null
    && typeof candidate.sessionGroups === 'object' && candidate.sessionGroups !== null;
}

/** 容错读取持久化配置：结构缺失或 JSON 损坏时回退空配置；record 访问一律走 hasOwn 防 prototype 键。 */
export function parseWorkspaceOrganization(raw: string | undefined): WorkspaceOrganization {
  if (!raw) return emptyWorkspaceOrganization();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyWorkspaceOrganization();
  }
  if (!isPlainOrganization(parsed)) return emptyWorkspaceOrganization();
  const isGroup = (value: unknown): value is WorkspaceOrganizationGroup => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as { id?: unknown; name?: unknown };
    return typeof candidate.id === 'string' && typeof candidate.name === 'string';
  };
  const groups = parsed.groups.filter(isGroup);
  const validIds = new Set(groups.map(group => group.id));
  const sanitize = (record: Record<string, unknown>): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === 'string' && validIds.has(value)) result[key] = value;
    }
    return result;
  };
  return {
    groups,
    directoryGroups: sanitize(parsed.directoryGroups as Record<string, unknown>),
    sessionGroups: sanitize(parsed.sessionGroups as Record<string, unknown>)
  };
}

export interface WorkspaceOrganizationSession {
  id: string;
  cwd: string;
  workspaceSourceCwd?: string;
}

/**
 * 解析单个任务的有效自定义组 id：单任务覆盖 > 目录规则 > undefined（回自动目录组）。
 * 指向已删除组的映射视为无效，按未配置处理。
 */
export function resolveWorkspaceGroupId(session: WorkspaceOrganizationSession, organization: WorkspaceOrganization): string | undefined {
  const validIds = new Set(organization.groups.map(group => group.id));
  if (hasMapping(organization.sessionGroups, session.id)) {
    const groupId: string | undefined = organization.sessionGroups[session.id];
    if (groupId !== undefined && validIds.has(groupId)) return groupId;
  }
  const directory = sessionWorkspaceDirectory(session);
  if (hasMapping(organization.directoryGroups, directory)) {
    const groupId: string | undefined = organization.directoryGroups[directory];
    if (groupId !== undefined && validIds.has(groupId)) return groupId;
  }
  return undefined;
}

/**
 * 聚合工作区组：
 * - 所有自定义组都列出（即使没有任何任务，空组 directories/sessionIds 为空）；
 * - 其余任务按规范化源目录归为自动组（同源 worktree 任务因此合组）；
 * - 自定义组的 directories 同时包含目录规则绑定的目录与成员任务的实际源目录。
 */
export function collectWorkspaceGroups(
  sessions: WorkspaceOrganizationSession[],
  organization: WorkspaceOrganization = emptyWorkspaceOrganization()
): WorkspaceGroupSummary[] {
  const custom = new Map<string, WorkspaceGroupSummary>();
  for (const group of organization.groups) {
    custom.set(group.id, { id: group.id, name: group.name, directories: [], sessionIds: [], custom: true });
  }
  const customDirectories = new Map<string, Set<string>>();
  for (const groupId of custom.keys()) customDirectories.set(groupId, new Set());
  for (const directory of Object.keys(organization.directoryGroups)) {
    const groupId: string | undefined = organization.directoryGroups[directory];
    if (groupId !== undefined && custom.has(groupId)) customDirectories.get(groupId)!.add(directory);
  }

  const auto = new Map<string, WorkspaceGroupSummary>();
  for (const session of sessions) {
    const directory = sessionWorkspaceDirectory(session);
    const groupId = resolveWorkspaceGroupId(session, organization);
    if (groupId && custom.has(groupId)) {
      custom.get(groupId)!.sessionIds.push(session.id);
      customDirectories.get(groupId)!.add(directory);
    } else {
      let group = auto.get(directory);
      if (!group) {
        group = { id: directory, name: workspaceName(directory), directories: [directory], sessionIds: [], custom: false };
        auto.set(directory, group);
      }
      group.sessionIds.push(session.id);
    }
  }

  const summaries: WorkspaceGroupSummary[] = [];
  for (const group of organization.groups) {
    const summary = custom.get(group.id)!;
    summary.directories = [...customDirectories.get(group.id)!].sort();
    summaries.push(summary);
  }
  summaries.push(...[...auto.values()].sort((left, right) => left.id.localeCompare(right.id)));
  return summaries;
}
