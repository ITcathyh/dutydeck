/**
 * CLI 侧退出码契约。被 `dutydeck session ask` 与其文档/skill 文案共用，
 * 保证「文档里写的码」和「实现里 exit 的码」不会漂移。
 *
 * 退出码约定：
 *   0   已回答，答案在 stdout（末尾一个换行）
 *   2   用法/环境错误（缺 token、参数非法、不在会话内）
 *   3   回传通道不可用（连不上服务、会话已结束、提问被取消）
 *   124 超时（stdout 为空）
 *
 * 人类可读信息一律走 stderr，stdout 只放答案本身——调用方可以直接
 * `answer=$(dutydeck session ask "...")` 而不必剥离提示文本。
 */
export const relayAskExitCodes = {
  answered: 0,
  usage: 2,
  unavailable: 3,
  timeout: 124
} as const;

export type RelayAskExitCode = (typeof relayAskExitCodes)[keyof typeof relayAskExitCodes];
