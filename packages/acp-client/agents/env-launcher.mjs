import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const carrierKey = 'dockmux_agent_env_file';
const digestKey = 'dockmux_agent_env_digest';
const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('Dockmux ACP environment launcher requires a command.\n');
  process.exit(2);
}

let bridged = {};
try {
  const environmentFile = process.env[carrierKey];
  if (!environmentFile) throw new Error('missing runtime environment file');
  bridged = JSON.parse(readFileSync(environmentFile, 'utf8'));
  if (!bridged || typeof bridged !== 'object' || Array.isArray(bridged)) throw new Error('expected an object');
  if (Object.values(bridged).some(value => typeof value !== 'string')) throw new Error('all values must be strings');
} catch (error) {
  process.stderr.write(`Invalid Dockmux ACP environment: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const env = { ...process.env, ...bridged };
delete env[carrierKey];
delete env[digestKey];
const child = spawn(command, args, { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.once('error', error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
