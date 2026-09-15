import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

if (process.env.PROCESS_RESOURCE_PID_FILE) {
  writeFileSync(process.env.PROCESS_RESOURCE_PID_FILE, String(process.pid));
}

if (process.env.PROCESS_RESOURCE_READY_FILE) {
  writeFileSync(process.env.PROCESS_RESOURCE_READY_FILE, String(process.pid));
}

if (process.env.PROCESS_RESOURCE_IGNORE_SIGINT === '1') {
  process.on('SIGINT', () => {});
}

const send = obj => process.stdout.write(`${JSON.stringify(obj)}\n`);

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const prompt = msg.prompt ?? '';
  if (process.env.PROCESS_RESOURCE_PROMPT_LOG) {
    appendFileSync(process.env.PROCESS_RESOURCE_PROMPT_LOG, `${JSON.stringify(prompt)}\n`);
  }

  // 门禁等待
  if (process.env.PROCESS_RESOURCE_GATE_DIR) {
    const gateDir = process.env.PROCESS_RESOURCE_GATE_DIR;
    mkdirSync(gateDir, { recursive: true });
    writeFileSync(`${gateDir}/entered`, '1');
    while (!existsSync(`${gateDir}/release`)) {
      await new Promise(r => setTimeout(r, 10));
    }
  }

  if (prompt === 'hang-forever') {
    return;
  }

  if (prompt === 'exit-without-completed') {
    process.exit(2);
  }

  if (prompt === 'chunk-multiline') {
    const chunk = [
      JSON.stringify({ type: 'thinking', text: 'chunk thinking' }),
      JSON.stringify({ type: 'text', text: 'chunk text' }),
      JSON.stringify({ type: 'completed', stopReason: 'end_turn' })
    ].join('\n');
    process.stdout.write(chunk);
    return;
  }

  // 默认正常响应
  send({ type: 'thinking', text: `thinking:${prompt}` });
  send({ type: 'text', text: `reply:${prompt}` });
  send({ type: 'completed', stopReason: 'end_turn' });
});

process.stdin.resume();
