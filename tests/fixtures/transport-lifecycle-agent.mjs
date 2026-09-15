import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

// 仅用于本地 transports 生命周期测试的专用进程，不接触任何真实 daemon。
if (process.env.lifecycle_close_stdin === '1') {
  // 关掉 stdin 管道读端后才发 ready 信号，使测试建立故障条件完全不依赖睡眠。
  closeSync(0);
  if (process.env.lifecycle_ready_file) writeFileSync(process.env.lifecycle_ready_file, String(process.pid));
  if (process.env.lifecycle_spawn_log) appendFileSync(process.env.lifecycle_spawn_log, `${process.pid}\n`);
  setInterval(() => {}, 1000);
}
else if (process.env.lifecycle_orphan_grandchild === '1') {
  const grandchildCode = process.env.lifecycle_grandchild_ignore_sigterm === '1'
    ? "process.on('SIGTERM', () => {}); if (process.send) process.send('ready'); setInterval(() => {}, 1000);"
    : "if (process.send) process.send('ready'); setInterval(() => {}, 1000);";
  const grandchild = spawn(process.execPath, ['-e', grandchildCode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  if (process.env.lifecycle_grandchild_pid_file) writeFileSync(process.env.lifecycle_grandchild_pid_file, String(grandchild.pid));
  if (process.env.lifecycle_spawn_log) appendFileSync(process.env.lifecycle_spawn_log, `${process.pid}\n`);

  // 孙代明确安装好处理器并发出 IPC ready 事件后，parent 才写 ready 并退出；绝不依赖固定睡眠建立竞争条件。
  grandchild.on('message', msg => {
    if (msg === 'ready') {
      if (process.env.lifecycle_ready_file) writeFileSync(process.env.lifecycle_ready_file, String(process.pid));
      process.exit(0);
    }
  });
}
else {
  if (process.env.lifecycle_ready_file) writeFileSync(process.env.lifecycle_ready_file, String(process.pid));
  if (process.env.lifecycle_spawn_log) appendFileSync(process.env.lifecycle_spawn_log, `${process.pid}\n`);
  if (process.env.lifecycle_ignore_sigterm === '1') process.on('SIGTERM', () => {});
  process.on('SIGINT', () => process.stdout.write('INTERRUPTED\n'));
  readline.createInterface({ input: process.stdin }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    process.stdout.write(`${JSON.stringify({ type: 'thinking', text: 'thinking' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'text', text: `echo:${message.prompt}` })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'completed' })}\n`);
  });
  process.stdin.resume();
}
