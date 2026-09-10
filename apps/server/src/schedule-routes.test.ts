import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { registerScheduleManagementRoutes } from './schedule-routes.js';

const apps: FastifyInstance[] = [];
async function app(options: Parameters<typeof registerScheduleManagementRoutes>[1] = {}) {
  const instance = Fastify();
  instance.setErrorHandler((error, _request, reply) => error instanceof RuntimeError
    ? reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } })
    : reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: error.message } }));
  await registerScheduleManagementRoutes(instance, options);
  apps.push(instance);
  return instance;
}
afterEach(async () => { await Promise.all(apps.splice(0).map(instance => instance.close())); });

async function setup() {
  const repositories = createRepositories(':memory:');
  await repositories.secretRefs.create({ id: 'secret-routes', kind: 'generic', provider: 'keychain', referenceKey: 'fixture/routes', status: 'configured' });
  await repositories.channelBots.create({ id: 'bot-routes', channel: 'lark', externalAppId: 'cli_schedule_routes', displayName: 'Routes Bot', brand: 'feishu', credentialRef: 'secret-routes', state: 'staged' });
  return repositories;
}

const body = {
  id: 'schedule-routes', channelBotId: 'bot-routes', name: 'Morning review',
  trigger: { kind: 'cron', expression: '0 9 * * 1-5' }, timezone: 'Asia/Shanghai', dstPolicy: { gap: 'skip', overlap: 'first' },
  delivery: { mode: 'chat', chatRef: 'private_chat_ref', continuation: 'chat_root' }, payloadRef: 'private_payload_ref',
  identityRef: 'identity_routes', secretRef: 'secret-routes'
};

describe('Schedule disabled management routes', () => {
  it('reports machine-readable blocked capability when repositories are not injected', async () => {
    const instance = await app();
    const capabilities = await instance.inject({ method: 'GET', url: '/api/foundation/schedules/capabilities' });
    expect(capabilities.json()).toMatchObject({ repositoriesWired: false, executorWired: false, uiEntryReady: false, writesEnabled: false, readiness: 'repository_unwired' });
    expect(capabilities.json().blockers.map((item: { code: string }) => item.code)).toEqual(expect.arrayContaining(['schedule_repository_unwired', 'schedule_executor_unavailable', 'schedule_ui_entry_unwired']));
    expect((await instance.inject({ method: 'GET', url: '/api/foundation/schedules' })).json()).toMatchObject({ error: { code: 'SCHEDULE_REPOSITORY_UNWIRED' } });
  });

  it('creates, lists, edits and previews only staged/disabled schedules with blockers', async () => {
    const repositories = await setup();
    await repositories.archivedHammerIntegrations.create({ id: 'hammer-routes', channelBotId: 'bot-routes', sourceEnabled: true, mode: 'full', enforceGates: true, skillsInjection: 'prompt' });
    const instance = await app({ repositories, authorize: () => true });
    const created = await instance.inject({ method: 'POST', url: '/api/foundation/schedules', payload: body });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ definition: { revision: 1, state: 'staged', desiredExecutorState: 'disabled', sourceOwnership: 'dutydeck', sourceEnabled: false, secretRefConfigured: true }, readiness: { executionEligible: false } });
    expect(JSON.stringify(created.json())).not.toContain('private_chat_ref');
    expect(JSON.stringify(created.json())).not.toContain('private_payload_ref');
    const list = await instance.inject({ method: 'GET', url: '/api/foundation/schedules' });
    expect(list.json().schedules).toHaveLength(1);
    const preview = await instance.inject({ method: 'GET', url: '/api/foundation/schedules/schedule-routes/preview?after=2026-08-28T02%3A00%3A00.000Z' });
    expect(preview.json()).toMatchObject({ executionEligible: false, preview: { scheduledForUtc: '2026-08-31T01:00:00.000Z' } });
    expect(preview.json().blockers.map((item: { code: string }) => item.code)).toContain('schedule_executor_unavailable');
    const updated = await instance.inject({ method: 'PATCH', url: '/api/foundation/schedules/schedule-routes', payload: { expectedRevision: 1, name: 'Edited review', state: 'disabled' } });
    expect(updated.json()).toMatchObject({ definition: { revision: 2, name: 'Edited review', state: 'disabled', currentGeneration: 2 } });
    const integrations = await instance.inject({ method: 'GET', url: '/api/foundation/schedules/archived-integrations?channelBotId=bot-routes' });
    expect(integrations.json()).toEqual({ integrations: [expect.objectContaining({ kind: 'hammer', mode: 'full', enforceGates: true, skillsInjection: 'prompt', state: 'archived', executorState: 'unavailable', blockerCode: 'hammer_executor_unavailable' })] });
    repositories.close();
  });

  it('has no enable or run-now route and denies writes without an evaluator', async () => {
    const repositories = await setup();
    const instance = await app({ repositories });
    expect((await instance.inject({ method: 'POST', url: '/api/foundation/schedules', payload: body })).json()).toMatchObject({ error: { code: 'SCHEDULE_PERMISSION_EVALUATOR_UNWIRED' } });
    expect((await instance.inject({ method: 'POST', url: '/api/foundation/schedules/schedule-routes/enable' })).statusCode).toBe(404);
    expect((await instance.inject({ method: 'POST', url: '/api/foundation/schedules/schedule-routes/run-now' })).statusCode).toBe(404);
    const routes = instance.printRoutes();
    expect(routes).not.toContain('enable');
    expect(routes).not.toContain('run-now');
    repositories.close();
  });
});
