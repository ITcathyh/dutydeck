import type { AgentCapabilities, AgentConfig, AgentDriver, DiagnosticLog, DriverContext, NativeContextExpected, NativeContextIdentity, NormalizedDriverEvent, Session, ToolRiskPolicy } from './index.js';

export interface PtyRetirementControl {
  capture(session: Session): unknown | Promise<unknown>;
  stop(session: Session, snapshot: unknown, beforeKill: (snapshot: unknown) => Promise<void>): Promise<unknown>;
  verify(session: Session, snapshot: unknown): boolean | Promise<boolean>;
  /**
   * 原终端已不存在时给出可复核的不存在证明（verify 能复查），终端还在时返回 undefined。只凭它不算退出证明：
   * 运行时还要求终端记录的所有者运行时已退出（见 retireDetachedPty）。
   */
  captureAbsence?(session: Session): Promise<unknown | undefined>;
}

export interface DriverCapabilities {
  persistentTerminal?: boolean;
  nativeFork?: boolean;
  remoteApproval?: boolean;
  permissionPosture: boolean;
  operations: readonly (keyof AgentDriver)[];
}

export interface DriverCreateInput {
  agent: AgentConfig;
  session: Session;
  context: DriverContext;
  onEvent(event: NormalizedDriverEvent): void;
  onExit(code: number | null): void;
  log?: DiagnosticLog;
  awaitingAnswer?: () => boolean;
  resolveRiskPolicy?: (fallback?: ToolRiskPolicy) => Promise<ToolRiskPolicy | undefined>;
}

export interface DriverProvider {
  protocol: AgentCapabilities['protocol'];
  resourceProtocol: 'controlled' | 'local';
  /** Existing sessions with no stored protocol used this driver with the indicated ledger. */
  unversionedSessionResources?: 'local';
  capabilities(agent?: AgentConfig): DriverCapabilities;
  create(input: DriverCreateInput): AgentDriver;
  retirement?: PtyRetirementControl;
  probe?(agent: AgentConfig, acpxCommand?: string): AgentCapabilities;
  restoreAgent?(agent: AgentConfig): AgentConfig;
  readNativeCreationRecord?(expected: NativeContextExpected): Promise<NativeContextIdentity | undefined>;
}
