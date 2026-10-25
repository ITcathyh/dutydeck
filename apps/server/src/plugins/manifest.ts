import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  agentConfigSchema,
  pluginCommandNamePattern,
  pluginHookEvents,
  pluginHooksFileSchema,
  pluginManifestSchema,
  pluginTriggerIdPattern,
  pluginTriggerSchema,
  scenarioProviderRefs,
  validateScenarioPack,
  type AgentConfig,
  type PluginHooksFile,
  type PluginManifest,
  type PluginService,
  type PluginTrigger,
  type ScenarioPack
} from '@dutydeck/shared';
import type { ZodError } from 'zod';
import { larkCommandRegistry } from '../lark/commands.js';
import { isPathInside } from '../skill-catalog.js';
import { scenarioRegexRunner } from './scenario-regex.js';

export const PLUGIN_MANIFEST_PATH = '.dutydeck-plugin/plugin.json';

export interface PluginIssue { file: string; field?: string; message: string }

export class PluginValidationError extends Error {
  constructor(readonly root: string, readonly issues: PluginIssue[]) {
    super(`插件 ${root} 校验失败：\n${issues.map(issue => `  ${issue.file}${issue.field ? ` ${issue.field}` : ''}：${issue.message}`).join('\n')}`);
    this.name = 'PluginValidationError';
  }
}

export interface PluginCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  template: string;
}

export interface LoadedPlugin {
  root: string;
  manifest: PluginManifest;
  commands: PluginCommand[];
  agents: AgentConfig[];
  skillsDir?: string;
  triggers: Map<string, PluginTrigger>;
  hooks: PluginHooksFile;
  providersEntry?: string;
  service?: { spec: PluginService; entry: string };
  /** 通过静态校验的场景包；provider 引用要到信任确认之后加载时才解析。 */
  scenarios: Array<{ file: string; pack: ScenarioPack }>;
  /** 没通过静态校验的场景包的问题：只跳过那个包，插件其余部分照常加载。 */
  scenarioIssues: PluginIssue[];
  /** 不影响加载的提示（例如 safe-regex2 认为可能回溯的正则）。 */
  scenarioWarnings: PluginIssue[];
  /** 需要安装时确认的能力：agents、hooks:<event>、providers。为空即声明式插件。 */
  capabilities: string[];
}

/**
 * 飞书与 Web 已占用的命令名。插件命令与它们重名时拒绝；`skills` 是 `/skills <名字>` 前导指令。
 */
export function reservedCommandNames(): Set<string> {
  const lark = larkCommandRegistry.flatMap(command => [command.name, ...(command.aliases ?? [])]);
  return new Set([...lark, 'file', 'model', 'reasoning', 'restart', 'skills']);
}

const zodIssues = (file: string, error: ZodError, prefix = ''): PluginIssue[] =>
  error.issues.map(issue => ({ file, field: `${prefix}${issue.path.join('.')}` || undefined, message: issue.message }));

async function readJson(path: string, file: string, issues: PluginIssue[]): Promise<unknown> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { issues.push({ file, message: `读取失败：${(error as NodeJS.ErrnoException).code ?? String(error)}` }); return undefined; }
  try { return JSON.parse(text); }
  catch (error) { issues.push({ file, message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }); return undefined; }
}

/** 组件路径解析：显式声明的必须存在；默认路径不存在就当没有这个组件。真实路径不得逃出插件根目录。 */
async function componentPath(root: string, realRoot: string, declared: string | undefined, fallback: string, field: string, kind: 'dir' | 'file', issues: PluginIssue[]): Promise<string | undefined> {
  const path = resolve(root, declared ?? fallback);
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    if (declared) issues.push({ file: PLUGIN_MANIFEST_PATH, field, message: `${declared} 不存在` });
    return undefined;
  }
  if (kind === 'dir' ? !info.isDirectory() : !info.isFile()) {
    issues.push({ file: PLUGIN_MANIFEST_PATH, field, message: `${declared ?? fallback} 应当是${kind === 'dir' ? '目录' : '文件'}` });
    return undefined;
  }
  const real = await realpath(path);
  if (!isPathInside(real, realRoot)) {
    issues.push({ file: PLUGIN_MANIFEST_PATH, field, message: `${declared ?? fallback} 指向插件目录之外` });
    return undefined;
  }
  return path;
}

async function listFiles(dir: string, extension: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(extension)).map(entry => entry.name).sort();
}

/** 只认 `key: value` 形式的 frontmatter（值可带引号）；其余键忽略。 */
export function parseCommandMarkdown(markdown: string): { frontmatter: Record<string, string>; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: markdown.trim() };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair) frontmatter[pair[1]!] = pair[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { frontmatter, body: markdown.slice(match[0].length).trim() };
}

/** agents 也要确认：Agent 定义就是要执行的命令（启动时还会跑 `--version`），并且可以自带 full-trust 权限模式。 */
export function pluginCapabilities(hooks: PluginHooksFile, providersEntry: string | undefined, agents: AgentConfig[] = [], service?: LoadedPlugin['service']): string[] {
  return [
    ...(agents.length ? ['agents'] : []),
    ...pluginHookEvents.filter(event => hooks[event]?.length).map(event => `hooks:${event}`),
    ...(providersEntry ? ['providers'] : []),
    ...(service ? ['service'] : [])
  ];
}

/** 读取并校验一个插件目录；所有问题一次性收集，带文件名和字段名抛出。 */
export async function loadPluginDirectory(rootInput: string, options: { reservedCommands?: Set<string> } = {}): Promise<LoadedPlugin> {
  const root = resolve(rootInput);
  const issues: PluginIssue[] = [];
  const realRoot = await realpath(root).catch(() => undefined);
  if (!realRoot) throw new PluginValidationError(root, [{ file: root, message: '目录不存在' }]);
  const rawManifest = await readJson(join(root, PLUGIN_MANIFEST_PATH), PLUGIN_MANIFEST_PATH, issues);
  if (rawManifest === undefined) throw new PluginValidationError(root, issues);
  const parsed = pluginManifestSchema.safeParse(rawManifest);
  if (!parsed.success) throw new PluginValidationError(root, zodIssues(PLUGIN_MANIFEST_PATH, parsed.error));
  const manifest = parsed.data;
  const reserved = options.reservedCommands ?? reservedCommandNames();

  const commands: PluginCommand[] = [];
  const commandsDir = await componentPath(root, realRoot, manifest.commands, 'commands', 'commands', 'dir', issues);
  if (commandsDir) for (const fileName of await listFiles(commandsDir, '.md')) {
    const file = `${manifest.commands ?? 'commands'}/${fileName}`;
    const name = basename(fileName, '.md');
    if (!pluginCommandNamePattern.test(name) || name.length > 32) { issues.push({ file, message: '命令名（文件名）只能用小写字母、数字、- 和 _，以字母开头，最长 32 个字符' }); continue; }
    if (reserved.has(name)) { issues.push({ file, message: `/${name} 是 Dutydeck 内置命令，插件不能重名` }); continue; }
    const { frontmatter, body } = parseCommandMarkdown(await readFile(join(commandsDir, fileName), 'utf8'));
    if (!body) { issues.push({ file, message: '正文（prompt 模板）为空' }); continue; }
    if (body.length > 20_000) { issues.push({ file, message: '正文超过 20000 个字符' }); continue; }
    commands.push({ name, template: body, ...(frontmatter.description ? { description: frontmatter.description } : {}), ...(frontmatter['argument-hint'] ? { argumentHint: frontmatter['argument-hint'] } : {}) });
  }

  const agents: AgentConfig[] = [];
  const agentsDir = await componentPath(root, realRoot, manifest.agents, 'agents', 'agents', 'dir', issues);
  if (agentsDir) for (const fileName of await listFiles(agentsDir, '.json')) {
    const file = `${manifest.agents ?? 'agents'}/${fileName}`;
    const raw = await readJson(join(agentsDir, fileName), file, issues);
    if (raw === undefined) continue;
    const agent = agentConfigSchema.safeParse(raw);
    if (agent.success) agents.push(agent.data); else issues.push(...zodIssues(file, agent.error));
  }

  const skillsDir = await componentPath(root, realRoot, manifest.skills, 'skills', 'skills', 'dir', issues);

  const triggers = new Map<string, PluginTrigger>();
  const triggersDir = await componentPath(root, realRoot, manifest.triggers, 'triggers', 'triggers', 'dir', issues);
  if (triggersDir) for (const fileName of await listFiles(triggersDir, '.json')) {
    const file = `${manifest.triggers ?? 'triggers'}/${fileName}`;
    const id = basename(fileName, '.json');
    if (!pluginTriggerIdPattern.test(id) || id.length > 64) { issues.push({ file, message: '触发器 id（文件名）只能用小写字母、数字、- 和 _，以字母开头' }); continue; }
    const raw = await readJson(join(triggersDir, fileName), file, issues);
    if (raw === undefined) continue;
    const trigger = pluginTriggerSchema.safeParse(raw);
    if (!trigger.success) { issues.push(...zodIssues(file, trigger.error)); continue; }
    for (const field of ['botAppId', 'chatId'] as const) for (const match of trigger.data.target[field].matchAll(/\{\{\s*config\.([a-z][a-z0-9_]*)\s*\}\}/g)) {
      if (!manifest.userConfig?.[match[1]!]) issues.push({ file, field: `target.${field}`, message: `引用了未在 userConfig 声明的配置项 ${match[1]}` });
    }
    triggers.set(id, trigger.data);
  }

  let hooks: PluginHooksFile = {};
  const hooksFile = await componentPath(root, realRoot, manifest.hooks, 'hooks/hooks.json', 'hooks', 'file', issues);
  if (hooksFile) {
    const file = manifest.hooks ?? 'hooks/hooks.json';
    const raw = await readJson(hooksFile, file, issues);
    if (raw !== undefined) {
      const parsedHooks = pluginHooksFileSchema.safeParse(raw);
      if (parsedHooks.success) hooks = parsedHooks.data as PluginHooksFile; else issues.push(...zodIssues(file, parsedHooks.error));
    }
  }

  const providersEntry = manifest.providers ? await componentPath(root, realRoot, manifest.providers, manifest.providers, 'providers', 'file', issues) : undefined;
  const serviceEntry = manifest.service ? await componentPath(root, realRoot, manifest.service.entry, manifest.service.entry, 'service.entry', 'file', issues) : undefined;
  const service = serviceEntry && manifest.service ? { spec: manifest.service, entry: serviceEntry } : undefined;

  const scenarios: LoadedPlugin['scenarios'] = [];
  const scenarioIssues: PluginIssue[] = [];
  const scenarioWarnings: PluginIssue[] = [];
  const scenariosDir = await componentPath(root, realRoot, manifest.scenarios, 'scenarios', 'scenarios', 'dir', issues);
  if (scenariosDir) for (const fileName of await listFiles(scenariosDir, '.json')) {
    const file = `${manifest.scenarios ?? 'scenarios'}/${fileName}`;
    const packIssues: PluginIssue[] = [];
    const raw = await readJson(join(scenariosDir, fileName), file, packIssues);
    const checked = raw === undefined ? undefined : validateScenarioPack(raw);
    if (checked) {
      packIssues.push(...checked.issues.map(issue => ({ file, ...issue })));
      scenarioWarnings.push(...checked.warnings.map(issue => ({ file, ...issue })));
    }
    const pack = checked?.pack;
    if (pack) {
      if (basename(fileName, '.json') !== pack.id) packIssues.push({ file, field: 'id', message: `文件名应当是 ${pack.id}.json` });
      if (scenarios.some(item => item.pack.id === pack.id)) packIssues.push({ file, field: 'id', message: `场景包 ${pack.id} 重复` });
      if (!manifest.providers) for (const ref of scenarioProviderRefs(pack)) packIssues.push({ file, field: ref.field, message: `引用了 provider ${ref.id}，但清单没有声明 providers 入口` });
      packIssues.push(...await phraseExampleIssues(pack, file));
    }
    if (packIssues.length || !pack) scenarioIssues.push(...packIssues);
    else scenarios.push({ file, pack });
  }

  if (issues.length) throw new PluginValidationError(root, issues);
  return {
    root, manifest, commands, agents, triggers, hooks, scenarios, scenarioIssues, scenarioWarnings,
    ...(skillsDir ? { skillsDir } : {}),
    ...(providersEntry ? { providersEntry } : {}),
    ...(service ? { service } : {}),
    capabilities: pluginCapabilities(hooks, providersEntry, agents, service)
  };
}

/** 短语示例要能被包里的正则匹配：在宿主的隔离线程里跑，执行的是包里的正则，不是插件代码。 */
async function phraseExampleIssues(pack: ScenarioPack, file: string): Promise<PluginIssue[]> {
  const phrases = pack.phrases;
  if (!phrases) return [];
  const cases = (['enable', 'disable'] as const).flatMap(kind => phrases.examples[kind].map((example, index) => ({ kind, example, index })));
  try {
    const results = await scenarioRegexRunner().run(cases.flatMap(({ kind, example }) => phrases[kind].map(regex => ({ ...regex, input: example, maxInput: phrases.maxLength }))));
    let offset = 0;
    return cases.flatMap(({ kind, example, index }) => {
      const count = phrases[kind].length;
      const matched = results.slice(offset, offset + count).some(result => result.matched);
      offset += count;
      return matched ? [] : [{ file, field: `phrases.examples.${kind}.${index}`, message: `示例「${example}」没有被 phrases.${kind} 里的任何正则匹配` }];
    });
  } catch (error) {
    return [{ file, field: 'phrases', message: `示例检查失败：${error instanceof Error ? error.message : String(error)}` }];
  }
}
