import { isAbsolute } from 'node:path';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';

export type WorkspaceGroupsAction = 'list' | 'create' | 'rename' | 'delete' | 'move' | 'reset';

export interface WorkspaceGroupsCliInput {
  action: WorkspaceGroupsAction;
  groupId?: string;
  name?: string;
  sessionIds?: string[];
  directories?: string[];
  url?: string;
  database?: string;
  json?: boolean;
}

export type WorkspaceGroupsSnapshot = Record<string, unknown>;

export type WorkspaceGroupsCliDependencies = LocalRuntimeRequestDependencies;

export class WorkspaceGroupsCliError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceGroupsCliError';
  }
}

function isValidSnapshot(result: unknown): result is WorkspaceGroupsSnapshot {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const obj = result as Record<string, unknown>;
  const org = obj.organization;
  if (!org || typeof org !== 'object' || Array.isArray(org)) return false;
  const orgObj = org as Record<string, unknown>;
  if (!Array.isArray(orgObj.groups)) return false;
  if (!orgObj.directoryGroups || typeof orgObj.directoryGroups !== 'object' || Array.isArray(orgObj.directoryGroups)) return false;
  if (!orgObj.sessionGroups || typeof orgObj.sessionGroups !== 'object' || Array.isArray(orgObj.sessionGroups)) return false;
  if (!Array.isArray(obj.workspaces)) return false;
  return true;
}

export async function runWorkspaceGroupsCli(
  input: WorkspaceGroupsCliInput,
  dependencies: WorkspaceGroupsCliDependencies = {}
): Promise<WorkspaceGroupsSnapshot> {
  const action = input.action;

  // 1. 参数校验（保证无 mutation / 无多余网络请求在 bad inputs 时发生）
  let method: string;
  let endpoint: string;
  let body: unknown;

  if (action === 'list') {
    method = 'GET';
    endpoint = '/api/workspace-groups';
  } else if (action === 'create') {
    const name = input.name?.trim();
    if (!name) {
      throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_NAME_REQUIRED', 'Group name is required');
    }
    method = 'POST';
    endpoint = '/api/workspace-groups';
    body = { name };
  } else if (action === 'rename') {
    const groupId = input.groupId?.trim();
    if (!groupId) {
      throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_ID_REQUIRED', 'Group ID is required');
    }
    const name = input.name?.trim();
    if (!name) {
      throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_NAME_REQUIRED', 'Group name is required');
    }
    method = 'PATCH';
    endpoint = `/api/workspace-groups/${encodeURIComponent(groupId)}`;
    body = { name };
  } else if (action === 'delete') {
    const groupId = input.groupId?.trim();
    if (!groupId) {
      throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_ID_REQUIRED', 'Group ID is required');
    }
    method = 'DELETE';
    endpoint = `/api/workspace-groups/${encodeURIComponent(groupId)}`;
  } else if (action === 'move' || action === 'reset') {
    let groupId: string | null = null;
    if (action === 'move') {
      const trimmedId = input.groupId?.trim();
      if (!trimmedId) {
        throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_ID_REQUIRED', 'Group ID is required');
      }
      groupId = trimmedId;
    }
    const sessionIds = (input.sessionIds ?? []).map(id => id.trim());
    const directories = (input.directories ?? []).map(dir => dir.trim());
    // 批量操作中任一空项都是调用方错误：必须整批拒绝，不能静默丢弃后只写入有效部分。
    if (sessionIds.some(id => !id)) {
      throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_SESSION_ID_INVALID', 'Session IDs must not be empty');
    }
    if (directories.some(dir => !dir)) {
      throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_DIRECTORY_INVALID', 'Directories must be non-empty absolute paths');
    }
    if (sessionIds.length === 0 && directories.length === 0) {
      throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_TARGET_REQUIRED', 'At least one session ID or directory is required');
    }
    for (const dir of directories) {
      if (!isAbsolute(dir)) {
        throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_DIRECTORY_INVALID', `Directory must be an absolute path: ${dir}`);
      }
    }
    method = 'PUT';
    endpoint = '/api/workspace-groups/assignments';
    body = {
      groupId,
      ...(sessionIds.length > 0 ? { sessionIds } : {}),
      ...(directories.length > 0 ? { directories } : {})
    };
  } else {
    throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_UNKNOWN_ACTION', `Unknown workspace-groups action: ${String(action)}`);
  }

  const result = await executeLocalRuntimeRequest({
    url: input.url,
    database: input.database,
    method,
    endpoint,
    body,
    errorSpec: {
      databaseRequired: 'WORKSPACE_GROUPS_DATABASE_REQUIRED',
      daemonUnavailable: 'WORKSPACE_GROUPS_DAEMON_UNAVAILABLE',
      localRuntimeRequired: 'WORKSPACE_GROUPS_LOCAL_RUNTIME_REQUIRED',
      requestFailed: 'WORKSPACE_GROUPS_REQUEST_FAILED',
      localRuntimeRequiredMessage: 'Workspace groups only connects to a loopback or literal local-interface runtime',
      requestFailedMessage: status => `Workspace groups request failed with HTTP ${status}`
    },
    createError: (code, message) => new WorkspaceGroupsCliError(code, message)
  }, dependencies);

  if (!isValidSnapshot(result)) {
    throw new WorkspaceGroupsCliError('WORKSPACE_GROUPS_INVALID_SNAPSHOT', 'Workspace groups API returned an invalid snapshot');
  }

  return result;
}
