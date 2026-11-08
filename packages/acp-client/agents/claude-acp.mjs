import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants, existsSync, lstatSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { launchAgent } from './launcher-process.mjs';
import { fileURLToPath } from 'node:url';

const policyUrl = new URL('./child-environment.mjs', import.meta.url);
const { childEnvironment } = await import(existsSync(policyUrl) ? policyUrl.href : '@dutydeck/shared/child-environment');

async function settingsEnvironment(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed?.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return {};
    return Object.fromEntries(Object.entries(parsed.env).filter((entry) => typeof entry[1] === 'string'));
  } catch { return {}; }
}

// 项目设置来自正在处理的仓库：能在 exec 之前改变加载、执行目标或 Dutydeck 自身配置的变量一律不取。
const workspaceDenied = /^(?:NODE_OPTIONS|NODE_PATH|PATH|SHELL|BASH_ENV|ENV|CLAUDE_CONFIG_DIR|LD_\w*|DYLD_\w*|\w*_EXECUTABLE|DUTYDECK_\w*)$/i;
const workspaceEnvironment = env => Object.fromEntries(Object.entries(env).filter(([key]) => !workspaceDenied.test(key)));

async function findClaudeExecutable(pathValue) {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const directory of String(pathValue ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try { await access(candidate, constants.X_OK); return candidate; }
      catch {}
    }
  }
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// 凭据保护：claude-agent-acp 起的 Claude Code 也要带上 PreToolUse hook（非管理员轮次才生效，见 secret-guard.mjs）。
// SDK 只接受一个可执行文件路径，这里写一个 sh 转发脚本，经 claude-guard.mjs 把 hook 并进 --settings 再启动真正的 CLI。
async function guardedExecutable() {
  const guardUrl = new URL('./secret-guard.mjs', import.meta.url);
  const guard = await import(existsSync(guardUrl) ? guardUrl.href : '@dutydeck/shared/secret-guard');
  const directory = join(tmpdir(), `dutydeck-claude-guard-${process.getuid?.() ?? 'user'}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Claude guard directory must be private and owned by the current user: ${directory}`);
  }
  const script = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./claude-guard.mjs', import.meta.url)))} "$@"\n`;
  const file = join(directory, `claude-${createHash('sha256').update(script).digest('hex').slice(0, 16)}.sh`);
  await writeFile(file, script, { mode: 0o700, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const hook = { matcher: guard.secretGuardToolMatcher, hooks: [{ type: 'command', command: guard.secretGuardHookCommand({ nodePath: process.execPath, policyRoot: process.cwd() }), timeout: 10 }] };
  return { file, settings: JSON.stringify({ hooks: { PreToolUse: [hook] } }) };
}

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
// 不读工作区 .env / .env.local：那是仓库或 Dutydeck 自己的服务配置，不是 Claude 的设置。
const settingsEnv = Object.assign(
  {},
  await settingsEnvironment(join(configDir, 'settings.json')),
  workspaceEnvironment(await settingsEnvironment(join(process.cwd(), '.claude', 'settings.json'))),
  workspaceEnvironment(await settingsEnvironment(join(process.cwd(), '.claude', 'settings.local.json')))
);
// 机器人设了 claudeAutoMemory=off 的群聊会话带小写标记；放在最底层，用户设置和显式环境里的同名值都压过它，与终端模式一致。
const autoMemoryDefault = process.env.dutydeck_claude_auto_memory === 'off' ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {};
// 设置里的变量同样过一遍子进程清洗，不把服务密钥和别的会话身份带给 Claude。
const env = { ...autoMemoryDefault, ...childEnvironment(settingsEnv), ...process.env };
const installedClaude = await findClaudeExecutable(env.PATH);
if (installedClaude && process.platform !== 'win32') {
  const guarded = await guardedExecutable();
  env.dutydeck_claude_executable = installedClaude;
  env.dutydeck_secret_guard_settings = guarded.settings;
  env.CLAUDE_CODE_EXECUTABLE = guarded.file;
} else if (installedClaude) env.CLAUDE_CODE_EXECUTABLE = installedClaude;
const bundledClaudeAcp = fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'));
const command = process.env.DUTYDECK_CLAUDE_ACP_COMMAND || process.execPath;
const args = process.env.DUTYDECK_CLAUDE_ACP_ARGS_JSON
  ? JSON.parse(process.env.DUTYDECK_CLAUDE_ACP_ARGS_JSON)
  : [bundledClaudeAcp];
launchAgent(command, args, env);
