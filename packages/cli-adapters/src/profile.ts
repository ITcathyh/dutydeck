import type { InsightClient } from '@dutydeck/shared';
import type { CliAdapter } from './types.js';
import type { CliPathEnv } from './cli-paths.js';
import type { CreateTranscriptTailerOptions, TranscriptEventSource, SessionIdLookupContext } from './native-profile.js';

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

export interface CliProfile {
  createAdapter(): CliAdapter;
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
