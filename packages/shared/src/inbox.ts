/**
 * 「待处理」：所有等人决定的持久对象的只读汇总。不新建存储，每一项都是某个现有对象的投影，
 * 动作指向该对象现有的 HTTP 接口；对象一旦变化，原接口会按自己的版本校验拒绝旧决定。
 */
export type InboxItemKind =
  | 'permission' | 'question' | 'reconcile' | 'task_report'
  | 'plan'
  | 'work_item_confirm' | 'work_item_revision' | 'work_item_answer' | 'work_item_request'
  | 'pull_request_confirm' | 'pull_request_question'
  | 'result_acceptance';

export const inboxKindLabels: Record<InboxItemKind, string> = {
  permission: '权限审批',
  question: 'Agent 提问',
  reconcile: '结果未知待核对',
  task_report: '等你决定',
  plan: '计划待批准',
  work_item_confirm: '工作项待确认',
  work_item_revision: '工作项计划修订待确认',
  work_item_answer: '工作项待回答',
  work_item_request: '工作项步骤请求',
  pull_request_confirm: 'PR 待确认',
  pull_request_question: 'PR 评审意见待决定',
  result_acceptance: '结果待验收'
};

/**
 * api：前端原样调用 method + path（body 已带对象版本）；
 * open：跳到所属会话；
 * lark_card：这个对象只能在飞书卡片上决定，Web 只展示。
 */
export interface InboxAction {
  id: 'approve' | 'reject' | 'confirm' | 'cancel' | 'discard' | 'open' | 'lark_card';
  label: string;
  type: 'api' | 'open' | 'lark_card';
  tone?: 'primary' | 'danger' | 'default';
  method?: 'POST';
  path?: string;
  body?: Record<string, unknown>;
}

export interface InboxItem {
  /** 稳定键：kind + 会话 + 原对象编号。 */
  id: string;
  kind: InboxItemKind;
  sessionId: string;
  taskId?: string;
  /** 会话显示名；没有名字时取工作区目录名。 */
  sessionTitle: string;
  workspace: string;
  title: string;
  detail?: string;
  createdAt: string;
  /** 生成时刻减 createdAt，毫秒。权限请求没有自己的创建时间，取会话进入等待审批的时刻（估计值）。 */
  waitingMs: number;
  /** 原对象的版本或指纹：工作项 revision、PR 记录 revision、计划的任务编号；对象没有则缺省。 */
  revision?: string | number;
  expiresAt?: string;
  actions: InboxAction[];
}

export interface InboxResponse {
  generatedAt: string;
  items: InboxItem[];
}
