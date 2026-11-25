// Build the trusted RoveTap web task link using the existing `?task=…&leader=…`
// route. The base URL is deployer-configured and must be an absolute HTTPS URL;
// plain HTTP is accepted only for loopback / explicitly allowed isolated e2e.

export function buildTaskUrl(webBaseUrl, taskId, leaderId) {
  if (!webBaseUrl) return null;
  let base;
  try {
    base = new URL(webBaseUrl);
  } catch {
    throw new Error('webBaseUrl 不是合法绝对 URL');
  }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopbackHost(base.hostname))) {
    throw new Error('webBaseUrl 必须是 https:// 绝对地址（隔离测试可用 http://127.0.0.1 或 http://localhost）');
  }
  if (!taskId || !leaderId) return null;
  // Preserve any base path and add the existing route query parameters.
  const url = new URL(base.toString());
  url.searchParams.set('task', taskId);
  url.searchParams.set('leader', leaderId);
  return url.toString();
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === 'localhost';
}
