import { test } from './lark-fixture';

test.describe('synthetic lark extended suite', () => {
  test('e2e-lark-management: group discovery, permissions, and topic persistence', async ({ runLarkScenario }) => {
    await runLarkScenario({
      scriptName: 'e2e-lark-management.mts',
    });
  });

  test('e2e-lark-app-creation: default one-click app creation flow', async ({ runLarkScenario }) => {
    await runLarkScenario({
      scriptName: 'e2e-lark-app-creation.mts',
    });
  });

  test('e2e-lark-app-creation: pending-review app creation flow', async ({ runLarkScenario }) => {
    await runLarkScenario({
      scriptName: 'e2e-lark-app-creation.mts',
      extraEnv: {
        DUTYDECK_E2E_PENDING_REVIEW: '1',
      },
    });
  });

  test('e2e-lark-detail-login: admin one-time link opens the session page in a signed-out browser', async ({ runLarkScenario }) => {
    await runLarkScenario({
      scriptName: 'e2e-lark-detail-login.mts',
    });
  });
});
