import type { BrowserAuthState, ConfigurationExplanation, SkillReference } from '@dutydeck/shared';
import { json, send } from './client';

/** 同机其他 Dutydeck 实例，经主服务转发访问。 */
export type PeerInstance = { id: string; name: string };

export type SystemDirectoryEntry = {
  name: string;
  path: string;
};

export type SystemDirectoriesResult = {
  path: string;
  parent?: string;
  roots: string[];
  host: string;
  entries: SystemDirectoryEntry[];
};

export const terminalSettingsApi = {
  get: () => json<{ terminalBackend: 'tmux' | 'herdr'; scope: 'pty-cli' }>('/api/settings/terminal', { cache: 'no-store' }),
  set: (terminalBackend: 'tmux' | 'herdr') => send<{ terminalBackend: 'tmux' | 'herdr'; scope: 'pty-cli' }>('PUT', '/api/settings/terminal', { terminalBackend }),
};

export const configurationApi = {
  explain: (sessionId: string, taskId?: string, attemptId?: string) => {
    const query = new URLSearchParams({ ...(taskId ? { taskId } : {}), ...(attemptId ? { attemptId } : {}) });
    return json<ConfigurationExplanation>(`/api/sessions/${encodeURIComponent(sessionId)}/configuration${query.size ? `?${query}` : ''}`);
  }
};

export const settingsRequests = {
  authStatus: () => json<BrowserAuthState>('/api/auth/status', { cache: 'no-store' }),
  login: (token: string) => send<BrowserAuthState>('POST', '/api/auth/login', { token }),
  passwordLogin: (password: string) => send<BrowserAuthState>('POST', '/api/auth/login', { password }),
  logout: () => json<BrowserAuthState>('/api/auth/logout', { method: 'POST' }),
  instances: () => json<{ instances: PeerInstance[] }>('/api/instances', { cache: 'no-store' }),
  systemDirectories: (path?: string) => json<SystemDirectoriesResult>(`/api/system/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`, { cache: 'no-store' }),
  systemCapabilities: () => json<{ platform: string; directoryPicker: boolean; filePicker: boolean }>('/api/system/capabilities'),
  skills: (cwd?: string, botAppId?: string, chatId?: string, pluginWorkspaceRoot?: string) => json<SkillReference[]>(`/api/system/skills?${new URLSearchParams({ ...(cwd ? { cwd } : {}), ...(botAppId ? { botAppId } : {}), ...(chatId ? { chatId } : {}), ...(pluginWorkspaceRoot ? { pluginWorkspaceRoot } : {}) })}`),
  selectDirectory: () => json<{ path: string }>('/api/system/select-directory', { method: 'POST' }),
  selectFile: () => json<{ path: string }>('/api/system/select-file', { method: 'POST' }),
};
