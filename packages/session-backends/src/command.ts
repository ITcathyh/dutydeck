import { execFile } from 'node:child_process';

/** Bounded asynchronous control command; never blocks the service event loop. */
export function runCommand(binary: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout?: number; maxBuffer?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderrTail = '';
    const child = execFile(binary, args, {
      env: options.env, cwd: options.cwd, encoding: 'utf8',
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) {
        Object.assign(error, { stderr, status: typeof error.code === 'number' ? error.code : null });
        reject(error);
      } else resolve(stdout);
    });
    // execFile otherwise waits for inherited stdio to close after a client
    // exits. Destroy our pipes as well: a faulty client cannot extend the
    // deadline by spawning a descendant that holds them open. Only the
    // management client is signalled; a managed Agent is never targeted.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      reject(Object.assign(new Error(`${binary} control command timed out`), { code: 'ETIMEDOUT', signal: 'SIGKILL', status: null, stderr: stderrTail }));
    }, options.timeout ?? 5_000);
    timer.unref();
    child.stderr?.on('data', data => { stderrTail = (stderrTail + data).slice(-4096); });
    child.stdin?.on('error', () => { /* The command callback owns failure reporting. */ });
    child.stdin?.end(options.input);
  });
}
