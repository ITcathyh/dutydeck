import { instanceApiUrl } from '../instance';

export const UNAUTHORIZED_EVENT = 'dutydeck:unauthorized';
/**
 * 分享页只读一个会话：页面加载时从 # 片段取出分享 token，之后每个请求都在查询串里带上它。
 * 放查询串而不是请求头，是因为 EventSource 带不了自定义请求头。
 */
let shareToken: string | undefined;
export const hasShareToken = () => Boolean(shareToken || typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('share'));
export const setShareToken = (token: string | undefined) => { shareToken = token; };
export const withShareToken = (url: string) => shareToken ? `${url}${url.includes('?') ? '&' : '?'}share=${encodeURIComponent(shareToken)}` : url;
export class ApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number, public readonly current?: unknown) { super(message); this.name = 'ApiError'; }
}
export const json = async <T,>(url: string, init?: RequestInit, instance?: string | null): Promise<T> => {
  const targetUrl = instance === undefined ? instanceApiUrl(url) : instance === null ? url : `/api/instances/${encodeURIComponent(instance)}${url.slice(4)}`;
  const response = await fetch(withShareToken(targetUrl), { credentials: 'same-origin', ...init });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const data = await response.json().catch(() => undefined);
    throw new ApiError(data?.error?.message ?? response.statusText, data?.error?.code ?? 'REQUEST_FAILED', response.status, data?.current);
  }
  return response.json();
};
/** JSON 写请求：method + JSON 请求体。 */
export const send = <T,>(method: string, url: string, body: unknown) => json<T>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
