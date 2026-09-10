import { createRequire } from 'node:module';

const requireFromServer = createRequire(new URL('../../../../apps/server/package.json', import.meta.url));
const WebSocket = requireFromServer('ws');
let currentStage = 'input_validation';

function invariant(value, code) {
  if (!value) throw new Error(code);
}

function safeBaseUrl(raw) {
  const url = new URL(raw);
  invariant(url.protocol === 'http:' || url.protocol === 'https:', 'BASE_URL_SCHEME_INVALID');
  invariant(!url.username && !url.password, 'BASE_URL_USERINFO_FORBIDDEN');
  invariant(!url.search && !url.hash, 'BASE_URL_QUERY_OR_FRAGMENT_FORBIDDEN');
  invariant(url.pathname === '/' || url.pathname === '', 'BASE_URL_PATH_FORBIDDEN');
  return url;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 7_500) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function assertSseConnected(baseUrl, sessionId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_500);
  try {
    const response = await fetch(new URL(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, baseUrl), {
      headers: { Origin: baseUrl.origin },
      signal: controller.signal,
    });
    invariant(response.status === 200, 'SSE_STATUS_INVALID');
    invariant((response.headers.get('content-type') ?? '').includes('text/event-stream'), 'SSE_CONTENT_TYPE_INVALID');
    const reader = response.body?.getReader();
    invariant(reader, 'SSE_BODY_MISSING');
    let text = '';
    while (!text.includes(': connected') && text.length < 16_384) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    invariant(text.includes(': connected'), 'SSE_CONNECTED_MARKER_MISSING');
    await reader.cancel().catch(() => undefined);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function websocketProbe(url, origin, expected) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('WEBSOCKET_TIMEOUT'));
    }, 7_500);
    const finish = (error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    ws.once('open', () => {
      if (expected !== 'open') return finish(new Error('CROSS_ORIGIN_WEBSOCKET_OPENED'));
      ws.close();
      finish();
    });
    ws.once('unexpected-response', (_request, response) => {
      if (expected === 'forbidden' && response.statusCode === 403) {
        response.resume();
        finish();
      }
      else if (expected === 'open' && response.statusCode === 404) {
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size <= 4_096) chunks.push(chunk);
        });
        response.on('end', () => {
          let reason = 'SAME_ORIGIN_TERMINAL_WS_ROUTE_NOT_FOUND';
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (payload?.type === 'error' && payload?.message === 'session not found') {
              reason = 'SAME_ORIGIN_TERMINAL_WS_SESSION_NOT_LIVE';
            }
          } catch { /* keep the allowlisted route-level reason */ }
          finish(new Error(reason));
        });
      }
      else if (expected === 'open') {
        response.resume();
        const reason = new Map([
          [400, 'SAME_ORIGIN_TERMINAL_WS_SESSION_UNSUPPORTED'],
          [401, 'SAME_ORIGIN_TERMINAL_WS_AUTH_REQUIRED'],
          [403, 'SAME_ORIGIN_TERMINAL_WS_ORIGIN_OR_POLICY_DENIED'],
          [409, 'SAME_ORIGIN_TERMINAL_WS_SESSION_CONFLICT'],
          [503, 'SAME_ORIGIN_TERMINAL_WS_POLICY_UNAVAILABLE'],
        ]).get(response.statusCode) ?? 'WEBSOCKET_REJECTION_INVALID';
        finish(new Error(reason));
      } else {
        response.resume();
        finish(new Error('WEBSOCKET_REJECTION_INVALID'));
      }
    });
    ws.once('error', error => {
      if (expected === 'forbidden' && /Unexpected server response: 403/.test(error.message)) finish();
      else finish(error);
    });
  });
}

async function main() {
  const runStage = async (name, work) => {
    currentStage = name;
    return work();
  };
  invariant(process.env.DUTYDECK_PARITY_REMOTE_OPEN_ACK === 'read_only_dedicated_instance', 'REMOTE_OPEN_ACK_REQUIRED');
  const baseUrl = safeBaseUrl(process.env.DUTYDECK_PARITY_BASE_URL ?? '');
  const sessionId = process.env.DUTYDECK_PARITY_SESSION_ID ?? '';
  invariant(/^[A-Za-z0-9_-]{8,160}$/.test(sessionId), 'SESSION_ID_INVALID');

  const health = await runStage('health', () => fetchWithTimeout(new URL('/health', baseUrl), { headers: { Origin: baseUrl.origin } }));
  invariant(health.status === 200, 'HEALTH_STATUS_INVALID');
  await health.body?.cancel().catch(() => undefined);

  const status = await runStage('auth_status', () => fetchWithTimeout(new URL('/api/auth/status', baseUrl), { headers: { Origin: baseUrl.origin } }));
  invariant(status.status === 200, 'AUTH_STATUS_UNAVAILABLE');
  const authBody = await status.json();
  invariant(authBody?.required === false && authBody?.authenticated === true, 'REMOTE_OPEN_MODE_NOT_CONFIRMED');

  const sessions = await runStage('tokenless_http', () => fetchWithTimeout(new URL('/api/sessions', baseUrl), { headers: { Origin: baseUrl.origin } }));
  invariant(sessions.status === 200, 'TOKENLESS_HTTP_FAILED');
  await sessions.body?.cancel().catch(() => undefined);

  const sessionResponse = await runStage('session_metadata', () => fetchWithTimeout(
    new URL(`/api/sessions/${encodeURIComponent(sessionId)}`, baseUrl),
    { headers: { Origin: baseUrl.origin } },
  ));
  invariant(sessionResponse.status === 200, 'SESSION_NOT_FOUND');
  const session = await sessionResponse.json();
  invariant(session?.protocol === 'pty-cli', 'SESSION_TERMINAL_PROTOCOL_UNSUPPORTED');
  invariant(!session?.archivedAt && session?.state !== 'failed' && session?.state !== 'stopped', 'SESSION_TERMINAL_INELIGIBLE');

  const badOrigin = 'https://cross-origin-parity.invalid';
  const rejectedSse = await runStage('cross_origin_sse', () => fetchWithTimeout(
    new URL(`/api/sessions/${encodeURIComponent(sessionId)}/stream`, baseUrl),
    { headers: { Origin: badOrigin } },
  ));
  invariant(rejectedSse.status === 403, 'CROSS_ORIGIN_SSE_NOT_REJECTED');
  await rejectedSse.body?.cancel().catch(() => undefined);

  await runStage('same_origin_sse', () => assertSseConnected(baseUrl, sessionId));
  const wsUrl = new URL(`/api/terminal/${encodeURIComponent(sessionId)}`, baseUrl);
  wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  await runStage('same_origin_terminal_ws', () => websocketProbe(wsUrl, baseUrl.origin, 'open'));
  await runStage('cross_origin_terminal_ws', () => websocketProbe(wsUrl, badOrigin, 'forbidden'));

  process.stdout.write(`${JSON.stringify({
    case_id: 'remote-dev-open-mode-no-token',
    status: 'pass',
    token_sent: false,
    mutation_sent: false,
    terminal_input_sent: false,
    same_origin_enforced: true,
  })}\n`);
}

main().catch(error => {
  const safeCodes = new Set([
    'REMOTE_OPEN_ACK_REQUIRED', 'BASE_URL_SCHEME_INVALID', 'BASE_URL_USERINFO_FORBIDDEN',
    'BASE_URL_QUERY_OR_FRAGMENT_FORBIDDEN', 'BASE_URL_PATH_FORBIDDEN', 'SESSION_ID_INVALID',
    'HEALTH_STATUS_INVALID', 'AUTH_STATUS_UNAVAILABLE', 'REMOTE_OPEN_MODE_NOT_CONFIRMED',
    'TOKENLESS_HTTP_FAILED', 'SESSION_NOT_FOUND', 'SESSION_TERMINAL_PROTOCOL_UNSUPPORTED',
    'SESSION_TERMINAL_INELIGIBLE', 'CROSS_ORIGIN_SSE_NOT_REJECTED', 'SSE_STATUS_INVALID',
    'SSE_CONTENT_TYPE_INVALID', 'SSE_BODY_MISSING', 'SSE_CONNECTED_MARKER_MISSING',
    'WEBSOCKET_TIMEOUT', 'CROSS_ORIGIN_WEBSOCKET_OPENED', 'WEBSOCKET_REJECTION_INVALID',
    'SAME_ORIGIN_TERMINAL_WS_SESSION_UNSUPPORTED', 'SAME_ORIGIN_TERMINAL_WS_AUTH_REQUIRED',
    'SAME_ORIGIN_TERMINAL_WS_ORIGIN_OR_POLICY_DENIED', 'SAME_ORIGIN_TERMINAL_WS_ROUTE_NOT_FOUND',
    'SAME_ORIGIN_TERMINAL_WS_SESSION_NOT_LIVE',
    'SAME_ORIGIN_TERMINAL_WS_SESSION_CONFLICT', 'SAME_ORIGIN_TERMINAL_WS_POLICY_UNAVAILABLE',
  ]);
  process.stderr.write(`${JSON.stringify({
    case_id: 'remote-dev-open-mode-no-token',
    status: 'fail',
    stage: currentStage,
    error_code: safeCodes.has(error?.message) ? error.message : 'REMOTE_OPEN_NETWORK_OR_PROTOCOL_FAILED',
  })}\n`);
  process.exitCode = 1;
});
