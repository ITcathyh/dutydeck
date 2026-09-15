import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

// 专用于进程驱动轮次完成协议验收的本地测试 Agent
if (process.env.turn_agent_ready_file) writeFileSync(process.env.turn_agent_ready_file, String(process.pid));

if (process.env.turn_agent_ignore_sigint === '1') {
  process.on('SIGINT', () => {});
}

if (process.env.turn_agent_close_stdin === '1') {
  process.stdin.destroy();
}

const send = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (process.env.turn_agent_terminate_gate) {
  process.on('SIGTERM', async () => {
    while (!existsSync(process.env.turn_agent_terminate_gate)) await new Promise(resolve => setTimeout(resolve, 5));
    send({ type: 'error', message: 'retired process error' });
    process.stdout.write(`${JSON.stringify({ type: 'completed', stopReason: 'error' })}\n`, () => process.exit(7));
  });
}

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const prompt = msg.prompt ?? '';
  if (process.env.turn_agent_submission_log) appendFileSync(process.env.turn_agent_submission_log, `${JSON.stringify(prompt)}\n`);

  // 1. 门禁暂停模式：收到指令后在完成前等待 release 信号
  if (process.env.turn_agent_gate_dir) {
    const gateDir = process.env.turn_agent_gate_dir;
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(`${gateDir}/entered`, '1');
    while (!existsSync(`${gateDir}/release`)) {
      await new Promise(r => setTimeout(r, 10));
    }
  }

  // 2. 指令支持的特定行为
  if (prompt === 'raw-error-then-completed') {
    send({ type: 'error', message: 'turn internal error' });
    send({ type: 'completed', stopReason: 'error' });
    return;
  }

  if (prompt === 'exit-without-completed') {
    process.exit(2);
  }

  if (prompt === 'chunk-all-and-exit-without-newline') {
    // thinking + tool + text + completed 在同一个 stdout chunk 且末尾无换行后直接退出
    const chunk = [
      JSON.stringify({ type: 'thinking', text: 'chunk thinking' }),
      JSON.stringify({ type: 'text', text: 'chunk text' }),
      JSON.stringify({ type: 'completed', stopReason: 'end_turn' })
    ].join('\n');
    process.stdout.write(chunk);
    process.exit(0);
  }

  if (prompt === 'hang-forever') {
    // 永远不返回 completed，用于测试超时
    return;
  }

  // 默认正常轮次输出
  send({ type: 'thinking', text: `thinking:${prompt}` });
  send({ type: 'text', text: `echo:${prompt}` });
  send({ type: 'completed', stopReason: 'end_turn' });
});

process.stdin.resume();
