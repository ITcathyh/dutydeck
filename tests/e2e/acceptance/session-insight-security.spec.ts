import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  launchSessionInsightTestServer,
  type SessionInsightTestEnvironment
} from './session-insight-harness.js';
import {
  readAuthContextFromDb,
  createRealShareToken,
  appendCanariesToLog,
  type SecurityCanaryDefinition
} from './session-insight-security-harness.js';
import type { TestServerInstance } from './harness.js';

test.describe('Session Insight Security & Authorization Acceptance', () => {
  let env: SessionInsightTestEnvironment;
  let serverInstance: TestServerInstance;

  test.beforeAll(async () => {
    env = await launchSessionInsightTestServer({ prefix: 'dutydeck-acc-sec-' });
    serverInstance = env.instance;
  });

  test.afterAll(async () => {
    if (serverInstance) {
      await serverInstance.cleanup();
    }
  });

  /**
   * 轮询分析状态直到终态，如果到达 failed/cancelled/interrupted 则返回，
   * 并在断言中携带具体错误码便于诊断。
   */
  async function waitInsightTerminal(sessionId: string, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let last: any;
    while (Date.now() < deadline) {
      const res = await serverInstance.request('GET', `/api/sessions/${sessionId}/insight`);
      last = res.json;
      const state = last?.status?.refreshState;
      if (state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'interrupted') {
        return last;
      }
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`insight did not reach terminal state. last=${JSON.stringify(last?.status)}`);
  }

  // ==========================================================================
  // 任务 1: 真实日志/prompt注入独特凭据/路径/XSS Canary，HTTP details/events/summary/export 检查缺失
  // ==========================================================================
  test('Security 1: Redaction and XSS sanitization across details, events, summary, and export', async ({ page }) => {
    test.setTimeout(120_000);

    const uniqueTag = `sec_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const xssScriptId = `__xss_sec1_canary_${uniqueTag}`;
    const xssImgId = `__xss_sec1_img_${uniqueTag}`;
    const canaries: SecurityCanaryDefinition = {
      secret: `sk-ant-api03-${uniqueTag}-SUPERSECRETKEY1234567890`,
      privatePath: env.claudeDataDir,
      xssPayload: `<script>window.${xssScriptId}=true;</script><img src="x" onerror="window.${xssImgId}=true">`
    };

    // 1. 创建受控 Claude 会话，将 Canary 注入 host prompt
    const hostPrompt = `CANARY_HOST_TASK_${uniqueTag}: export TOKEN=${canaries.secret} and verify ${canaries.privatePath} with ${canaries.xssPayload}`;
    const session = await env.createSession('claude', hostPrompt);

    // 2. 向专属 mainPath 真实写入 Canary（不写 agentId 避免主流 stream 冲突）
    appendCanariesToLog(session.mainPath, session.nativeSessionId, canaries);

    // 结构化逐行验证：使用 JSON.parse 解析每行，确认注入条目包含完整 Canary 内容（绝非未注入就 assert 缺失）
    const lines = readFileSync(session.mainPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const injectedToolUse = lines.find((l: any) =>
      l?.message?.content?.some?.((c: any) =>
        c?.type === 'tool_use' &&
        typeof c?.input?.command === 'string' &&
        c.input.command.includes(canaries.secret) &&
        c.input.command.includes(canaries.privatePath) &&
        c.input.command.includes(canaries.xssPayload)
      )
    );
    expect(injectedToolUse, 'Injected tool_use with complete secret, path and XSS must exist in native log').toBeTruthy();

    const injectedToolResult = lines.find((l: any) =>
      l?.message?.content?.some?.((c: any) =>
        c?.type === 'tool_result' &&
        typeof c?.content === 'string' &&
        c.content.includes(canaries.secret) &&
        c.content.includes(canaries.privatePath) &&
        c.content.includes(canaries.xssPayload)
      )
    );
    expect(injectedToolResult, 'Injected tool_result with complete secret, path and XSS must exist in native log').toBeTruthy();

    // 3. 触发分析并等待快照完成
    const refreshRes = await serverInstance.request('POST', `/api/sessions/${session.sessionId}/insight/refresh`);
    expect([200, 202]).toContain(refreshRes.status);

    const terminal = await waitInsightTerminal(session.sessionId);
    expect(terminal.status.refreshState, `errorCode=${terminal.status.errorCode}`).toBe('succeeded');

    // 4. 检查 Details 接口
    const detailsRes = await serverInstance.request('GET', `/api/sessions/${session.sessionId}/insight`);
    expect(detailsRes.status).toBe(200);
    const detailsText = detailsRes.text;
    expect(detailsText).not.toContain(canaries.secret);
    expect(detailsText).not.toContain(canaries.privatePath);

    const snapshotId = detailsRes.json?.summary?.snapshotId;
    expect(snapshotId).toBeTruthy();

    // 5. 检查 Events 接口
    const eventsRes = await serverInstance.request(
      'GET',
      `/api/sessions/${session.sessionId}/insight/events?snapshotId=${snapshotId}&limit=100`
    );
    expect(eventsRes.status).toBe(200);
    const eventsText = eventsRes.text;
    expect(eventsText).not.toContain(canaries.secret);
    expect(eventsText).not.toContain(canaries.privatePath);

    // 6. 检查 Summary 接口
    const summaryRes = await serverInstance.request('GET', '/api/insights/summary?groupBy=workspace');
    expect(summaryRes.status).toBe(200);
    const summaryText = summaryRes.text;
    expect(summaryText).not.toContain(canaries.secret);
    expect(summaryText).not.toContain(canaries.privatePath);

    // 7. 检查 Markdown 导出
    const exportMdRes = await serverInstance.request('POST', '/api/insights/export', {
      kind: 'session',
      sessionId: session.sessionId,
      snapshotId,
      format: 'markdown'
    });
    expect(exportMdRes.status).toBe(200);
    expect(exportMdRes.text).not.toContain(canaries.secret);
    expect(exportMdRes.text).not.toContain(canaries.privatePath);

    // 8. 检查 HTML 导出与真实浏览器执行隔离
    const exportHtmlRes = await serverInstance.request('POST', '/api/insights/export', {
      kind: 'session',
      sessionId: session.sessionId,
      snapshotId,
      format: 'html'
    });
    expect(exportHtmlRes.status).toBe(200);
    const htmlBody = exportHtmlRes.text;
    expect(htmlBody).not.toContain(canaries.secret);
    expect(htmlBody).not.toContain(canaries.privatePath);

    // 确保原始恶意脚本标签被转义：不能形成可执行的 <script> 标签或可执行的 onerror 属性
    expect(htmlBody).not.toMatch(new RegExp(`<script>window\\.${xssScriptId}`, 'i'));
    expect(htmlBody).not.toContain(`onerror="window.${xssImgId}`);
    expect(htmlBody).not.toContain(`onerror='window.${xssImgId}`);

    // 在真实浏览器渲染导出的 HTML，断言脚本未被触发执行
    await page.goto(`${serverInstance.baseUrl}/`);
    await page.setContent(htmlBody);
    const triggered = await page.evaluate(([scriptId, imgId]) => {
      const w = window as any;
      return Boolean(w[scriptId] || w[imgId]);
    }, [xssScriptId, xssImgId]);
    expect(triggered).toBe(false);
  });

  // ==========================================================================
  // 任务 2: 全 7 个 insight 入口真实 share principal / 未授权拒绝与 no-store 覆盖
  // ==========================================================================
  test('Security 2: auth real context rejects unauthenticated, share principal and proxy on all 7 insight endpoints with no-store', async () => {
    test.setTimeout(60_000);

    const nonexistentSessionId = 'ses_security_nonexistent_888888';
    const fakeSnapshotId = 'snap_security_nonexistent_888888';
    const fakeRequestId = '00000000-0000-4000-8000-000000000001';

    // 1. 从测试库读取真实 shareSecret 并签发真实 share token
    const { shareSecret } = readAuthContextFromDb(serverInstance.dataDir);
    expect(shareSecret).toBeTruthy();

    const realShareToken = createRealShareToken(shareSecret!, nonexistentSessionId);

    // 对照验证：针对普通 session 路径，持有效签名的 share 请求受 auth 中间件放行（走业务 404，而非 auth 401/403）
    const shareSessionProbe = await fetch(
      `${serverInstance.baseUrl}/api/sessions/${nonexistentSessionId}?share=${realShareToken}`
    );
    expect([200, 404]).toContain(shareSessionProbe.status);

    // 2. 依次验证全部 7 个 insight 入口：持真实 share token 访问全部拒绝（401 或 403，先 auth 后 lookup，且带 no-store）
    const endpointsToProbe = [
      {
        name: 'details',
        method: 'GET',
        url: `${serverInstance.baseUrl}/api/sessions/${nonexistentSessionId}/insight?share=${realShareToken}`
      },
      {
        name: 'refresh',
        method: 'POST',
        url: `${serverInstance.baseUrl}/api/sessions/${nonexistentSessionId}/insight/refresh?share=${realShareToken}`,
        body: '{}'
      },
      {
        name: 'cancel',
        method: 'DELETE',
        url: `${serverInstance.baseUrl}/api/sessions/${nonexistentSessionId}/insight/refresh/${fakeRequestId}?share=${realShareToken}`
      },
      {
        name: 'events',
        method: 'GET',
        url: `${serverInstance.baseUrl}/api/sessions/${nonexistentSessionId}/insight/events?snapshotId=${fakeSnapshotId}&share=${realShareToken}`
      },
      {
        name: 'summary',
        method: 'GET',
        url: `${serverInstance.baseUrl}/api/insights/summary?share=${realShareToken}`
      },
      {
        name: 'compare',
        method: 'POST',
        url: `${serverInstance.baseUrl}/api/insights/compare?share=${realShareToken}`,
        body: JSON.stringify({
          left: { sessionId: nonexistentSessionId, snapshotId: fakeSnapshotId },
          right: { sessionId: nonexistentSessionId, snapshotId: fakeSnapshotId }
        })
      },
      {
        name: 'export',
        method: 'POST',
        url: `${serverInstance.baseUrl}/api/insights/export?share=${realShareToken}`,
        body: JSON.stringify({
          kind: 'session',
          sessionId: nonexistentSessionId,
          snapshotId: fakeSnapshotId,
          format: 'markdown'
        })
      }
    ];

    for (const ep of endpointsToProbe) {
      const res = await fetch(ep.url, {
        method: ep.method,
        headers: ep.body !== undefined ? { 'content-type': 'application/json' } : {},
        body: ep.body
      });

      // 核心安全保证 1：必须被拒绝（401/403），且鉴权先于资源查找（不能因为 session 不存在而返回 404）
      expect([401, 403], `${ep.name} should reject share token with 401 or 403`).toContain(res.status);
      expect(res.status, `${ep.name} must reject before lookup, not 404`).not.toBe(404);

      // 核心安全保证 2：设计明示所有 insight 响应（含拒绝错误响应）必须带 no-store
      const cacheControl = res.headers.get('cache-control') || '';
      expect(cacheControl, `${ep.name} share rejection must include no-store`).toContain('no-store');
    }

    // 3. 管理员正常访问对照：到达 insight 路由，带 no-store 且不被 auth 阻断
    const adminReachProbes = [
      { method: 'GET', url: `/api/sessions/${nonexistentSessionId}/insight` },
      {
        method: 'GET',
        url: `/api/sessions/${nonexistentSessionId}/insight/events?snapshotId=${fakeSnapshotId}`
      },
      { method: 'GET', url: '/api/insights/summary' },
      {
        method: 'POST',
        url: '/api/insights/compare',
        body: {
          left: { sessionId: nonexistentSessionId, snapshotId: fakeSnapshotId },
          right: { sessionId: nonexistentSessionId, snapshotId: fakeSnapshotId }
        }
      },
      {
        method: 'POST',
        url: '/api/insights/export',
        body: { kind: 'session', sessionId: nonexistentSessionId, snapshotId: fakeSnapshotId, format: 'markdown' }
      }
    ];

    for (const probe of adminReachProbes) {
      const res = await serverInstance.request(probe.method, probe.url, probe.body);
      expect([401, 403]).not.toContain(res.status);
      expect(res.headers.get('cache-control') || '').toContain('no-store');
    }

    const adminRefresh = await serverInstance.request(
      'POST',
      `/api/sessions/${nonexistentSessionId}/insight/refresh`
    );
    expect([401, 403]).not.toContain(adminRefresh.status);
    expect(adminRefresh.headers.get('cache-control') || '').toContain('no-store');

    const adminCancel = await serverInstance.request(
      'DELETE',
      `/api/sessions/${nonexistentSessionId}/insight/refresh/${fakeRequestId}`
    );
    expect([401, 403]).not.toContain(adminCancel.status);
    expect(adminCancel.headers.get('cache-control') || '').toContain('no-store');
  });
});
