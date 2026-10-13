/**
 * 飞书卡片「查看详情」的目标地址。
 *
 * 详情指向只读分享页 /share/<会话>，分享 token 放在 # 片段里：浏览器不会把片段发给服务端，
 * 打开页面的请求日志和 Referer 里都没有它。签名要用服务端密钥，而 buildLarkCard 是纯函数、
 * 调用点遍布各处，所以由服务进程启动时注册一次签名函数；没有注册时（CLI 进程、单测）
 * 退回完整工作台的任务页，那里要先登录。
 */
let signShareToken: ((sessionId: string) => string) | undefined;

/** 注册签名函数，返回注销函数 */
export function setLarkSessionShareSigner(signer: (sessionId: string) => string): () => void {
  signShareToken = signer;
  return () => { if (signShareToken === signer) signShareToken = undefined; };
}

export function larkSessionDetailUrl(webBaseUrl: string, sessionId: string): string {
  const path = encodeURIComponent(sessionId);
  return signShareToken ? `${webBaseUrl}/share/${path}#${signShareToken(sessionId)}` : `${webBaseUrl}/sessions/${path}`;
}

/**
 * 结果卡「查看改动」的目标地址：/diff/<会话>/<任务>，token 同样放在 # 片段里。token 只授权读这一轮的 diff，
 * 带到期时间（见 auth.ts 的 signTurnDiffToken）。没有注册签名函数时退回要先登录的同一页面。
 */
let signTurnDiffToken: ((sessionId: string, taskId: string) => string) | undefined;

export function setLarkTurnDiffSigner(signer: (sessionId: string, taskId: string) => string): () => void {
  signTurnDiffToken = signer;
  return () => { if (signTurnDiffToken === signer) signTurnDiffToken = undefined; };
}

export function larkTurnDiffUrl(webBaseUrl: string, sessionId: string, taskId: string): string {
  const path = `${webBaseUrl}/diff/${encodeURIComponent(sessionId)}/${encodeURIComponent(taskId)}`;
  return signTurnDiffToken ? `${path}#${signTurnDiffToken(sessionId, taskId)}` : path;
}
