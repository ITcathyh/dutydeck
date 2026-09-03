// Web 改版验收：一条命令跑完「不许弄坏」的三道闸 + 视觉 e2e 进度条。
//
// 用法：
//   node scripts/verify-redesign.mjs            全跑
//   node scripts/verify-redesign.mjs --quick    跳过 pnpm test 与 pnpm build（只跑 tsc + 视觉 e2e）
//   node scripts/verify-redesign.mjs --visual   只跑视觉 e2e
//
// 三道回归闸的基线（改版前实测，不要「修绿」）：
//   1. pnpm test → 2207 passed / 1 failed。那 1 个失败是
//      packages/acp-client/src/claude-launcher.test.ts，本机环境污染，与前端无关。
//      所以判据是「失败数 ≤ 1 且失败的就是它」，不是「0 failed」，也不是「恰好 N passed」
//      ——各队正在加测试，通过数只会涨，写死数字会在别人加测试时假红。
//   2. npx tsc -b apps/web → exit 0
//   3. pnpm build → exit 0
//
// 视觉 e2e 不参与「通过 / 失败」判定——它现在本来就该红，红转绿的条数是改版进度条。
// 脚本打印红/绿分布，退出码只看三道回归闸。

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const quick = args.has('--quick');
const visualOnly = args.has('--visual');

/** 本机已知失败，见 vitest 基线注释。 */
const KNOWN_FAILING_TEST = 'packages/acp-client/src/claude-launcher.test.ts';
/** 通过数下限。各队在加测试，所以是下限不是等号；掉到这个数以下说明有东西被删或整批变红。 */
const MIN_PASSING = 2200;

const run = (cmd, argv, opts = {}) => new Promise(done => {
  const child = spawn(cmd, argv, { cwd: ROOT, shell: false, ...opts });
  let out = '';
  child.stdout?.on('data', d => { out += d; });
  child.stderr?.on('data', d => { out += d; });
  child.on('close', code => done({ code, out }));
  child.on('error', err => done({ code: 1, out: String(err) }));
});

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 闸 1：单元测试 ────────────────────────────────────────────────────────────
if (!visualOnly && !quick) {
  console.log('\n[1/4] pnpm test');
  const { out } = await run('pnpm', ['test']);
  // vitest 打两行汇总，格式几乎一样：
  //   Test Files  1 failed | 155 passed (156)
  //        Tests  1 failed | 2207 passed | 7 skipped (2215)
  // 直接 match(/(\d+)\s+passed/) 会先命中 Test Files 那行的 155，把用例数当成文件数，
  // 于是 155 < 下限 → 假红。必须锚定到 "Tests" 那一行再取数。
  const testsLine = out.split('\n').find(l => /^\s*Tests\s+/.test(l)) ?? '';
  const passed = Number(testsLine.match(/(\d+)\s+passed/)?.[1] ?? -1);
  const failed = Number(testsLine.match(/(\d+)\s+failed/)?.[1] ?? 0);
  const onlyKnown = failed === 0 || (failed === 1 && out.includes(KNOWN_FAILING_TEST));
  record('单元测试', passed >= MIN_PASSING && onlyKnown,
    `${passed} passed / ${failed} failed${failed === 1 && onlyKnown ? '（已知环境污染，符合基线）' : ''}`);
} else {
  console.log('\n[1/4] pnpm test — 跳过');
}

// ── 闸 2：Web 类型检查 ────────────────────────────────────────────────────────
console.log('\n[2/4] tsc -b apps/web');
if (!visualOnly) {
  // tsc -b 会缓存 .tsbuildinfo，上一次通过后即使源码退化也可能直接返回 0。
  // 用 --force 绕开缓存，代价是每次多几秒。
  const { code, out } = await run('npx', ['tsc', '-b', 'apps/web', '--force', '--pretty', 'false']);
  record('Web 类型检查', code === 0, code === 0 ? 'exit 0' : out.split('\n').filter(Boolean).slice(0, 6).join(' / '));
} else {
  console.log('跳过');
}

// ── 闸 2.5：e2e 文案回查 ─────────────────────────────────────────────────────
console.log('\n[2.5/4] e2e 文案回查');
{
  /*
    这一闸不跑浏览器，只做字符串存在性比对，毫秒级，所以 --quick / --visual 都不跳过。

    它防的是「绿着说谎」的断言：locator 文案随产品改名失效后，`count()` 返回 0
    恰好等于期望值，断言恒真通过。2026-09-03 排查出 4 处这样的失效，全部出自本分支
    自己的两次改名。跑 e2e 是发现不了的——它本来就绿。
  */
  const { code, out } = await run('node', ['scripts/check-e2e-copy.mjs']);
  record('e2e 文案回查', code === 0, code === 0 ? '无失效文案' : out.split('\n').filter(Boolean).slice(0, 8).join(' / '));
}

// ── 闸 3：构建 ────────────────────────────────────────────────────────────────
console.log('\n[3/4] pnpm build');
if (!visualOnly && !quick) {
  const { code, out } = await run('pnpm', ['build']);
  record('构建', code === 0, code === 0 ? 'exit 0' : out.split('\n').filter(Boolean).slice(-6).join(' / '));
} else {
  console.log('跳过');
}

// ── 视觉 e2e：进度条，不参与通过判定 ──────────────────────────────────────────
console.log('\n[4/4] 视觉 e2e（进度条，不计入通过/失败）');
const reportPath = resolve(ROOT, 'tests/e2e/visual/results.json');
await rm(reportPath, { force: true });
const { out: visualOut } = await run('npx', [
  'playwright', 'test', '--config', 'tests/e2e/visual/playwright.config.ts',
  '--reporter', `json`
], { env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } });

let progress = null;
try {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const specs = [];
  const walk = suite => {
    for (const s of suite.specs ?? []) {
      // Playwright 把 skipped 的 spec 也标成 ok:true。改版进度条不能把「跳过」
      // 算成「已达成」——依赖顶栏存在的那几条在顶栏建好前是 skip，直接计绿会让
      // 进度条一开始就虚高。所以单独取出 status。
      const statuses = (s.tests ?? []).map(t => t.status);
      const skipped = statuses.length > 0 && statuses.every(st => st === 'skipped');
      specs.push({ title: s.title, ok: s.ok && !skipped, skipped });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const s of report.suites ?? []) walk(s);
  const green = specs.filter(s => s.ok);
  const red = specs.filter(s => !s.ok && !s.skipped);
  const skipped = specs.filter(s => s.skipped);
  // 标题里带 [红→绿] 的是改版目标；带 [绿] / [绿·护栏] 的是「不许弄坏」的护栏。
  const goals = specs.filter(s => s.title.includes('红→绿'));
  const guards = specs.filter(s => !s.title.includes('红→绿'));
  const brokenGuards = guards.filter(s => !s.ok && !s.skipped);
  progress = {
    total: specs.length, green: green.length, red: red.length, skipped: skipped.length,
    goalsDone: goals.filter(s => s.ok).length, goalsTotal: goals.length, brokenGuards
  };
  console.log(`\n  改版目标：${progress.goalsDone}/${progress.goalsTotal} 已达成`);
  console.log(`  护栏    ：${guards.filter(s => s.ok).length}/${guards.length} 保持绿`);
  if (skipped.length) console.log(`  跳过    ：${skipped.length}（前置条件未满足，不计入进度）`);
  if (brokenGuards.length) {
    console.log('\n  ⚠ 以下护栏断言变红了 —— 这些是「改版不许弄坏」的东西，需要看：');
    for (const g of brokenGuards) console.log(`    · ${g.title}`);
  }
  if (red.length) {
    console.log('\n  仍然红的：');
    for (const s of red) console.log(`    · ${s.title}`);
  }
  if (skipped.length) {
    console.log('\n  跳过的：');
    for (const s of skipped) console.log(`    · ${s.title}`);
  }
} catch {
  console.log('  （解析 Playwright 报告失败，原始输出末尾：）');
  console.log('  ' + visualOut.split('\n').filter(Boolean).slice(-5).join('\n  '));
}

// ── 结论 ─────────────────────────────────────────────────────────────────────
const gatesRan = results.length;
const gatesFailed = results.filter(r => !r.ok);
console.log('\n' + '─'.repeat(60));
console.log(`回归闸：${gatesRan - gatesFailed.length}/${gatesRan} 通过`);
if (progress) console.log(`改版进度：${progress.goalsDone}/${progress.goalsTotal}`);
// 护栏变红不阻断（改版中途可能短暂失衡），但要在退出码之外显式提醒。
if (progress?.brokenGuards.length) console.log(`⚠ ${progress.brokenGuards.length} 条护栏断言变红`);
process.exit(gatesFailed.length ? 1 : 0);
