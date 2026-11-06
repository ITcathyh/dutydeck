import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { Plugin } from 'vite';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const compressible = /\.(?:css|html|js|json|map|svg)$/;
// 太小的文件压缩后省不了几个字节，不值得多一次文件查找。
const minimumBytes = 1024;

/**
 * 构建后给文本产物写 `<文件>.br` 和 `<文件>.gz`。服务端（apps/server/src/app.ts）按 Accept-Encoding
 * 直接发这些副本，运行时不压缩；没有副本的文件照常回原文件。
 */
export function precompressAssets(): Plugin {
  return {
    name: 'dutydeck-precompress',
    apply: 'build',
    async writeBundle(options, bundle) {
      const directory = options.dir;
      if (!directory) throw new Error('precompressAssets requires build.outDir');
      await Promise.all(Object.keys(bundle).filter(name => compressible.test(name)).map(async name => {
        const file = join(directory, name);
        const source = await readFile(file);
        if (source.byteLength < minimumBytes) return;
        const [gzipped, brotli] = await Promise.all([
          gzipAsync(source, { level: 9 }),
          brotliAsync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength } })
        ]);
        if (gzipped.byteLength < source.byteLength) await writeFile(`${file}.gz`, gzipped);
        if (brotli.byteLength < source.byteLength) await writeFile(`${file}.br`, brotli);
      }));
    }
  };
}
