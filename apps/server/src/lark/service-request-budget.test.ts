import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { createLarkCardService } from './service.js';

const env = { LARK_APP_ID: 'cli_budget', LARK_APP_SECRET: 'synthetic' };
afterEach(() => { vi.restoreAllMocks(); });

it('keeps each service budget separate when services nest', async () => {
  const first = createLarkCardService(env), second = createLarkCardService(env);
  await first.withRequestBudget(async outer => {
    await second.withRequestBudget(async inner => {
      expect(inner).not.toBe(outer);
      await first.withRequestBudget(async again => { expect(again).toBe(outer); });
      await second.withRequestBudget(async again => { expect(again).toBe(inner); });
    });
  });
  first.close(); second.close();
});

it('uses one AsyncLocalStorage for every service instance', async () => {
  const run = vi.spyOn(AsyncLocalStorage.prototype, 'run');
  for (let index = 0; index < 3; index++) {
    const service = createLarkCardService(env);
    await service.withRequestBudget(async () => {});
    service.close();
  }
  const storages = run.mock.contexts.filter((_, index) => run.mock.calls[index]![0] instanceof Map);
  expect(storages).toHaveLength(3);
  expect(new Set(storages).size).toBe(1);
});
