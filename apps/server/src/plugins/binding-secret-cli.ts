import { z } from 'zod';
import type { LocalFileSecretProvider } from '@dutydeck/secret-provider';
import { readSecretValue, type SecretValueInputOptions } from '../secret-cli.js';

/** New references are immutable; rotate by creating a new name and revision-updating bindings. */
export async function setPluginBindingSecret(plugin: string, name: string, options: SecretValueInputOptions, provider: LocalFileSecretProvider, read = readSecretValue) {
  z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).parse(plugin);
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/).parse(name);
  const reference = `plugin.${plugin}.${name}`;
  const value = await read(options, { prompt: 'Plugin secret (hidden): ' });
  try { provider.writeExclusive(reference, value); }
  finally { value.fill(0); }
  return { plugin, reference, status: 'configured' };
}
