import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { runIsolatedCommand, VerificationManager } from '../../src/verification.js';

const cwd = process.argv[2];
if (!cwd) throw new Error('missing fixture cwd');
const options = { timeoutMs: 5_000, maxOutputBytes: 4_096 };
const earlyCommand = `exit 0\n#${'x'.repeat(256 * 1024)}`;
const earlyExit = await runIsolatedCommand(earlyCommand, cwd, { ...options, maxOutputBytes: 1_000 });
const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
const manager = new VerificationManager(repos.config);
let persisted;
try { persisted = await manager.run('session', cwd, { command: earlyCommand }); }
finally { await manager.stop(); repos.close(); }
const normal = await runIsolatedCommand('printf ok', cwd, options);
const failure = await runIsolatedCommand('printf failed; exit 7', cwd, options);
const spawnFailure = await runIsolatedCommand('printf should-not-run', join(cwd, 'missing'), options);
const timedOut = await runIsolatedCommand('sleep 30', cwd, { ...options, timeoutMs: 200 });
const controller = new AbortController();
const abortTimer = setTimeout(() => controller.abort(), 200);
const interrupted = await runIsolatedCommand('sleep 30', cwd, { ...options, signal: controller.signal });
clearTimeout(abortTimer);
process.stdout.write(JSON.stringify({ earlyExit, persisted, normal, failure, spawnFailure, timedOut, interrupted }) + '\n');
