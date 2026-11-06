import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { precompressAssets } from '../vite-precompress';

it('writes gzip and brotli sidecars for built text assets only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-precompress-'));
  try {
    const script = 'export const value = "dutydeck";\n'.repeat(200);
    const files: Record<string, string | Buffer> = {
      'assets/app.js': script,
      'assets/app.css': '.timeline { color: red; }\n'.repeat(100),
      'assets/tiny.js': 'export {}',
      'assets/logo.png': Buffer.alloc(4096, 1)
    };
    await writeFile(join(directory, 'index.html'), '<main></main>'.repeat(100));
    await mkdir(join(directory, 'assets'));
    await Promise.all(Object.entries(files).map(([name, body]) => writeFile(join(directory, name), body)));
    const bundle = Object.fromEntries(['index.html', ...Object.keys(files)].map(name => [name, {}]));
    const plugin = precompressAssets();
    await (plugin.writeBundle as (options: { dir: string }, bundle: object) => Promise<void>)({ dir: directory }, bundle);

    expect((await readdir(join(directory, 'assets'))).sort()).toEqual(['app.css', 'app.css.br', 'app.css.gz', 'app.js', 'app.js.br', 'app.js.gz', 'logo.png', 'tiny.js']);
    expect(gunzipSync(await readFile(join(directory, 'assets/app.js.gz'))).toString()).toBe(script);
    expect(brotliDecompressSync(await readFile(join(directory, 'assets/app.js.br'))).toString()).toBe(script);
    expect((await readdir(directory)).sort()).toEqual(['assets', 'index.html', 'index.html.br', 'index.html.gz']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
