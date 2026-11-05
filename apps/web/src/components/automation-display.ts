/** 计划跟进状态；旧实例没有时不显示。 */
export const runStateLabels: Record<string, string> = { waiting: '正常，等待下次运行', running: '本轮执行中', awaiting_human: '等待人工（审批、提问或核对）', failed: '最近一轮失败', completed: '已完成（Agent 确认达成）', deadline_reached: '已到截止，未确认完成', disabled: '已停用' };
export const runLabels: Record<string, string> = { pending: '等待执行', accepted: '已接收', completed: '已完成', failed: '执行失败', interrupted: '已中断', skipped: '已跳过', error: '执行出错', invalidated: '已失效', blocked: '执行受阻' };

export function automationTime(value: string | undefined, timezone: string) {
  return value ? `${new Date(value).toLocaleString('zh-CN', { timeZone: timezone, hour12: false })} · ${timezone}` : '未记录';
}
