import { spawn, type SpawnOptions } from 'node:child_process';

export function acpkPassThroughArgs(argv: readonly string[]) {
  return argv[2] === 'acpk' ? argv.slice(3) : undefined;
}

export function runAcpk(args: readonly string[], spawnProcess: typeof spawn = spawn) {
  return new Promise<number>((resolve, reject) => {
    const options: SpawnOptions = { stdio: 'inherit', env: process.env };
    const child = spawnProcess('acpk', [...args], options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
