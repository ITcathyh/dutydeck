export const runLabels: Record<string, string> = { pending: '等待执行', accepted: '已接收', completed: '已完成', failed: '执行失败', interrupted: '已中断', skipped: '已跳过', error: '执行出错', invalidated: '已失效', blocked: '执行受阻' };

export function automationTime(value: string | undefined, timezone: string) {
  return value ? `${new Date(value).toLocaleString('zh-CN', { timeZone: timezone, hour12: false })} · ${timezone}` : '未记录';
}
