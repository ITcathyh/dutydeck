import {
  collectWorkspaceGroups,
  createWorkspaceGroupId,
  emptyWorkspaceOrganization,
  normalizeWorkspaceDirectoryInput,
  normalizeWorkspaceGroupName,
  parseWorkspaceOrganization,
  type ConfigRepository,
  type WorkspaceOrganization,
  type WorkspaceOrganizationSession,
  type WorkspaceOrganizationSnapshot,
  RuntimeError
} from '@dutydeck/shared';

/** 专用配置键：整个安装级共享一份整理配置。 */
export const WORKSPACE_ORGANIZATION_CONFIG_KEY = 'workspace_organization:v1';
/** CAS 竞争时的有限重试次数；超出后明确 409，不覆盖他人写入。 */
const MAX_CAS_ATTEMPTS = 50;

export interface WorkspaceOrganizationListedSession extends WorkspaceOrganizationSession {
  source?: string;
  archivedAt?: string;
}

export interface WorkspaceOrganizationServiceOptions {
  config: Pick<ConfigRepository, 'get' | 'compareAndSet'>;
  /** 通常注入 runtime.listSessions；service 只做只读投影，绝不启动/停止会话。 */
  listSessions: () => Promise<WorkspaceOrganizationListedSession[]>;
}

export class WorkspaceOrganizationService {
  private readonly config: WorkspaceOrganizationServiceOptions['config'];
  private readonly listSessions: WorkspaceOrganizationServiceOptions['listSessions'];

  constructor(options: WorkspaceOrganizationServiceOptions) {
    if (typeof options.config.compareAndSet !== 'function') {
      // 无 CAS 保护时 fail closed，禁止任何写入，避免 read+set 覆盖并发修改。
      throw new Error('WorkspaceOrganizationService requires a ConfigRepository with compareAndSet');
    }
    this.config = options.config;
    this.listSessions = options.listSessions;
  }

  /** 整理页管理所见：包含归档任务，排除 work_item 托管会话。 */
  private async manageableSessions(): Promise<WorkspaceOrganizationListedSession[]> {
    const sessions = await this.listSessions();
    return sessions.filter(session => session.source !== 'work_item');
  }

  private async readOrganization(): Promise<{ raw: string | undefined; organization: WorkspaceOrganization }> {
    const raw = await this.config.get(WORKSPACE_ORGANIZATION_CONFIG_KEY);
    return { raw, organization: parseWorkspaceOrganization(raw) };
  }

  private async snapshot(organization: WorkspaceOrganization, createdGroupId?: string): Promise<WorkspaceOrganizationSnapshot> {
    const sessions = await this.manageableSessions();
    const result: WorkspaceOrganizationSnapshot = {
      organization,
      workspaces: collectWorkspaceGroups(sessions, organization)
    };
    if (createdGroupId) result.createdGroupId = createdGroupId;
    return result;
  }

  async getSnapshot(): Promise<WorkspaceOrganizationSnapshot> {
    const { organization } = await this.readOrganization();
    return this.snapshot(organization);
  }

  /**
   * 读当前配置 -> 变更 -> CAS 写单个 key；冲突则重读重试。
   * 任何参数/存在性校验都在 mutate 内部、基于每次重读的最新配置完成，
   * 保证整批验证失败时绝不发生部分写入。
   */
  private async mutate(
    mutate: (organization: WorkspaceOrganization, sessions: WorkspaceOrganizationListedSession[]) => WorkspaceOrganization,
    createdGroupId?: string
  ): Promise<WorkspaceOrganizationSnapshot> {
    const sessions = await this.manageableSessions();
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const { raw, organization } = await this.readOrganization();
      const next = mutate(structuredClone(organization), sessions);
      const serialized = JSON.stringify(next);
      if (serialized === (raw ?? JSON.stringify(emptyWorkspaceOrganization()))) {
        return this.snapshot(next, createdGroupId);
      }
      const swapped = await this.config.compareAndSet!(WORKSPACE_ORGANIZATION_CONFIG_KEY, raw, serialized);
      if (swapped) return this.snapshot(next, createdGroupId);
    }
    throw new RuntimeError('WORKSPACE_GROUP_CONFLICT', '分组配置刚被其他操作修改，请重试', 409);
  }

  async createGroup(nameInput: unknown): Promise<WorkspaceOrganizationSnapshot> {
    let name: string;
    try {
      name = normalizeWorkspaceGroupName(String(nameInput ?? ''));
    } catch (error) {
      throw new RuntimeError('INVALID_WORKSPACE_GROUP_NAME', (error as Error).message, 400);
    }
    const groupId = createWorkspaceGroupId();
    return this.mutate(organization => {
      if (organization.groups.some(group => group.name === name)) {
        throw new RuntimeError('WORKSPACE_GROUP_NAME_CONFLICT', '已存在同名分组', 409);
      }
      organization.groups.push({ id: groupId, name });
      return organization;
    }, groupId);
  }

  async renameGroup(groupId: string, nameInput: unknown): Promise<WorkspaceOrganizationSnapshot> {
    let name: string;
    try {
      name = normalizeWorkspaceGroupName(String(nameInput ?? ''));
    } catch (error) {
      throw new RuntimeError('INVALID_WORKSPACE_GROUP_NAME', (error as Error).message, 400);
    }
    return this.mutate(organization => {
      const group = organization.groups.find(item => item.id === groupId);
      if (!group) throw new RuntimeError('WORKSPACE_GROUP_NOT_FOUND', '分组不存在', 404);
      if (organization.groups.some(item => item.id !== groupId && item.name === name)) {
        throw new RuntimeError('WORKSPACE_GROUP_NAME_CONFLICT', '已存在同名分组', 409);
      }
      group.name = name;
      return organization;
    });
  }

  /** 删除自定义组：只删配置（组定义 + 指向它的目录/任务映射），所有任务本身保留。 */
  async deleteGroup(groupId: string): Promise<WorkspaceOrganizationSnapshot> {
    return this.mutate(organization => {
      if (!organization.groups.some(group => group.id === groupId)) {
        throw new RuntimeError('WORKSPACE_GROUP_NOT_FOUND', '分组不存在', 404);
      }
      organization.groups = organization.groups.filter(group => group.id !== groupId);
      for (const directory of Object.keys(organization.directoryGroups)) {
        if (organization.directoryGroups[directory] === groupId) delete organization.directoryGroups[directory];
      }
      for (const sessionId of Object.keys(organization.sessionGroups)) {
        if (organization.sessionGroups[sessionId] === groupId) delete organization.sessionGroups[sessionId];
      }
      return organization;
    });
  }

  async assign(input: { groupId: string | null; sessionIds?: string[]; directories?: string[] }): Promise<WorkspaceOrganizationSnapshot> {
    const sessionIds = input.sessionIds ?? [];
    const rawDirectories = input.directories ?? [];
    if (sessionIds.length === 0 && rawDirectories.length === 0) {
      throw new RuntimeError('INVALID_WORKSPACE_GROUP_ASSIGNMENT', '至少指定一个任务或目录', 400);
    }
    let directories: string[];
    try {
      directories = rawDirectories.map(directory => normalizeWorkspaceDirectoryInput(String(directory)));
    } catch (error) {
      throw new RuntimeError('INVALID_WORKSPACE_DIRECTORY', (error as Error).message, 400);
    }
    return this.mutate((organization, sessions) => {
      if (input.groupId !== null && !organization.groups.some(group => group.id === input.groupId)) {
        throw new RuntimeError('WORKSPACE_GROUP_NOT_FOUND', '目标分组不存在', 404);
      }
      // 整批先验证：任一任务不存在或为 work_item 托管会话即整体失败，不写任何映射。
      if (sessionIds.length > 0) {
        const knownIds = new Set(sessions.map(session => session.id));
        const unknown = sessionIds.find(id => !knownIds.has(id));
        if (unknown) throw new RuntimeError('SESSION_NOT_FOUND', `任务不存在或不可整理：${unknown}`, 404);
      }
      const target = input.groupId;
      if (target === null) {
        for (const id of sessionIds) delete organization.sessionGroups[id];
        for (const directory of directories) delete organization.directoryGroups[directory];
      } else {
        for (const id of sessionIds) organization.sessionGroups[id] = target;
        for (const directory of directories) organization.directoryGroups[directory] = target;
      }
      return organization;
    });
  }
}
