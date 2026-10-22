import { PluginHost } from './host.js';

// stdin contains trusted installation config, including secrets; never print it or provider errors.
try {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text) as Parameters<typeof PluginHost.validatePlugin>[0];
  process.exit(await PluginHost.validatePlugin(input) ? 0 : 1);
} catch { process.exit(1); }
