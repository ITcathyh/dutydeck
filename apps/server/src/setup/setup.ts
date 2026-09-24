/**
 * `dutydeck setup` —— 首次运行引导向导。
 *
 * 设计约束（每一条都对应一个真实踩坑）：
 *
 *   1. **要么写完整，要么什么都不写。** 所有答案先在内存里攒成一个完整的
 *      plan，凭据校验/目录校验/用户放弃都发生在落盘之前。中途失败时磁盘上
 *      不会留下半份配置，也不会留下一个孤立的飞书应用。
 *   2. **幂等 + 可续跑。** 重跑时先读现有配置，逐项给「保留 / 更新」选择；
 *      内容无变化就报告「无需改动」，而不是假装做了一堆事。
 *   3. **失败时给出算好的下一条命令**，不是泛泛的建议。
 *   4. **--json 是行为契约**：绝不提问、绝不渲染二维码、绝不挂住，并且掩码机密。
 *   5. **非 TTY 平价**：所有提问都过 prompts.ts 那个唯一收口，stdin 关闭即取
 *      默认值；危险动作在非交互下 fail closed，--yes 是唯一放行方式。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCliUi, type CliUi } from '../cli-ui.js';
import { createPrompter, PromptAbortedError, PromptUnavailableError, type Prompter } from './prompts.js';
import { detectAgents, validateWorkingDirectory, type DetectedAgent } from './detect.js';
import { isSecretKey, maskSecret, readExistingConfig, writeEnvFile, type WriteEnvResult } from './env-file.js';
import { bindLarkApp, renderLarkBindResult, type LarkBindResult } from './lark-bind.js';
import { isValidLarkAppId } from '../lark/open-platform-configurator.js';

export interface SetupCliOptions {
  /** 非交互确认；也是跳过危险确认（发布飞书版本）的唯一方式。 */
  yes?: boolean;
  /** 机器消费模式：不提问、不渲染二维码、输出单行 JSON。 */
  json?: boolean;
  /** 默认工作目录；提供后该步不再提问。 */
  cwd?: string;
  /** 监听端口。 */
  port?: string;
  /** 仅监听本机。 */
  localOnly?: boolean;
  /** 飞书应用 ID（cli_*）。提供后进入飞书绑定步骤。 */
  larkAppId?: string;
  /** 跳过飞书绑定。 */
  skipLark?: boolean;
  /** 强制重新扫码登录开放平台（换账号）。 */
  forceLogin?: boolean;
  /** .env 路径覆盖，测试用。 */
  envFile?: string;
}

export interface SetupDependencies {
  ui?: CliUi;
  prompter?: Prompter;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detect?: typeof detectAgents;
  bind?: typeof bindLarkApp;
  writeEnv?: typeof writeEnvFile;
  readExisting?: typeof readExistingConfig;
}

export interface SetupResult {
  ok: boolean;
  action: 'setup';
  /** 本次是首配还是在既有配置上更新。 */
  mode: 'initial' | 'update';
  agents: Array<{ id: string; name: string; version?: string }>;
  defaultCwd?: string;
  port?: string;
  envFile?: string;
  /** 是否真的写了盘；false 表示配置已经是目标状态。 */
  changed: boolean;
  /** 本次改动的键名（不含值）。 */
  changedKeys: string[];
  lark?: LarkBindResult;
  /** 终态说明，或一条可直接执行的下一步命令。 */
  next: string;
  warnings: string[];
  error?: { code: string; message: string };
}

/** 端口校验与提问、flag 两条路径共用——绝不各写一遍。 */
function validatePort(raw: string): string {
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口需为 1-65535 之间的整数（收到「${raw.trim()}」）。`);
  }
  return String(port);
}

function validateAppId(raw: string): string {
  const value = raw.trim();
  if (!isValidLarkAppId(value)) throw new Error(`飞书应用 ID 格式无效，应形如 cli_xxx（收到「${value}」）。`);
  return value;
}

/** 掩码后的配置快照，用于回显与 JSON——机密永不原样出现。 */
function maskedView(entries: Map<string, string>): Array<[string, string]> {
  return [...entries.entries()].map(([key, value]) => [key, isSecretKey(key) ? maskSecret(value) : value]);
}

export async function runSetup(options: SetupCliOptions = {}, dependencies: SetupDependencies = {}): Promise<SetupResult> {
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const json = options.json === true;
  const assumeYes = options.yes === true;
  const ui = dependencies.ui ?? createCliUi({ env });
  // --json 隐含「绝不交互」：机器调用方不该被一个提问挂住。
  // 同时 stdin 非 TTY 也一律降级为非交互。
  const interactive = !json && process.stdin.isTTY === true;
  const prompter = dependencies.prompter ?? createPrompter({ ui, interactive, assumeYes });
  const detect = dependencies.detect ?? detectAgents;
  const bind = dependencies.bind ?? bindLarkApp;
  const writeEnv = dependencies.writeEnv ?? writeEnvFile;
  const readExisting = dependencies.readExisting ?? readExistingConfig;

  const envFile = options.envFile ?? join(cwd, '.env');
  const existing = readExisting(envFile);
  const mode: 'initial' | 'update' = existing.size > 0 ? 'update' : 'initial';
  const warnings: string[] = [];
  /** 累积的待写键值；只有全部步骤成功才会落盘。 */
  const updates: Record<string, string | undefined> = {};

  const fail = (code: string, message: string, next: string): SetupResult => ({
    ok: false, action: 'setup', mode, agents: [], changed: false, changedKeys: [],
    envFile, next, warnings, error: { code, message }
  });

  try {
    if (!json) {
      ui.section('Dutydeck 首次配置向导');
      ui.keyValues([['工作区', cwd], ['配置文件', envFile]]);
      if (mode === 'update') {
        ui.status('info', '检测到已有配置，本次为增量更新', `${existing.size} 项`);
        if (existing.size > 0) ui.keyValues(maskedView(existing));
      }
    }

    // ---- 步骤 1：探测已安装的 Agent CLI ----
    if (!json) ui.section('1/4 探测本机 Agent CLI');
    const detected: DetectedAgent[] = detect({ cwd });
    if (!json) {
      if (detected.length === 0) {
        ui.status('warn', '未检测到任何已安装的 Agent CLI');
        ui.hint('Dutydeck 只驱动本机已安装且已完成供应商认证的 Agent CLI。');
        ui.hint('安装其中任意一个后重跑本向导，例如 Claude Code / Codex / Gemini。');
        ui.command('dutydeck setup');
      } else {
        for (const agent of detected) ui.status('ok', agent.name, agent.version ?? agent.command);
        ui.hint('以上为已安装的 CLI。认证状态请用 dutydeck doctor 单独体检。');
      }
    }
    if (detected.length === 0) {
      warnings.push('未检测到已安装的 Agent CLI；配置仍会写入，但需要装好 CLI 才能跑任务。');
    }

    // ---- 步骤 2：默认工作目录 ----
    if (!json) ui.section('2/4 默认工作目录');
    const currentCwd = existing.get('DUTYDECK_DEFAULT_CWD');
    let defaultCwd: string | undefined;
    if (options.cwd !== undefined) {
      // flag 路径和提问路径共用同一个 validator，杜绝漂移。
      defaultCwd = validateWorkingDirectory(options.cwd);
    } else if (currentCwd && !assumeYes && interactive) {
      // 幂等：已有值时问「保留还是改」，而不是无条件重问。
      const keep = await prompter.confirm({ question: `保留当前默认工作目录 ${currentCwd}？`, defaultValue: true });
      defaultCwd = keep ? currentCwd : await prompter.ask<string>({
        question: '默认工作目录（绝对路径）',
        remedyFlag: '--cwd <目录>',
        validate: raw => validateWorkingDirectory(raw)
      });
    } else if (currentCwd) {
      defaultCwd = currentCwd;
    } else {
      defaultCwd = await prompter.ask<string>({
        question: '默认工作目录（绝对路径）',
        remedyFlag: '--cwd <目录>',
        defaultValue: cwd,
        validate: raw => validateWorkingDirectory(raw)
      });
    }
    if (defaultCwd !== currentCwd) updates.DUTYDECK_DEFAULT_CWD = defaultCwd;
    // 沿用 .env 里的旧值是唯一没过 validateWorkingDirectory 的路径：目录可能在写入
    // 之后被删掉了。所以校验要落在这里，而不是所有路径之后（那时新填的值必然已存在）。
    // 且警告的计算绝不能放进 if (!json)：机器调用方看不到人类输出，恰恰最需要这条结构化警告。
    const reusedStaleCwd = defaultCwd === currentCwd && !existsSync(defaultCwd);
    if (reusedStaleCwd) {
      warnings.push(`.env 记录的默认工作目录已不存在：${defaultCwd}。用 dutydeck setup --cwd <目录> 指定一个新的。`);
    }
    if (!json) {
      ui.status(reusedStaleCwd ? 'warn' : defaultCwd === currentCwd ? 'ok' : 'done', '默认工作目录', defaultCwd);
      if (reusedStaleCwd) {
        ui.hint('这个目录已经不存在了，任务会起不来。改成一个已存在的目录：');
        ui.command('dutydeck setup --cwd <绝对路径>');
      }
    }

    // ---- 步骤 3：监听设置 ----
    if (!json) ui.section('3/4 监听设置');
    const currentPort = existing.get('DUTYDECK_PORT');
    let port: string | undefined = currentPort;
    if (options.port !== undefined) port = validatePort(options.port);
    else if (!currentPort && interactive && !assumeYes) {
      port = await prompter.ask<string>({
        question: '监听端口',
        remedyFlag: '--port <端口>',
        defaultValue: '4310',
        validate: validatePort
      });
    } else if (!currentPort) port = '4310';
    if (port !== currentPort) updates.DUTYDECK_PORT = port;
    if (options.localOnly === true) updates.DUTYDECK_LOCAL_ONLY = 'true';
    if (!json) {
      ui.status(port === currentPort ? 'ok' : 'done', '监听端口', port);
      if (options.localOnly === true) ui.status('done', '仅本机可访问', '127.0.0.1');
      else ui.hint('远程浏览器访问需要 access token：dutydeck auth token');
    }

    // ---- 步骤 4：飞书绑定（可选，会产生对外副作用）----
    if (!json) ui.section('4/4 飞书机器人（可选）');
    let lark: LarkBindResult | undefined;
    const skipLark = options.skipLark === true;
    let appId = options.larkAppId;
    if (!skipLark && appId === undefined && interactive && !assumeYes) {
      const wants = await prompter.confirm({ question: '现在绑定飞书机器人？（可稍后再做）', defaultValue: false });
      if (wants) {
        appId = await prompter.ask<string>({
          question: '飞书应用 ID（cli_ 开头）',
          remedyFlag: '--lark-app-id <cli_xxx>',
          validate: validateAppId
        });
      }
    }
    if (skipLark || appId === undefined) {
      if (!json) {
        ui.status('skip', '已跳过飞书绑定');
        ui.hint('稍后绑定：');
        ui.command('dutydeck setup --lark-app-id cli_xxx');
      }
    } else {
      const validated = validateAppId(appId);
      lark = await bind({
        appId: validated, ui, prompter, assumeYes, json,
        forceLogin: options.forceLogin === true,
        ...(existing.get('LARK_APP_ID') === validated && existing.get('LARK_APP_SECRET')
          ? { appSecret: existing.get('LARK_APP_SECRET') } : {})
      });
      // 逐项如实呈现权限/机器人/长连接/事件/回调/版本/发布的结果：
      // 已满足的报「已配置」，本次变更的报「已完成」，未验证的绝不报成功。
      if (!json) renderLarkBindResult(ui, lark);
      if (lark.outcome === 'ready' || lark.outcome === 'ready_with_warnings') {
        updates.LARK_APP_ID = validated;
        // App Secret 不在这里索取：那是机密，必须走隐藏输入/fd 路径。
        if (!existing.get('LARK_APP_SECRET')) {
          warnings.push('尚未配置 LARK_APP_SECRET；飞书通道要等它就位才能收发消息。');
        }
      }
      warnings.push(...lark.warnings);
      // 飞书步骤失败不推翻前面的本地配置：前三步是纯本地、已验证过的，
      // 丢掉它们只会逼用户重头再答一遍。但要把失败如实报出来。
      if (lark.outcome === 'failed') {
        const written = writeEnv(envFile, updates);
        return {
          ok: false, action: 'setup', mode,
          agents: detected.map(({ id, name, version }) => ({ id, name, version })),
          defaultCwd, port, envFile, changed: written.changed, changedKeys: written.changedKeys,
          lark, warnings,
          next: lark.next,
          error: lark.error ?? { code: 'LARK_BIND_FAILED', message: '飞书绑定失败。' }
        };
      }
    }

    // ---- 落盘：到这里所有校验都过了，一次性原子写入 ----
    const written: WriteEnvResult = writeEnv(envFile, updates);

    const next = written.changed
      ? 'dutydeck start'
      : '配置已是目标状态，无需改动。';
    const result: SetupResult = {
      ok: true, action: 'setup', mode,
      agents: detected.map(({ id, name, version }) => ({ id, name, version })),
      defaultCwd, port, envFile,
      changed: written.changed, changedKeys: written.changedKeys,
      lark, warnings, next
    };

    if (json) {
      ui.json(result);
      return result;
    }

    ui.section('配置结果');
    ui.status(written.changed ? 'done' : 'ok', written.changed ? `已写入 ${envFile}` : `配置无变化：${envFile}`,
      written.changed ? written.changedKeys.join(', ') : undefined);
    for (const warning of warnings) ui.status('warn', warning);

    const summary = [
      { text: '启动 Dutydeck（后台常驻）', command: 'dutydeck start' },
      { text: '打开工作台', command: `http://127.0.0.1:${port ?? '4310'}` },
      { text: '体检本机环境与配置', command: 'dutydeck doctor' },
      { text: '开机自启（下次登录生效）', command: 'dutydeck autostart enable' }
    ];
    if (lark === undefined) summary.push({ text: '稍后绑定飞书机器人', command: 'dutydeck setup --lark-app-id cli_xxx' });
    ui.summary('接下来做什么', summary);
    return result;
  } catch (error) {
    // 中断与「非交互下缺输入」是两类完全不同的失败，必须给不同的下一步。
    if (error instanceof PromptUnavailableError) {
      const next = `dutydeck setup ${error.remedyFlag} 或 dutydeck setup --yes`;
      if (json) ui.json(fail(error.code, error.message, next));
      else {
        ui.status('fail', error.message);
        ui.hint('非交互环境（CI / 管道）请用字段 flag 显式提供，或用 --yes 接受默认值：');
        ui.command(next);
      }
      return fail(error.code, error.message, next);
    }
    if (error instanceof PromptAbortedError) {
      const next = 'dutydeck setup';
      if (json) ui.json(fail(error.code, error.message, next));
      else {
        ui.status('skip', error.message);
        ui.hint('未写入任何配置，可随时重跑：');
        ui.command(next);
      }
      return fail(error.code, error.message, next);
    }
    const message = error instanceof Error ? error.message : String(error);
    const next = 'dutydeck setup';
    if (json) ui.json(fail('SETUP_FAILED', message, next));
    else {
      ui.status('fail', message);
      ui.hint('未写入任何配置。修正后重跑：');
      ui.command(next);
    }
    return fail('SETUP_FAILED', message, next);
  } finally {
    prompter.close();
  }
}
