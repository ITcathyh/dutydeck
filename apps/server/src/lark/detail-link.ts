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
