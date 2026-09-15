import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { agentConfigSchema, installationOwnerTaskActor, type RepositoryBundle, type Session } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { LarkGroupManager } from './group-management.js';
import { readLarkConfig, saveLarkConfig } from './config.js';
import type { LarkMessageEvent } from './listener.js';

describe('LarkGroupManager prepareTurn & commit contract', () => {
  let dir: string;
  let repos: RepositoryBundle;
  let manager: LarkGroupManager;
  let time: Date;
  let members: string[];
  let mockClient: any;
  const event: LarkMessageEvent = {
    messageId: 'om_start',
    chatId: 'oc_one',
    chatType: 'group',
    threadId: 'omt_one',
    rootId: 'om_root',
    messageType: 'text',
    content: '{"text":"hi"}',
    mentions: [],
    senderOpenId: 'ou_alice'
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dutydeck-group-turn-'));
    await mkdir(join(dir, 'one'));
    repos = createRepositories(join(dir, 'state.sqlite'));
    time = new Date('2026-09-07T00:00:00.000Z');
    members = ['ou_alice', 'ou_bob'];

    await repos.agents.save(
      agentConfigSchema.parse({
        id: 'agent_one',
        name: 'agent_one',
        command: process.execPath,
        cwd: dir,
        protocol: 'pipe'
      })
    );
    await saveLarkConfig(repos.config, repos.agents, {
      appId: 'cli_one',
      appSecret: 'synthetic_cli_one',
      defaultAgentId: 'agent_one',
      workspace: dir,
      fullTrustConfirmed: true,
      groupToolsEnabled: true,
      groupToolsAllowSend: true
    });

    mockClient = {
      getBotInfo: vi.fn(async () => ({ appName: 'cli_one', openId: 'ou_bot_cli_one' })),
      checkApplicationIdentity: vi.fn(async () => ({ verified: true, reportedAppId: 'cli_one', tenantKey: 'synthetic-tenant' })),
      listChats: vi.fn(async () => ({ items: [{ chatId: 'oc_one', name: '项目群', external: false }], hasMore: false })),
      listChatMembers: vi.fn(async () => ({
        items: members.map(openId => ({ memberId: openId, openId, name: openId, memberType: 'user' })),
        hasMore: false,
        securityLimited: false
      })),
      getUserEmails: vi.fn(async () => [])
    };

    manager = new LarkGroupManager(repos, {
      now: () => time,
      client: () => mockClient
    });

    await manager.sync('cli_one');
    // Save group config to establish binding
    await manager.save('cli_one', 'oc_one', {
      expectedRevision: 0,
      patch: { accessOverride: { mode: 'all_chat_members' } }
    });
  });

  afterEach(async () => {
    repos?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('proves prepareTurn does not modify run-context or activeOpenId, and commit switches actor', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-switch',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');

    // First turn with alice
    await manager.beginTurn(session.id, 'ou_alice');
    const initialRunRaw = await repos.config.get(`lark.run-context.${session.id}`);
    expect(initialRunRaw).toBeDefined();
    const initialRun = JSON.parse(initialRunRaw!);
    expect(initialRun.activeOpenId).toBe('ou_alice');

    // Prepare turn for bob
    const commit = await manager.prepareTurn(session.id, 'ou_bob');
    expect(typeof commit).toBe('function');

    // Verify prepareTurn did NOT change run-context
    const runAfterPrepare = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    expect(runAfterPrepare.activeOpenId).toBe('ou_alice');
    expect(runAfterPrepare).toEqual(initialRun);

    // Call commit
    await commit!();

    // Verify commit DID switch activeOpenId to bob
    const runAfterCommit = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    expect(runAfterCommit.activeOpenId).toBe('ou_bob');
  });

  it('ensures run-context remains unchanged while prepareTurn is pending asynchronously', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-pending',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');

    let prepareResolved = false;
    let resolveEntered!: () => void;
    const entered = {
      promise: new Promise<void>(resolve => {
        resolveEntered = resolve;
      }),
      resolve: () => resolveEntered()
    };
    let resolveStall!: () => void;
    const stall = {
      promise: new Promise<void>(resolve => {
        resolveStall = resolve;
      }),
      resolve: () => resolveStall()
    };

    mockClient.listChatMembers.mockImplementationOnce(async () => {
      entered.resolve();
      await stall.promise;
      return {
        items: members.map(openId => ({ memberId: openId, openId, name: openId, memberType: 'user' })),
        hasMore: false,
        securityLimited: false
      };
    });

    const preparePromise = manager.prepareTurn(session.id, 'ou_bob').then(res => {
      prepareResolved = true;
      return res;
    });

    // Wait until listChatMembers is actually entered
    await entered.promise;

    // Assert prepareTurn is still not settled
    expect(prepareResolved).toBe(false);

    // Verify that WHILE prepareTurn is pending, run-context has NOT changed
    const runDuringPending = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    expect(runDuringPending.activeOpenId).toBe('ou_alice');

    // Release stall
    stall.resolve();
    const commit = await preparePromise;

    // After prepare returns, still alice
    const runAfterPending = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    expect(runAfterPending.activeOpenId).toBe('ou_alice');

    // Only commit changes it
    await commit!();
    const runAfterCommit = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    expect(runAfterCommit.activeOpenId).toBe('ou_bob');
  });

  it('leaves identity unchanged when commit is never called', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-no-commit',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');

    // Prepare turn but drop commit
    const commit = await manager.prepareTurn(session.id, 'ou_bob');
    expect(commit).toBeDefined();

    // No commit called
    const currentRun = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    expect(currentRun.activeOpenId).toBe('ou_alice');
  });

  it('preserves other RunContext field changes made between prepare and commit', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-merge',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');

    const commit = await manager.prepareTurn(session.id, 'ou_bob');

    // Simulate concurrent update to revision, cwd, model between prepare and commit
    const current = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    current.revision = 42;
    current.cwd = '/updated/cwd';
    current.model = 'gpt-next';
    current.sourceId = 'cli_one:oc_one:group:thread:updated';
    await repos.config.set(`lark.run-context.${session.id}`, JSON.stringify(current));

    // Execute commit
    await commit!();

    const afterCommit = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    // activeOpenId switched to bob
    expect(afterCommit.activeOpenId).toBe('ou_bob');
    // other fields were NOT overwritten by prepare's stale snapshot
    expect(afterCommit.revision).toBe(42);
    expect(afterCommit.cwd).toBe('/updated/cwd');
    expect(afterCommit.model).toBe('gpt-next');
    expect(afterCommit.sourceId).toBe('cli_one:oc_one:group:thread:updated');
  });

  it('rejects commit if scope changed between prepare and commit', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-scope-change',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');

    const commit = await manager.prepareTurn(session.id, 'ou_bob');

    // Change scope chatId in DB
    const current = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    current.chatId = 'oc_different';
    await repos.config.set(`lark.run-context.${session.id}`, JSON.stringify(current));

    await expect(commit!()).rejects.toMatchObject({
      code: 'LARK_RUN_SCOPE_MISMATCH'
    });
  });

  it('rejects commit if run was deleted between prepare and commit, without reviving stale snapshot', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-deleted-run',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');

    const commit = await manager.prepareTurn(session.id, 'ou_bob');

    // Delete run-context
    const rawDb = new Database(join(dir, 'state.sqlite'));
    try {
      rawDb.prepare('DELETE FROM configs WHERE key = ?').run(`lark.run-context.${session.id}`);
    } finally {
      rawDb.close();
    }

    // Commit should reject with LARK_RUN_SCOPE_MISMATCH
    await expect(commit!()).rejects.toMatchObject({
      code: 'LARK_RUN_SCOPE_MISMATCH'
    });

    // Run context should NOT be resurrected
    expect(await repos.config.get(`lark.run-context.${session.id}`)).toBeUndefined();
  });

  it('creates RunContext only at commit for installation owner first entry', async () => {
    const session: Session = {
      id: 'session-owner-first',
      agentId: 'agent_one',
      cwd: dir,
      source: 'lark',
      sourceId: 'cli_one:oc_one:group:thread:om_root',
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await repos.sessions.save(session);

    // Prior to prepare, no run-context
    expect(await repos.config.get(`lark.run-context.${session.id}`)).toBeUndefined();

    const commit = await manager.prepareTurn(session.id, installationOwnerTaskActor);
    expect(typeof commit).toBe('function');

    // After prepare, STILL no run-context in DB
    expect(await repos.config.get(`lark.run-context.${session.id}`)).toBeUndefined();

    // Call commit
    await commit!();

    // Now RunContext is created and activeOpenId is set to installationOwnerTaskActor
    const createdRaw = await repos.config.get(`lark.run-context.${session.id}`);
    expect(createdRaw).toBeDefined();
    const created = JSON.parse(createdRaw!);
    expect(created.appId).toBe('cli_one');
    expect(created.chatId).toBe('oc_one');
    expect(created.activeOpenId).toBe(installationOwnerTaskActor);
  });

  it('handles installation owner first entry when matching run already exists at commit time', async () => {
    const session: Session = {
      id: 'session-owner-race',
      agentId: 'agent_one',
      cwd: dir,
      source: 'lark',
      sourceId: 'cli_one:oc_one:group:thread:om_root',
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await repos.sessions.save(session);

    const commit = await manager.prepareTurn(session.id, installationOwnerTaskActor);

    // In the meantime, another process recorded a matching run
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    await manager.recordRun(session, config, event, 'thread:om_root');
    const existing = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    existing.revision = 99;
    await repos.config.set(`lark.run-context.${session.id}`, JSON.stringify(existing));

    // Commit should merge activeOpenId and preserve revision: 99
    await commit!();

    const result = JSON.parse((await repos.config.get(`lark.run-context.${session.id}`))!);
    expect(result.activeOpenId).toBe(installationOwnerTaskActor);
    expect(result.revision).toBe(99);
  });

  it('rejects installation owner commit if mismatched run was inserted at commit time', async () => {
    const session: Session = {
      id: 'session-owner-mismatch-race',
      agentId: 'agent_one',
      cwd: dir,
      source: 'lark',
      sourceId: 'cli_one:oc_one:group:thread:om_root',
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await repos.sessions.save(session);

    const commit = await manager.prepareTurn(session.id, installationOwnerTaskActor);

    // In the meantime, an incompatible run with different chatId was inserted
    await repos.config.set(
      `lark.run-context.${session.id}`,
      JSON.stringify({
        appId: 'cli_one',
        chatId: 'oc_other_group',
        bindingId: 'diff_binding'
      })
    );

    await expect(commit!()).rejects.toMatchObject({
      code: 'LARK_RUN_SCOPE_MISMATCH'
    });
  });

  it('performs zero remote client requests during commit phase', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-remote-calls',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');
    await manager.beginTurn(session.id, 'ou_alice');

    const commit = await manager.prepareTurn(session.id, 'ou_bob');
    expect(commit).toBeDefined();

    // Clear all mock counts before calling commit
    mockClient.getBotInfo.mockClear();
    mockClient.checkApplicationIdentity.mockClear();
    mockClient.listChats.mockClear();
    mockClient.listChatMembers.mockClear();
    mockClient.getUserEmails.mockClear();

    // Execute commit
    await commit!();

    // Verify commit made zero remote requests
    expect(mockClient.getBotInfo).not.toHaveBeenCalled();
    expect(mockClient.checkApplicationIdentity).not.toHaveBeenCalled();
    expect(mockClient.listChats).not.toHaveBeenCalled();
    expect(mockClient.listChatMembers).not.toHaveBeenCalled();
    expect(mockClient.getUserEmails).not.toHaveBeenCalled();
  });

  it('maintains original error semantics: missing actor throws LARK_TASK_ACTOR_REQUIRED', async () => {
    const config = await manager.resolved((await readLarkConfig(repos.config, 'cli_one'))!, 'oc_one');
    const session: Session = {
      id: 'session-actor-required',
      agentId: 'agent_one',
      cwd: dir,
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await manager.recordRun(session, config, event, 'thread:om_root');

    await expect(manager.prepareTurn(session.id)).rejects.toMatchObject({
      code: 'LARK_TASK_ACTOR_REQUIRED'
    });
  });

  it('returns undefined for unmanaged sessions', async () => {
    const session: Session = {
      id: 'session-unmanaged',
      agentId: 'agent_one',
      cwd: dir,
      source: 'other',
      state: 'thinking',
      runId: 'run',
      createdAt: time.toISOString(),
      updatedAt: time.toISOString()
    };
    await repos.sessions.save(session);

    const commit = await manager.prepareTurn(session.id, 'ou_alice');
    expect(commit).toBeUndefined();
  });
});
