import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  agentConfigSchema, DriverDetachedError, installationOwnerTaskActor,
  type AgentDriver, type NormalizedDriverEvent, type RepositoryBundle, type Session
} from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { LarkGroupManager } from './group-management.js';
import { readLarkConfig, saveLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';
import { startLocalServer, type LocalServer } from '../service.js';

const APP_ID = 'cli_one';
const CHAT_ID = 'oc_one';
const ALICE = 'ou_alice';
const BOB = 'ou_bob';
const CAROL = 'ou_carol';
const runKey = (sessionId: string) => `lark.run-context.${sessionId}`;

const event: LarkMessageEvent = {
  messageId: 'om_start', chatId: CHAT_ID, chatType: 'group', threadId: 'omt_one', rootId: 'om_root',
  messageType: 'text', content: '{"text":"hi"}', mentions: [], senderOpenId: ALICE
};

interface FakeDriver extends AgentDriver {
  generation: number;
  sentPrompts: string[];
  complete: () => void;
}

interface Harness {
  dir: string;
  repos: RepositoryBundle;
  runtime: DutydeckRuntime;
  manager: LarkGroupManager;
  mockClient: any;
  drivers: FakeDriver[];
  session: Session;
  cleanup: () => Promise<void>;
}

async function setupHarness(members: string[] = [ALICE, BOB, CAROL]): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dutydeck-group-runtime-'));
  await mkdir(join(dir, 'one'), { recursive: true });
  const repos = createRepositories(join(dir, 'state.sqlite'), { newDatabaseAuthority: 'ledger_v1' });
  const time = new Date('2026-09-14T00:00:00.000Z');

  await repos.agents.save(agentConfigSchema.parse({
    id: 'agent_one', name: 'agent_one', command: process.execPath, cwd: dir, protocol: 'acp', permissionMode: 'ask'
  }));
  await saveLarkConfig(repos.config, repos.agents, {
    appId: APP_ID, appSecret: 'synthetic_cli_one', defaultAgentId: 'agent_one',
    workspace: dir, fullTrustConfirmed: true, groupToolsEnabled: true, groupToolsAllowSend: true
  });

  const mockClient: any = {
    getBotInfo: vi.fn(async () => ({ appName: 'cli_one', openId: 'ou_bot_cli_one' })),
    checkApplicationIdentity: vi.fn(async () => ({ verified: true, reportedAppId: APP_ID, tenantKey: 'synthetic-tenant' })),
    listChats: vi.fn(async () => ({ items: [{ chatId: CHAT_ID, name: '项目群', external: false }], hasMore: false })),
    listChatMembers: vi.fn(async () => ({
      items: members.map(openId => ({ memberId: openId, openId, name: openId, memberType: 'user' })),
      hasMore: false, securityLimited: false
    })),
    getUserEmails: vi.fn(async () => [])
  };

  const manager = new LarkGroupManager(repos, { now: () => time, client: () => mockClient });
  await manager.sync(APP_ID);
  await manager.save(APP_ID, CHAT_ID, { expectedRevision: 0, patch: { accessOverride: { mode: 'all_chat_members' } } });

  const drivers: FakeDriver[] = [];
  const factory = (_agent: any, _protocol: any, onEvent: (event: NormalizedDriverEvent) => void, _onExit: any, _sessionId: string) => {
    let finish: (() => void) | undefined;
    const driver: FakeDriver = {
      generation: drivers.length + 1,
      sentPrompts: [],
      start: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      send: vi.fn(async (prompt: string) => {
        driver.sentPrompts.push(prompt);
        await new Promise<void>((resolve, reject) => { finish = resolve; (driver as any).rejectSend = reject; });
      }),
      stop: vi.fn(async () => { (driver as any).rejectSend?.(new DriverDetachedError()); finish = undefined; }),
      isStopped: vi.fn(async () => true),
      resolvePermission: vi.fn(async () => true),
      complete() {
        onEvent({ type: 'text', data: { text: `answer-${driver.generation}` } });
        onEvent({ type: 'completed', data: { stopReason: 'end_turn' } });
        finish?.();
      }
    };
    drivers.push(driver);
    return driver;
  };

  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: factory as any,
    // 与 apps/server/src/service.ts 接线后的语义一致：非 work item 会话把 prepareTurn
    // 返回的可选 commit 交给 Runtime，由其短写序列在归属校验后执行。
    authorizeExecution: async (sessionId, actorId) => manager.prepareTurn(sessionId, actorId)
  });
  await runtime.initialize([{ ...(await repos.agents.get('agent_one'))!, protocol: 'acp' }]);

  const session = await runtime.start({
    agentId: 'agent_one', cwd: dir, source: 'lark',
    sourceId: `${APP_ID}:${CHAT_ID}:group:thread:om_root`, permissionMode: 'ask'
  });
  const config = await manager.resolved((await readLarkConfig(repos.config, APP_ID))!, CHAT_ID);
  await manager.recordRun(session, config, event, 'thread:om_root');
  await manager.beginTurn(session.id, ALICE);

  let closed = false;
  return {
    dir, repos, runtime, manager, mockClient, drivers, session,
    cleanup: async () => {
      if (closed) return;
      closed = true;
      await runtime.shutdown().catch(() => {});
      repos.close();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

describe('真实 Runtime + LarkGroupManager 群身份提交与停止/重启', () => {
  let h: Harness;
  beforeEach(async () => { h = await setupHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await h.cleanup(); });

  it('prepare 远端成员检查挂起时旧身份不变；stop/restart 后旧 commit 不执行，新操作者在新 run/driver 上执行', async () => {
    const id = h.session.id;
    const firstRunId = h.session.runId;

    // bob 的远端成员检查进入后挂起：prepare 未完成，commit 尚不存在。
    let prepareEntered = false;
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve; });
    h.mockClient.listChatMembers.mockImplementationOnce(async () => {
      prepareEntered = true;
      await prepareGate;
      return {
        items: [ALICE, BOB, CAROL].map(openId => ({ memberId: openId, openId, name: openId, memberType: 'user' })),
        hasMore: false, securityLimited: false
      };
    });

    const bobTurn = h.runtime.send(id, 'bob 的任务', undefined, undefined, BOB).then(
      task => ({ ok: true as const, task }), error => ({ ok: false as const, error })
    );
    await vi.waitFor(() => expect(prepareEntered).toBe(true));

    // prepare 挂起期间 activeOpenId 必须仍是 alice。
    expect(JSON.parse((await h.repos.config.get(runKey(id)))!).activeOpenId).toBe(ALICE);

    // stop 撤销旧生命周期；网络授权不占短写序列，停止不等待挂起的远端检查。
    await h.runtime.stop(id);
    const bobOutcome = await bobTurn;
    expect(bobOutcome.ok).toBe(false); if (!bobOutcome.ok) expect(bobOutcome.error).toMatchObject({ code: 'OPERATION_REVOKED' });

    // 释放旧授权的远端响应：prepare 此时才完成，但旧生命周期已撤销，
    // Runtime 绝不能执行它返回的 commit。
    releasePrepare();
    await new Promise(resolve => setImmediate(resolve));
    expect(JSON.parse((await h.repos.config.get(runKey(id)))!).activeOpenId).toBe(ALICE);

    // restart 产生新 runId 与新 driver。
    const restarted = await h.runtime.restart(id);
    expect(restarted.runId).not.toBe(firstRunId);
    expect(h.drivers).toHaveLength(2);
    expect(h.runtime.getDriver(id)).toBe(h.drivers[1]);

    // bob 在新运行上重新发起：prepare + commit 成功，真实 driver 收到该任务。
    const secondTurn = h.runtime.send(id, 'bob 的新任务', undefined, undefined, BOB);
    await vi.waitFor(() => expect(h.drivers[1]!.sentPrompts).toContain('bob 的新任务'));
    h.drivers[1]!.complete();
    await secondTurn;

    const run = JSON.parse((await h.repos.config.get(runKey(id)))!);
    expect(run.activeOpenId).toBe(BOB);
    expect((await h.runtime.getSession(id))?.runId).toBe(restarted.runId);
    const tasks = await h.runtime.getTasks(id);
    // 接受前被停止，因此不创建Task；重启后新任务 completed。
    expect(tasks.map(task => [task.prompt, task.status])).toEqual([
      ['bob 的新任务', 'completed']
    ]);
    // publicTask 不暴露 executionContext，操作者身份直接从持久任务记录核验。
    const stored = await h.repos.tasks.listBySession(id);
    expect(stored.map(task => [task.prompt, task.executionContext?.actorId])).toEqual([
      ['bob 的新任务', BOB]
    ]);
    // 旧 driver 从未执行 bob 被撤销的任务。
    expect(h.drivers[0]!.sentPrompts).toEqual([]);
  });

  it('已进入短序列的群 commit 写未完成时 stop 必须等待；释放后旧写落库、新 actor 的写不被覆盖', async () => {
    const id = h.session.id;

    // 在 commit 真正发起 config.set 的位置挂闸门：写操作已进入 Runtime 短序列，
    // 但持久化尚未完成。alice 的初始写入发生在挂闸门安装之前。
    let writeEntered = false;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const realSet = h.repos.config.set.bind(h.repos.config);
    const setSpy = vi.spyOn(h.repos.config, 'set').mockImplementation(async (key: string, value: string) => {
      if (key === runKey(id) && value.includes(BOB)) {
        writeEntered = true;
        await writeGate;
      }
      return realSet(key, value);
    });

    try {
      const bobTurn = h.runtime.send(id, 'bob 暂停中的任务', undefined, undefined, BOB).then(
        task => ({ ok: true as const, task }), error => ({ ok: false as const, error })
      );
      await vi.waitFor(() => expect(writeEntered).toBe(true));

      // commit 写挂起期间启动 stop：停止屏障排在同一条短写链之后，必须等待。
      let stopSettled = false;
      const stopping = h.runtime.stop(id).finally(() => { stopSettled = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(stopSettled).toBe(false);
      expect(stopSettled).toBe(false);

      // 释放写：已进入的本地写先完成，随后停止屏障放行并回收 driver。
      releaseWrite();
      await stopping;
      const bobOutcome = await bobTurn;
      expect(bobOutcome.ok).toBe(false); if (!bobOutcome.ok) expect(bobOutcome.error).toMatchObject({ code: 'OPERATION_REVOKED' });
      expect(JSON.parse((await h.repos.config.get(runKey(id)))!).activeOpenId).toBe(BOB);
      // bob 的任务在提交后、driver.send 前随旧生命周期撤销，未触达 driver。
      expect(h.drivers[0]!.sentPrompts).toEqual([]);

      // 新运行由 carol 执行：旧写（bob）不得迟到覆盖 carol 的身份。
      await h.runtime.restart(id);
      const carolTurn = h.runtime.send(id, 'carol 的任务', undefined, undefined, CAROL);
      await vi.waitFor(() => expect(h.drivers[1]!.sentPrompts).toContain('carol 的任务'));
      h.drivers[1]!.complete();
      await carolTurn;
      expect(JSON.parse((await h.repos.config.get(runKey(id)))!).activeOpenId).toBe(CAROL);
      await new Promise(resolve => setImmediate(resolve));
      expect(JSON.parse((await h.repos.config.get(runKey(id)))!).activeOpenId).toBe(CAROL);
    } finally {
      releaseWrite();
      setSpy.mockRestore();
    }
  });

  it('commit 时发现 RunContext 已被删除则拒绝，不复活旧快照且不触达 driver', async () => {
    const id = h.session.id;
    // send 后对 runKey 的读取依次为：prepareTurn 取 run（第 1 次）、authorize 校验归属
    // （第 2 次）、commit 复查当前值（第 3 次）。让 commit 的读取返回 undefined，
    // 精确模拟准备与提交之间原记录被删除。
    const realGet = h.repos.config.get.bind(h.repos.config);
    let runReads = 0;
    vi.spyOn(h.repos.config, 'get').mockImplementation(async (key: string) => {
      if (key === runKey(id)) { runReads += 1; if (runReads === 3) return undefined; }
      return realGet(key);
    });

    await expect(h.runtime.send(id, 'bob 越权任务', undefined, undefined, BOB)).rejects.toMatchObject({
      code: 'LARK_RUN_SCOPE_MISMATCH'
    });
    expect(h.drivers[0]!.send).not.toHaveBeenCalled();
    // commit 拒绝后不得复活/覆盖：真实记录仍是 alice 的活动身份。
    expect(JSON.parse((await h.repos.config.get(runKey(id)))!).activeOpenId).toBe(ALICE);
  });

  it('远端成员校验不通过时任务失败、driver 不发送、旧身份保持', async () => {
    await h.cleanup();
    // 群内只有 alice：bob 不是成员，其 turn.append 必须被拒绝。
    h = await setupHarness([ALICE]);
    const id = h.session.id;

    await expect(h.runtime.send(id, '外人任务', undefined, undefined, BOB)).rejects.toMatchObject({
      code: 'LARK_GROUP_POLICY_DENIED'
    });
    expect(h.drivers[0]!.send).not.toHaveBeenCalled();
    expect(JSON.parse((await h.repos.config.get(runKey(id)))!).activeOpenId).toBe(ALICE);
    const tasks = await h.runtime.getTasks(id);
    expect(tasks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 真实 service hook 接线（startLocalServer seam）：本地 fake 飞书 HTTP + 真实 ACP agent，
// 不 mock Runtime。验证 apps/server/src/service.ts 的 authorizeExecution 把 prepareTurn 的
// 可选 commit 交回 Runtime 短序列，而不是在 hook 内 beginTurn 自行提交。
// ---------------------------------------------------------------------------
describe('startLocalServer 真实 seam：群身份 commit 由 Runtime 短序列执行', () => {
  const APP = 'cli_seam';
  const CHAT = 'oc_seam';
  const BOB_MEMBER = 'ou_bob';

  afterEach(() => { vi.restoreAllMocks(); });

  async function startFakeLark(onBobMembers: () => Promise<void>) {
    let armed = false;
    const json = (response: ServerResponse, status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const members = () => ({ items: [{ member_id: BOB_MEMBER, open_id: BOB_MEMBER, name: 'Bob', member_type: 'user' }], has_more: false });
    const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const url = request.url ?? '';
      if (url.includes('/tenant_access_token/')) return json(response, 200, { code: 0, tenant_access_token: 't', expire: 7200 });
      if (url.includes('/bot/v3/info')) return json(response, 200, { code: 0, bot: { app_name: 'seam', open_id: 'ou_bot_seam' } });
      if (url.includes('/application/v6/applications/')) return json(response, 200, { code: 0, data: { app: { app_id: APP, tenant_key: 'seam-tenant' } } });
      if (url.includes('/im/v1/chats/') && url.includes('/members/list')) {
        // 只让 bob 那一轮（armed 之后）挂在远端成员检查上，安装者首轮与其余调用立即返回。
        if (armed) { armed = false; await onBobMembers(); }
        return json(response, 200, { code: 0, data: members() });
      }
      if (url.includes('/im/v1/chats')) return json(response, 200, { code: 0, data: { items: [{ chat_id: CHAT, name: 'seam 群', external: false }], has_more: false } });
      return json(response, 200, { code: 0, data: {} });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      server, baseUrl: `http://127.0.0.1:${port}`,
      armBobMemberCall: () => { armed = true; }
    };
  }

  it('prepare 挂起期间 stop：hook 不自行 beginTurn，commit 交回 Runtime 且撤销后不执行、身份不被污染', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-seam-'));
    await mkdir(join(root, 'ws'), { recursive: true });
    await writeFile(join(root, 'release'), 'ready');
    const lifecycleAgent = resolve('tests/fixtures/acp-lifecycle-agent.mjs');
    const database = join(root, 'dutydeck.db');
    const seedRepos = createRepositories(database, { newDatabaseAuthority: 'ledger_v1' });
    seedRepos.close();

    // bob 成员检查进入后挂起，直到测试显式放行。
    let bobMembersEntered = false;
    let releaseBobMembers!: () => void;
    const bobMembersGate = new Promise<void>(resolve => { releaseBobMembers = resolve; });
    const fake = await startFakeLark(async () => { bobMembersEntered = true; await bobMembersGate; });
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const probe = createServer();
      probe.once('error', rejectPort);
      probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => resolvePort((address as { port: number }).port)); });
    });

    // 确定性记录 hook 的授权路径，不靠时序：beginTurn 是“准备后自己提交”的旧路径，
    // prepareTurn 返回可选 commit、交回 Runtime 是新路径。两个 hook 调用都被各自 send
    // await 完成，因此测试末尾计数即最终值，不依赖迟到提交的时序。
    const realPrepareTurn = LarkGroupManager.prototype.prepareTurn;
    const prepareOutcomes: Array<Promise<{ actor?: string; hasCommit: boolean }>> = [];
    const beginTurnSpy = vi.spyOn(LarkGroupManager.prototype, 'beginTurn');
    vi.spyOn(LarkGroupManager.prototype, 'prepareTurn').mockImplementation(function (this: any, sessionId: string, actorId?: string) {
      const pending = realPrepareTurn.call(this, sessionId, actorId);
      prepareOutcomes.push(pending.then(
        (commit: unknown) => ({ actor: actorId, hasCommit: typeof commit === 'function' }),
        () => ({ actor: actorId, hasCommit: false })
      ));
      return pending;
    });

    let server: LocalServer | undefined;
    try {
      server = await startLocalServer({
        webRoot: root,
        env: {
          ...process.env, NODE_ENV: 'test', DUTYDECK_HOST: '127.0.0.1', DUTYDECK_PORT: String(port),
          DUTYDECK_DEFAULT_CWD: root, DUTYDECK_DATABASE_URL: database, DUTYDECK_AUTH: 'false',
          DUTYDECK_DISABLE_LARK_LISTENER: 'true', LARK_OPEN_API_BASE_URL: fake.baseUrl,
          DUTYDECK_AGENTS_JSON: JSON.stringify([{
            id: 'lifecycle-agent', name: 'Lifecycle Agent', command: process.execPath,
            args: [lifecycleAgent], protocol: 'acp', cwd: root, permissionMode: 'full-trust',
            env: { lifecycle_directory: root }, timeout: 30, capabilities: { pause: false, resume: true }
          }])
        }
      });
      const http = async (path: string, init?: RequestInit) => {
        const response = await fetch(`http://127.0.0.1:${server!.config.port}${path}`, {
          ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) }
        });
        return { status: response.status, body: await response.json().catch(() => ({})) };
      };

      expect((await http('/api/lark/config', { method: 'PUT', body: JSON.stringify({
        stage: 'agent', appId: APP, appSecret: 'seam-secret', defaultAgentId: 'lifecycle-agent',
        workspace: root, permissionMode: 'ask'
      }) })).status).toBe(200);
      expect((await http(`/api/lark/bots/${APP}/sync-groups`, { method: 'POST' })).status).toBe(200);
      expect((await http(`/api/lark/bots/${APP}/groups/${CHAT}`, {
        method: 'PUT', body: JSON.stringify({ expectedRevision: 0, patch: { accessOverride: { mode: 'all_chat_members' } } })
      })).status).toBe(200);

      const session = await server.runtime.start({
        agentId: 'lifecycle-agent', cwd: root, source: 'lark',
        sourceId: `${APP}:${CHAT}:group:thread:om_root`
      });
      const id = session.id;

      // 安装者首轮：prepareTurn 返回 commit，由 Runtime 短序列执行，RunContext 建立。
      await server.runtime.send(id, '安装者任务', undefined, undefined, installationOwnerTaskActor);
      await expect.poll(() => prepareOutcomes.length).toBeGreaterThanOrEqual(1);
      const ownerPrepare = await prepareOutcomes[0]!;
      expect(ownerPrepare.actor).toBe(installationOwnerTaskActor);
      expect(ownerPrepare.hasCommit).toBe(true);
      const inspector = createRepositories(database);
      try {
        expect(JSON.parse((await inspector.config.get(runKey(id)))!).activeOpenId).toBe(installationOwnerTaskActor);
      } finally { inspector.close(); }

      // bob 轮：prepare 在远端成员检查处挂起；stop 撤销生命周期后再放行远端响应。
      fake.armBobMemberCall();
      const bobTurn = server.runtime.send(id, 'bob 任务', undefined, undefined, BOB_MEMBER).then(
        () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })
      );
      await vi.waitFor(() => expect(bobMembersEntered).toBe(true));
      await server.runtime.stop(id);
      releaseBobMembers();
      const bobOutcome = await bobTurn;
      expect(bobOutcome.ok).toBe(false); if (!bobOutcome.ok) expect(bobOutcome.error).toMatchObject({ code: 'OPERATION_REVOKED' });

      // 确定等待 bob 的 prepareTurn 已把 commit 交回 Runtime（而非仍挂在网络上）。
      await vi.waitFor(() => expect(prepareOutcomes.length).toBeGreaterThanOrEqual(2));
      const bobPrepare = (await Promise.all(prepareOutcomes)).find(item => item.actor === BOB_MEMBER);
      expect(bobPrepare?.hasCommit).toBe(true);
      // service hook 全程不得走“准备后自己 beginTurn 提交”的旧路径。
      expect(beginTurnSpy).not.toHaveBeenCalled();

      // commit 已交回 Runtime，但生命周期在其执行前撤销：Runtime 必须丢弃它，身份保持安装者。
      const after = createRepositories(database);
      try {
        expect(JSON.parse((await after.config.get(runKey(id)))!).activeOpenId).toBe(installationOwnerTaskActor);
      } finally { after.close(); }
    } finally {
      releaseBobMembers?.();
      await server?.close();
      fake.server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
