import { writeFileSync } from 'node:fs';
import { LocalFileSecretProvider } from './index.ts';

const [directory, referenceKey, fingerprint, marker] = process.argv.slice(2);
const provider = new LocalFileSecretProvider(directory);
provider.fingerprint = () => {
  writeFileSync(marker, 'locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
};
provider.replaceConditional(referenceKey, Buffer.from('never committed'), fingerprint);
