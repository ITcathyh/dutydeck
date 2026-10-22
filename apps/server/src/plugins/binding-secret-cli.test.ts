import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { LocalFileSecretProvider, LocalFilePluginSecretResolver } from '@dutydeck/secret-provider';
import { setPluginBindingSecret } from './binding-secret-cli.js';
it('creates an immutable namespaced secret, wipes input and exposes only its reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-plugin-secret-'));
  try {
    const provider = new LocalFileSecretProvider(join(root, 'secrets'), { createDirectory: true }); const value = Buffer.from('synthetic-token');
    const result = await setPluginBindingSecret('sample', 'group-a', {}, provider, async () => value);
    expect(result).toEqual({plugin:'sample',reference:'plugin.sample.group-a',status:'configured'}); expect(value.every(byte=>byte===0)).toBe(true);
    expect(new LocalFilePluginSecretResolver(provider).read(result.reference)).toBe('synthetic-token');
    await expect(setPluginBindingSecret('sample', 'group-a', {}, provider, async()=>Buffer.from('new'))).rejects.toMatchObject({code:'SECRET_ALREADY_EXISTS'});
  } finally { await rm(root,{recursive:true,force:true}); }
});
