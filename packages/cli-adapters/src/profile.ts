import type { ProcessIdentity, ProcessObservation } from '@dutydeck/shared/execution';
import type { InsightClient, DriverTranscriptSourceObservation } from '@dutydeck/shared';
import type { CliAdapter } from './types.js';
import type { CliPathEnv } from './cli-paths.js';
import type { CreateTranscriptTailerOptions, TranscriptEventSource, SessionIdLookupContext, ClaudeNativeSession } from './native-profile.js';

export interface PtyAgentContribution {
  /** 独立的 Agent 入口标识 */
  id: string;
  /** 展示名 */
  name: string;
  /** 可执行文件名 */
  command: string;
  /** 透传进 AgentConfig.args 的默认参数（一般为空：spawn 参数由 adapter.buildArgs 构造） */
  args?: string[];
  /** cli-adapters 里的适配器 id */
  adapterId: string;
  capabilities: { pause: boolean; resume: boolean };
}

type TranscriptReader = new (options: CreateTranscriptTailerOptions) => TranscriptEventSource;
type Lookup = { resolve(context: SessionIdLookupContext): string | undefined };

export interface TerminalLaunchSettings {
  args(userArgs: string[], generated: string[], cwd: string, env: Record<string, string>): string[];
  recordLaunch(args: string[], cwd: string, failureBlock: boolean): void;
  launchGuardWiring(): Readonly<{ planGuard: boolean; secretGuard: boolean; failureBlock: boolean }> | undefined;
  setPlanGuard(active: boolean): void;
  planGuardCommand(): string;
  cleanup(): void;
}

export interface NativeSessionResolver { resolve(forceDiscovery?: boolean): ClaudeNativeSession | undefined }
interface ProcessProbe { identify(pid: number): ProcessIdentity; observe(identity: ProcessIdentity): ProcessObservation }

export interface CliExtensions {
  settings?(sessionId: string): TerminalLaunchSettings;
  spawnEnv?(env: Record<string, string>): Record<string, string>;
  cleanPrompt?(text: string, original: string): string;
  heldInputMessage?(screen: string): string | undefined;
  strictCursor?: boolean;
  permissions?: { secretGuardActive(context: { root: string; sessionId: string }): boolean };
  compact?: {
    ownsMenu(screen: string): boolean;
    ownsComposer(screen: string, expected: string, final: boolean): boolean;
    statusBlocks(adapter: CliAdapter, lines: string[], interrupted: boolean): boolean;
  };
  nativeSession?: {
    createResolver(identity: ProcessIdentity, cwd: string, env: CliPathEnv, probe: ProcessProbe, retryMs?: number): NativeSessionResolver;
    pinned(context: SessionIdLookupContext): boolean;
    resume(source: DriverTranscriptSourceObservation, cwd: string, env: CliPathEnv): string | undefined;
  };
}

export interface CliProfile {
  createAdapter(): CliAdapter;
  extensions?: CliExtensions;
  contributions?: readonly PtyAgentContribution[];
  /** Keep the established discovery order, independently of adapter registration order. */
  discoveryOrder?: number;
  nativeOrder?: number;
  transcript?(options: CreateTranscriptTailerOptions, readers: Record<'claude' | 'codex' | 'traex' | 'grok', TranscriptReader>): TranscriptEventSource;
  sessionId?(context: SessionIdLookupContext, readers: Record<'claude' | 'codex' | 'traex' | 'grok' | 'opencode' | 'opencode2', Lookup>): string | undefined;
  dataRoot?(env: CliPathEnv): string;
  insightClient?: InsightClient;
  automaticResume?: boolean;
  flattenSubmissionScreen?: boolean;
}
