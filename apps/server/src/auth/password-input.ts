import type { ReadStream, WriteStream } from 'node:tty';

/** 终端里读一行不回显的输入；Ctrl-C 取消，退格删一个字符 */
function readHiddenLine(stdin: ReadStream, stderr: WriteStream, prompt: string): Promise<string> {
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\u0003') return finish(new Error('已取消，访问密码未修改。'));
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * `dutydeck auth password set` 的输入：stdin 不是终端时读完整个 stdin（去掉末尾一个换行），
 * 是终端时不回显地输入两遍，不一致就不改。
 */
export async function readPasswordInput(stdin: NodeJS.ReadStream = process.stdin, stderr: NodeJS.WriteStream = process.stderr): Promise<string> {
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) text += chunk.toString();
    return text.replace(/\r?\n$/, '');
  }
  const first = await readHiddenLine(stdin as ReadStream, stderr as WriteStream, '访问密码（输入不回显）：');
  const second = await readHiddenLine(stdin as ReadStream, stderr as WriteStream, '再输入一次：');
  if (first !== second) throw new Error('两次输入的访问密码不一致，未修改。');
  return first;
}
