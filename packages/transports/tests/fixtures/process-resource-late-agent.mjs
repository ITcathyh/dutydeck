import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const emit = o => process.stdout.write(JSON.stringify(o) + '\n');

readline.createInterface({ input: process.stdin }).on('line', line => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const prompt = parsed.prompt ?? '';
  if (process.env.PROCESS_RESOURCE_PROMPT_LOG) {
    appendFileSync(process.env.PROCESS_RESOURCE_PROMPT_LOG, JSON.stringify(prompt) + '\n');
  }

  if (prompt === 'first-timeout') {
    // 忽略 SIGTERM，必须升级到 SIGKILL 才能终止
    process.on('SIGTERM', () => {});
    // 在 80ms 驱动超时之后触发迟到输出（160ms）
    setTimeout(() => {
      emit({ type: 'text', text: 'STALE-FIRST' });
      emit({ type: 'error', message: 'STALE-ERROR' });
      emit({ type: 'completed', stopReason: 'end_turn' });
      if (process.env.LATE_EVENT_LOG) {
        appendFileSync(process.env.LATE_EVENT_LOG, 'emitted\n');
      }
    }, 160);
  } else {
    emit({ type: 'text', text: 'fresh:' + prompt });
    emit({ type: 'completed', stopReason: 'end_turn' });
  }
});

process.stdin.resume();
