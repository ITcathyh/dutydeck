import { describeDroppedAgent, type DroppedAgent } from '@dutydeck/config';

/**
 * DUTYDECK_AGENTS_JSON 里命令找不到的 Agent 不会被登记。不在启动日志里说，
 * 用户只会在选 Agent 时发现它不见了；文案与 `dutydeck doctor` 同源。
 */
export function logDroppedAgents(log: { warn(details: object, message: string): void }, dropped: ReadonlyArray<DroppedAgent>): void {
  for (const agent of dropped) {
    const described = describeDroppedAgent(agent);
    log.warn({ agentId: agent.id, command: agent.command }, `${described.detail}。${described.remedy}`);
  }
}
