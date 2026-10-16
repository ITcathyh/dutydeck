import { readFileSync } from 'node:fs';
import { launchAgent } from './launcher-process.mjs';

// claude-acp.mjs 经一个 sh 转发脚本把 CLAUDE_CODE_EXECUTABLE 指到这里：把凭据保护 hook 并进 --settings，
// 再启动真正的 Claude Code。SDK 自己也可能传 --settings，而 Claude Code 只认最后一个，所以合并而不是追加。
const { dutydeck_claude_executable: claude, dutydeck_secret_guard_settings: guard, ...env } = process.env;
const args = process.argv.slice(2);
const index = args.findIndex(arg => arg === '--settings' || arg.startsWith('--settings='));
let settings = {};
if (index >= 0) {
  const inline = args[index].startsWith('--settings=');
  const value = inline ? args[index].slice('--settings='.length) : args[index + 1] ?? '';
  settings = JSON.parse(value.trimStart().startsWith('{') ? value : readFileSync(value, 'utf8'));
  args.splice(index, inline ? 1 : 2);
}
const hooks = { ...settings.hooks, PreToolUse: [...JSON.parse(guard).hooks.PreToolUse, ...(settings.hooks?.PreToolUse ?? [])] };
// 子进程看到的是真实路径：在会话里再起 Dutydeck 时不会把转发脚本又包一层。
launchAgent(claude, ['--settings', JSON.stringify({ ...settings, hooks }), ...args], { ...env, CLAUDE_CODE_EXECUTABLE: claude });
