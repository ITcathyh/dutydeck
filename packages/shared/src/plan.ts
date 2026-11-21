/** 会话里最近一份计划的状态。operable=false 表示要回飞书计划卡处理。 */
export type PlanState = { state: 'none' | 'planning' | 'pending' | 'approved' | 'needs_changes' | 'cancelled' | 'expired'; taskId?: string; expiresAt?: string; operable?: boolean };
