import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ type: 'thinking', text: 'JSONL thinking' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'tool_call', id: 'jsonl-tool', name: 'echo', input: msg })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'tool_result', id: 'jsonl-tool', output: 'ok' })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'text', text: `JSONL: ${msg.prompt}` })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'completed' })}\n`);
});
