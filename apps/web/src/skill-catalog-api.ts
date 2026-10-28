import { ApiError, UNAUTHORIZED_EVENT, withShareToken, type SkillReference } from './api';
import { instanceApiUrl } from './instance';

export interface SkillCatalogResult {
  skills: SkillReference[];
  diagnostics: Array<{ path: string; ref?: string; code: string; message: string }>;
  partial: boolean;
  budget: { entries: number; candidates: number; bytes: number; concurrentReads: number };
}

export async function fetchSkillCatalog(cwd?: string, botAppId?: string, chatId?: string, pluginWorkspaceRoot?: string): Promise<SkillCatalogResult> {
  const query = new URLSearchParams({ ...(cwd ? { cwd } : {}), ...(botAppId ? { botAppId } : {}), ...(chatId ? { chatId } : {}), ...(pluginWorkspaceRoot ? { pluginWorkspaceRoot } : {}) });
  const response = await fetch(withShareToken(instanceApiUrl(`/api/system/skill-catalog?${query}`)), { credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(data.error?.message ?? 'Skill 目录读取失败', data.error?.code ?? 'REQUEST_FAILED', response.status);
  }
  return data as SkillCatalogResult;
}
