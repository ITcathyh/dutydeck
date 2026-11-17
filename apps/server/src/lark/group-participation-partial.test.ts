import { afterEach, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, resolveParticipation } from '@dutydeck/shared';
import { LarkGroupManager, registerLarkGroupManagementRoutes } from './group-management.js';
import { saveLarkConfig } from './config.js';
import { CollaborationService } from '../collaboration-service.js';
import { registerCollaborationRoutes } from '../collaboration-routes.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it('keeps the committed routing write after collaboration CAS fails and retries with the refreshed revision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-participation-partial-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repos = createRepositories(join(directory, 'state.sqlite'));
  cleanups.push(async () => repos.close());
  await repos.agents.save(agentConfigSchema.parse({ id: 'example-agent', name: 'Example', command: process.execPath, cwd: directory, protocol: 'pipe' }));
  await saveLarkConfig(repos.config, repos.agents, {
    appId: 'cli_test', appSecret: 'synthetic-only', defaultAgentId: 'example-agent', workspace: directory,
    fullTrustConfirmed: true, mentionPolicy: 'always'
  });
  const manager = new LarkGroupManager(repos, {
    client: config => ({
      getBotInfo: async () => ({ appName: 'Example', openId: 'ou_bot' }),
      checkApplicationIdentity: async () => ({ verified: true, reportedAppId: config.appId, tenantKey: 'synthetic-tenant' }),
      listChats: async () => ({ items: [{ chatId: 'oc_test', name: 'Test group', external: false }], hasMore: false }),
      listChatMembers: async () => ({ items: [], hasMore: false, securityLimited: false }),
      getUserEmails: async () => []
    }) as any
  });
  await manager.sync('cli_test');
  const service = new CollaborationService({ repositories: repos, authorize: async () => true });
  const app = Fastify();
  cleanups.push(() => app.close());
  app.setErrorHandler((error, _request, reply) => reply.code((error as any).statusCode ?? 500).send({ error: { code: (error as any).code, message: error.message } }));
  await registerLarkGroupManagementRoutes(app, manager);
  await registerCollaborationRoutes(app, {
    service, runtime: {} as any, tools: {} as any, authorizeManagement: async () => 'synthetic-owner',
    bootstrap: async () => {}, evaluation: {} as any, extensions: {} as any
  });
  const scope = { appId: 'cli_test', chatId: 'oc_test' };
  const initial = await repos.collaboration.updateSettings(scope, { expectedRevision: 0, participation: 'off' }, 'synthetic-owner');
  await repos.collaboration.updateSettings(scope, { expectedRevision: initial.revision, instructions: 'another editor' }, 'synthetic-owner');
  const first = await app.inject({
    method: 'PUT', url: '/api/lark/bots/cli_test/groups/oc_test',
    payload: { expectedRevision: 0, patch: { routingOverride: { groupReplyMode: { mode: 'inherit' }, mentionPolicy: { mode: 'set', value: 'topic' } } } }
  });
  expect(first.statusCode).toBe(200);
  const conflict = await app.inject({
    method: 'PATCH', url: '/api/lark/groups/cli_test/oc_test/collaboration/settings',
    payload: { expectedRevision: initial.revision, participation: 'eager' }
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error.code).toBe('COLLABORATION_REVISION_CONFLICT');
  const groups = (await app.inject('/api/lark/management/groups')).json();
  const actual = groups.groups.find((group: any) => group.chatId === 'oc_test').bots[0];
  const settings = await repos.collaboration.getSettings(scope);
  expect(actual.binding.routingOverride.mentionPolicy).toEqual({ mode: 'set', value: 'topic' });
  expect(settings.participation).toBe('off');
  expect(settings.instructions).toBe('another editor');
  expect(resolveParticipation({ mentionPolicy: actual.effective.routing.mentionPolicy.value, participation: settings.participation }).level).toBe('topic');
  const retry = await app.inject({
    method: 'PATCH', url: '/api/lark/groups/cli_test/oc_test/collaboration/settings',
    payload: { expectedRevision: settings.revision, participation: 'eager' }
  });
  expect(retry.statusCode).toBe(200);
  expect(resolveParticipation({ mentionPolicy: actual.effective.routing.mentionPolicy.value, participation: retry.json().settings.participation }).level).toBe('eager');
  expect(retry.json().settings.instructions).toBe('another editor');
});
