/**
 * pty-cli 驱动的内置 Agent 贡献清单。
 *
 * id/adapterId 与 @dockmux/cli-adapters 的适配器 id 一致；
 * command 按 botmux src/adapters/cli/registry.ts 的 RAW_CLI_EXECUTABLES 核对；
 * capabilities.resume 按 botmux 各适配器 buildArgs 的实际 resume 支持核对
 * （gemini 适配器明确 always start fresh，无 resume）。
 * pause 全 false：MVP 不支持暂停。
 *
 * 与 @dockmux/config 的 PtyAgentContribution 对齐：config 包定义的形状是
 * `{ id, name, command, args?, builtin? }`，本接口是它的超集——多出的
 * adapterId / capabilities 是 server 组装 driver 时的元数据（id 与 adapterId
 * 在 MVP 恒等，server 可直接用 agent.id 经 createCliAdapter 取适配器）。
 * 注意：config 的 scanPtyAgents 目前硬编码 capabilities { pause:false, resume:true }，
 * gemini 的 resume:false 尚未经 config 传播（M2 收口）。
 */
export interface PtyAgentContribution {
  /** 与 adapter id 一致 */
  id: string;
  /** 展示名（对齐 botmux CLI_DISPLAY_NAMES） */
  name: string;
  /** 可执行文件名 */
  command: string;
  /** 透传进 AgentConfig.args 的默认参数（一般为空：spawn 参数由 adapter.buildArgs 构造） */
  args?: string[];
  /** cli-adapters 里的适配器 id（MVP 与 id 恒等） */
  adapterId: string;
  capabilities: { pause: boolean; resume: boolean };
}

export const PTY_AGENT_CONTRIBUTIONS: PtyAgentContribution[] = [
  { id: 'claude-code', name: 'Claude', command: 'claude', adapterId: 'claude-code', capabilities: { pause: false, resume: true } },
  { id: 'codex', name: 'Codex', command: 'codex', adapterId: 'codex', capabilities: { pause: false, resume: true } },
  { id: 'gemini', name: 'Gemini', command: 'gemini', adapterId: 'gemini', capabilities: { pause: false, resume: false } },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', adapterId: 'opencode', capabilities: { pause: false, resume: true } },
  { id: 'grok', name: 'Grok Build', command: 'grok', adapterId: 'grok', capabilities: { pause: false, resume: true } },
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent', adapterId: 'cursor', capabilities: { pause: false, resume: true } },
  { id: 'kimi', name: 'Kimi', command: 'kimi', adapterId: 'kimi', capabilities: { pause: false, resume: true } },
  { id: 'traex', name: 'TRAE', command: 'traex', adapterId: 'traex', capabilities: { pause: false, resume: true } },
];

/** 编译期对齐守卫：本包的贡献数据必须能赋给 @dockmux/config 的
 *  PtyAgentContribution 形状（config 不被本包依赖，用结构子集断言代替
 *  跨包 import）。形状漂移时这行会编译失败。 */
type ConfigContributionShape = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  builtin?: boolean;
};
const _alignmentCheck: ConfigContributionShape[] = PTY_AGENT_CONTRIBUTIONS;
void _alignmentCheck;
