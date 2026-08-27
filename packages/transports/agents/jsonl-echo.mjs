import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ type: 'text', text: `JSONL echo: ${message.prompt}` })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'completed' })}\n`);
});
