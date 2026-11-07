import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { currentProcessIdentity, observeProcess } from '@dutydeck/storage';
import { z } from 'zod';
import { processIdentitySchema } from './activation.js';
import { writeFileAtomicSync } from '../atomic-file.js';

/**
 * 进程内 provider 让 daemon 崩溃或启动卡死后的隔离记录。全部同步读写：崩溃记录在 uncaughtExceptionMonitor 里、进程退出前写下。
 * 外部插件被隔离后整包不加载，直到 plugin enable / activate / rollback / uninstall 清除；内置插件不受隔离。
 */
const QUARANTINE_DIR = '.quarantine';
const recordSchema = z.object({ plugin: z.string(), reason: z.enum(['crash', 'startup']), at: z.string(), origin: z.string().optional() });
const loadingSchema = z.object({ plugin: z.string(), at: z.string(), identity: processIdentitySchema });
export type PluginQuarantine = z.infer<typeof recordSchema>;

const directory = (pluginsDir: string) => join(pluginsDir, QUARANTINE_DIR);
const loadingPrefix = (plugin: string) => `${plugin}.loading-`;

const writePrivateJsonSync = (path: string, value: unknown) => writeFileAtomicSync(path, JSON.stringify(value));

function readJson<T>(path: string, schema: z.ZodType<T>): T | undefined {
  try { return schema.parse(JSON.parse(readFileSync(path, 'utf8'))); } catch { return undefined; }
}

export const quarantineDetail = (record: PluginQuarantine) => `已隔离，不会加载：${record.reason === 'crash' ? '上次 daemon 因这个插件的进程内代码出错而退出' : '上次 daemon 在加载它的 providers 时中断（卡住后被重启或被杀）'}（${record.at}）`;
export const quarantineRemedy = (plugin: string) => `修复或确认插件后运行 dutydeck plugin enable ${plugin} 解除隔离，然后重启 daemon。`;

export function quarantinePlugin(pluginsDir: string, record: PluginQuarantine): void {
  mkdirSync(directory(pluginsDir), { recursive: true, mode: 0o700 });
  writePrivateJsonSync(join(directory(pluginsDir), `${record.plugin}.json`), record);
}

/**
 * 只读。显式崩溃记录优先；否则写下加载标记的进程已确认退出（provider 导入或 register 期间被杀、卡死后被重启）也算隔离。
 * 进程存活或无法确认时不算：可能是共用插件目录的另一个实例正在加载。
 */
export function readPluginQuarantine(pluginsDir: string, plugin: string): PluginQuarantine | undefined {
  const dir = directory(pluginsDir);
  const record = readJson(join(dir, `${plugin}.json`), recordSchema);
  if (record) return record;
  let files: string[];
  try { files = readdirSync(dir); } catch { return undefined; }
  for (const file of files.filter(name => name.startsWith(loadingPrefix(plugin)) && name.endsWith('.json'))) {
    const marker = readJson(join(dir, file), loadingSchema);
    if (marker && observeProcess(marker.identity) === 'dead') return { plugin, reason: 'startup', at: marker.at };
  }
  return undefined;
}

export function clearPluginQuarantine(pluginsDir: string, plugin: string): void {
  const dir = directory(pluginsDir);
  let files: string[];
  try { files = readdirSync(dir); } catch { return; }
  for (const file of files) if (file === `${plugin}.json` || file.startsWith(loadingPrefix(plugin))) rmSync(join(dir, file), { force: true });
}

const activeLoadingMarkers = new Set<string>();

/** provider 导入和 register 期间留下的标记；返回的函数在加载结束（成功、失败或超时）时删除它。写不进去不阻止启动。 */
export function markProviderLoading(pluginsDir: string, plugin: string): () => void {
  const path = join(directory(pluginsDir), `${loadingPrefix(plugin)}${process.pid}.json`);
  try {
    mkdirSync(directory(pluginsDir), { recursive: true, mode: 0o700 });
    writePrivateJsonSync(path, { plugin, at: new Date().toISOString(), identity: currentProcessIdentity() });
  } catch { return () => {}; }
  activeLoadingMarkers.add(path);
  return () => { activeLoadingMarkers.delete(path); try { rmSync(path, { force: true }); } catch { /* 删不掉的标记只在本进程退出后才会生效为隔离 */ } };
}

/**
 * 启动期间收到正常停止信号时调用：加载被打断不是插件卡死，删掉本进程的加载标记，下次启动不误判隔离。
 * 同步死循环会堵住事件循环，信号处理器跑不到，进程最终被 SIGKILL，标记照常留下。
 */
export function releaseProviderLoadingMarkers(): void {
  for (const path of activeLoadingMarkers) { try { rmSync(path, { force: true }); } catch { /* 同上 */ } }
  activeLoadingMarkers.clear();
}
