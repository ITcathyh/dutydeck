/** buildArgs 的会话上下文（从 botmux 20+ 字段瘦身到这些） */
export interface AdapterSessionContext {
  sessionId: string;
  cwd?: string;
  resume?: boolean;
  resumeSessionId?: string;
  initialPrompt?: string;
  model?: string;
  reasoningEffort?: string;
  locale?: string;
}

/** 后端写接口的最小表面（PtyBackend/TmuxBackend 都满足） */
export interface PtyLike {
  write(data: string): void | boolean;
  sendText?(text: string): void | boolean;
  sendSpecialKeys?(...keys: string[]): void | boolean;
  pasteText?(text: string): void;
}

export interface CliAdapterCapabilities {
  /** 支持 --resume 类会话恢复 */
  resume?: boolean;
  /** 支持 skill 投递（M2，占位） */
  skills?: boolean;
  /** 首轮 prompt 走 CLI 参数而非 stdin */
  initialPromptViaArgs?: boolean;
}

export interface CliAdapter {
  readonly id: string;
  readonly capabilities: CliAdapterCapabilities;
  /** 构造 spawn 参数（bin 由 driver 层的 AgentConfig.command 提供，适配器不解析 bin 路径） */
  buildArgs(ctx: AdapterSessionContext): string[];
  /** 把 prompt 写进后端（paste+Enter / 分块 stdin / runner 帧，因 CLI 而异） */
  writeInput(backend: PtyLike, prompt: string): void;
  /** 恢复会话的 spawn 参数（仅 resume 能力的适配器实现） */
  buildResumeCommand?(sessionId: string): string[];
  // ---- idle pattern 族（喂给 IdleDetector）----
  completionPattern?: RegExp;
  busyPattern?: RegExp;
  idleToBusyPattern?: RegExp;
  readyPattern?: RegExp;
  staticBusyPattern?: RegExp;
  staticBusyClearPattern?: RegExp;
  /** 返回要注入到首轮 prompt 前的上下文块（无则 undefined） */
  injectSessionContext?(ctx: AdapterSessionContext): string | undefined;
}
