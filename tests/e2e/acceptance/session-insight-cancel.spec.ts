import { test, expect } from '@playwright/test';
import { existsSync, appendFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './harness.js';
import {
  launchSessionInsightTestServer,
  type SessionInsightTestEnvironment
} from './session-insight-harness.js';

// Load better-sqlite3 portably using createRequire anchored to packages/storage/package.json
const storageRequire = createRequire(resolve(REPO_ROOT, 'packages/storage/package.json'));
const Database = storageRequire('better-sqlite3');

interface DbSnapshot {
  tasks: any[];
  events: any[];
  usageLedger: any[];
}

function captureDbSnapshot(dbPath: string): DbSnapshot {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY id ASC').all();
    const events = db.prepare('SELECT * FROM events ORDER BY id ASC').all();
    // usage_ledger is mandatory after migration 34; query directly so missing table fails explicitly
    const usageLedger = db.prepare('SELECT * FROM usage_ledger ORDER BY id ASC').all();
    return { tasks, events, usageLedger };
  } finally {
    db.close();
  }
}

/**
 * 追加约 64MiB 合法 Codex response_item / message 记录。
 * 每行保持合法 JSONL 格式与 native 关联，不超 4MiB 单行上限，且绝非坏行。
 */
function append64MiBValidCodexRecords(filePath: string, nativeSessionId: string): number {
  const targetBytes = 64 * 1024 * 1024;
  const chunkTextSize = 64 * 1024; // 64 KiB 文本，单行远低于 4 MiB 限制
  const paddingText = 'A'.repeat(chunkTextSize);

  let writtenBytes = 0;
  let index = 0;
  const now = Date.now();

  const bufferChunks: string[] = [];
  let bufferSize = 0;

  while (writtenBytes < targetBytes) {
    const timestamp = new Date(now + index * 100).toISOString();
    const lineObj = {
      timestamp,
      ordinal: 1000 + index,
      type: 'response_item',
      payload: {
        type: 'message',
        id: `msg_cancel_test_${nativeSessionId.replace(/-/g, '').slice(0, 12)}_${index}`,
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: `CANCEL_BENCHMARK_TOKEN_STREAM_${index}_${paddingText}`
          }
        ],
        phase: 'commentary',
        internal_chat_message_metadata_passthrough: {
          turn_id: `turn_${nativeSessionId.replace(/-/g, '').slice(0, 12)}`,
          create_time: Math.floor(now / 1000) + index,
          content_item_kinds: ['assistant_stream']
        }
      },
      metadata: {
        client_authored: false,
        user_input_order: 10 + index
      }
    };
    const lineStr = JSON.stringify(lineObj) + '\n';
    bufferChunks.push(lineStr);
    const lineBytes = Buffer.byteLength(lineStr, 'utf8');
    bufferSize += lineBytes;
    writtenBytes += lineBytes;
    index++;

    if (bufferSize >= 8 * 1024 * 1024) {
      appendFileSync(filePath, bufferChunks.join(''), 'utf8');
      bufferChunks.length = 0;
      bufferSize = 0;
    }
  }

  if (bufferChunks.length > 0) {
    appendFileSync(filePath, bufferChunks.join(''), 'utf8');
  }

  return writtenBytes;
}

test.describe('Session Insight Refresh Cancellation E2E', () => {
  let env: SessionInsightTestEnvironment;

  test.beforeAll(async () => {
    env = await launchSessionInsightTestServer({
      prefix: 'dutydeck-acc-cancel-'
    });
  });

  test.afterAll(async () => {
    if (env?.instance) {
      await env.instance.cleanup();
    }
  });

  test('cancelling insight refresh preserves old snapshot, keeps task/usage ledger intact, and cleans temp files', async () => {
    test.setTimeout(120_000);

    // 1. 创建受控 Codex 会话并执行任务至 completed
    const session = await env.createSession('codex', 'VERIFY_SESSION_INSIGHT_CANCELLATION');
    const { sessionId, nativeSessionId, mainPath } = session;
    expect(sessionId).toBeTruthy();
    expect(nativeSessionId).toBeTruthy();
    expect(existsSync(mainPath)).toBe(true);

    // 2. 发起首次刷新，poll 等待至 succeeded 并持久化 oldSnapshot
    const firstRefreshRes = await env.instance.request(
      'POST',
      `/api/sessions/${sessionId}/insight/refresh`,
      {}
    );
    expect([200, 202]).toContain(firstRefreshRes.status);
    const firstRequestId = firstRefreshRes.json?.requestId;
    expect(firstRequestId).toBeTruthy();

    const refreshDeadline = Date.now() + 45_000;
    let oldSnapshotId: string | null = null;
    let initialDetails: any = null;

    while (Date.now() < refreshDeadline) {
      const detailsRes = await env.instance.request('GET', `/api/sessions/${sessionId}/insight`);
      expect(detailsRes.status).toBe(200);
      const state = detailsRes.json?.status?.refreshState;
      if (state === 'succeeded') {
        initialDetails = detailsRes.json;
        oldSnapshotId = detailsRes.json.status.currentSnapshotId;
        break;
      }
      expect(['queued', 'running', 'succeeded']).toContain(state);
      await new Promise(r => setTimeout(r, 200));
    }

    expect(initialDetails).toBeTruthy();
    expect(oldSnapshotId).toBeTruthy();
    expect(initialDetails.status.refreshState).toBe('succeeded');
    expect(initialDetails.summary).toBeTruthy();
    const oldSnapshotSummary = initialDetails.summary;

    // 3. 读取 SQLite dutydeck.db 全行快照 (tasks, events, usage_ledger)
    const dbPath = join(env.instance.dataDir, 'dutydeck.db');
    expect(existsSync(dbPath)).toBe(true);
    const dbSnapshotBefore = captureDbSnapshot(dbPath);
    expect(dbSnapshotBefore.tasks.length).toBeGreaterThan(0);

    // 4. 向 mainPath 追加约 64MiB 合法 Codex agent_message 记录
    const appendedBytes = append64MiBValidCodexRecords(mainPath, nativeSessionId);
    expect(appendedBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    const fileStat = statSync(mainPath);
    expect(fileStat.size).toBeGreaterThanOrEqual(64 * 1024 * 1024);

    // 5. POST 刷新必须返回 202 + requestId 非空，立即 DELETE 必须返回 200
    const secondRefreshRes = await env.instance.request(
      'POST',
      `/api/sessions/${sessionId}/insight/refresh`,
      {}
    );
    expect(secondRefreshRes.status).toBe(202);
    expect(secondRefreshRes.json?.cacheHit).toBe(false);
    const cancelRequestId = secondRefreshRes.json?.requestId;
    expect(cancelRequestId).toBeTruthy();

    const deleteRes = await env.instance.request(
      'DELETE',
      `/api/sessions/${sessionId}/insight/refresh/${cancelRequestId}`
    );
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.json?.success).toBe(true);

    // 6. poll 至 cancelled（不接受 succeeded 替代，强约束）
    const cancelPollDeadline = Date.now() + 45_000;
    let finalDetails: any = null;
    let reachedCancelled = false;

    while (Date.now() < cancelPollDeadline) {
      const detailsRes = await env.instance.request('GET', `/api/sessions/${sessionId}/insight`);
      expect(detailsRes.status).toBe(200);
      const state = detailsRes.json?.status?.refreshState;
      if (state === 'cancelled') {
        reachedCancelled = true;
        finalDetails = detailsRes.json;
        break;
      }
      // 不接受 succeeded 替代
      expect(state).not.toBe('succeeded');
      await new Promise(r => setTimeout(r, 200));
    }

    expect(reachedCancelled).toBe(true);
    expect(finalDetails).toBeTruthy();
    expect(finalDetails.status.refreshState).toBe('cancelled');

    // 7. assert old fixed summary / current pointer unchanged 仍然可读
    expect(finalDetails.status.currentSnapshotId).toBe(oldSnapshotId);
    expect(finalDetails.summary).toEqual(oldSnapshotSummary);

    // 显式指定 snapshotId 读取旧快照
    const explicitOldSnapshotRes = await env.instance.request(
      'GET',
      `/api/sessions/${sessionId}/insight?snapshotId=${oldSnapshotId}`
    );
    expect(explicitOldSnapshotRes.status).toBe(200);
    expect(explicitOldSnapshotRes.json?.status?.currentSnapshotId).toBe(oldSnapshotId);
    expect(explicitOldSnapshotRes.json?.summary).toEqual(oldSnapshotSummary);

    // 8. 等待并验证 private snapshot temp 目录已被清理
    const tmpBase = join(env.instance.dataDir, 'insight-tmp');
    const reqTempDir = join(tmpBase, cancelRequestId);

    const cleanupDeadline = Date.now() + 10_000;
    while (Date.now() < cleanupDeadline) {
      if (!existsSync(reqTempDir)) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    expect(existsSync(reqTempDir)).toBe(false);

    // 9. 验证任务与费用记录逐字/全行相等
    const dbSnapshotAfter = captureDbSnapshot(dbPath);
    expect(dbSnapshotAfter.tasks).toEqual(dbSnapshotBefore.tasks);
    expect(dbSnapshotAfter.events).toEqual(dbSnapshotBefore.events);
    expect(dbSnapshotAfter.usageLedger).toEqual(dbSnapshotBefore.usageLedger);
  });
});
