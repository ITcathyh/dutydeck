import { defineConfig, devices } from '@playwright/test';

/**
 * 视觉 e2e 的独立配置。
 *
 * 刻意放在 `tests/e2e/visual/` 里而不是仓库根：根目录的 `vitest.config.ts` 已经把
 * `tests/**\/*.test.ts` 收进 node project，Playwright 用 `.spec.ts` 后缀 + 独立
 * testDir 与之完全不重叠，`pnpm test` 不会误跑浏览器用例。
 *
 * 服务绑外部主机名而不是 loopback，`127.0.0.1` 会 ERR_CONNECTION_REFUSED —— 见
 * fixtures.ts 的 BASE_URL。想指向别的实例时设 `DOCKMUX_E2E_BASE_URL`。
 *
 * 不配 webServer：dockmux 服务是常驻的，测试自己拉起会打断其他人的验证。
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // 断言的是全局主题与布局，用例之间只共享只读的服务状态，可以并行。
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  // 这些用例现在**本来就该红**（它们是验收标准不是回归测试），重试只会拖长时间。
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['json', { outputFile: 'results.json' }]] : [['list']],
  outputDir: './.artifacts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.DOCKMUX_E2E_BASE_URL ?? 'http://10.37.33.49:4310',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // 主题相关用例自己 emulateMedia，这里给一个确定的初值，避免受宿主机系统外观影响。
    colorScheme: 'light'
  }
});
