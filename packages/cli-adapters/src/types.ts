import type { PermissionMode } from '@dockmux/shared';

/** buildArgs 的会话上下文（从 botmux 20+ 字段瘦身到这些） */
export interface AdapterSessionContext {
  sessionId: string;
  cwd?: string;
  resume?: boolean;
  resumeSessionId?: string;
  initialPrompt?: string;
  model?: string;
  reasoningEffort?: string;
  /**
   * 由 AgentConfig/Session 传入的权限姿态。缺省按非 full-trust 处理，
   * 适配器不得因旧调用方漏传而默认追加 bypass 参数。
   */
  permissionMode?: PermissionMode;
  locale?: string;
  /**
   * 会话 env（含 relay 注入的 `dockmux_relay_url` / `_token` / `_command`）。
   * 供 `injectSessionContext` 把回传命令说明拼进上下文块——命令前缀是运行期
   * 算出的绝对路径，静态文案拿不到，只能经 env 下发。见 shared-hints.ts 注释。
   */
  env?: Record<string, string>;
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
  /**
   * 恢复会话的续接参数片段（仅 resume 能力的适配器实现）。
   *
   * 返回 `null` = **「这个 id 我用不了，别 resume，起新会话」**。driver 收到
   * null 会放弃 resume 改走 fresh spawn，并发一条降级事件告诉用户上下文丢了。
   *
   * 什么时候该返回 null：CLI 自己铸 session id（opencode / codex / cursor…），
   * 而传进来的 id 明显不是它铸的——最典型的是反查失败后 driver 退回来的
   * dockmux sessionId（`ses_<uuid>` 形态）。这种 id 递给 CLI 必然无效：
   * `opencode -s <不存在的id>` 立刻 exit 1，会话随即被判 failed。宁可丢上下文
   * 起新会话，也不要拿一个必然无效的 id 去启动。
   *
   * 反过来，dockmux 亲自把 id 钉给 CLI 的适配器（claude `--session-id`、
   * grok `--session-id`、pi、mtr…）永远不该返回 null：那个 id 就是有效的
   * resume 目标。
   *
   * ⚠️ 它只是**续接定位片段**，不是完整 argv——不含模型、权限姿态
   * 等通用参数。driver 走的是 `buildArgs({resume:true})`，本方法负责
   * 两件事：声明 resume 能力，以及裁决「这个 id 能不能用」（见 driver.resume）。
   */
  buildResumeCommand?(sessionId: string): string[] | null;
  // ---- idle pattern 族（喂给 IdleDetector）----
  completionPattern?: RegExp;
  busyPattern?: RegExp;
  /** Current rendered footer evidence that vetoes screen-derived completion. */
  screenBusyPattern?: RegExp;
  idleToBusyPattern?: RegExp;
  readyPattern?: RegExp;
  staticBusyPattern?: RegExp;
  staticBusyClearPattern?: RegExp;
  /** 返回要注入到首轮 prompt 前的上下文块（无则 undefined） */
  injectSessionContext?(ctx: AdapterSessionContext): string | undefined;
}
