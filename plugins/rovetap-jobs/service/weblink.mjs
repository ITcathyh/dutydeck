// Build the trusted RoveTap web task link using the existing `?task=…&leader=…`
// route. The base URL is deployer-configured and must be an absolute HTTPS URL;
// plain HTTP is accepted only for loopback / explicitly allowed isolated e2e.
//
// Operators sometimes paste a one-time pairing/login URL that carries secrets in
// userinfo, query or fragment. Receipts must never forward those segments to
// Feishu: userinfo is rejected, pre-existing query/fragment are dropped, and
// only origin + path plus the trusted task/leader parameters survive.

export function buildTaskUrl(webBaseUrl, taskId, leaderId) {
  if (!webBaseUrl) return null;
  let base;
  try {
    base = new URL(webBaseUrl);
  } catch {
    throw new Error('webBaseUrl 不是合法绝对 URL');
  }
  if (base.username || base.password) {
    throw new Error('webBaseUrl 不能包含用户名或密码（userinfo），请填工作台普通地址');
  }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLoopbackHost(base.hostname))) {
    throw new Error('webBaseUrl 必须是 https:// 绝对地址（隔离测试可用 http://127.0.0.1 或 http://localhost）');
  }
  if (!taskId || !leaderId) return null;
  base.search = '';
  base.hash = '';
  base.searchParams.set('task', taskId);
  base.searchParams.set('leader', leaderId);
  return base.toString();
}

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === 'localhost';
}
