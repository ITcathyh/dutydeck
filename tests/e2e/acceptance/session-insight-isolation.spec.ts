import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import {
  launchSessionInsightTestServer,
  type SessionInsightTestEnvironment
} from './session-insight-harness.js';

test.describe('Session Insight Multi-Instance Isolation E2E', () => {
  let envA: SessionInsightTestEnvironment | undefined;
  let envB: SessionInsightTestEnvironment | undefined;

  test.afterAll(async () => {
    const cleanups: Promise<void>[] = [];
    if (envA?.instance) cleanups.push(envA.instance.cleanup());
    if (envB?.instance) cleanups.push(envB.instance.cleanup());
    await Promise.allSettled(cleanups);
  });

  test('isolates sources, events, exports and rejects cross-snapshot access across independent instances sharing native UUID', async () => {
    test.setTimeout(180_000);

    // 1. 创建 A/B 两个独立环境
    [envA, envB] = await Promise.all([
      launchSessionInsightTestServer({ prefix: 'dutydeck-acc-iso-a-' }),
      launchSessionInsightTestServer({ prefix: 'dutydeck-acc-iso-b-' })
    ]);

    const sharedNativeUuid = randomUUID();
    const canaryA = `canaryA${Date.now()}xyz1`;
    const canaryB = `canaryB${Date.now()}xyz2`;

    // 2. 分别创建会话，传递相同的 nativeSessionId
    const [sessionA, sessionB] = await Promise.all([
      envA.createSession('codex', 'TASK_PROMPT_ISOLATION_A', { nativeSessionId: sharedNativeUuid }),
      envB.createSession('codex', 'TASK_PROMPT_ISOLATION_B', { nativeSessionId: sharedNativeUuid })
    ]);

    expect(sessionA.nativeSessionId).toBe(sharedNativeUuid);
    expect(sessionB.nativeSessionId).toBe(sharedNativeUuid);

    // 3. 读取 mainPath 现有 JSONL，找到真实的 CommandExecution 失败记录并 clone 注入各 canary
    const injectFailedCommand = (mainPath: string, canary: string) => {
      const lines = readFileSync(mainPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l));

      const template = lines.find(
        (l: any) =>
          l.type === 'event_msg' &&
          l.payload?.type === 'item_completed' &&
          l.payload?.item?.type === 'CommandExecution' &&
          l.payload?.item?.exit_code === 1
      );
      if (!template) {
        throw new Error(`Failed to find failed CommandExecution template in ${mainPath}`);
      }

      const cloned = structuredClone(template);
      cloned.timestamp = new Date().toISOString();
      cloned.ordinal = lines.length;
      cloned.payload.item.id = `exec-${canary}`;
      cloned.payload.item.command = ['/usr/bin/zsh', '-lc', `echo ${canary} && exit 1`];
      cloned.payload.item.aggregated_output = canary;
      cloned.payload.item.stdout = canary;
      cloned.payload.item.stderr = canary;
      cloned.payload.item.formatted_output = canary;
      cloned.payload.item.status = 'failed';
      cloned.payload.item.exit_code = 1;

      appendFileSync(mainPath, JSON.stringify(cloned) + '\n', 'utf8');
    };

    injectFailedCommand(sessionA.mainPath, canaryA);
    injectFailedCommand(sessionB.mainPath, canaryB);

    // 4. 触发各自 refresh，轮询直到 refreshState=succeeded
    const [refreshResA, refreshResB] = await Promise.all([
      envA.instance.request('POST', `/api/sessions/${sessionA.sessionId}/insight/refresh`, {}),
      envB.instance.request('POST', `/api/sessions/${sessionB.sessionId}/insight/refresh`, {})
    ]);
    expect([200, 202]).toContain(refreshResA.status);
    expect([200, 202]).toContain(refreshResB.status);

    let detailsA: any;
    let detailsB: any;

    await expect.poll(async () => {
      const res = await envA!.instance.request('GET', `/api/sessions/${sessionA.sessionId}/insight`);
      detailsA = res.json;
      return detailsA?.status?.refreshState ?? '';
    }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe('succeeded');

    await expect.poll(async () => {
      const res = await envB!.instance.request('GET', `/api/sessions/${sessionB.sessionId}/insight`);
      detailsB = res.json;
      return detailsB?.status?.refreshState ?? '';
    }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe('succeeded');

    // 5. 校验 summary.sources 隔离性
    expect(detailsA.summary).toBeTruthy();
    expect(detailsB.summary).toBeTruthy();

    const snapshotIdA = detailsA.summary.snapshotId as string;
    const snapshotIdB = detailsB.summary.snapshotId as string;
    expect(snapshotIdA).toBeTruthy();
    expect(snapshotIdB).toBeTruthy();
    expect(snapshotIdA).not.toBe(snapshotIdB);

    const sourcesA = detailsA.summary.sources as any[];
    const sourcesB = detailsB.summary.sources as any[];
    expect(Array.isArray(sourcesA)).toBe(true);
    expect(Array.isArray(sourcesB)).toBe(true);
    expect(sourcesA.length).toBeGreaterThanOrEqual(1);
    expect(sourcesB.length).toBeGreaterThanOrEqual(1);

    const mainSourceA = sourcesA[0];
    const mainSourceB = sourcesB[0];
    expect(mainSourceA.sourceKey).toBeTruthy();
    expect(mainSourceB.sourceKey).toBeTruthy();

    // 跨实例 sourceKey 必须不同，严格隔离
    expect(mainSourceA.sourceKey).not.toBe(mainSourceB.sourceKey);

    // 6. GET events 检验：含自己 canary，绝不含对方 canary；且同 nativeSessionId 在事件层严格核验
    const [eventsResA, eventsResB] = await Promise.all([
      envA.instance.request('GET', `/api/sessions/${sessionA.sessionId}/insight/events?snapshotId=${snapshotIdA}&limit=200`),
      envB.instance.request('GET', `/api/sessions/${sessionB.sessionId}/insight/events?snapshotId=${snapshotIdB}&limit=200`)
    ]);

    expect(eventsResA.status).toBe(200);
    expect(eventsResB.status).toBe(200);

    const itemsA = eventsResA.json.items as any[];
    const itemsB = eventsResB.json.items as any[];
    expect(itemsA.length).toBeGreaterThan(0);
    expect(itemsB.length).toBeGreaterThan(0);

    // 针对 mainSourceKey 的事件，每一个 nativeSessionId 都 === sharedNativeUuid
    const mainItemsA = itemsA.filter(e => e.sourceKey === mainSourceA.sourceKey);
    const mainItemsB = itemsB.filter(e => e.sourceKey === mainSourceB.sourceKey);
    expect(mainItemsA.length).toBeGreaterThan(0);
    expect(mainItemsB.length).toBeGreaterThan(0);
    for (const item of mainItemsA) {
      expect(item.nativeSessionId).toBe(sharedNativeUuid);
    }
    for (const item of mainItemsB) {
      expect(item.nativeSessionId).toBe(sharedNativeUuid);
    }

    // 找到 canary 失败 event，核验其所属 sourceKey 与 nativeSessionId
    const canaryEventA = itemsA.find(e => JSON.stringify(e).includes(canaryA));
    expect(canaryEventA).toBeTruthy();
    expect(canaryEventA.sourceKey).toBe(mainSourceA.sourceKey);
    expect(canaryEventA.nativeSessionId).toBe(sharedNativeUuid);

    const canaryEventB = itemsB.find(e => JSON.stringify(e).includes(canaryB));
    expect(canaryEventB).toBeTruthy();
    expect(canaryEventB.sourceKey).toBe(mainSourceB.sourceKey);
    expect(canaryEventB.nativeSessionId).toBe(sharedNativeUuid);

    const eventsStrA = JSON.stringify(eventsResA.json);
    const eventsStrB = JSON.stringify(eventsResB.json);

    expect(eventsStrA).toContain(canaryA);
    expect(eventsStrA).not.toContain(canaryB);

    expect(eventsStrB).toContain(canaryB);
    expect(eventsStrB).not.toContain(canaryA);

    // 7. POST export (html) 检验：含自己 canary，绝不含对方 canary
    const [exportResA, exportResB] = await Promise.all([
      envA.instance.request('POST', '/api/insights/export', {
        kind: 'session',
        sessionId: sessionA.sessionId,
        snapshotId: snapshotIdA,
        format: 'html'
      }),
      envB.instance.request('POST', '/api/insights/export', {
        kind: 'session',
        sessionId: sessionB.sessionId,
        snapshotId: snapshotIdB,
        format: 'html'
      })
    ]);

    expect(exportResA.status).toBe(200);
    expect(exportResB.status).toBe(200);

    expect(exportResA.text).toContain(canaryA);
    expect(exportResA.text).not.toContain(canaryB);

    expect(exportResB.text).toContain(canaryB);
    expect(exportResB.text).not.toContain(canaryA);

    // 8. 跨快照拒绝检验：B 实例访问 A 快照必须被拒绝 (404 或 410)
    const crossDetailsRes = await envB.instance.request(
      'GET',
      `/api/sessions/${sessionB.sessionId}/insight?snapshotId=${snapshotIdA}`
    );
    expect([404, 410]).toContain(crossDetailsRes.status);

    const crossEventsRes = await envB.instance.request(
      'GET',
      `/api/sessions/${sessionB.sessionId}/insight/events?snapshotId=${snapshotIdA}&limit=200`
    );
    expect([404, 410]).toContain(crossEventsRes.status);

    const crossExportRes = await envB.instance.request(
      'POST',
      '/api/insights/export',
      {
        kind: 'session',
        sessionId: sessionB.sessionId,
        snapshotId: snapshotIdA,
        format: 'html'
      }
    );
    expect([404, 410]).toContain(crossExportRes.status);
  });
});
