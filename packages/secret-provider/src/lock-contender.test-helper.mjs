import { LocalFileSecretProvider } from './index.ts';

const [directory, key, fingerprint] = process.argv.slice(2);
try {
  new LocalFileSecretProvider(directory).replaceConditional(key, Buffer.from('contender'), fingerprint);
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
