import fs from 'node:fs';
import path from 'node:path';
import type { AgentCapabilities, AgentConfig } from './index.js';

function isExecutableFilePosix(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableFileWin32(filePath: string): boolean {
  // Windows 分支未实机验证（测试与生产运行环境为 Linux）。
  // Windows 下文件执行权限主要由后缀名与系统 DACL 决定，fs.accessSync(X_OK) 在 Windows 上并不等价于执行权限位。
  // 此处在 Windows 下验证普通文件存在，并由调用方按 PATHEXT 匹配。
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function checkExecutableCandidate(targetPath: string, isWin32: boolean, extensions: string[]): boolean {
  if (isWin32) {
    const ext = path.extname(targetPath).toLowerCase();
    if (ext && extensions.includes(ext)) {
      return isExecutableFileWin32(targetPath);
    }
    for (const pathext of extensions) {
      const candidate = `${targetPath}${pathext}`;
      if (isExecutableFileWin32(candidate)) return true;
    }
    return isExecutableFileWin32(targetPath);
  }
  return isExecutableFilePosix(targetPath);
}

export function commandExists(command: string): boolean {
  if (!command || typeof command !== 'string') return false;
  const isWin32 = process.platform === 'win32';
  const hasPathSep = command.includes('/') || (isWin32 && command.includes('\\'));

  const rawPathExt = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const win32Exts = isWin32
    ? rawPathExt.split(';').map(e => e.trim().toLowerCase()).filter(Boolean)
    : [];

  if (hasPathSep) {
    const resolved = path.resolve(command);
    return checkExecutableCandidate(resolved, isWin32, win32Exts);
  }

  const rawPathEnv = process.env.PATH;
  let entries: string[];
  if (rawPathEnv === undefined) {
    // Linux/POSIX 平台在 PATH 环境变量缺失时，采用与 Node.js spawn / libc execvp 一致的系统缺省搜索路径
    // Windows 分支未在实机验证，如实标为 unverified
    entries = isWin32 ? [] : ['/usr/bin', '/bin'];
  } else {
    // 按系统 PATH 查找语义保留目录字节，不要 trim()；
    // 空条目（例如 PATH=""、首尾或连续冒号）在 POSIX 标准中表示当前工作目录（'.'）
    entries = rawPathEnv.split(path.delimiter).map(dir => dir === '' ? '.' : dir);
  }

  for (const dir of entries) {
    const candidate = path.join(dir, command);
    if (checkExecutableCandidate(candidate, isWin32, win32Exts)) {
      return true;
    }
  }

  return false;
}

export function probeAgent(agent: AgentConfig, acpxCommand = 'acpx'): AgentCapabilities {
  const executable = commandExists(agent.command);
  // The default runtime is the pinned `acpx` package imported by acp-client.
  // A non-default command is treated as an operator-supplied dependency probe.
  const acpx = acpxCommand === 'acpx' || commandExists(acpxCommand);
  const requested = agent.protocol === 'auto' ? (acpx && executable ? 'acp' : executable ? 'jsonl' : 'pty') : agent.protocol;
  const available = requested === 'acp' ? acpx && executable : executable;
  return { protocol: requested, available, detail: available ? undefined : requested === 'acp' && !acpx ? `acpx is unavailable; install acpx@0.13.0` : `Command not found: ${agent.command}`, pause: agent.capabilities.pause, resume: agent.capabilities.resume };
}
