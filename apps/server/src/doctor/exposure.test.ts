import { describe, expect, it } from 'vitest';
import { createCliUi } from '../cli-ui.js';
import { AUTH_TOKEN_CONFIG_KEY } from '../auth/auth.js';
import { checkLarkExposure, larkBotsConfigKey } from './checks.js';
import { observeSocketActivation, runDoctor } from './doctor.js';
import type { DoctorCheck, DoctorConfig, DoctorDependencies } from './types.js';

const SECRET = 'exposure-test-app-secret-must-not-leak';
const HIGH_RISK_OPEN_ID = 'ou_exposure_high_risk_user';
const HIGH_RISK_EMAIL = 'high-risk@example.test';

const baseConfig: DoctorConfig = {
  host: '127.0.0.1',
  port: 4310,
  authEnabled: true,
  databaseUrl: '/tmp/dutydeck-exposure-test/.dutydeck/dutydeck.db',
  agents: [{ id: 'claude', name: 'Claude Code', command: 'claude', version: '1.2.3', protocol: 'acp' }]
};

function bot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: 'cli_exposure',
    appSecret: SECRET,
    name: 'exposure fixture',
    defaultAgentId: 'claude',
    permissionMode: 'full-trust',
    fullTrustConfirmed: true,
    listening: true,
    allowedUsers: [],
    allowedEmails: [],
    allowedBots: [],
    peerBotsAllowed: true,
    highRiskAllowedUsers: [],
    highRiskAllowedEmails: [],
    highRiskPattern: 'dangerous',
    riskControlMode: 'off',
    ...overrides
  };
}

interface Scenario {
  host?: string;
  authEnabled?: boolean;
  localOnly?: boolean;
  rawBots?: string;
  databaseError?: boolean;
  listenerDisabled?: boolean;
  runningHost?: string;
  runningAuthEnabled?: boolean;
  running?: boolean;
  systemdUnit?: string;
  socketActivationProbe?: DoctorDependencies['socketActivationProbe'];
  socket?: { status: 'active' | 'inactive' | 'unknown'; source?: 'process' | 'unit'; host?: string; reason?: string };
}

async function exposure(scenario: Scenario = {}): Promise<{ check: DoctorCheck | undefined; serialized: string }> {
  const host = scenario.host ?? '0.0.0.0';
  const authEnabled = scenario.authEnabled ?? false;
  const rawBots = scenario.rawBots ?? JSON.stringify([bot()]);
  const dependencies = {
    ui: createCliUi({ stdout: { write() {}, isTTY: false }, stderr: { write() {}, isTTY: false }, env: {}, color: false }),
    env: {
      ...(scenario.localOnly !== undefined ? { DUTYDECK_LOCAL_ONLY: String(scenario.localOnly) } : {}),
      ...(scenario.listenerDisabled ? { DUTYDECK_DISABLE_LARK_LISTENER: 'true' } : {})
    },
    nodeVersion: 'v22.12.0',
    platform: 'linux',
    username: 'tester',
    getuid: () => 1000,
    processUid: () => 1000,
    config: { ...baseConfig, host, authEnabled, ...(scenario.localOnly !== undefined ? { localOnly: scenario.localOnly } : {}) },
    daemonStatus: () => ({ running: scenario.running ?? true, pid: 4242, ready: scenario.running ?? true, address: 'http://127.0.0.1:4310', authEnabled }),
    daemonRecord: () => ({
      pid: 4242,
      ready: scenario.running ?? true,
      host: scenario.runningHost ?? host,
      port: 4310,
      authEnabled: scenario.runningAuthEnabled ?? authEnabled,
      database: baseConfig.databaseUrl,
      ...(scenario.systemdUnit ? { supervisor: 'systemd' as const, systemdUnit: scenario.systemdUnit } : {})
    }),
    daemonLogFile: '/tmp/dutydeck-exposure-test/.dutydeck/daemon/dutydeck.log',
    databaseProbe: () => scenario.databaseError
      ? { exists: true, error: 'fixture database unavailable' }
      : { exists: true, appliedVersion: 14, values: { [AUTH_TOKEN_CONFIG_KEY]: 'fixture-token', [larkBotsConfigKey]: rawBots } },
    expectedSchemaVersion: 14,
    agentProbe: async () => ({ status: 'ok' as const, version: 'stub 1.0.0' }),
    portProbe: async () => 'occupied' as const,
    exists: () => true,
    access: async () => undefined,
    stat: async () => ({ mode: 0o40700 }),
    autostartStatus: async () => ({ state: { platform: 'linux', supported: true, enabled: true, lingerEnabled: true } }),
    pluginChecks: async () => [],
    socketActivationProbe: scenario.socketActivationProbe ?? (async () => scenario.socket ?? { status: 'inactive' })
  } as DoctorDependencies;
  const report = await runDoctor({ json: true }, dependencies);
  const check = report.checks.find(candidate => candidate.id === 'lark.exposure');
  return { check, serialized: JSON.stringify(report) };
}

async function blockedExposure(rawBots: string): Promise<{ check: DoctorCheck; serialized: string }> {
  const check = await checkLarkExposure({
    host: '0.0.0.0',
    hostSource: 'runtime',
    authEnabled: false,
    socket: { status: 'inactive' },
    rawBots,
    listenerDisabled: false
  });
  return { check, serialized: JSON.stringify(check) };
}

describe('lark.exposure —— 网络与机器人权限组合', () => {
  it('非回环无认证但机器人不是完全信任时，不新增告警', async () => {
    const { check } = await exposure({ rawBots: JSON.stringify([bot({ permissionMode: 'ask', fullTrustConfirmed: false })]) });
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('认证=open');
    expect(check?.detail).toContain('permissionMode=ask');
  });

  it('开放监听 + 完全信任 + 广范围高危用户 + off 才升为 fail，并给出真实修复命令', async () => {
    const { check } = await exposure();
    expect(check?.level).toBe('fail');
    expect(check?.detail).toContain('高危范围=全部');
    expect(check?.detail).toContain('riskControlMode=off');
    expect(check?.remedy).toContain('不会自动修改');
    expect(check?.command).toBe('dutydeck settings bot set cli_exposure permissionMode=ask fullTrustConfirmed=false');
    expect(check?.verify).toBe('dutydeck doctor --json');
  });

  it('单条无效机器人配置不掩盖另一条有效机器人的高危 fail', async () => {
    const invalid = bot({
      appId: 'cli_invalid',
      defaultAgentWeights: [{ agentId: 'claude', weight: 1, extra: true }]
    });
    const { check, serialized } = await exposure({ rawBots: JSON.stringify([invalid, bot({ appId: 'cli_valid' })]) });

    expect(check?.level).toBe('fail');
    expect(check?.detail).toContain('1 个无效机器人条目已跳过');
    expect(check?.detail).toContain('cli_valid：permissionMode=full-trust');
    expect(check?.command).toBe('dutydeck settings bot set cli_valid permissionMode=ask fullTrustConfirmed=false');
    expect(serialized).not.toContain(SECRET);
  });

  it('同样的危险组合在 guidance 下标为 warn，而不是把提醒当成强制拦截', async () => {
    const { check } = await exposure({ rawBots: JSON.stringify([bot({ riskControlMode: 'guidance' })]) });
    expect(check?.level).toBe('warn');
    expect(check?.detail).toContain('riskControlMode=guidance');
    expect(check?.remedy).toBeTruthy();
  });

  it.each([
    ['127.0.0.1', 'ok'],
    ['::1', 'ok'],
    ['0.0.0.0', 'fail'],
    ['::', 'fail'],
    ['192.0.2.10', 'fail']
  ])('监听地址 %s 与开放认证的组合级别为 %s', async (host, expected) => {
    const { check } = await exposure({ host });
    expect(check?.level).toBe(expected);
  });

  it('token 认证下，即使机器人完全信任且风控关闭也不新增暴露告警', async () => {
    const { check } = await exposure({ authEnabled: true });
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('认证=token');
  });

  it('enforced 不是弱风控；guidance 的指定高危名单也不是广范围', async () => {
    const enforced = await exposure({ rawBots: JSON.stringify([bot({ riskControlMode: 'enforced' })]) });
    expect(enforced.check?.level).toBe('ok');
    const legacyEnforced = await exposure({ rawBots: JSON.stringify([bot({ riskControlMode: undefined, hardGateEnabled: true })]) });
    expect(legacyEnforced.check?.level).toBe('ok');
    expect(legacyEnforced.check?.detail).toContain('riskControlMode=enforced');
    const restrictedGuidance = await exposure({
      rawBots: JSON.stringify([bot({
        riskControlMode: 'guidance',
        highRiskAllowedUsers: [{ openId: HIGH_RISK_OPEN_ID, name: 'High Risk User' }]
      })])
    });
    expect(restrictedGuidance.check?.level).toBe('ok');
    expect(restrictedGuidance.check?.detail).toContain('高危范围=指定');
  });

  it.each([
    ['无效用户条目', { highRiskAllowedUsers: [{}], highRiskAllowedEmails: [] }],
    ['空白邮箱', { highRiskAllowedUsers: [], highRiskAllowedEmails: [' '] }]
  ])('guidance 的%s被运行时清空后仍是广范围，必须告警', async (_label, lists) => {
    const { check } = await exposure({ rawBots: JSON.stringify([bot({ riskControlMode: 'guidance', ...lists })]) });
    expect(check?.level).toBe('warn');
    expect(check?.detail).toContain('高危范围=全部');
    expect(check?.detail).toContain('ID 0、邮箱 0');
  });

  it('缺默认 Agent 的完全信任机器人不能形成会话，不误报为可运行危险权限', async () => {
    const { check } = await exposure({ rawBots: JSON.stringify([bot({ defaultAgentId: undefined })]) });
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('未形成监听权限');
  });

  it.each([
    { field: 'eventHandlers', value: 'broken', marker: 'broken' },
    { field: 'cardActionForwarding', value: { owner: 'exposure', token: 'exposure-forwarding-secret-must-not-leak' }, marker: 'exposure-forwarding-secret-must-not-leak' }
  ])('$field 配置受阻时不算危险，也不吞掉其他有效机器人的告警', async ({ field, value, marker }) => {
    const blocked = bot({
      appId: 'cli_blocked',
      [field]: value,
      highRiskAllowedUsers: [{ openId: HIGH_RISK_OPEN_ID, name: 'High Risk User' }],
      highRiskAllowedEmails: [HIGH_RISK_EMAIL]
    });
    const isolated = await blockedExposure(JSON.stringify([blocked]));
    expect(isolated.check.level).toBe('ok');
    expect(isolated.check.detail).toContain('cli_blocked：permissionMode=full-trust（配置受阻，未形成监听权限）');
    expect(isolated.check.detail).not.toContain(marker);
    expect(isolated.serialized).not.toContain(SECRET);
    expect(isolated.serialized).not.toContain(marker);
    expect(isolated.serialized).not.toContain(HIGH_RISK_OPEN_ID);
    expect(isolated.serialized).not.toContain(HIGH_RISK_EMAIL);
    expect(isolated.serialized).not.toContain('High Risk User');

    const mixed = await blockedExposure(JSON.stringify([blocked, bot({ appId: 'cli_valid' })]));
    expect(mixed.check.level).toBe('fail');
    expect(mixed.check.command).toBe('dutydeck settings bot set cli_valid permissionMode=ask fullTrustConfirmed=false');
  });

  it('off 不会执行已配置的高危名单，仍按广范围处理', async () => {
    const { check } = await exposure({
      rawBots: JSON.stringify([bot({
        highRiskAllowedUsers: [{ openId: HIGH_RISK_OPEN_ID, name: 'High Risk User' }],
        highRiskAllowedEmails: [HIGH_RISK_EMAIL]
      })])
    });
    expect(check?.level).toBe('fail');
    expect(check?.detail).toContain('off 下名单不限制执行');
    expect(check?.detail).toContain('ID 1、邮箱 1');
  });

  it('沿用旧配置的 fullTrustConfirmed 语义，并排除未确认或未监听的机器人', async () => {
    const legacy = await exposure({ rawBots: JSON.stringify([bot({ permissionMode: undefined })]) });
    expect(legacy.check?.level).toBe('fail');
    const minimalLegacy = await exposure({
      rawBots: JSON.stringify([{
        appId: 'cli_exposure', appSecret: SECRET, listening: true, fullTrustConfirmed: true, defaultAgentId: 'claude'
      }])
    });
    expect(minimalLegacy.check?.level).toBe('fail');
    expect(minimalLegacy.check?.detail).toContain('riskControlMode=off');
    const unconfirmed = await exposure({ rawBots: JSON.stringify([bot({ fullTrustConfirmed: false })]) });
    expect(unconfirmed.check?.level).toBe('ok');
    const notListening = await exposure({ rawBots: JSON.stringify([bot({ listening: false })]) });
    expect(notListening.check?.level).toBe('ok');
    const disabled = await exposure({ listenerDisabled: true });
    expect(disabled.check?.level).toBe('ok');
  });

  it('保留显式 local-only 维度，不把解析后的回环地址当成同一事实', async () => {
    const { check } = await exposure({ host: '127.0.0.1', localOnly: true });
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('local-only=开启');
    expect(check?.detail).toContain('认证=local');
  });

  it('daemon 可能由另一个 shell 以 --local-only 启动时，缺少显式事实显示未知而非关闭', async () => {
    const { check } = await exposure({ host: '127.0.0.1', runningHost: '127.0.0.1' });
    expect(check?.level).toBe('ok');
    expect(check?.detail).toContain('local-only=未知');
    expect(check?.detail).not.toContain('local-only=关闭');
  });

  it('socket 激活按 unit 观测地址判定，不套用 .env 的 host', async () => {
    const loopback = await exposure({ socket: { status: 'active', source: 'unit', host: '::1' } });
    expect(loopback.check?.level).toBe('ok');
    expect(loopback.check?.detail).toContain('socket=unit');
    const wildcard = await exposure({ host: '127.0.0.1', socket: { status: 'active', source: 'unit', host: '::' } });
    expect(wildcard.check?.level).toBe('fail');
    expect(wildcard.check?.detail).toContain('监听=::');
  });

  it('socket 的实际地址不可知时降级，不猜成回环或通配地址', async () => {
    const { check } = await exposure({ socket: { status: 'active', source: 'process', reason: 'address-unavailable' } });
    expect(check?.level).toBe('skip');
    expect(check?.detail).toContain('实际监听地址未知');
  });

  it.each(['active', 'unknown'] as const)('service 停止但 systemd socket %s 时，不按回环配置报安全', async socketState => {
    const calls: string[] = [];
    const { check } = await exposure({
      host: '127.0.0.1',
      running: false,
      systemdUnit: 'dutydeck.service',
      socketActivationProbe: input => observeSocketActivation(input, unit => {
        calls.push(unit);
        if (unit === 'dutydeck.service') return { status: 0, stdout: 'TriggeredBy=dutydeck.socket\n' };
        if (socketState === 'unknown') return { status: 1, stdout: '' };
        return { status: 0, stdout: 'ActiveState=active\nSubState=listening\n' };
      })
    });

    expect(calls).toEqual(['dutydeck.service', 'dutydeck.socket']);
    expect(check?.level).toBe('skip');
    expect(check?.detail).toContain('实际监听地址未知');
    expect(check?.detail).toContain(socketState === 'active' ? 'socket=unit' : 'socket=未知');
  });

  it('数据库不可读或机器人配置损坏时不重复报错，也不假装权限已知', async () => {
    expect((await exposure({ databaseError: true })).check?.level).toBe('skip');
    expect((await exposure({ rawBots: '{broken' })).check?.level).toBe('skip');
  });

  it('安全投影不包含 secret、用户 openId、姓名或邮箱', async () => {
    const { check, serialized } = await exposure({
      rawBots: JSON.stringify([bot({
        highRiskAllowedUsers: [{ openId: HIGH_RISK_OPEN_ID, name: 'High Risk User' }],
        highRiskAllowedEmails: [HIGH_RISK_EMAIL]
      })])
    });
    expect(check?.level).toBe('fail');
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(HIGH_RISK_OPEN_ID);
    expect(serialized).not.toContain(HIGH_RISK_EMAIL);
    expect(serialized).not.toContain('High Risk User');
  });
});

describe('socket 激活观测边界', () => {
  it('只把当前进程的 LISTEN_* 视为进程直接证据，且地址保持未知', () => {
    const observed = observeSocketActivation({ env: { LISTEN_PID: '100', LISTEN_FDS: '1' }, processPid: 100, running: false });
    expect(observed).toEqual({ status: 'active', source: 'process', reason: 'address-unavailable' });
    expect(observeSocketActivation({ env: {}, processPid: 100, running: true, record: { pid: 200 } })).toEqual({ status: 'inactive' });
  });

  it('TriggeredBy 只定位 socket，另查 ActiveState 与 SubState 才判定正在监听', () => {
    const record = { pid: 200, supervisor: 'systemd' as const, systemdUnit: 'dutydeck.service' };
    const calls: string[] = [];
    const active = observeSocketActivation(
      { env: {}, processPid: 100, running: true, record },
      (unit, properties) => {
        calls.push(`${unit}:${properties.join(',')}`);
        if (unit === 'dutydeck.service') return { status: 0, stdout: 'TriggeredBy=dutydeck.socket\n' };
        return { status: 0, stdout: 'ActiveState=active\nSubState=listening\n' };
      }
    );
    expect(active).toEqual({ status: 'active', source: 'unit', reason: 'address-unavailable' });
    expect(calls).toEqual(['dutydeck.service:TriggeredBy', 'dutydeck.socket:ActiveState,SubState']);
    expect(observeSocketActivation(
      { env: {}, processPid: 100, running: true, record },
      () => ({ status: 0, stdout: 'TriggeredBy=\n' })
    )).toEqual({ status: 'inactive' });
    expect(observeSocketActivation(
      { env: {}, processPid: 100, running: true, record },
      () => ({ status: 1, stdout: '' })
    )).toEqual({ status: 'unknown', reason: 'unit-unavailable' });
  });

  it('service 已停止也查询记录的 socket；查询失败返回 unknown', () => {
    const record = { pid: 200, supervisor: 'systemd' as const, systemdUnit: 'dutydeck.service' };
    const input = { env: {}, processPid: 100, running: false, record };
    const active = observeSocketActivation(input, unit => unit === 'dutydeck.service'
      ? { status: 0, stdout: 'TriggeredBy=dutydeck.socket\n' }
      : { status: 0, stdout: 'ActiveState=active\nSubState=listening\n' });
    expect(active).toEqual({ status: 'active', source: 'unit', reason: 'address-unavailable' });

    const unknown = observeSocketActivation(input, unit => unit === 'dutydeck.service'
      ? { status: 0, stdout: 'TriggeredBy=dutydeck.socket\n' }
      : { status: 1, stdout: '' });
    expect(unknown).toEqual({ status: 'unknown', reason: 'unit-unavailable' });
  });

  it('socket 明确未激活才是 inactive，状态缺失或矛盾时不猜', () => {
    const record = { pid: 200, supervisor: 'systemd' as const, systemdUnit: 'dutydeck.service' };
    const observe = (socketOutput: string) => observeSocketActivation(
      { env: {}, processPid: 100, running: false, record },
      unit => ({ status: 0, stdout: unit === 'dutydeck.service' ? 'TriggeredBy=dutydeck.socket\n' : socketOutput })
    );
    expect(observe('ActiveState=inactive\nSubState=dead\n')).toEqual({ status: 'inactive' });
    expect(observe('ActiveState=active\n')).toEqual({ status: 'unknown', reason: 'unit-unavailable' });
    expect(observe('ActiveState=active\nSubState=dead\n')).toEqual({ status: 'unknown', reason: 'unit-unavailable' });
  });
});
