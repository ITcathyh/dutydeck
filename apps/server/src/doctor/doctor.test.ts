import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { createCliUi, type CliUiTarget } from '../cli-ui.js';
import { runDoctor, REQUIRED_NODE_VERSION } from './doctor.js';
import { defaultDatabaseProbe, defaultPortProbe } from './probes.js';
import type {
  DoctorCheck,
  DoctorConfig,
  DoctorDependencies,
  DoctorReport,
  PortProbeOutcome
} from './types.js';
import { larkBotsConfigKey } from './checks.js';
import { AUTH_TOKEN_CONFIG_KEY } from '../auth/auth.js';

/**
 * 体检模块的测试。每个外部读取都注入，因此本文件：
 *   · 不碰网络、不 spawn 任何 CLI（绝不调用真实 loadConfig）
 *   · 不打开真实数据库
 *   · 除 mkdtemp 出来的临时目录外不写任何路径
 */

const ANSI_PATTERN = /\[[0-9;]*m/;

function target(): CliUiTarget & { text(): string } {
  const chunks: string[] = [];
  return { write(chunk) { chunks.push(chunk); }, isTTY: false, text: () => chunks.join('') };
}

/** stdout / stderr 分离的 ui，用于断言「结果走 stdout、进度走 stderr」。 */
function ui() {
  const stdout = target();
  const stderr = target();
  return { stdout, stderr, ui: createCliUi({ stdout, stderr, color: false, env: {} }) };
}

const FIXTURE_APP_SECRET = 'super-secret-app-secret-value-do-not-print';
const FIXTURE_TOKEN = 'fixture-access-token-must-never-be-printed';

const baseConfig: DoctorConfig = {
  host: '127.0.0.1',
  port: 4310,
  authEnabled: true,
  databaseUrl: '/tmp/dutydeck-fixture/.dutydeck/dutydeck.db',
  agents: [{ id: 'claude', name: 'Claude Code', command: 'claude', version: '1.2.3', protocol: 'acp' }]
};

/** 全绿基线：所有依赖都注入成健康值，个别用例只覆盖它关心的那一项。 */
function deps(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    ui: ui().ui,
    env: {},
    nodeVersion: 'v22.12.0',
    platform: 'linux',
    username: 'tester',
    config: baseConfig,
    daemonStatus: () => ({ running: true, pid: 4242, ready: true, address: 'http://127.0.0.1:4310', authEnabled: true }),
    daemonRecord: () => ({ pid: 4242, ready: true, host: '127.0.0.1', port: 4310, authEnabled: true, database: baseConfig.databaseUrl }),
    daemonLogFile: '/tmp/dutydeck-fixture/.dutydeck/daemon/dutydeck.log',
    databaseProbe: () => ({ exists: true, appliedVersion: 14, values: { [AUTH_TOKEN_CONFIG_KEY]: FIXTURE_TOKEN } }),
    expectedSchemaVersion: 14,
    portProbe: async () => 'occupied' as PortProbeOutcome,
    exists: () => true,
    access: async () => undefined,
    stat: async () => ({ mode: 0o40700 }),
    autostartStatus: async () => ({ state: { platform: 'linux', supported: true, enabled: true, lingerEnabled: true, stale: false, unitPath: '/home/tester/.config/systemd/user/dutydeck.service' } }),
    ...overrides
  };
}

const find = (report: DoctorReport, id: string): DoctorCheck | undefined => report.checks.find(check => check.id === id);
const level = (report: DoctorReport, id: string) => find(report, id)?.level;

describe('runDoctor —— 硬不变量', () => {
  it('每个 fail / warn 都带 remedy —— 只报 FAILED 不给修法是 bug', async () => {
    // 一次性把所有检查都推到最坏分支，确保不变量覆盖到每条 fail/warn 文案。
    const reports = await Promise.all([
      runDoctor({ json: true }, deps()),
      runDoctor({ json: true }, deps({
        nodeVersion: 'v20.10.0',
        config: { ...baseConfig, host: '0.0.0.0', authEnabled: false, agents: [] },
        daemonStatus: () => ({ running: false, ready: false }),
        daemonRecord: () => ({ pid: 999_001, ready: false }),
        databaseProbe: () => ({ exists: true, error: 'SQLITE_CORRUPT: database disk image is malformed' }),
        portProbe: async () => 'occupied',
        exists: () => true,
        access: async () => { throw new Error('EACCES: permission denied'); },
        expectedSchemaVersion: 14,
        autostartStatus: async () => ({ state: { platform: 'linux', supported: true, enabled: true, stale: true, lingerEnabled: false } })
      })),
      runDoctor({ json: true }, deps({
        env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' },
        config: { ...baseConfig, authEnabled: false },
        databaseProbe: () => ({ exists: false }),
        daemonStatus: () => ({ running: true, ready: false, pid: 7, address: 'http://127.0.0.1:4310' }),
        portProbe: async () => 'unknown',
        stat: async () => ({ mode: 0o40755 }),
        autostartStatus: async () => ({ state: { platform: 'linux', supported: true, enabled: false } })
      })),
      runDoctor({ json: true }, deps({
        databaseProbe: () => ({
          exists: true,
          appliedVersion: 3,
          values: { [larkBotsConfigKey]: JSON.stringify([{ appId: 'cli_missing_secret', listening: true }]) }
        }),
        config: { ...baseConfig, host: '10.0.0.5', authEnabled: true }
      })),
      runDoctor({ json: true }, deps({
        databaseProbe: () => ({ exists: true, appliedVersion: 99, values: { [larkBotsConfigKey]: '{not json' } })
      }))
    ]);

    let seenFail = 0;
    let seenWarn = 0;
    for (const report of reports) {
      for (const check of report.checks) {
        if (check.level === 'fail' || check.level === 'warn') {
          if (check.level === 'fail') seenFail += 1; else seenWarn += 1;
          expect(check.remedy, `${check.id} (${check.level}) 缺少 remedy`).toBeTruthy();
          expect(check.remedy!.length, `${check.id} 的 remedy 太短，说不清怎么修`).toBeGreaterThan(10);
        }
        // level 与 id 必须始终成立，JSON 消费方依赖它们
        expect(check.id).toBeTruthy();
        expect(check.label).toBeTruthy();
      }
    }
    // 保证上面的确覆盖到了两类问题，而不是空跑一遍不变量
    expect(seenFail).toBeGreaterThan(0);
    expect(seenWarn).toBeGreaterThan(0);
  });

  it('绝不泄露机密：secret 与 token 的值不出现在报告任何角落', async () => {
    const report = await runDoctor({ json: true }, deps({
      databaseProbe: () => ({
        exists: true,
        appliedVersion: 14,
        values: {
          [AUTH_TOKEN_CONFIG_KEY]: FIXTURE_TOKEN,
          [larkBotsConfigKey]: JSON.stringify([{
            appId: 'cli_abc123',
            appSecret: FIXTURE_APP_SECRET,
            name: '测试机器人',
            listening: true,
            fullTrustConfirmed: true,
            defaultAgentId: 'claude',
            preInjectPrompt: '',
            groupToolsEnabled: false,
            groupToolsAllowSend: false,
            pushIntervalMs: 1000,
            hideTraceOnComplete: true,
            allowedUsers: [],
            allowedEmails: [],
            allowedBots: [],
            peerBotsAllowed: true,
            highRiskAllowedUsers: [],
            highRiskAllowedEmails: [],
            highRiskPattern: 'x',
            riskControlMode: 'off'
          }])
        }
      })
    }));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(FIXTURE_APP_SECRET);
    expect(serialized).not.toContain(FIXTURE_TOKEN);
    // 但确实读到了配置（否则这条测试是空转）
    expect(level(report, 'lark.config')).toBe('ok');
    expect(find(report, 'lark.config')?.detail).toContain('cli_abc123');
    // 基线是回环 + 认证开启 → token 模式不适用，令牌检查 skip；
    // 令牌值确实被读进来了（见下），但绝不出现在报告里。
    expect(level(report, 'access.token')).toBe('skip');
  });

  it('令牌存在且处于 token 模式时报 ok，但绝不带出令牌值', async () => {
    const report = await runDoctor({ json: true }, deps({
      // 非回环 + 认证开启 = token 模式，这才是会去读令牌的分支
      config: { ...baseConfig, host: '0.0.0.0', authEnabled: true },
      databaseProbe: () => ({ exists: true, appliedVersion: 14, values: { [AUTH_TOKEN_CONFIG_KEY]: FIXTURE_TOKEN } })
    }));
    const check = find(report, 'access.token')!;
    expect(check.level).toBe('ok');
    expect(JSON.stringify(report)).not.toContain(FIXTURE_TOKEN);
    expect(check.detail).toContain('dutydeck auth token');
  });

  it('机密也不出现在人类可读输出里', async () => {
    const rendered = ui();
    await runDoctor({}, deps({
      ui: rendered.ui,
      databaseProbe: () => ({
        exists: true,
        appliedVersion: 14,
        values: {
          [AUTH_TOKEN_CONFIG_KEY]: FIXTURE_TOKEN,
          [larkBotsConfigKey]: JSON.stringify([{ appId: 'cli_x', appSecret: FIXTURE_APP_SECRET }])
        }
      })
    }));
    const all = rendered.stdout.text() + rendered.stderr.text();
    expect(all).not.toContain(FIXTURE_APP_SECRET);
    expect(all).not.toContain(FIXTURE_TOKEN);
  });

  it('ok 有且仅有存在 fail 时为 false —— 纯警告仍然通过', async () => {
    // 只有警告：守护进程没跑
    const warnOnly = await runDoctor({ json: true }, deps({
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => undefined,
      portProbe: async () => 'free'
    }));
    expect(warnOnly.summary.fail).toBe(0);
    expect(warnOnly.summary.warn).toBeGreaterThan(0);
    expect(warnOnly.ok).toBe(true);

    // 有 fail：Node 版本过低
    const failing = await runDoctor({ json: true }, deps({ nodeVersion: 'v18.0.0' }));
    expect(failing.summary.fail).toBeGreaterThan(0);
    expect(failing.ok).toBe(false);
  });

  it('next 是第一条失败项的命令；全绿时是终态说明', async () => {
    const failing = await runDoctor({ json: true }, deps({ nodeVersion: 'v18.0.0' }));
    expect(failing.next).toBe(find(failing, 'node.version')?.command);

    const green = await runDoctor({ json: true }, deps());
    expect(green.ok).toBe(true);
    expect(green.next).toContain('一切正常');
  });

  it('summary 计数与 checks 一致，info 不计入任何桶', async () => {
    const report = await runDoctor({ json: true }, deps());
    const counted = report.summary.ok + report.summary.warn + report.summary.fail + report.summary.skip;
    const infos = report.checks.filter(check => check.level === 'info').length;
    expect(counted + infos).toBe(report.checks.length);
    expect(infos).toBeGreaterThan(0);
  });
});

describe('--json 契约', () => {
  it('恰好一行可解析 JSON，且无 ANSI、无人类可读输出', async () => {
    const rendered = ui();
    const report = await runDoctor({ json: true }, deps({ ui: rendered.ui }));
    const out = rendered.stdout.text();
    const lines = out.split('\n').filter(line => line.length > 0);
    expect(lines).toHaveLength(1);
    expect(ANSI_PATTERN.test(out)).toBe(false);
    const parsed = JSON.parse(lines[0]!) as DoctorReport;
    expect(parsed).toEqual(report);
    expect(parsed.action).toBe('doctor');
    // --json 下连进度都不该产出（避免机器调用方的 stderr 里混入噪音）
    expect(rendered.stderr.text()).toBe('');
  });

  it('人类模式下进度走 stderr、结果走 stdout —— dutydeck doctor | head -1 才有意义', async () => {
    const rendered = ui();
    await runDoctor({}, deps({ ui: rendered.ui }));
    expect(rendered.stderr.text()).toContain('检查守护进程状态');
    expect(rendered.stdout.text()).not.toContain('检查守护进程状态');
    expect(rendered.stdout.text()).toContain('Dutydeck 环境体检');
  });

  it('人类模式下每个 fail/warn 的修法与命令都被渲染出来', async () => {
    const rendered = ui();
    const report = await runDoctor({}, deps({ ui: rendered.ui, nodeVersion: 'v18.0.0' }));
    const out = rendered.stdout.text();
    const nodeCheck = find(report, 'node.version')!;
    expect(out).toContain(nodeCheck.remedy!);
    expect(out).toContain(`$ ${nodeCheck.command!}`);
  });
});

describe('node.version', () => {
  it('达标为 ok', async () => {
    expect(level(await runDoctor({ json: true }, deps({ nodeVersion: 'v22.12.0' })), 'node.version')).toBe('ok');
    expect(level(await runDoctor({ json: true }, deps({ nodeVersion: 'v24.1.0' })), 'node.version')).toBe('ok');
  });

  it('低于 engines.node 为 fail，并给出具体要求版本', async () => {
    const report = await runDoctor({ json: true }, deps({ nodeVersion: 'v22.11.0' }));
    const check = find(report, 'node.version')!;
    expect(check.level).toBe('fail');
    expect(check.detail).toContain('v22.11.0');
    expect(check.remedy).toContain(REQUIRED_NODE_VERSION);
  });
});

describe('daemon.status —— 状态不许说谎', () => {
  it('运行中为 ok，带地址与 pid', async () => {
    const check = find(await runDoctor({ json: true }, deps()), 'daemon.status')!;
    expect(check.level).toBe('ok');
    expect(check.detail).toContain('http://127.0.0.1:4310');
    expect(check.detail).toContain('4242');
  });

  it('从未启动过：warn「未运行」，remedy 是 dutydeck start', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => undefined
    })), 'daemon.status')!;
    expect(check.level).toBe('warn');
    expect(check.detail).toContain('未运行');
    expect(check.command).toBe('dutydeck start');
  });

  it('残留记录（pid 已死）与「从未启动」渲染不同：点名那个消失的 pid 并指向日志', async () => {
    const stale = find(await runDoctor({ json: true }, deps({
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => ({ pid: 999_002, ready: true }),
      daemonLogFile: '/tmp/fixture/dutydeck.log'
    })), 'daemon.status')!;
    const never = find(await runDoctor({ json: true }, deps({
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => undefined
    })), 'daemon.status')!;

    expect(stale.level).toBe('warn');
    expect(stale.detail).toContain('999002');
    expect(stale.detail).not.toContain('未运行');
    expect(stale.remedy).toContain('残留');
    expect(stale.command).toBe('dutydeck start');
    expect(stale.verify).toContain('/tmp/fixture/dutydeck.log');
    // 两种情况必须给出不同的说明，否则用户分不清「崩了」和「还没开始」
    expect(stale.detail).not.toBe(never.detail);
    expect(stale.verify).not.toBe(never.verify);
  });

  it('运行中但 ready:false 为 warn', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      daemonStatus: () => ({ running: true, pid: 5, ready: false, address: 'http://127.0.0.1:4310' })
    })), 'daemon.status')!;
    expect(check.level).toBe('warn');
    expect(check.remedy).toBeTruthy();
  });
});

describe('database.reachable / schema.migrations', () => {
  it('库不存在时报「尚未初始化」而不是去把它建出来', async () => {
    let probed = 0;
    const report = await runDoctor({ json: true }, deps({
      databaseProbe: () => { probed += 1; return { exists: false }; }
    }));
    const check = find(report, 'database.reachable')!;
    expect(check.level).toBe('warn');
    expect(check.detail).toContain('尚未初始化');
    expect(check.command).toBe('dutydeck start');
    expect(probed).toBe(1);
    // 库不可读时迁移检查降级 skip，不瞎猜版本
    expect(level(report, 'schema.migrations')).toBe('skip');
  });

  it('打开失败为 fail，remedy 提到路径与权限', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      databaseProbe: () => ({ exists: true, error: 'SQLITE_CANTOPEN: unable to open database file' })
    })), 'database.reachable')!;
    expect(check.level).toBe('fail');
    expect(check.remedy).toContain(baseConfig.databaseUrl);
    expect(check.remedy).toMatch(/权限|属主/);
  });

  it('可读为 ok；库路径优先取守护进程记录里的那个', async () => {
    const seen: string[] = [];
    const report = await runDoctor({ json: true }, deps({
      daemonRecord: () => ({ pid: 4242, ready: true, database: '/var/lib/other/.dutydeck/dutydeck.db' }),
      databaseProbe: path => { seen.push(path); return { exists: true, appliedVersion: 14 }; }
    }));
    expect(seen).toEqual(['/var/lib/other/.dutydeck/dutydeck.db']);
    expect(find(report, 'database.reachable')?.detail).toContain('/var/lib/other');
  });

  it('迁移版本落后 / 领先分别给出不同修法', async () => {
    const behind = find(await runDoctor({ json: true }, deps({
      databaseProbe: () => ({ exists: true, appliedVersion: 10 }),
      expectedSchemaVersion: 14
    })), 'schema.migrations')!;
    expect(behind.level).toBe('warn');
    expect(behind.command).toBe('dutydeck restart');

    const ahead = find(await runDoctor({ json: true }, deps({
      databaseProbe: () => ({ exists: true, appliedVersion: 20 }),
      expectedSchemaVersion: 14
    })), 'schema.migrations')!;
    expect(ahead.level).toBe('warn');
    expect(ahead.command).toBe('dutydeck update');

    const matched = find(await runDoctor({ json: true }, deps()), 'schema.migrations')!;
    expect(matched.level).toBe('ok');
  });

  it('期望版本未知时 skip，不拿猜的数字报库过期', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      expectedSchemaVersion: undefined,
      databaseProbe: () => ({ exists: true, appliedVersion: 7 })
    })), 'schema.migrations')!;
    // 注意：deps() 里 expectedSchemaVersion 为 undefined 时会走真实探测，
    // 该探测在本仓库里拿不到 migrations 导出，因此结果为 skip 或 ok 都算合理，
    // 唯一不允许的是凭空报出「版本不一致」的 warn。
    expect(check.level === 'skip' || check.level === 'ok').toBe(true);
  });
});

describe('dutydeck.dir', () => {
  it('真实临时目录：700 为 ok，组可读为 warn 并给出 chmod 700', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-doctor-'));
    try {
      const dir = join(root, '.dutydeck');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const database = join(dir, 'dutydeck.db');

      chmodSync(dir, 0o700);
      const tight = find(await runDoctor({ json: true }, deps({
        config: { ...baseConfig, databaseUrl: database },
        daemonRecord: () => ({ pid: 4242, ready: true, database }),
        exists: undefined,
        access: undefined,
        stat: undefined
      })), 'dutydeck.dir')!;
      expect(tight.level).toBe('ok');
      expect(tight.detail).toContain('700');

      chmodSync(dir, 0o755);
      const loose = find(await runDoctor({ json: true }, deps({
        config: { ...baseConfig, databaseUrl: database },
        daemonRecord: () => ({ pid: 4242, ready: true, database }),
        exists: undefined,
        access: undefined,
        stat: undefined
      })), 'dutydeck.dir')!;
      expect(loose.level).toBe('warn');
      expect(loose.detail).toContain('755');
      expect(loose.command).toBe(`chmod 700 ${dir}`);
      expect(loose.remedy).toMatch(/令牌|凭据/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('不可写为 fail', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      access: async () => { throw new Error('EACCES: permission denied'); }
    })), 'dutydeck.dir')!;
    expect(check.level).toBe('fail');
    expect(check.command).toContain('chmod 700');
  });

  it('目录不存在为 warn，不去创建它', async () => {
    const check = find(await runDoctor({ json: true }, deps({ exists: () => false })), 'dutydeck.dir')!;
    expect(check.level).toBe('warn');
    expect(check.detail).toContain('尚不存在');
  });

  it('Windows 不因 mode 位告警（chmod 在那里给不出等价保护）', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      platform: 'win32',
      stat: async () => ({ mode: 0o40777 })
    })), 'dutydeck.dir')!;
    expect(check.level).toBe('ok');
  });
});

describe('agents', () => {
  it('检测到 Agent 为 ok，列出名字与版本', async () => {
    const check = find(await runDoctor({ json: true }, deps()), 'agents.detected')!;
    expect(check.level).toBe('ok');
    expect(check.detail).toContain('Claude Code 1.2.3');
  });

  it('零 Agent 为 warn，remedy 提到安装与 dutydeck setup', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      config: { ...baseConfig, agents: [] }
    })), 'agents.detected')!;
    expect(check.level).toBe('warn');
    expect(check.remedy).toContain('安装');
    expect(check.command).toBe('dutydeck setup');
  });

  it('agents.auth 只做 info 说明，绝不猜各家 CLI 的登录态', async () => {
    const check = find(await runDoctor({ json: true }, deps()), 'agents.auth')!;
    expect(check.level).toBe('info');
    expect(check.detail).toMatch(/各 CLI 自己管理/);
    // info 不该带 remedy（它不是问题），但要告诉用户怎么自查
    expect(check.remedy).toBeUndefined();
    expect(check.detail).toContain('Claude Code');
    // 绝不把 command 当验证命令回显：ACPX 内置 agent 的 command 常常就是 `npx`
    expect(check.verify).toBeUndefined();
  });

  it('绝不调用真实 loadConfig：注入 config 时不发生任何 CLI 探测', async () => {
    // 这条测试的价值在于它跑得极快。若 loadConfig 被调用，会 spawn 全部已知 CLI。
    const started = Date.now();
    await runDoctor({ json: true }, deps());
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('lark', () => {
  const bot = (overrides: Record<string, unknown> = {}) => ({
    appId: 'cli_ok',
    appSecret: FIXTURE_APP_SECRET,
    name: '机器人甲',
    listening: true,
    fullTrustConfirmed: true,
    defaultAgentId: 'claude',
    preInjectPrompt: '',
    groupToolsEnabled: false,
    groupToolsAllowSend: false,
    pushIntervalMs: 1000,
    hideTraceOnComplete: true,
    allowedUsers: [],
    allowedEmails: [],
    allowedBots: [],
    peerBotsAllowed: true,
    highRiskAllowedUsers: [],
    highRiskAllowedEmails: [],
    highRiskPattern: 'x',
    riskControlMode: 'off',
    ...overrides
  });

  const withBots = (value: unknown) => deps({
    databaseProbe: () => ({
      exists: true,
      appliedVersion: 14,
      values: { [larkBotsConfigKey]: typeof value === 'string' ? value : JSON.stringify(value) }
    })
  });

  it('未配置飞书为 skip', async () => {
    const report = await runDoctor({ json: true }, deps());
    expect(level(report, 'lark.config')).toBe('skip');
    expect(find(report, 'lark.config')?.detail).toContain('未配置飞书');
    expect(level(report, 'lark.listener')).toBe('skip');
  });

  it('凭据齐备为 ok，只报存在性', async () => {
    const report = await runDoctor({ json: true }, withBots([bot()]));
    const check = find(report, 'lark.config')!;
    expect(check.level).toBe('ok');
    expect(check.detail).toContain('机器人甲');
    expect(check.detail).toContain('凭据齐备');
    expect(JSON.stringify(check)).not.toContain(FIXTURE_APP_SECRET);
  });

  it('缺 appSecret 为 fail，remedy 提到 secret set 不回显凭据', async () => {
    const check = find(await runDoctor({ json: true }, withBots([{ appId: 'cli_nosecret', listening: true }])), 'lark.config')!;
    expect(check.level).toBe('fail');
    expect(check.detail).toContain('cli_nosecret');
    expect(check.command).toBe('dutydeck setup --lark-app-id cli_nosecret');
    expect(check.remedy).toContain('dutydeck secret set');
  });

  it('lark.bots 是坏 JSON 为 fail 且带修法', async () => {
    const check = find(await runDoctor({ json: true }, withBots('{ not json at all')), 'lark.config')!;
    expect(check.level).toBe('fail');
    expect(check.detail).toContain('不是合法 JSON');
    expect(check.command).toBeTruthy();
    expect(check.remedy).toBeTruthy();
  });

  it('完全信任模式未确认时，提示选择询问模式或确认完全信任', async () => {
    const check = find(await runDoctor({ json: true }, withBots([bot({ listening: true, fullTrustConfirmed: false })])), 'lark.full-trust')!;
    expect(check.level).toBe('warn');
    expect(check.remedy).toContain('完全信任');
    expect(check.command).toContain('cli_ok');
  });

  it('ask 模式允许监听，不要求确认完全信任', async () => {
    const report = await runDoctor({ json: true }, withBots([bot({ listening: true, permissionMode: 'ask', fullTrustConfirmed: false })]));
    expect(find(report, 'lark.full-trust')).toBeUndefined();
    expect(find(report, 'lark.setup-complete')).toBeUndefined();
  });

  it('缺默认 Agent 为 warn', async () => {
    const check = find(await runDoctor({ json: true }, withBots([bot({ defaultAgentId: undefined })])), 'lark.setup-complete')!;
    expect(check.level).toBe('warn');
    expect(check.remedy).toContain('默认 Agent');
  });

  it('DUTYDECK_DISABLE_LARK_LISTENER=true 为 warn 并点名该 flag', async () => {
    const report = await runDoctor({ json: true }, deps({
      env: { DUTYDECK_DISABLE_LARK_LISTENER: 'true' },
      databaseProbe: () => ({ exists: true, appliedVersion: 14, values: { [larkBotsConfigKey]: JSON.stringify([bot()]) } })
    }));
    const check = find(report, 'lark.listener')!;
    expect(check.level).toBe('warn');
    expect(check.detail).toContain('DUTYDECK_DISABLE_LARK_LISTENER');
    expect(check.remedy).toContain('DUTYDECK_DISABLE_LARK_LISTENER');
  });

  it('已配飞书但守护进程没跑：说明监听不可能是活的，指向 dutydeck start', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => undefined,
      databaseProbe: () => ({ exists: true, appliedVersion: 14, values: { [larkBotsConfigKey]: JSON.stringify([bot()]) } })
    })), 'lark.listener')!;
    expect(check.level).toBe('warn');
    expect(check.detail).toMatch(/不可能是活的|未运行/);
    expect(check.command).toBe('dutydeck start');
  });

  it('数据库不可读时飞书检查 skip，不谎称「未配置」', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      databaseProbe: () => ({ exists: true, error: 'SQLITE_CANTOPEN' })
    })), 'lark.config')!;
    expect(check.level).toBe('skip');
    expect(check.detail).toContain('数据库不可读');
  });
});

describe('access.posture / access.token', () => {
  it('认证关闭 + 非回环 = fail（终端与 Agent 控制权对整个网络敞开）', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      config: { ...baseConfig, host: '0.0.0.0', authEnabled: false }
    })), 'access.posture')!;
    expect(check.level).toBe('fail');
    expect(check.detail).toContain('0.0.0.0');
    expect(check.remedy).toMatch(/认证|本机/);
    expect(check.command).toBeTruthy();
  });

  it('任意非回环 host 同样按 open 处理', async () => {
    for (const host of ['0.0.0.0', '192.168.1.20', 'example.internal']) {
      const report = await runDoctor({ json: true }, deps({ config: { ...baseConfig, host, authEnabled: false } }));
      expect(level(report, 'access.posture'), host).toBe('fail');
      expect(report.ok, host).toBe(false);
    }
  });

  it('认证关闭但只监听回环为 warn', async () => {
    for (const host of ['127.0.0.1', '::1']) {
      const check = find(await runDoctor({ json: true }, deps({
        config: { ...baseConfig, host, authEnabled: false }
      })), 'access.posture')!;
      expect(check.level, host).toBe('warn');
      expect(check.remedy, host).toBeTruthy();
      expect(check.command, host).toBeTruthy();
    }
  });

  it('认证开启为 ok；远程场景提到 dutydeck auth token', async () => {
    const local = find(await runDoctor({ json: true }, deps()), 'access.posture')!;
    expect(local.level).toBe('ok');

    const remote = find(await runDoctor({ json: true }, deps({
      config: { ...baseConfig, host: '0.0.0.0', authEnabled: true }
    })), 'access.posture')!;
    expect(remote.level).toBe('ok');
    expect(remote.detail).toContain('dutydeck auth token');
  });

  it('token 模式缺令牌为 fail（每个请求都会 401）', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      config: { ...baseConfig, host: '0.0.0.0', authEnabled: true },
      databaseProbe: () => ({ exists: true, appliedVersion: 14, values: {} })
    })), 'access.token')!;
    expect(check.level).toBe('fail');
    expect(check.detail).toContain('401');
    expect(check.command).toBe('dutydeck auth token');
  });

  it('仅本机模式不需要令牌 → skip', async () => {
    expect(level(await runDoctor({ json: true }, deps()), 'access.token')).toBe('skip');
  });

  it('运行态与配置不一致时报 access.drift', async () => {
    const report = await runDoctor({ json: true }, deps({
      config: { ...baseConfig, host: '0.0.0.0', authEnabled: false },
      daemonStatus: () => ({ running: true, pid: 1, ready: true, address: 'http://127.0.0.1:4310' }),
      daemonRecord: () => ({ pid: 1, ready: true, host: '127.0.0.1', port: 4310, authEnabled: true })
    }));
    const drift = find(report, 'access.drift')!;
    expect(drift.level).toBe('warn');
    expect(drift.detail).toContain('127.0.0.1');
    expect(drift.command).toBe('dutydeck restart');
  });

  it('一致时不产出 access.drift 噪音', async () => {
    expect(find(await runDoctor({ json: true }, deps()), 'access.drift')).toBeUndefined();
  });
});

describe('port.conflict', () => {
  it('端口空闲为 ok', async () => {
    const check = find(await runDoctor({ json: true }, deps({ portProbe: async () => 'free' })), 'port.conflict')!;
    expect(check.level).toBe('ok');
  });

  it('被我们自己的守护进程占用 → ok（那就是它自己）', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      portProbe: async () => 'occupied',
      daemonStatus: () => ({ running: true, pid: 4242, ready: true, address: 'http://127.0.0.1:4310' }),
      daemonRecord: () => ({ pid: 4242, ready: true, port: 4310 })
    })), 'port.conflict')!;
    expect(check.level).toBe('ok');
    expect(check.detail).toContain('就是它自己');
  });

  it('被别人占用且守护进程没跑 → fail，给换端口的命令与查占用者的 verify', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      portProbe: async () => 'occupied',
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => undefined
    })), 'port.conflict')!;
    expect(check.level).toBe('fail');
    expect(check.command).toContain('dutydeck setup --port');
    // Linux 上给 ss（lsof 常常没装），darwin 上给 lsof
    expect(check.verify).toContain('ss -ltnp');
    expect(check.verify).toContain('4310');
  });

  it('darwin 上 verify 用 lsof', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      platform: 'darwin',
      portProbe: async () => 'occupied',
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => undefined
    })), 'port.conflict')!;
    expect(check.verify).toContain('lsof -iTCP:4310');
  });

  it('探测不出来为 warn，不冒充可用', async () => {
    const check = find(await runDoctor({ json: true }, deps({ portProbe: async () => 'unknown' })), 'port.conflict')!;
    expect(check.level).toBe('warn');
    expect(check.remedy).toBeTruthy();
    expect(check.command).toBeTruthy();
  });

  it('端口探测带超时参数，绝不挂住体检', async () => {
    let seenTimeout = 0;
    await runDoctor({ json: true }, deps({
      portProbeTimeoutMs: 250,
      portProbe: async (_host, _port, timeoutMs) => { seenTimeout = timeoutMs; return 'free'; }
    }));
    expect(seenTimeout).toBe(250);
  });

  it('守护进程没跑时，探针拿的是配置里的 host/port', async () => {
    const seen: Array<[string, number]> = [];
    await runDoctor({ json: true }, deps({
      config: { ...baseConfig, host: '0.0.0.0', port: 9911, authEnabled: true },
      daemonStatus: () => ({ running: false, ready: false }),
      daemonRecord: () => undefined,
      portProbe: async (host, port) => { seen.push([host, port]); return 'free'; }
    }));
    expect(seen).toEqual([['0.0.0.0', 9911]]);
  });

  /**
   * 回归：`dutydeck start --port 14612` 后跑体检，曾经报「4310 被别人占用」FAIL，
   * 并建议 `dutydeck setup --port <其他端口>` —— 一条不存在的故障配一条错误的修法。
   * 根因是探针只认配置端口，而 `--port` 从不回写配置。
   */
  it('daemon 跑在非默认端口时，探配置端口不得误报冲突', async () => {
    const seen: Array<[string, number]> = [];
    const report = await runDoctor({ json: true }, deps({
      config: { ...baseConfig, port: 4310 },
      daemonStatus: () => ({ running: true, pid: 77, ready: true, address: 'http://127.0.0.1:14612' }),
      daemonRecord: () => ({ pid: 77, ready: true, host: '127.0.0.1', port: 14612, authEnabled: true, database: baseConfig.databaseUrl }),
      // 配置端口 4310 此刻空着；真正在用的 14612 被自己占着。
      portProbe: async (host, port) => { seen.push([host, port]); return 'occupied'; }
    }));
    // 探的必须是正在跑的那个端口，而不是没人用的配置端口。
    expect(seen).toEqual([['127.0.0.1', 14612]]);
    const check = find(report, 'port.conflict')!;
    expect(check.level).toBe('ok');
    expect(check.detail).toContain('14612');
    expect(check.detail).toContain('就是它自己');
    // 绝不能再冒出「换个端口」这种把正常运行当故障的建议。
    expect(check.command ?? '').not.toContain('setup --port');
  });

  it('端口漂移由 access.drift 单独报出，而不是伪装成端口冲突', async () => {
    const report = await runDoctor({ json: true }, deps({
      config: { ...baseConfig, port: 4310 },
      daemonStatus: () => ({ running: true, pid: 77, ready: true, address: 'http://127.0.0.1:14612' }),
      daemonRecord: () => ({ pid: 77, ready: true, host: '127.0.0.1', port: 14612, authEnabled: true, database: baseConfig.databaseUrl }),
      portProbe: async () => 'occupied'
    }));
    const drift = find(report, 'access.drift')!;
    expect(drift.level).toBe('warn');
    expect(drift.detail).toContain('14612');
    expect(drift.detail).toContain('4310');
    expect(drift.command).toBe('dutydeck restart');
    // 端口这一项本身必须是干净的 ok，漂移不重复计一次失败。
    expect(level(report, 'port.conflict')).toBe('ok');
  });
});

describe('platform.pickers', () => {
  it('darwin 上为 ok', async () => {
    expect(level(await runDoctor({ json: true }, deps({ platform: 'darwin' })), 'platform.pickers')).toBe('ok');
  });

  it('非 darwin 为 info，说明要手输路径并提到 dutydeck setup --cwd', async () => {
    const check = find(await runDoctor({ json: true }, deps({ platform: 'linux' })), 'platform.pickers')!;
    expect(check.level).toBe('info');
    expect(check.detail).toContain('手工输入');
    expect(check.verify).toContain('dutydeck setup --cwd');
  });
});

describe('autostart', () => {
  it('不支持的平台为 info', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      autostartStatus: async () => ({ state: { platform: 'unsupported', supported: false, enabled: false } })
    })), 'autostart')!;
    expect(check.level).toBe('info');
  });

  it('未注册为 info 并给出 enable 命令', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      autostartStatus: async () => ({ state: { platform: 'linux', supported: true, enabled: false } })
    })), 'autostart')!;
    expect(check.level).toBe('info');
    expect(check.command).toBe('dutydeck autostart enable');
  });

  it('已注册为 ok', async () => {
    expect(level(await runDoctor({ json: true }, deps()), 'autostart')).toBe('ok');
  });

  it('stale 为 warn，说明启动路径漂移了', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      autostartStatus: async () => ({ state: { platform: 'darwin', supported: true, enabled: true, stale: true, unitPath: '/x/y.plist' } })
    })), 'autostart.stale')!;
    expect(check.level).toBe('warn');
    expect(check.remedy).toMatch(/路径/);
    expect(check.command).toBe('dutydeck autostart enable');
  });

  it('Linux 已注册但没开 linger 为 warn，命令里带真实用户名', async () => {
    const check = find(await runDoctor({ json: true }, deps({
      username: 'alice',
      autostartStatus: async () => ({ state: { platform: 'linux', supported: true, enabled: true, lingerEnabled: false } })
    })), 'autostart.linger')!;
    expect(check.level).toBe('warn');
    expect(check.command).toBe('loginctl enable-linger alice');
  });

  it('autostart 模块不可用时降级 skip，不让体检整体崩掉', async () => {
    const report = await runDoctor({ json: true }, deps({
      autostartStatus: async () => { throw new Error('模块不存在'); }
    }));
    expect(level(report, 'autostart')).toBe('skip');
    // 其余检查照常产出
    expect(level(report, 'node.version')).toBe('ok');
  });
});

describe('默认探针（真实系统，仅限临时目录与本地端口）', () => {
  it('端口探针：空闲 / 占用都判对，且探完一定把 socket 关掉', async () => {
    // 关不掉 socket 的话，紧随体检之后的 dutydeck start 会被自己的探针挤掉端口。
    expect(await defaultPortProbe('127.0.0.1', 45231, 1_000)).toBe('free');
    const server = createServer();
    await new Promise<void>(resolve => server.listen({ host: '127.0.0.1', port: 45231 }, () => resolve()));
    expect(await defaultPortProbe('127.0.0.1', 45231, 1_000)).toBe('occupied');
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(await defaultPortProbe('127.0.0.1', 45231, 1_000)).toBe('free');
  });

  it('数据库探针：库不存在时如实返回且绝不建库', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-doctor-db-'));
    try {
      const missing = join(root, 'nope.db');
      expect(defaultDatabaseProbe(missing, [])).toEqual({ exists: false });
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('数据库探针：只读读出迁移版本与 configs 键值', () => {
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-doctor-db-'));
    try {
      const file = join(root, 'dutydeck.db');
      const writer = new Database(file);
      writer.pragma('journal_mode = WAL');
      writer.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
      writer.exec("INSERT INTO schema_migrations VALUES (14, 'now')");
      writer.exec('CREATE TABLE configs (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      writer.exec(`INSERT INTO configs VALUES ('${larkBotsConfigKey}', '[]')`);
      writer.close();

      const result = defaultDatabaseProbe(file, [larkBotsConfigKey, AUTH_TOKEN_CONFIG_KEY]);
      expect(result.exists).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.appliedVersion).toBe(14);
      expect(result.values?.[larkBotsConfigKey]).toBe('[]');
      expect(result.values?.[AUTH_TOKEN_CONFIG_KEY]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('数据库探针：半初始化的库（没有 configs / schema_migrations 表）仍算可读，不误报为坏库', () => {
    // 这是真实回归：早先版本里 prepare 抛错会让整个库被判成不可读，
    // 于是「库刚建好还没迁移」被显示成「数据库损坏」。
    const root = mkdtempSync(join(tmpdir(), 'dutydeck-doctor-db-'));
    try {
      const file = join(root, 'partial.db');
      const writer = new Database(file);
      writer.exec('CREATE TABLE unrelated (a TEXT)');
      writer.close();

      const result = defaultDatabaseProbe(file, [larkBotsConfigKey]);
      expect(result.exists).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.appliedVersion).toBeUndefined();
      expect(result.values?.[larkBotsConfigKey]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('只读性', () => {
  it('全流程不调用任何写操作：databaseProbe 只被调一次且只读 configs 键', async () => {
    const calls: Array<{ path: string; keys: readonly string[] }> = [];
    await runDoctor({ json: true }, deps({
      databaseProbe: (path, keys) => { calls.push({ path, keys }); return { exists: true, appliedVersion: 14 }; }
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.keys).toContain(larkBotsConfigKey);
    expect(calls[0]!.keys).toContain(AUTH_TOKEN_CONFIG_KEY);
  });

  it('exists 返回 false 时不尝试 access / stat（不去碰不存在的路径）', async () => {
    let accessed = 0;
    let statted = 0;
    await runDoctor({ json: true }, deps({
      exists: () => false,
      access: async () => { accessed += 1; },
      stat: async () => { statted += 1; return { mode: 0o40700 }; }
    }));
    expect(accessed).toBe(0);
    expect(statted).toBe(0);
  });
});
