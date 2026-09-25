import { describe, expect, it } from 'vitest';
import { detectImageFormat, gifSequenceHint } from './image-format.js';

// 1x1 GIF（静态）的完整字节，仅用于文件头识别。
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

describe('detectImageFormat', () => {
  it.each([
    [gif, '.gif', 'image/gif'],
    [Buffer.concat([Buffer.from('GIF87a'), gif.subarray(6)]), '.gif', 'image/gif'],
    [Buffer.from('89504e470d0a1a0a', 'hex'), '.png', 'image/png'],
    [Buffer.from('ffd8ffe0', 'hex'), '.jpg', 'image/jpeg'],
    [Buffer.from('52494646000000005745425056503820', 'hex'), '.webp', 'image/webp'],
    [Buffer.from('RIFF0000WEBPVP8L'), '.webp', 'image/webp'],
    [Buffer.from('RIFF0000WEBPVP8X'), '.webp', 'image/webp'],
  ])('按文件头识别 %s', (bytes, extension, mimeType) => {
    expect(detectImageFormat(bytes)).toEqual({ extension, mimeType });
  });

  it('识别结果不依赖文件名或扩展名', () => {
    expect(detectImageFormat(gif)?.extension).toBe('.gif');
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from('GIF89a'),
    Buffer.from('not an image'),
    Buffer.from('RIFF0000WAVEfmt '),
    Buffer.from('89504e47', 'hex'),
  ])('无法识别或文件头过短时返回 undefined：%j', bytes => {
    expect(detectImageFormat(bytes)).toBeUndefined();
  });
});

describe('gifSequenceHint', () => {
  it('只对 GIF 给出多帧提示', () => {
    expect(gifSequenceHint('image/gif')).toContain('多帧');
    expect(gifSequenceHint('image/png')).toBeUndefined();
    expect(gifSequenceHint(undefined)).toBeUndefined();
  });
});
