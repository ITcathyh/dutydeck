import type { Readable } from 'node:stream';
import type { RelayClientOptions } from '@dutydeck/relay';
import { runSessionAsk } from './relay-cli.js';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const deny = (reason: string) => JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
} });

/** Claude invokes this command with a structured AskUserQuestion payload on stdin.
 * Other tools and sessions without relay credentials retain their native behavior.
 * A managed question must not fall back to an unanswered terminal dialog on timeout.
 */
export async function runNativeAskHook(payload: unknown, options: RelayClientOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  if (!(env.dutydeck_relay_url ?? env.DUTYDECK_RELAY_URL)?.trim()
    || !(env.dutydeck_relay_token ?? env.DUTYDECK_RELAY_TOKEN)?.trim()) return '';
  if (!object(payload) || payload.hook_event_name !== 'PreToolUse' || payload.tool_name !== 'AskUserQuestion') return '';
  const input = payload.tool_input;
  const questions = object(input) && input.questions;
  if (!Array.isArray(questions) || !questions.length || questions.length > 4) {
    return deny('无法转换提问格式。请用本会话的 dutydeck session ask 重新向用户提问，不要代替用户选择。');
  }
  const parsed: Array<{ question: string; prompt: string; choices: Array<{ label: string }>; multiple: boolean }> = [];
  for (const question of questions) {
    if (!object(question) || typeof question.question !== 'string' || !question.question.trim()
      || question.question.length > 20_000 || !Array.isArray(question.options)
      || question.options.length < 1 || question.options.length > 50) return deny('提问或选项无效，请用 session ask 重新提问。');
    const choices: Array<{ label: string }> = [];
    const descriptions: string[] = [];
    for (const option of question.options) {
      if (!object(option) || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 200) {
        return deny('选项文案无效，请用 session ask 重新提问。');
      }
      choices.push({ label: option.label });
      if (typeof option.description === 'string' && option.description.trim()) {
        descriptions.push(`${option.label}：${option.description}`);
      }
    }
    if (new Set(choices.map(choice => choice.label.trim())).size !== choices.length
      || parsed.some(previous => previous.question === question.question)) return deny('问题或选项重复，请拆开重新提问。');
    parsed.push({ question: question.question,
      prompt: [question.question, ...descriptions].join('\n'), choices, multiple: question.multiSelect === true });
  }
  const answers: Array<[string, string]> = [];
  try {
    // Ask one question at a time so an ordinary topic reply has one clear target.
    for (const question of parsed) {
      const result = await runSessionAsk(question.prompt, {
        choices: JSON.stringify(question.choices), multiple: question.multiple,
      }, options);
      if (result.status !== 'answered' || !result.answer?.trim()) {
        return deny(result.status === 'expired'
          ? '飞书提问已过期，尚未获得用户答案。请说明需要用户补充什么，或重新发起提问；不要自行选择。'
          : '提问已取消或会话已结束，尚未获得完整答案。请停止依赖该答案的操作。');
      }
      answers.push([question.question, result.answer]);
    }
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { ...input as Record<string, unknown>, answers: Object.fromEntries(answers) },
    } });
  } catch {
    // Never echo transport errors: they may contain local URLs or credentials.
    return deny('飞书提问通道暂不可用，未获得用户答案。请告知用户稍后重试，不要自行选择。');
  }
}

export async function readNativeAskPayload(input: Readable): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error('Native question payload is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
