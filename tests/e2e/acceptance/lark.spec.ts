import { test } from './lark-fixture';

test.describe('synthetic lark extended suite', () => {
  test('e2e-lark-management: group discovery, permissions, and topic persistence', async ({ runLarkScenario }) => {
    await runLarkScenario({
      scriptName: 'e2e-lark-management.mts',
      scenarioDirName: 'scenario',
    });
  });

  test('e2e-lark-app-creation: default one-click app creation flow', async ({ runLarkScenario }) => {
    await runLarkScenario({
      scriptName: 'e2e-lark-app-creation.mts',
      scenarioDirName: 'scenario',
    });
  });

  test('e2e-lark-app-creation: pending-review app creation flow', async ({ runLarkScenario }) => {
    await runLarkScenario({
      scriptName: 'e2e-lark-app-creation.mts',
      scenarioDirName: 'scenario',
      extraEnv: {
        DUTYDECK_E2E_PENDING_REVIEW: '1',
      },
    });
  });
});
