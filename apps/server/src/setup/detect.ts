/**
 * setup 的两个本地步骤：探测已安装的 Agent CLI、确定默认工作目录。
 *
 * 都刻意做成纯函数 + 可注入依赖：探测要 spawnSync 一堆 CLI（慢且依赖机器状态），
 * 目录校验要摸文件系统，两者都必须能在测试里替换掉。
 */
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { builtinAgents } from '@dutydeck/config';
import type { AgentConfig } from '@dutydeck/shared';

export interface DetectedAgent {
  id: string;
  name: string;
  /** CLI 可执行文件（已确认存在于 PATH 或为绝对路径）。 */
  command: string;
  /** 探测到的版本串；取不到说明 CLI 存在但 `--version` 没给出可用输出。 */
  version?: string;
  protocol: 'acp' | 'pty-cli';
  builtin: boolean;
}

export interface DetectAgentsOptions {
  /** 注入点：默认调用 @dutydeck/config 的 builtinAgents()。 */
  scan?: (cwd: string) => AgentConfig[];
  cwd?: string;
}

/**
 * 列出本机已安装的 Agent CLI。
 *
 * 复用 `builtinAgents()`——它内部已经做了 commandExists + cliVersion 探测，
 * 我们不重复实现一套探测逻辑，否则向导报告的可用性会和服务端真实解析结果漂移。
 *
 * 关于「是否已认证」：Dutydeck 没有统一的认证探测接口，各家 CLI 的登录状态存放
 * 位置和判定方式都不同（配置文件、keychain、环境变量），逐个去猜会既慢又不可靠，
 * 还可能误报成「未认证」把用户劝退。因此这里只报告「已安装 + 版本」这个可靠事实，
 * 认证状态留给 doctor 用各 CLI 自己的方式单独体检。
 */
export function detectAgents(options: DetectAgentsOptions = {}): DetectedAgent[] {
  const cwd = options.cwd ?? process.cwd();
  const scan = options.scan ?? (target => builtinAgents(target));
  return scan(cwd).map(agent => ({
    id: agent.id,
    name: agent.name,
    command: agent.command,
    version: agent.version,
    protocol: agent.protocol === 'pty-cli' ? 'pty-cli' : 'acp',
    builtin: agent.builtin === true
  }));
}

/** 目录校验失败的原因，供调用方给出针对性的中文提示。 */
export type DirectoryProblem = 'not_absolute' | 'missing' | 'not_a_directory' | 'not_readable';

export class InvalidWorkingDirectoryError extends Error {
  readonly code = 'SETUP_INVALID_CWD';
  constructor(readonly problem: DirectoryProblem, readonly path: string, message: string) {
    super(message);
  }
}

export interface ValidateDirectoryOptions {
  /** 注入点：测试用假文件系统。 */
  stat?: (path: string) => { isDirectory(): boolean };
  access?: (path: string, mode: number) => void;
}

/**
 * 校验工作目录：必须是绝对路径、存在、是目录、且可读。
 *
 * 为什么在 setup 阶段就严格校验：运行时如果目录不存在，服务端会静默退回到
 * 别的行为，用户要到第一次跑任务才发现问题。有人盯着屏幕的唯一时刻就是现在。
 *
 * 注意 Linux 上没有原生目录选择器（/api/system/capabilities 只在 macOS 报
 * directoryPicker），所以向导必须接受手输路径并自己校验。
 */
export function validateWorkingDirectory(input: string, options: ValidateDirectoryOptions = {}): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new InvalidWorkingDirectoryError('missing', trimmed, '工作目录不能为空。');
  // 先展开 ~，再要求绝对路径：用户输入 ~/project 是完全合理的。
  const expanded = trimmed.startsWith('~')
    ? resolve(process.env.HOME ?? '', trimmed.slice(1).replace(/^\/+/, ''))
    : trimmed;
  if (!isAbsolute(expanded)) {
    throw new InvalidWorkingDirectoryError('not_absolute', expanded, `请使用绝对路径，例如 /home/you/project（收到「${trimmed}」）。`);
  }
  const statImpl = options.stat ?? statSync;
  const accessImpl = options.access ?? accessSync;
  let stats: { isDirectory(): boolean };
  try {
    stats = statImpl(expanded);
  } catch {
    throw new InvalidWorkingDirectoryError('missing', expanded, `目录不存在：${expanded}。请先创建它，或改填一个已存在的目录。`);
  }
  if (!stats.isDirectory()) {
    throw new InvalidWorkingDirectoryError('not_a_directory', expanded, `${expanded} 不是目录。请填写项目所在的目录，而不是文件。`);
  }
  try {
    accessImpl(expanded, constants.R_OK);
  } catch {
    throw new InvalidWorkingDirectoryError('not_readable', expanded, `目录不可读：${expanded}。请检查权限（ls -ld ${expanded}）。`);
  }
  return expanded;
}
