/**
 * @dutydeck/relay —— 与 IM 无关的会话回传通道（send / ask）。
 *
 * 缺口背景：`lark/agent-tools.ts` 的 `promptForSession()` 有两道门槛
 * （非飞书来源 → 无回传；未开 groupToolsEnabled → 无回传），所以 Web 工作台
 * 创建的 pty-cli 会话此前完全没有回传通道，CLI 只能把话打印到终端靠屏幕解析兜底。
 * 本包补的就是这条通用通道：任何来源的会话都能主动 send、阻塞 ask。
 *
 * 与 lark group send 的关系是**分层并存**，不是替代：
 *  - relay 面向「会话 ↔ 发起该会话的用户」，落点是会话事件流（SSE / Web 时间线），
 *    飞书会话经 coordinator 既有的事件订阅自然带到卡片上。
 *  - `dutydeck group send` 面向「Agent ↔ 飞书群里的其他人/机器人」，
 *    能 @ 人、回复指定消息、进话题，是 IM 特有语义，relay 不覆盖也不应覆盖。
 *  两者 env 键、token、路由前缀均独立，互不影响。
 */
export {
  RelayError,
  type RelayAskRecord,
  type RelayAskStatus,
  type RelayAskStore,
  type RelayCapability,
  type RelayEventPublisher,
  type RelayMessageKind,
  type RelayPublishInput,
  type RelaySecretStore,
  type RelaySessionLookup,
  type RelaySessionSnapshot
} from './types.js';

export {
  RelayCapabilityRegistry,
  loadOrCreateRelaySigningSecret,
  relayBearerToken,
  relayCommandEnvKey,
  relaySigningSecretConfigKey,
  relayTokenEnvKey,
  relayUrlEnvKey
} from './capability.js';

export {
  RelayAskBroker,
  relayAskDefaultTimeoutMs,
  relayAskMaxTimeoutMs,
  relayAskMinTimeoutMs,
  type RelayAskOutcome
} from './ask-broker.js';

export {
  RelayService,
  relayMessageMaxLength,
  type RelayAnswerInput,
  type RelayAskInput,
  type RelaySendInput
} from './service.js';

export { relayAskExitCodes, type RelayAskExitCode } from './cli-contract.js';

export {
  relayCommandFrom,
  relayEnabled,
  relayHintLines,
  type RelayPromptEnv
} from './prompt.js';

export { RelayCliError, RelayHttpClient, type RelayClientOptions } from './client.js';
