import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { registerAuthMiddleware } from './auth/auth.js';
import { inheritedListenOptions, inheritedSocketMismatch, takeInheritedListenSocket } from './socket-activation.js';

const config = { host: process.env.FIXTURE_CONFIG_HOST!, port: Number(process.env.FIXTURE_CONFIG_PORT) };
const mode = process.env.FIXTURE_AUTH_MODE as 'local' | 'token';
const token = 'fixture-token-not-a-credential';
const app = Fastify({ logger: false });
registerAuthMiddleware(app, { mode, localOnly: mode === 'local', getToken: async () => token });
app.post('/api/fixture/control', async request => ({ ok: true, peer: request.socket.remoteAddress, hasCredential: Boolean(request.headers.authorization) }));
const inherited = takeInheritedListenSocket();
if (!inherited || 'error' in inherited) throw new Error(inherited && 'error' in inherited ? inherited.error : 'missing inherited socket');
await app.listen(inheritedListenOptions(inherited.fd));
const mismatch = inheritedSocketMismatch(app.server.address(), config);
const childFds = process.env.FIXTURE_CHECK_FDS === 'true'
  ? execFileSync('sh', ['-c', 'ls /proc/$$/fd']).toString().split(/\s+/).filter(Boolean)
  : undefined;
process.stdout.write(`${JSON.stringify({ address: app.server.address(), mismatch: mismatch ?? null, addresses: app.addresses().length, childFds })}\n`);
process.stdin.once('data', async () => {
  await app.close();
  if (mismatch) {
    process.stderr.write(`${mismatch}\n`);
    process.exitCode = 1;
  }
});
process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
