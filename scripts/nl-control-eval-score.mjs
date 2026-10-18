/**
 * nl-control-eval 打分逻辑（纯函数，不调用真实 agent）。
 *
 * 输入一条用例的期望、桩记录到的 dutydeck 调用列表和 Agent 最终回答，
 * 判为 correct / wrong / miss / ask 四类。scripts/nl-control-eval.mjs 和单测共用。
 *
 * @typedef {Object} StubCall 一次桩调用记录，字段与 scripts/nl-eval-stub.mjs 写入 JSONL 的一致。
 * @property {string} [kind]
 * @property {string[]} [argv]
 * @property {string} [operation]
 * @property {unknown[]} [args]
 * @property {Record<string, unknown>} [options]
 * @property {string} [risk]
 *
 * @typedef {string | number | boolean | null | { contains?: string, includes?: string, regex?: string, truthy?: boolean }} ParamConstraint
 *
 * @typedef {Object} Expected
 * @property {'command'|'none'|'ask'} kind
 * @property {string} [operation] 期望的 operation 名（如 session.new、schedule.create、status）。
 * @property {Record<string, ParamConstraint>} [params] commander options 名的约束。
 * @property {ParamConstraint[]} [args] 位置参数约束。
 * @property {string[]} [answerContains] kind=none 时回答必须包含这些关键词之一。
 *
 * @typedef {'correct'|'wrong'|'miss'|'ask'} Verdict
 * @typedef {Object} ScoreResult
 * @property {Verdict} verdict
 * @property {string[]} reasons
 * @property {StubCall} [matchedCall]
 */

/** 只读查询和 --dry-run 预览不改变任何状态，不算执行了控制操作。 */
const isDryRun = call => Boolean(call.options?.dryRun) || Boolean(call.argv?.includes('--dry-run'));
const isControl = call => call.risk !== 'read' && !isDryRun(call);

/** 只在 Agent 没有执行任何调用时有意义：判断它是不是在反问用户。 */
export function detectQuestion(text) {
  if (!text) return false;
  if (/[?？]/.test(text)) return true;
  return /要不要|行不行|可以吗|对吗|是否|请问|哪个|哪些|几点|哪天|什么时候|谁来|用哪个|确认一下/.test(text);
}

/**
 * @param {string} name
 * @param {ParamConstraint} constraint
 * @param {unknown} actual
 * @returns {string | undefined}
 */
function failConstraint(name, constraint, actual) {
  if (constraint !== null && typeof constraint === 'object') {
    if (constraint.truthy !== undefined) return Boolean(actual) === constraint.truthy ? undefined : `${name} 期望${constraint.truthy ? '真值' : '假值'}，实际 ${JSON.stringify(actual)}`;
    if (constraint.contains !== undefined) {
      const haystack = Array.isArray(actual) ? actual.join(' ') : String(actual ?? '');
      return haystack.includes(constraint.contains) ? undefined : `${name} 应包含「${constraint.contains}」，实际 ${JSON.stringify(actual)}`;
    }
    if (constraint.includes !== undefined) {
      return Array.isArray(actual) && actual.includes(constraint.includes) ? undefined : `${name} 应包含 ${JSON.stringify(constraint.includes)}，实际 ${JSON.stringify(actual)}`;
    }
    if (constraint.regex !== undefined) {
      return new RegExp(constraint.regex).test(String(actual ?? '')) ? undefined : `${name} 应匹配 ${constraint.regex}，实际 ${JSON.stringify(actual)}`;
    }
    return `${name}：空约束`;
  }
  return actual === constraint ? undefined : `${name} 期望 ${JSON.stringify(constraint)}，实际 ${JSON.stringify(actual)}`;
}

/**
 * 校验一条调用是否满足期望的 operation、options 和位置参数；返回所有不满足的原因。
 * @param {Expected} expected
 * @param {StubCall} call
 * @returns {string[]}
 */
export function matchCall(expected, call) {
  const reasons = [];
  if (call.operation !== expected.operation) {
    reasons.push(`operation 是 ${call.operation}，期望 ${expected.operation}`);
    return reasons;
  }
  const options = call.options ?? {};
  for (const [name, constraint] of Object.entries(expected.params ?? {})) {
    const reason = failConstraint(name, constraint, options[name]);
    if (reason) reasons.push(reason);
  }
  const args = call.args ?? [];
  (expected.args ?? []).forEach((constraint, index) => {
    const reason = failConstraint(`args[${index}]`, constraint, args[index]);
    if (reason) reasons.push(reason);
  });
  return reasons;
}

/**
 * 打分：
 * - command：有满足约束的调用 → correct；有调用但都不满足 → wrong；没调用且反问 → ask；没调用 → miss。
 *   只做了 --dry-run 预览不算调用。
 * - ask：没执行控制操作且反问 → correct；没执行也没问 → miss；执行了 → wrong。
 * - none：没执行控制操作 → correct（回答或反问都算对）；执行了 → wrong。
 *   ask/none 下只读查询、预览和被拒的命令都没有改变状态，不算执行。
 * @param {Expected} expected
 * @param {StubCall[]} calls
 * @param {string} answer
 * @returns {ScoreResult}
 */
export function scoreCase(expected, calls, answer) {
  // kind=error 且带 operation：命令发出了但参数/用法被拒，算一次失败的执行尝试；help 不算。
  const realCalls = calls.filter(call => (call.kind === 'call' || call.kind === 'error') && call.operation && !isDryRun(call));
  const controlCalls = realCalls.filter(call => call.kind === 'call' && isControl(call));
  if (expected.kind === 'none') {
    if (controlCalls.length) return { verdict: 'wrong', reasons: [`不该执行任何控制操作，实际执行了 ${controlCalls.map(c => c.operation).join('、')}`] };
    if (expected.answerContains && !expected.answerContains.some(keyword => answer.includes(keyword))) {
      return { verdict: 'wrong', reasons: [`没执行操作，但回答没有引导用户${expected.answerContains.join('/')}`] };
    }
    return { verdict: 'correct', reasons: [] };
  }
  if (expected.kind === 'ask') {
    if (controlCalls.length) return { verdict: 'wrong', reasons: [`该先反问，实际执行了 ${controlCalls.map(c => c.operation).join('、')}`] };
    return detectQuestion(answer) ? { verdict: 'correct', reasons: [] } : { verdict: 'miss', reasons: ['该反问用户，实际没有提问'] };
  }
  // command
  if (!realCalls.length) {
    return detectQuestion(answer)
      ? { verdict: 'ask', reasons: ['该执行命令，实际反问了用户'] }
      : { verdict: 'miss', reasons: ['该执行命令，实际没有任何调用'] };
  }
  for (const call of realCalls) {
    const reasons = matchCall(expected, call);
    if (!reasons.length) return { verdict: 'correct', reasons: [], matchedCall: call };
  }
  const tried = realCalls.map(c => c.operation).join('、');
  return { verdict: 'wrong', reasons: [`执行了 ${tried}，但没有一条满足 ${expected.operation} 的参数要求`] };
}
