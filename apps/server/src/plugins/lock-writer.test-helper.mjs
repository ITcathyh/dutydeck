import { PluginStore } from './store.ts';

const [directory, operation, target, hold] = process.argv.slice(2);
const store = new PluginStore(directory);
if (hold) {
  const write = store.writeLock.bind(store);
  store.writeLock = async lock => {
    process.send({ type: 'snapshot' });
    await new Promise(resolve => process.once('message', resolve));
    return write(lock);
  };
}
process.send({ type: 'ready' });
process.once('message', async () => {
  try {
    process.send({ type: 'attempt' });
    if (operation === 'install') await store.install(target);
    else if (operation === 'update') await store.update(target);
    else if (operation === 'uninstall') await store.uninstall(target);
    else await store.setEnabled(target, false);
    process.send({ type: 'result', ok: true });
  } catch (error) {
    process.send({ type: 'result', ok: false, code: error.code, message: error.message });
  } finally { process.disconnect(); }
});
