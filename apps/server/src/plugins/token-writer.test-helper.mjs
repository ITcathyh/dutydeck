import { PluginStore } from './store.ts';

const [directory, operation, plugin, trigger, hold] = process.argv.slice(2);
const store = new PluginStore(directory);
if (hold) {
  const locked = store.withStoreLock.bind(store);
  store.withStoreLock = action => locked(async () => {
    process.send({ type: 'locked' });
    await new Promise(resolve => process.once('message', resolve));
    return action();
  });
}
process.send({ type: 'ready' });
process.once('message', async () => {
  try {
    process.send({ type: 'attempt' });
    const result = operation === 'uninstall' ? await store.uninstall(plugin) : await store.ensureTriggerToken(plugin, trigger, operation === 'rotate');
    process.send({ type: 'result', ok: true, ...result });
  } catch (error) {
    process.send({ type: 'result', ok: false, code: error.code, message: error.message });
  } finally { process.disconnect(); }
});
