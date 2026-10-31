/** @typedef {import('@dutydeck/plugin-sdk').PluginToolSchema} Schema */
/** @typedef {import('@dutydeck/plugin-sdk').PluginToolContext} Context */
/** @typedef {import('@dutydeck/plugin-sdk').PluginToolBinding} Binding */
/** @typedef {import('@dutydeck/plugin-sdk').JsonValue} JsonValue */
/** @typedef {Record<string, string | number | boolean>} Input */
/** @returns {Schema} */
const text = (maxLength = 128) => ({ type: 'string', minLength: 1, maxLength });
/** @param {number} minimum @param {number} maximum @returns {Schema} */
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
/** @param {Record<string, Schema>} properties @param {string[]} required @returns {Schema} */
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const identity = { source_key: text(), record_id: text() };
const traceSchema = object({
  mode: { type: 'string', enum: ['identity', 'message', 'search'] }, ...identity,
  message_id: text(), psm: text(256), rule: text(256), since: text(40), until: text(40), limit: integer(1, 20)
}, ['mode']);
const knownSchema = object({
  ...identity, message_id: text(), alarm_id: text(), card_url: text(2048),
  days: integer(1, 180), limit: integer(1, 10), include_cross_region: { type: 'boolean' }
});
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const messageId = /^om_[A-Za-z0-9]{1,125}$/;
const TIMEOUT_MS = 8000;

class RequestError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}
/** @param {string} message @returns {never} */
const invalid = message => { throw new RequestError('ALARM_ANA_INVALID_INPUT', message); };
/** @param {Input} input */
function checkIdentity(input) {
  if (!safeId.test(String(input.source_key ?? '')) || !safeId.test(String(input.record_id ?? ''))) invalid('source_key 与 record_id 须同时提供，且只能含字母数字和 _ . -。');
}
/** @param {Input} input */
function traceParams(input) {
  /** @type {Record<string, string[]>} */
  const groups = { identity: ['source_key', 'record_id'], message: ['message_id'], search: ['psm', 'rule', 'since', 'until', 'limit'] };
  const keys = groups[String(input.mode)];
  if (!keys || Object.keys(input).some(key => key !== 'mode' && !keys.includes(key))) invalid('三种查法只能选一种：identity、message 或 search，不能混用参数。');
  if (input.mode === 'identity') checkIdentity(input);
  if (input.mode === 'message' && !messageId.test(String(input.message_id ?? ''))) invalid('message 模式须提供 om_ 开头的 message_id。');
  if (input.mode === 'search' && !keys.some(key => input[key] !== undefined)) invalid('search 模式须提供至少一个筛选条件或 limit。');
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'mode'));
}
/** @param {Input} input */
function knownParams(input) {
  if (input.source_key !== undefined || input.record_id !== undefined) checkIdentity(input);
  if ([input.record_id, input.message_id, input.alarm_id, input.card_url].filter(Boolean).length !== 1) invalid('须且只能用 source_key+record_id、message_id、alarm_id、card_url 中的一种定位。');
  if (input.message_id && !messageId.test(String(input.message_id))) invalid('message_id 须以 om_ 开头。');
  return input;
}
/** @param {Binding} binding */
function endpoint(binding) {
  let url;
  try { url = new URL(String(binding.config.endpoint)); } catch { invalid('binding endpoint 必须是同机 Dashboard 的 HTTP 地址。'); }
  // 无管理 token：代操作只能走 Dashboard 对本机请求的既有授权。
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid('endpoint 只允许 http://127.0.0.1:<port> ，不能带路径、凭据或查询参数。');
  return url.origin;
}
/** @param {unknown} value @param {Binding} binding */
function resource(value, binding) {
  const input = /** @type {Input} */ (value);
  return `${endpoint(binding)}/alarm/${encodeURIComponent(String(input.source_key))}/${encodeURIComponent(String(input.record_id))}`;
}
/** @param {unknown} error */
const failure = error => ({ error: {
  code: error instanceof RequestError ? error.code : 'ALARM_ANA_INVALID_RESPONSE',
  message: error instanceof RequestError ? error.message : 'alarm_ana 返回了无法识别的响应，请核对 Dashboard 版本。'
} });
/** @param {string} path @param {Record<string, unknown>} params @param {Context} context @param {Record<string, unknown>} [body] @returns {Promise<Record<string, JsonValue>>} */
async function request(path, params, context, body) {
  const url = new URL(path, endpoint(context.binding));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };
  if (path === '/api/known-issues') {
    const token = await context.binding.getSecret('read_token');
    if (!token) throw new RequestError('ALARM_ANA_READ_TOKEN_REQUIRED', 'known_issues 需要管理员绑定独立读取 token；其他查询不需要。');
    headers.authorization = `Bearer ${token}`;
  }
  if (body) headers['content-type'] = 'application/json';
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  try {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, redirect: 'error', signal, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new RequestError(`ALARM_ANA_HTTP_${response.status}`, `alarm_ana 返回 HTTP ${response.status}；${[401, 403].includes(response.status) ? '请核对独立读取权限及同机访问条件。' : '请核对参数与 Dashboard 状态。'}`);
    if (!response.body) throw new Error('invalid response');
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 2_000_000) throw new RequestError('ALARM_ANA_RESPONSE_TOO_LARGE', 'alarm_ana 响应超过 2 MB，请缩小查询范围。');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid response');
    return result;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (signal.aborted) throw new RequestError('ALARM_ANA_TIMEOUT', 'alarm_ana 请求超时或被取消；查询可重试，代操作结果未知，不得自动重发。');
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'invalid response')) throw new RequestError('ALARM_ANA_INVALID_RESPONSE', 'alarm_ana 返回了无法识别的 JSON，请核对 Dashboard 版本。');
    throw new RequestError('ALARM_ANA_UNREACHABLE', '无法连接本机 alarm_ana Dashboard；请核对服务与端口。代操作结果未知，不得自动重发。');
  }
}

// 只保留业务解释所需字段；新字段默认不进入模型。所有层级共享输出预算。
const traceKeys = new Set(`identity source_key record_id alert_detail_url message_link found stages received grading policy rca card_delivery ack feedback agent_actions status sources file state error bad_lines bad_files send_time ledger_days in_segment segment_acked row origin result_time label source final_source reason rule_id rule_name psm cluster severity strong_condition strong_conditions push_enabled llm_confidence fallback_reason llm_queue_state other_rows recurrence_upgrades ts count_24h verdict skip_rca queue_state queue result disposition stage job_id enqueued_at claimed_at analysis_completed_at sent_at skip_rca_reason delivery_state delivery_sent delivery_attempts delivery_receipt pending_card_message_id pending_card_suppressed retry_count last_error failed_at available_at rca_route category verdict_label verdict_source verdict_reason card_conclusion conclusion candidate_conclusion rca_started_at rca_finished_at duration_ms queue_wait_sec run_sec hint single has_queue_payload direct attempted_at recorded_at error_type message_id root_message_id card_message_id throttle entries value aggregate cards update_count member_count deliveries at kind thread notice groups opened_at expires_at alarm_id history_hit argos_comment argos_comment_at send_started_at send_completed_at latest_observation observation_count auto_ack_attempts intent_id ok acked_at holdout_ratio ack_state acked total_ack first_ack_at first_ack_duration_second ack_by_system ack_by_self system_ack_seen checked_at total_silence current_upgrade_level max_upgrade_level duty_notification_count notification_count count finish start_at end_at comment anomaly_type rca_root_causes auto_ack agent_ack button_feedback action history_conclusion annotated_at hit note channels argos_comment_attempts argos_comment_error oncall_followup last_stage started_at alarm_psm alarm_rule comment_state comment_written comment_error poll_message_count bot_message_count actions action_id task_ref dry_run params minutes intent_at outcome_at outcome paired matches via candidates scanned`.split(' '));
const knownKeys = new Set(`query source_key record_id original_chat_url handling_chat_url message_link rule_name rule_id psm send_time alarm_id region rca_status rca_conclusion verdict match_basis stats days event_count first_seen last_seen concluded_event_count matches kind type text time handler trigger_name uncertain todos owner due status origin security_sensitive incomplete warnings`.split(' '));
const healthKeys = new Set(`available generated_at age_minutes report alerts code severity summary`.split(' '));
const conclusionKeys = new Set(['summary', 'root_cause']);
const diagnosticKeys = new Set(['summary', 'error', 'last_error', 'comment_error', 'argos_comment_error', 'message']);
/** @param {unknown} data @param {Set<string>} keys @param {number} budget @returns {Record<string, JsonValue>} */
function project(data, keys, budget = 24000) {
  let remaining = budget; let truncated = false;
  /** @param {unknown} value @param {number} depth @param {string} field @returns {JsonValue} */
  const visit = (value, depth = 0, field = '') => {
    if (remaining <= 0 || depth > 12) { truncated = true; return null; }
    if (typeof value === 'string') {
      let clean = value.replace(/\b(?:oc|ou)_[A-Za-z0-9]+\b/g, '[已省略身份]');
      if (field.endsWith('_url') || field.endsWith('_link')) {
        const target = /^\[[^\]]*\]\((.*)\)$/.exec(value.trim())?.[1] ?? value.trim();
        try { const url = new URL(target); clean = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? target : ''; }
        catch { clean = ''; }
      } else if (diagnosticKeys.has(field)) {
        // 先保留 HTTP 证据链接；路径须有明确起始边界（空白、引号、等号、冒号、括号或逗号分号）和非空段，允许连续分隔符，引号路径允许空格。
        clean = clean.replace(/https?:\/\/[^\s<>"'`，。；：！？（）]+|(["'])(?:[A-Za-z]:[\\/]+|~?\/+)(?=[^\s\\/"'])[^\r\n]+?\1|(?<=^|[\s"'`=:：(\[{（【，,；;、])(?:[A-Za-z]:[\\/]+|~?\/+)[^\s\\/<>"'`，。；：！？（）)\]};,]+(?:[\\/]+[^\s\\/<>"'`，。；：！？（）)\]};,]+)*[\\/]*/gi,
          match => /^https?:/i.test(match) ? match : /^['"]/.test(match) ? `${match[0]}[已省略路径]${match[0]}` : '[已省略路径]');
      }
      let result = clean.slice(0, 1000);
      if (JSON.stringify(result).length > remaining) result = result.slice(0, Math.max(0, Math.floor((remaining - 2) / 6)));
      remaining -= JSON.stringify(result).length; if (result.length < clean.length) truncated = true;
      return result;
    }
    if (Array.isArray(value)) {
      if (value.length > 20) truncated = true;
      remaining -= 2;
      const result = [];
      for (const child of value.slice(0, 20)) {
        if (remaining < 8) { truncated = true; break; }
        remaining -= 1; result.push(visit(child, depth + 1));
      }
      return result;
    }
    if (value && typeof value === 'object') {
      /** @type {Record<string, JsonValue>} */
      const result = {};
      remaining -= 2;
      for (const [key, child] of Object.entries(value)) {
        if (field === 'conclusion') {
          // 兼容旧 followup 台账，只接受已知业务文本；省略未知结论字段须显式标记。
          if (!conclusionKeys.has(key) || typeof child !== 'string') { truncated = true; continue; }
        } else if (!keys.has(key)) continue;
        remaining -= key.length + 4;
        if (remaining <= 0) { truncated = true; break; }
        result[key] = visit(child, depth + 1, key);
      }
      return result;
    }
    const result = typeof value === 'number' || typeof value === 'boolean' ? value : null;
    remaining -= JSON.stringify(result).length; return result;
  };
  // 先分配状态与证据完整性字段，长结论/待办不能挤掉它们。
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const priority = ['outcome', 'task_ref', 'security_sensitive', 'incomplete', 'verdict', 'found', 'available', 'generated_at', 'age_minutes'];
    const entries = Object.entries(data);
    data = Object.fromEntries([...entries.filter(([key]) => priority.includes(key)), ...entries]);
  }
  const result = /** @type {Record<string, JsonValue>} */ (visit(data));
  return { ...result, truncated };
}

/** @param {import('@dutydeck/plugin-sdk').PluginApi} api */
export default function register(api) {
  /** @param {string} name @param {string} description @param {Schema} inputSchema @param {string} path @param {(input: Input) => Record<string, unknown>} parameters @param {Set<string>} keys */
  const query = (name, description, inputSchema, path, parameters, keys) => api.registerQuery({
    name, description, version: '1', inputSchema,
    resource: (_input, binding) => `${endpoint(binding)}${path}`,
    async execute(input, context) {
      try {
        const result = await request(path, parameters(/** @type {Input} */ (input)), context);
        if ((name === 'alarm_trace' && typeof result.found !== 'boolean' && !Array.isArray(result.candidates)) ||
            (name === 'known_issues' && typeof result.verdict !== 'string') ||
            (name === 'ops_health' && typeof result.available !== 'boolean')) throw new Error('invalid response');
        return project(result, keys);
      }
      catch (error) { return failure(error); }
    }
  });
  query('alarm_trace', '只读追溯报警状态、分级原因、投递与认领；按身份、话题根消息 ID 或条件搜索。', traceSchema, '/api/alarm-trace', traceParams, traceKeys);
  query('known_issues', '只读查询相同报警键的历史结论；需要独立读取 token，不把历史当本轮根因。', knownSchema, '/api/known-issues', knownParams, knownKeys);
  query('ops_health', '只读已生成的系统健康快照与异常摘要；返回快照时间和年龄，不运行体检或推送。', object({}), '/api/ops-health', input => input, healthKeys);
  for (const action of ['ack', 'silence', 'comment']) {
    /** @type {Record<string, Schema>} */
    const extra = action === 'silence' ? { minutes: integer(1, 240) } : action === 'comment' ? { comment: text(500) } : {};
    api.registerAction({
      name: action, version: '1', description: `代请求人执行 ${action}，最终写入由 alarm_ana 开关控制；读取 receipt.outcome，skipped 不是已执行，unknown 禁止重发。`,
      inputSchema: object({ ...identity, ...extra }, ['source_key', 'record_id', ...Object.keys(extra)]), resource,
      async execute(value, context) {
        const input = /** @type {Input} */ (value);
        let result;
        try {
          checkIdentity(input);
          if (!context.actionId) invalid('缺少 dutydeck 动作 ID，不能提交代操作。');
          result = await request('/api/agent-actions', {}, context, {
            ...input, action, apply: true, task_ref: context.actionId, requester: context.identity.actor.id
          });
          if ((typeof result.outcome !== 'string' || !['ok', 'failed', 'skipped', 'rejected', 'unknown'].includes(result.outcome)) && result.phase !== 'intent') throw new Error('invalid action response');
        } catch (error) {
          result = { outcome: 'unknown', task_ref: context.actionId, ...failure(error) };
        }
        const { outcome, task_ref: _taskRef, ...details } = result;
        result = { outcome, task_ref: context.actionId, ...details };
        const receipt = project(result, new Set(['action_id', 'action', 'source_key', 'record_id', 'task_ref', 'phase', 'at', 'outcome', 'dry_run', 'deduplicated', 'error', 'code', 'message']), 2400);
        return { receipt: JSON.stringify(receipt) };
      }
    });
  }
}
