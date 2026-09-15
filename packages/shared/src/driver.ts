import type { DriverContext, DriverSubmission, DriverSubmissionInput, DriverResourceCapabilities, OperationPermit } from './driver-resources.js';
import type { EventType, PermissionMode, ToolRiskPolicy } from './index.js';

/**
 * Dutydeck 驱动契约（canonical driver contract）
 * ================================================
 * 运行时（@dutydeck/runtime）与具体 Agent 接入方式之间的唯一接缝。
 * 每个实现负责把一种 Agent 接入形态（ACP 子进程 / PTY 里的 CLI / 远程 API…）
 * 归一化成同一种事件流（NormalizedDriverEvent）。
 *
 * 已实现：
 *  - AcpxAdapter（@dutydeck/acp-client）—— ACP 协议，经 acpx 运行时
 *  - PtyCliDriver（@dutydeck/pty-driver）—— PTY 里的供应商 CLI 适配层
 *
 * 实现方注意：
 *  - 事件必须按发生顺序回调；运行时按 session 串行化消费，不要求实现方自己排队。
 *  - 一轮任务结束时必须且只能发一次 `completed` 事件（stopReason 见下）。
 *  - 任何无法解析的输出一律发 `raw_terminal`，绝不丢数据。
 *  - driver 崩溃/未处理的实例级子进程退出时调 onExit；运行时据此把会话置 failed 并取消后续队列。
 *    注意：轮次内执行失败通过所属 send 报告，驱动内部回收或迟到的非当前进程退出不调用 onExit。
 */

/** 归一化驱动事件：9+1 类，data 形态见各类型注释 */
export interface NormalizedDriverEvent {
  type: EventType;
  data: any;
  raw?: string;
  /** Stable transcript record identity, preserved when replaying after restart. */
  sourceId?: string;
}

export interface TranscriptCursor { path?: string; offset: number }
export interface DriverTurnRecovery { kind: 'pty-jsonl-v1'; turnId: string; transcript: TranscriptCursor }

/** A detached persistent turn remains running in its backend. */
export class DriverDetachedError extends Error {
  constructor() { super('Driver detached for Dutydeck daemon shutdown'); this.name = 'DriverDetachedError'; }
}

/** The original turn cannot be safely identified or attached; do not replay its prompt. */
export class DriverRecoveryError extends Error {
  constructor(message: string) { super(message); this.name = 'DriverRecoveryError'; }
}

/**
 * 各事件类型的 data 形态（与 acp-client 的 normalizeAcpxEvent 输出对齐）：
 *
 *  text               { text: string }                        Assistant 文本（流式分片，消费方拼接）
 *  thinking           { text: string }                        思考过程/CoT（流式分片）
 *  tool_call          { id, name, input?, status: 'pending'|'running', startedAt? }
 *  tool_result        { id, name?, output?, status: 'completed'|'failed', completedAt? }
 *  permission_request { id, toolCallId?, title, options?: {id,label,kind?}[], status: 'pending' }
 *  status             { state: string, ... }                  非消息态（compaction/usage/commands），时间线与卡片不渲染为消息
 *  error              { message: string, detail? }
 *  completed          { stopReason?: string }                 一轮结束；'max_tokens'|'truncated' 视为 failed
 *  task               TaskRecord                               任务记录更新（运行时内部使用，driver 不发）
 *  raw_terminal       { text: string }                        未解析的终端输出，兜底通道，永不丢数据
 *
 * tool_call 与 tool_result 靠 id 关联（runtime 的 correlateToolCalls 按 id 合并）。
 */

/** Agent 驱动：一个实现 = 一种 Agent 接入形态 */
export interface AgentDriver {
  /** 启动/确保会话就绪（ACP ensureSession / PTY spawn CLI）。失败必须抛错。 */
  start(): Promise<void>;
  /**
   * 发送一轮 prompt 并等待该轮次结束。
   * 实现必须在确认该轮提交成功且收到明确归一化的 completed 事件后才完成 Promise，
   * 且必须先向运行时投递本轮全部事件再完成 Promise。轮次失败（提交失败/超时/异常退出）必须 reject。
   */
  send(prompt: string | DriverSubmission): Promise<void>;
  /** Finish all asynchronous turn preparation before the durable submission intent. */
  prepareTurn?(input: DriverSubmissionInput, operation: OperationPermit): Promise<void>;
  prepareSubmission?(input: DriverSubmissionInput): Omit<DriverSubmission, 'operation' | 'onAccepted'>;
  resourceCapabilities?: DriverResourceCapabilities;
  /** 中断当前轮次（保留会话，可再 send）。 */
  interrupt(): Promise<void>;
  /** 重连/恢复持久会话；受控驱动的新增资源使用本次显式许可。 */
  resume(operation?: OperationPermit): Promise<void>;
  /** Capture the output boundary before submitting a new turn, if recoverable. */
  checkpoint?(): DriverTurnRecovery | undefined;
  /** Attach to the original live backend and await this turn without resending its prompt. */
  recover?(state: DriverTurnRecovery): Promise<void>;
  /** 停止驱动并清理子进程。discardSession=true 时同时清除持久化会话状态。 */
  stop(options?: { discardSession?: boolean }): Promise<void>;
  /** Authoritative post-stop resource probe. True means this driver's owned
   * execution resource is gone; a resolved stop(), detach, or rejected adoption
   * alone is not proof. Unsupported drivers must omit this or return false. */
  isStopped?(): Promise<boolean>;
  /** 裁决一个挂起的权限请求。返回是否成功兑现。 */
  resolvePermission?(id: string, approved: boolean): Promise<boolean>;
  /** 切换模型（不支持的实现可不实现）。 */
  setModel?(model: string): Promise<void>;
  configureNative?(request: import('./driver-resources.js').NativeConfigurationRequest): Promise<import('./driver-resources.js').NativeConfigurationProof>;
  nativeConfiguration?(): { model?: string; reasoningEffort?: string };
  /** 切换推理强度。 */
  setReasoningEffort?(reasoningEffort: string): Promise<void>;
  /** 设置高危工具风险策略（full-trust 之外的门禁由实现强制执行）。 */
  setRiskPolicy?(policy?: ToolRiskPolicy): void;
  /** 切换权限模式。 */
  setPermissionMode?(mode: PermissionMode): void;
  /**
   * 可选：暴露原始终端流（PTY 形态的 driver 实现，ACP driver 不实现）。
   * 供 Web xterm 终端视图与 /api/terminal WS 代理使用。
   * 每次调用返回一个新的订阅；dispose 后不得再回调。
   */
  createTerminalStream?(): TerminalStream;
  /** Attach only to an existing owned terminal; never launch or submit a task. */
  attachTerminal?(): boolean;
}

export interface TerminalScreen {
  data: string;
  cols: number;
  rows: number;
}

/** 原始终端流：屏幕输出 + 输入注入 + 尺寸调整 */
export interface TerminalStream {
  /** 可选恢复当前屏幕，然后按顺序订阅后续 PTY 输出。 */
  onData(callback: (data: string) => void, onSnapshot?: (screen: TerminalScreen) => void): void;
  /** 向终端注入输入（键盘字节） */
  write(data: string): void;
  /** 调整终端尺寸 */
  resize(cols: number, rows: number): void;
  /** 结束订阅（不杀 PTY 进程） */
  dispose(): void;
}

/**
 * 驱动工厂签名（运行时按 agent.protocol 路由到具体工厂）。
 * protocol: 'acp' | 'jsonl' | 'pipe' | 'pty' | 'pty-cli'（pty-cli 使用 Dutydeck PTY 适配层）
 */
export type DriverFactory = ((
  agent: import('./index.js').AgentConfig,
  protocol: string,
  onEvent: (event: NormalizedDriverEvent) => void,
  onExit: (code: number | null) => void,
  sessionId: string,
  context: DriverContext
) => AgentDriver) & { controlledResources?: (protocol: string) => boolean };

/** 驱动能力描述（用于 /api/agents 展示与会话创建时的协议选择） */
export interface DriverDescriptor {
  /** 协议标识 */
  protocol: string;
  /** 该驱动能接入的 agent id 列表（内置发现或配置注入） */
  agentIds(): string[];
  /** 探测某 agent 在本机是否可用（CLI 是否安装等） */
  available(agentId: string): boolean;
  /** 创建驱动实例 */
  create: DriverFactory;
}
