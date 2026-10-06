import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import {
  launchSessionInsightTestServer,
  buildSessionMarker,
  type SessionInsightTestEnvironment
} from './session-insight-harness.js';

test.describe('Session Insight Harness & Controlled CLI Smoke', () => {
  let env: SessionInsightTestEnvironment;

  test.beforeAll(async () => {
    env = await launchSessionInsightTestServer({ prefix: 'dutydeck-acc-smoke-' });
  });

  test.afterAll(async () => {
    if (env?.instance) {
      await env.instance.cleanup();
    }
  });

  test('verifies 3-client agent registration and command/env configuration', async () => {
    const agentsRes = await env.instance.request('GET', '/api/agents');
    expect(agentsRes.status).toBe(200);
    const agents = agentsRes.json;
    expect(Array.isArray(agents)).toBe(true);

    const ids = agents.map((a: any) => a.id);
    expect(ids).toContain('claude-code');
    expect(ids).toContain('codex');
    expect(ids).toContain('traex');
  });

  test('creates controlled Claude session with real-native transcript, cwd-aligned main+subagent files and exact marker', async () => {
    test.setTimeout(60_000);
    const result = await env.createSession('claude', 'VERIFY_CLAUDE_CONTROLLED_SMOKE');

    expect(result.sessionId).toBeTruthy();
    expect(result.nativeSessionId).toBeTruthy();
    expect(result.nativeAgentId).toBeTruthy();

    expect(existsSync(result.mainPath)).toBe(true);
    // 真实子流命名 agent-<agentId>.jsonl
    expect(result.subagentPath!.split('/').pop()).toBe(`agent-${result.nativeAgentId}.jsonl`);
    expect(existsSync(result.subagentPath!)).toBe(true);

    const mainContent = readFileSync(result.mainPath, 'utf8');
    const subContent = readFileSync(result.subagentPath!, 'utf8');

    expect(mainContent).toContain(buildSessionMarker(result.sessionId));
    expect(mainContent).toContain('gemini-3.8-flash');
    expect(mainContent).toContain(result.nativeAgentId!);
    expect(subContent).toContain(result.nativeAgentId!);

    // cwd 必须对齐实例真实 sourceRepo（resolver 按此核验），不得残留 fixture 占位 cwd
    expect(mainContent).toContain(env.instance.sourceRepo);
    expect(mainContent).not.toContain('/workspace/test-sandbox');
    expect(subContent).toContain(env.instance.sourceRepo);
    expect(subContent).not.toContain('/workspace/test-sandbox');
  });

  test('creates controlled Codex session with real-native rollout and history marker', async () => {
    test.setTimeout(60_000);
    const result = await env.createSession('codex', 'VERIFY_CODEX_CONTROLLED_SMOKE');

    expect(existsSync(result.mainPath)).toBe(true);
    const rolloutContent = readFileSync(result.mainPath, 'utf8');
    expect(rolloutContent).toContain(result.nativeSessionId);
    expect(rolloutContent).toContain(buildSessionMarker(result.sessionId));
    expect(rolloutContent).toContain('gpt-6-astra');

    const historyFile = `${env.codexHome}/history.jsonl`;
    expect(existsSync(historyFile)).toBe(true);
    const historyContent = readFileSync(historyFile, 'utf8');
    expect(historyContent).toContain(result.nativeSessionId);
    expect(historyContent).toContain(buildSessionMarker(result.sessionId));
  });

  test('creates controlled TraeX session with real-native rollout and history marker', async () => {
    test.setTimeout(60_000);
    const result = await env.createSession('traex', 'VERIFY_TRAEX_CONTROLLED_SMOKE');

    expect(existsSync(result.mainPath)).toBe(true);
    const rolloutContent = readFileSync(result.mainPath, 'utf8');
    expect(rolloutContent).toContain(result.nativeSessionId);
    expect(rolloutContent).toContain('GPT-6-Astra');

    const historyFile = `${env.traeHome}/cli/history.jsonl`;
    expect(existsSync(historyFile)).toBe(true);
    const historyContent = readFileSync(historyFile, 'utf8');
    expect(historyContent).toContain(result.nativeSessionId);
    expect(historyContent).toContain(buildSessionMarker(result.sessionId));
  });

  test('pins a caller-supplied nativeSessionId for a single Codex session across return value, rollout and history', async () => {
    test.setTimeout(60_000);
    // 固定 nativeID：供跨实例 isolation spec 在真实 submit 前选同一 nativeID。
    // 绝不在同一 instance 建第二个同 nativeID 的 Codex session——rollout 文件名与 history
    // 都按 nativeID 寻址，会写穿同一来源造成 observed mismatch；这里只建单个核验。
    const fixedNativeId = '7c4f1a2b-8d3e-4a6b-9c5d-0e1f2a3b4c5d';
    const result = await env.createSession(
      'codex',
      'VERIFY_CODEX_PINNED_NATIVE_ID_SMOKE',
      { nativeSessionId: fixedNativeId }
    );

    // returned nativeSessionId 即调用方指定值（而非随机铸 UUID）
    expect(result.nativeSessionId).toBe(fixedNativeId);
    // rollout 文件名按 nativeID 寻址，证明 fixture 在真实 submit 前已按指定 ID 种入
    expect(result.mainPath.split('/').pop()).toContain(fixedNativeId);

    const rolloutLines = readFileSync(result.mainPath, 'utf8').trim().split('\n').map(JSON.parse);
    const sessionMeta = rolloutLines.find((l: any) => l.type === 'session_meta');
    expect(sessionMeta).toBeTruthy();
    expect(sessionMeta.payload.id).toBe(fixedNativeId);
    expect(sessionMeta.payload.session_id).toBe(fixedNativeId);
    expect(sessionMeta.payload.cwd).toBe(env.instance.sourceRepo);
    expect(readFileSync(result.mainPath, 'utf8')).toContain(buildSessionMarker(result.sessionId));

    // history.jsonl 被同 instance 其它 codex 会话追加，故按行定位固定 ID 的 marker 锚点
    const historyLines = readFileSync(`${env.codexHome}/history.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
    const pinnedHistory = historyLines.find((l: any) => l.session_id === fixedNativeId);
    expect(pinnedHistory).toBeTruthy();
    expect(pinnedHistory.text).toContain(buildSessionMarker(result.sessionId));
    // createSession 内部已轮询至 task completed（否则抛错），能返回即任务真实完成
  });

  test('real Go engine refresh reaches succeeded and resolves BOTH main and subagent sources', async () => {
    test.setTimeout(120_000);
    const result = await env.createSession('claude', 'VERIFY_CLAUDE_REFRESH_SOURCES');

    // 触发真实刷新（最终 Go binary + resolver，不使用 fake engine / mock API）
    const refreshRes = await env.instance.request(
      'POST',
      `/api/sessions/${result.sessionId}/insight/refresh`
    );
    expect([200, 202]).toContain(refreshRes.status);

    // 轮询至终态
    let state = '';
    await expect.poll(async () => {
      const res = await env.instance.request('GET', `/api/sessions/${result.sessionId}/insight`);
      state = res.json?.status?.refreshState ?? '';
      return state;
    }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toMatch(/succeeded|failed|cancelled|interrupted/);

    // 必须真实成功（cwd/身份/子流边界任一对不上都会 failed:no_verified_source）
    expect(state, `refresh did not succeed; engine/resolver rejected sources`).toBe('succeeded');

    const details = await env.instance.request('GET', `/api/sessions/${result.sessionId}/insight`);
    expect(details.status).toBe(200);
    expect(details.json.status.availability).toBe('complete');
    expect(details.json.summary).toBeTruthy();
    expect(details.json.summary.snapshotId).toBeTruthy();

    // 主 + 子流两个来源都被解析，且子流带真实 nativeAgentId
    const sources = details.json.summary.sources as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources.length).toBeGreaterThanOrEqual(2);

    const primary = sources.find(s => s.scopeRole === 'primary');
    const subagent = sources.find(s => s.scopeRole === 'subagent');
    expect(primary, 'must resolve a primary main source').toBeTruthy();
    expect(subagent, 'must resolve the subagent source').toBeTruthy();
    expect((subagent as any).streamIdentity).toMatchObject({
      kind: 'subagent',
      nativeAgentId: result.nativeAgentId
    });
    expect((primary as any).client).toBe('claude');
    expect((subagent as any).client).toBe('claude');
  });
});
