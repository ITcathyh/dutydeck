export interface WebBaseUrlReachability {
  kind: 'unset' | 'local' | 'public';
  /** 非 public 时给出配置提示；public 无出口问题，不带 message。 */
  message?: string;
}

export const webBaseUrlUnsetMessage = '未配置公网 Web 地址：审批/问答卡片没有网页出口，手机无法打开详情。';
export const webBaseUrlLocalMessage = 'Web 地址只在本机或内网可达：手机外网打不开，卡片上的“查看详情”没有出口。';
export const webBaseUrlInvalidMessage = 'Web 地址不是合法的 http(s) 链接：卡片上的“查看详情”不会渲染，请改为手机可达的公网地址。';

/**
 * 判断主机名是否只在本机/内网可达：localhost、*.local、环回、RFC1918 私网与链路本地。
 * 入参已小写；IPv6 地址由调用方剥掉 URL.hostname 的方括号。
 */
const isLocalHostname = (hostname: string): boolean => {
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local')) return true;
  if (hostname.includes(':')) {
    const firstHextet = parseInt(hostname.slice(0, 4), 16);
    // fe80::/10 链路本地、fc00::/7 唯一本地地址（IPv6 私网）。
    return Number.isInteger(firstHextet) && ((firstHextet >= 0xfe80 && firstHextet <= 0xfebf) || (firstHextet >= 0xfc00 && firstHextet <= 0xfdff));
  }
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [first = 0, second = 0] = parts.map(Number);
    return first === 0 // 0.0.0.0/8 含 0.0.0.0，公网不可路由
      || first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  return false;
};

/**
 * S7 配置健康提示：判断 webBaseUrl 能否作为飞书卡片的公网 Web 出口。
 * 入参归一化前后均可（空串、补协议前的裸域名都接受），规则与 normalizeWebBaseUrl 对齐：
 * - 空/未配置 → 'unset'，提示卡片没有网页出口；
 * - localhost、127.x、0.0.0.0、::1、*.local、10/172.16-31/192.168 私网、169.254/fe80 链路本地，
 *   以及无法解析或非 http(s) 的畸形输入 → 'local'（均非可用公网出口），畸形输入给专属文案；
 * - http(s) 公网域名或公网 IP → 'public'，不提示。
 */
export const describeWebBaseUrlReachability = (webBaseUrl: string | null | undefined): WebBaseUrlReachability => {
  const trimmed = webBaseUrl?.trim() ?? '';
  if (!trimmed) return { kind: 'unset', message: webBaseUrlUnsetMessage };
  // ftp:// 等非 http(s) 协议不能补成 https://（new URL 会把主机名误读成协议段），直接判不可用。
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1]!)) return { kind: 'local', message: webBaseUrlInvalidMessage };
  // normalizeWebBaseUrl 会把非 http(s) 输入误补成 https://<原串>（ftp://x → https://ftp://x），
  // 归一化后的存储态会在主机段内出现第二个 ://；启动日志读取的是存储态，需同样判畸形，避免警示漏报。
  // 只看首个路径分隔符之前的主机段，避免误伤路径或参数里自带 URL 的合法公网地址。
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*:\/\//i.test(trimmed)) return { kind: 'local', message: webBaseUrlInvalidMessage };
  let parsed: URL;
  try {
    parsed = new URL(scheme ? trimmed : `https://${trimmed}`);
  } catch {
    return { kind: 'local', message: webBaseUrlInvalidMessage };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'local', message: webBaseUrlInvalidMessage };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return { kind: 'local', message: webBaseUrlInvalidMessage };
  return isLocalHostname(hostname) ? { kind: 'local', message: webBaseUrlLocalMessage } : { kind: 'public' };
};
