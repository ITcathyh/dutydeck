process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  process.stdout.write(`\u001b[36mRAW PTY\u001b[0m ${data}`);
});
