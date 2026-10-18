import { PluginStore } from './store.ts';

const [directory, operation, plugin, key] = process.argv.slice(2);
const store = new PluginStore(directory);
const read = store.readConfigFile.bind(store);
store.readConfigFile = async () => {
  const config = await read();
  process.send({ type: 'read' });
  await new Promise(resolve => process.once('message', resolve));
  return config;
};
process.send({ type: 'ready' });
process.once('message', async () => {
  try {
    process.send({ type: 'attempt' });
    if (operation === 'uninstall') await store.uninstall(plugin);
    else await store.setConfig(plugin, key, Buffer.from(key));
    process.send({ type: 'result', ok: true });
  } catch (error) {
    process.send({ type: 'result', ok: false, message: error.message });
  } finally { process.disconnect(); }
});
