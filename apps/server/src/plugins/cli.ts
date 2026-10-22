import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { pluginNamePattern } from '@dutydeck/shared';
import { resolveDatabaseUrl } from '@dutydeck/config';
import { createCliUi, type CliUi } from '../cli-ui.js';
import { readDaemonStatus, resolveDaemonDir } from '../daemon/daemon.js';
import { readSecretValue } from '../secret-cli.js';
import { listBuiltinPlugins } from './builtin.js';
import { loadPluginDirectory, PluginValidationError, type LoadedPlugin } from './manifest.js';
import { PluginStore, PluginStoreError, type PluginLockEntry, type PluginTrustPrompt } from './store.js';

export type PluginCliAction = 'install' | 'uninstall' | 'enable' | 'disable' | 'list' | 'update' | 'activate' | 'rollback' | 'status' | 'validate' | 'init' | 'trigger-token' | 'config';

export interface PluginCliOptions {
  scope?: string;
  yes?: boolean;
  json?: boolean;
  rotate?: boolean;
  database?: string;
  dir?: string;
  value?: string;
  valueFd?: string;
}

export interface PluginCliIo {
  ui?: CliUi;
  confirm?: (prompt: PluginTrustPrompt) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** 内置插件目录；默认随包发布的 builtin-plugins。 */
  builtinRoot?: string;
}

/** 与 secret / auth 命令同一个数据目录：显式 --database，其次运行中的 daemon 记录，最后按配置解析。 */
export function pluginDataDir(database: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (database) return dirname(resolve(database));
  return dirname(readDaemonStatus(resolveDaemonDir())?.database ?? resolveDatabaseUrl(env));
}

/** 只有终端交互时才能确认；管道或脚本里必须显式 --yes。 */
export async function confirmOnTerminal(prompt: PluginTrustPrompt): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  process.stderr.write(`插件 ${prompt.plugin} 需要信任以下能力：${prompt.capabilities.join('、')}\n${prompt.details.map(line => `  ${line}`).join('\n')}\n`);
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await readline.question('信任并继续？[y/N] ')).trim()); }
  finally { readline.close(); }
}

const describeSource = (entry: PluginLockEntry) => `${entry.source.kind} ${entry.source.spec}${entry.source.ref ? `#${entry.source.ref}` : ''}${entry.resolved.sha ? ` @ ${entry.resolved.sha.slice(0, 12)}` : ''}${entry.resolved.version ? ` v${entry.resolved.version}` : ''}`;

function summarize(plugin: LoadedPlugin) {
  return {
    name: plugin.manifest.name,
    ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
    commands: plugin.commands.map(command => command.name),
    agents: plugin.agents.map(agent => agent.id),
    skills: Boolean(plugin.skillsDir),
    triggers: [...plugin.triggers.keys()],
    hooks: Object.entries(plugin.hooks).filter(([, specs]) => specs?.length).map(([event]) => event),
    providers: Boolean(plugin.providersEntry),
    scenarios: plugin.scenarios.map(({ pack }) => ({ id: pack.id, version: pack.version, mode: pack.mode })),
    capabilities: plugin.capabilities
  };
}

const describeIssue = (issue: { file: string; field?: string; message: string }) => `${issue.file}${issue.field ? ` ${issue.field}` : ''}：${issue.message}`;
const scenarioProblem = (plugin: LoadedPlugin) => plugin.scenarioIssues.length ? `场景包未加载：${plugin.scenarioIssues.map(describeIssue).join('；')}` : undefined;

const restartHint = (ui: CliUi) => ui.hint('运行 dutydeck restart 后生效。');

export async function runPluginCli(action: PluginCliAction, args: string[], options: PluginCliOptions, io: PluginCliIo = {}): Promise<{ ok: boolean }> {
  const ui = io.ui ?? createCliUi();
  const json = options.json === true;
  const store = () => new PluginStore(pluginDataDir(options.database, io.env), io.builtinRoot, options.database ? resolve(options.database) : readDaemonStatus(resolveDaemonDir())?.database ?? resolveDatabaseUrl(io.env ?? process.env));
  // 非交互时不问：store 直接报出要信任的能力并提示加 --yes。
  const confirm = io.confirm ?? (process.stdin.isTTY && process.stderr.isTTY ? confirmOnTerminal : undefined);
  const emit = (value: Record<string, unknown>) => { if (json) ui.json({ ok: true, ...value }); };

  if (action === 'validate') {
    try {
      const plugin = await loadPluginDirectory(resolve(io.cwd ?? process.cwd(), args[0]!));
      if (plugin.scenarioIssues.length) throw new PluginValidationError(plugin.root, plugin.scenarioIssues);
      const summary = summarize(plugin);
      if (json) { emit({ plugin: summary }); return { ok: true }; }
      ui.status('ok', `插件 ${summary.name} 校验通过`, summary.version);
      ui.keyValues([
        ['命令', summary.commands.map(name => `/${name}`).join(' ') || '无'],
        ['Agents', summary.agents.join(' ') || '无'],
        ['Skills', summary.skills ? '有' : '无'],
        ['触发器', summary.triggers.join(' ') || '无'],
        ['Hooks', summary.hooks.join(' ') || '无'],
        ['Providers', summary.providers ? '有' : '无'],
        ['场景包', summary.scenarios.map(pack => `${pack.id}@${pack.version}（${pack.mode}）`).join(' ') || '无']
      ]);
      for (const warning of plugin.scenarioWarnings) ui.hint(`提示：${describeIssue(warning)}`);
      ui.hint(summary.capabilities.length ? `安装时需要确认信任：${summary.capabilities.join('、')}` : '声明式插件，安装后直接可用。');
      return { ok: true };
    } catch (error) {
      if (!(error instanceof PluginValidationError)) throw error;
      if (json) ui.json({ ok: false, error: { code: 'PLUGIN_INVALID', message: error.message, issues: error.issues } });
      else { ui.status('fail', '插件校验失败', error.root); for (const issue of error.issues) ui.hint(`${issue.file}${issue.field ? ` ${issue.field}` : ''}：${issue.message}`); }
      return { ok: false };
    }
  }

  if (action === 'init') {
    const name = args[0]!;
    if (!pluginNamePattern.test(name)) throw new PluginStoreError('PLUGIN_NAME_INVALID', `插件名 ${name} 必须是 kebab-case，例如 my-plugin`);
    const root = resolve(io.cwd ?? process.cwd(), options.dir ?? name);
    if (existsSync(root)) throw new PluginStoreError('PLUGIN_INIT_EXISTS', `${root} 已存在`);
    await mkdir(join(root, '.dutydeck-plugin'), { recursive: true });
    await mkdir(join(root, 'commands'));
    await writeFile(join(root, '.dutydeck-plugin', 'plugin.json'), `${JSON.stringify({ name, version: '0.1.0', description: `${name} plugin for Dutydeck` }, null, 2)}\n`);
    await writeFile(join(root, 'commands', 'hello.md'), '---\ndescription: 打个招呼并说明参数\nargument-hint: <名字>\n---\n向 $ARGUMENTS 打个招呼，并用一句话介绍你能做什么。\n');
    await writeFile(join(root, 'README.md'), [
      `# ${name}`, '',
      '目录约定（都可选，路径可在 .dutydeck-plugin/plugin.json 里改）：', '',
      '- `commands/<名字>.md`：斜杠命令，frontmatter 写 description、argument-hint，正文是 prompt 模板，`$ARGUMENTS` 换成参数。',
      '- `agents/*.json`：Agent 定义，格式同 DUTYDECK_AGENTS_JSON 的一项（安装时需要确认信任）。',
      '- `skills/<名字>/SKILL.md`：Skills。',
      '- `triggers/<id>.json`：外部触发器，`POST /api/plugins/<插件>/triggers/<id>`。',
      '- `hooks/hooks.json`：事件 hook（安装时需要确认信任）。',
      '- `providers`：plugin.json 里指定 ESM 入口，默认导出 `register(api)`（安装时需要确认信任）。', '',
      `校验：dutydeck plugin validate ${root}`, `安装：dutydeck plugin install ${root}`, ''
    ].join('\n'));
    if (json) emit({ root }); else { ui.status('done', `已生成插件模板 ${name}`, root); ui.hint(`校验：dutydeck plugin validate ${root}`); }
    return { ok: true };
  }

  const plugins = store();
  // 安装和更新不因场景包的问题失败（插件其余部分照常加载），但要把不会加载的包说出来，说法和 validate 一致。
  const scenarioIssuesOf = async (name: string, candidate = false) => { const entry = plugins.get(name); return (await loadPluginDirectory(candidate && entry.candidate ? plugins.artifactDir(name, entry.candidate) : plugins.pluginDir(name))).scenarioIssues; };
  const warnScenarioIssues = (name: string, issues: LoadedPlugin['scenarioIssues']) => {
    if (!issues.length) return;
    ui.status('warn', `插件 ${name} 有场景包没通过校验，不会加载`);
    for (const issue of issues) ui.hint(describeIssue(issue));
  };
  if (action === 'install') {
    const entry = await plugins.install(args[0]!, { scope: options.scope, yes: options.yes === true, ...(confirm ? { confirm } : {}), ...(io.cwd ? { cwd: io.cwd } : {}) });
    const scenarioIssues = await scenarioIssuesOf(entry.name);
    if (json) emit({ plugin: entry, ...(scenarioIssues.length ? { scenarioIssues } : {}) });
    else { ui.status('done', `已安装插件 ${entry.name}`, describeSource(entry)); ui.hint(`作用域：${entry.scope}`); if (entry.trustedCapabilities.length) ui.hint(`已信任：${entry.trustedCapabilities.join('、')}`); warnScenarioIssues(entry.name, scenarioIssues); restartHint(ui); }
    return { ok: true };
  }
  if (action === 'update') {
    const names = args[0] ? [args[0]] : plugins.list().map(entry => entry.name);
    const results = [];
    for (const name of names) {
      const result = await plugins.update(name, { yes: options.yes === true, ...(confirm ? { confirm } : {}) });
      const scenarioIssues = await scenarioIssuesOf(name, true);
      results.push({ ...result, ...(scenarioIssues.length ? { scenarioIssues } : {}) });
    }
    if (json) emit({ plugins: results });
    else {
      for (const result of results) {
        ui.status(result.changed ? 'done' : 'ok', result.changed ? `已准备插件候选 ${result.entry.name}` : `插件 ${result.entry.name} 已是最新`, result.entry.candidate?.version ?? describeSource(result.entry));
        warnScenarioIssues(result.entry.name, result.scenarioIssues ?? []);
      }
      if (results.some(result => result.changed)) ui.hint('活动版本未改变。运行 dutydeck plugin status <name> 检查切换条件，再 dutydeck plugin activate <name>；成功后启动服务。');
    }
    return { ok: true };
  }
  if (action === 'activate' || action === 'rollback') {
    const entry = action === 'activate' ? await plugins.activate(args[0]!) : await plugins.rollback(args[0]!);
    if (json) emit({ plugin: entry });
    else { ui.status('done', `${action === 'activate' ? '已激活' : '已回退'}插件 ${entry.name}`, entry.version); ui.hint('运行 dutydeck start；systemd 实例运行 systemctl --user start <unit>。'); }
    return { ok: true };
  }
  if (action === 'status') {
    const status = await plugins.activationStatus(args[0]!);
    if (json) emit({ name: args[0], ...status });
    else {
      ui.keyValues([['选定版本', `${status.selected.version ?? '(无版本)'} · ${status.selected.id}`], ['候选', status.candidate?.version ?? status.candidate?.id ?? '无'], ['上一版本', status.previous?.version ?? status.previous?.id ?? '无']]);
      for (const host of status.hosts) ui.status(host.activated ? 'ok' : 'warn', `Host PID ${host.pid}`, `${host.artifact} · ${host.activated ? '已激活' : '加载失败或未完成'}`);
      for (const blocker of status.blockers) ui.status('warn', blocker.id, blocker.detail);
      if (!status.blockers.length) ui.hint('当前可离线切换；这不代表静态校验已证明 provider 能加载。');
      else ui.hint('先在当前版本完成/取消任务并核对动作，再 dutydeck stop；systemd 实例用 systemctl --user stop <unit> 停止所有共用此目录的实例。切换后 dutydeck start / systemctl --user start <unit>。');
    }
    return { ok: true };
  }
  if (action === 'uninstall') {
    await plugins.uninstall(args[0]!);
    if (json) emit({ name: args[0] }); else { ui.status('done', `已卸载插件 ${args[0]}`); restartHint(ui); }
    return { ok: true };
  }
  if (action === 'enable' || action === 'disable') {
    const entry = await plugins.setEnabled(args[0]!, action === 'enable');
    if (json) emit({ plugin: entry }); else { ui.status('done', `${action === 'enable' ? '已启用' : '已停用'}插件 ${entry.name}`); restartHint(ui); }
    return { ok: true };
  }
  if (action === 'list') {
    const entries = plugins.list();
    const builtinNames = plugins.builtinNames();
    const builtins = await Promise.all(listBuiltinPlugins(plugins.builtinRoot).map(async ({ name, root }) => {
      try {
        const loaded = await loadPluginDirectory(root);
        const problem = loaded.manifest.name !== name ? `目录名 ${name} 与插件名 ${loaded.manifest.name} 不一致` : scenarioProblem(loaded);
        return { name, ...(loaded.manifest.version ? { version: loaded.manifest.version } : {}), ...(problem ? { problem } : {}) };
      } catch (error) { return { name, problem: error instanceof Error ? error.message : String(error) }; }
    }));
    const checked = await Promise.all(entries.map(async entry => {
      if (builtinNames.has(entry.name)) return { entry, activation: undefined, problem: `和内置插件 ${entry.name} 同名，不会加载；卸载后改名重新安装` };
      try {
        const loaded = await loadPluginDirectory(plugins.pluginDir(entry.name));
        const untrusted = loaded.capabilities.filter(capability => !entry.trustedCapabilities.includes(capability));
        const problem = untrusted.length ? `能力未经确认：${untrusted.join('、')}` : scenarioProblem(loaded);
        return { entry, activation: await plugins.activationStatus(entry.name), ...(problem ? { problem } : {}) };
      } catch (error) { return { entry, activation: undefined, problem: error instanceof Error ? error.message : String(error) }; }
    }));
    if (json) { emit({ plugins: [...builtins.map(item => ({ ...item, builtin: true, scope: 'global', enabled: true })), ...checked.map(({ entry, problem, activation }) => ({ ...entry, ...(activation ? { activation } : {}), ...(problem ? { problem } : {}) }))] }); return { ok: true }; }
    if (!entries.length && !builtins.length) { ui.status('info', '还没有安装插件'); ui.hint('安装：dutydeck plugin install <目录|git 地址|npm 包>'); return { ok: true }; }
    for (const { name, version, problem } of builtins) {
      ui.status(problem ? 'warn' : 'ok', `${name}${version ? ` ${version}` : ''}`, '内置 · 已启用 · global');
      if (problem) ui.hint(problem);
    }
    for (const { entry, problem } of checked) {
      ui.status(problem ? 'warn' : entry.enabled ? 'ok' : 'skip', `${entry.name}${entry.version ? ` ${entry.version}` : ''}`, `${entry.enabled ? '已启用' : '已停用'} · ${entry.scope}`);
      ui.hint(describeSource(entry));
      if (entry.candidate) ui.hint(`候选：${entry.candidate.version ?? entry.candidate.id}；尚未激活，查看 dutydeck plugin status ${entry.name}`);
      if (problem) ui.hint(problem);
    }
    return { ok: true };
  }
  if (action === 'trigger-token') {
    const [plugin, triggerId] = (args[0] ?? '').split('/', 2);
    if (!plugin || !triggerId) throw new PluginStoreError('PLUGIN_TRIGGER_INVALID', '格式：dutydeck plugin trigger-token <插件>/<触发器>');
    const { token, created } = await plugins.ensureTriggerToken(plugin, triggerId, options.rotate === true);
    const path = `/api/plugins/${plugin}/triggers/${triggerId}`;
    if (json) emit({ plugin, trigger: triggerId, path, token, created });
    else { ui.status('done', created ? `已生成触发器令牌 ${plugin}/${triggerId}` : `触发器令牌 ${plugin}/${triggerId}`); ui.line(token); ui.hint(`入口：POST ${path}（令牌按触发器的 auth 配置放在请求头，或作为 HMAC 密钥），轮换后立即生效`); }
    return { ok: true };
  }
  if (action === 'config') {
    const [name, key] = args;
    if (!name || !key) throw new PluginStoreError('PLUGIN_CONFIG_INVALID', '格式：dutydeck plugin config <插件> <配置项> [--value <值> | --value-fd <fd>]');
    const value = options.value !== undefined ? Buffer.from(options.value, 'utf8') : await readSecretValue({ ...(options.valueFd !== undefined ? { valueFd: options.valueFd } : {}) });
    const result = await plugins.setConfig(name, key, value, options.value !== undefined);
    if (json) emit({ name, key, sensitive: result.sensitive }); else { ui.status('done', `已设置 ${name} 的 ${key}`, result.sensitive ? '敏感值，存入本机密钥目录' : undefined); restartHint(ui); }
    return { ok: true };
  }
  throw new PluginStoreError('PLUGIN_ACTION_UNKNOWN', `未知操作 ${action}`);
}
