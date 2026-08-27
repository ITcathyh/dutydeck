import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

async function settingsEnvironment(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed?.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) return {};
    return Object.fromEntries(Object.entries(parsed.env).filter((entry) => typeof entry[1] === 'string'));
  } catch { return {}; }
}

async function fileEnvironment(file) {
  try { return parseEnv(await readFile(file, 'utf8')); }
  catch { return {}; }
}

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

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const settingsEnv = Object.assign(
  {},
  await settingsEnvironment(join(configDir, 'settings.json')),
  await fileEnvironment(join(process.cwd(), '.env')),
  await fileEnvironment(join(process.cwd(), '.env.local')),
  await settingsEnvironment(join(process.cwd(), '.claude', 'settings.json')),
  await settingsEnvironment(join(process.cwd(), '.claude', 'settings.local.json'))
);
const env = { ...settingsEnv, ...process.env };
const installedClaude = await findClaudeExecutable(env.PATH);
if (installedClaude) env.CLAUDE_CODE_EXECUTABLE = installedClaude;
const bundledClaudeAcp = fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'));
const command = process.env.DOCKMUX_CLAUDE_ACP_COMMAND || process.execPath;
const args = process.env.DOCKMUX_CLAUDE_ACP_ARGS_JSON
  ? JSON.parse(process.env.DOCKMUX_CLAUDE_ACP_ARGS_JSON)
  : [bundledClaudeAcp];
const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  if (signal && process.platform !== 'win32') {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
