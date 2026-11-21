import type {
  SessionInsightCancelResponse,
  SessionInsightCompareRequest,
  SessionInsightCompareResponse,
  SessionInsightDetailsResponse,
  SessionInsightEventsQuery,
  SessionInsightEventsResponse,
  SessionInsightExportRequest,
  SessionInsightRefreshResponse,
  SessionInsightSummaryQuery,
  SessionInsightSummaryResponse
} from '@dutydeck/shared';
import { UNAUTHORIZED_EVENT, withShareToken, ApiError, json, send } from './client';
import { instanceApiUrl } from '../instance';

// ============================================================================
// 会话分析（Session Insight）
//
// 所有请求都经过 instanceApiUrl：远端实例经实例代理转发，实例间不共享缓存。
// 下载报告同样走实例路径并携带原有 cookie；401 仍触发统一未授权事件。
// ============================================================================

export type InsightEventFilters = Pick<SessionInsightEventsQuery, 'kind' | 'tool' | 'result'> & { cursor?: string; limit?: number };
export type InsightSummaryFilters = Partial<Omit<SessionInsightSummaryQuery, 'cursor'>> & { cursor?: string };

/** React Query key 统一工厂：实例、session、snapshot、筛选项全部进 key，实例切换不串缓存。 */
export const insightQueryKeys = {
  details: (instance: string | undefined, sessionId: string, snapshotId?: string | null) =>
    ['insight', instance ?? null, 'details', sessionId, snapshotId ?? null] as const,
  events: (instance: string | undefined, sessionId: string, snapshotId: string, filters: InsightEventFilters) =>
    ['insight', instance ?? null, 'events', sessionId, snapshotId, filters] as const,
  summary: (instance: string | undefined, filters: InsightSummaryFilters) =>
    ['insight', instance ?? null, 'summary', filters] as const,
  compare: (instance: string | undefined, request: SessionInsightCompareRequest | null) =>
    ['insight', instance ?? null, 'compare', request] as const
};

const insightEventsUrl = (sessionId: string, query: { snapshotId: string } & InsightEventFilters) => {
  const params = new URLSearchParams();
  params.set('snapshotId', query.snapshotId);
  params.set('limit', String(query.limit ?? 100));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.kind) params.set('kind', query.kind);
  if (query.tool) params.set('tool', query.tool);
  if (query.result) params.set('result', query.result);
  return `/api/sessions/${encodeURIComponent(sessionId)}/insight/events?${params.toString()}`;
};

const insightSummaryUrl = (query: InsightSummaryFilters) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return `/api/insights/summary?${params.toString()}`;
};

const attachmentFilename = (response: Response, fallback: string) => {
  const disposition = response.headers.get('Content-Disposition');
  // 服务端文件名只含安全 ID 与日期；优先取 filename*，再取 filename。
  const encoded = disposition?.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded.trim()); } catch { /* 落到 filename */ } }
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  return plain?.trim() || fallback;
};

const downloadBlob = async (url: string, body: unknown, fallbackFilename: string): Promise<{ blob: Blob; filename: string }> => {
  const response = await fetch(withShareToken(instanceApiUrl(url)), {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    // 错误响应仍是服务端统一的 JSON 结构，不是文件内容。
    let data: unknown;
    try { data = await response.clone().json(); } catch { data = undefined; }
    const payload = data as { error?: { message?: string; code?: string } } | undefined;
    throw new ApiError(payload?.error?.message ?? response.statusText, payload?.error?.code ?? 'REQUEST_FAILED', response.status, data);
  }
  const blob = await response.blob();
  return { blob, filename: attachmentFilename(response, fallbackFilename) };
};

export const insightApi = {
  details: (sessionId: string, snapshotId?: string | null, signal?: AbortSignal) => {
    const query = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : '';
    return json<SessionInsightDetailsResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/insight${query}`,
      { cache: 'no-store', signal }
    );
  },
  refresh: (sessionId: string) =>
    send<SessionInsightRefreshResponse>('POST', `/api/sessions/${encodeURIComponent(sessionId)}/insight/refresh`, {}),
  cancel: (sessionId: string, requestId: string) =>
    json<SessionInsightCancelResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/insight/refresh/${encodeURIComponent(requestId)}`,
      { method: 'DELETE' }
    ),
  events: (sessionId: string, query: { snapshotId: string } & InsightEventFilters, signal?: AbortSignal) =>
    json<SessionInsightEventsResponse>(insightEventsUrl(sessionId, query), { cache: 'no-store', signal }),
  summary: (query: InsightSummaryFilters, signal?: AbortSignal) =>
    json<SessionInsightSummaryResponse>(insightSummaryUrl(query), { cache: 'no-store', signal }),
  compare: (body: SessionInsightCompareRequest, signal?: AbortSignal) =>
    json<SessionInsightCompareResponse>('/api/insights/compare', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }),
  exportReport: (body: SessionInsightExportRequest) => {
    const fallbackFilename = body.kind === 'session'
      ? `session-insight-${body.sessionId}.${body.format === 'html' ? 'html' : 'md'}`
      : `session-insight-comparison.${body.format === 'html' ? 'html' : 'md'}`;
    return downloadBlob('/api/insights/export', body, fallbackFilename);
  }
};
