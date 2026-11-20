import type { LarkServiceError } from './service.js';

export const larkHistoryScopes = ['im:message:readonly', 'im:chat:read'] as const;
export const larkPermissionNextStep = '请让管理员在飞书开放平台开通权限并发布应用版本，然后重试。';

export function isLarkPermissionError(error: LarkServiceError) {
  const upstreamCode = Number(error.details?.upstreamCode);
  return Boolean(error.statusCode === 403 || error.details?.consoleUrl || error.details?.permissionViolations
    || [99991661, 99991663, 99991668, 99991672, 99991679].includes(upstreamCode)
    || /permission|forbidden|access denied|权限|无权/i.test(error.message));
}
