import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readPasswordInput } from './password-input.js';

const fakeTty = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } }) as unknown as NodeJS.ReadStream;
const sink = () => { const stream = new PassThrough(); let text = ''; stream.on('data', chunk => { text += chunk; }); return { stream: stream as unknown as NodeJS.WriteStream, text: () => text }; };

describe('readPasswordInput', () => {
  it('stdin 不是终端时读完整个输入，只去掉末尾一个换行', async () => {
    const stdin = new PassThrough();
    stdin.end(' pass word \n');
    expect(await readPasswordInput(stdin as unknown as NodeJS.ReadStream, sink().stream)).toBe(' pass word ');
  });

  it('终端里不回显地输入两遍，退格生效；两遍不一致就不改', async () => {
    const stdin = fakeTty();
    const stderr = sink();
    const matched = readPasswordInput(stdin, stderr.stream);
    stdin.write('secrex\u007ft\r');
    await new Promise(resolve => setImmediate(resolve));
    stdin.write('secret\r');
    expect(await matched).toBe('secret');
    expect(stderr.text()).not.toContain('secret');

    const mismatched = readPasswordInput(stdin, sink().stream);
    stdin.write('one\r');
    await new Promise(resolve => setImmediate(resolve));
    stdin.write('two\r');
    await expect(mismatched).rejects.toThrow('两次输入的访问密码不一致');

    const cancelled = readPasswordInput(stdin, sink().stream);
    stdin.write('\u0003');
    await expect(cancelled).rejects.toThrow('已取消');
  });
});
