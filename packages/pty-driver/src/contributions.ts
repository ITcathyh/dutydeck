/**
 * pty-cli 驱动的内置 Agent 贡献清单。
 *
 * adapterId 对应 @dutydeck/cli-adapters 的适配器；id 是独立的入口标识；
 * command 按各 CLI 常见可执行文件名核对；
 * capabilities.resume 按各适配器 buildArgs 的实际 resume 支持核对
 * （gemini 适配器明确 always start fresh，无 resume）。
 * pause 全 false：这些供应商 CLI 没有可由 Dutydeck 可靠兑现的暂停语义。
 *
 * 与 @dutydeck/config 的 PtyAgentContribution 对齐：config 包定义的形状是
 * `{ id, name, command, args?, builtin?, adapterId?, capabilities? }`。
 * id 与 adapterId 不同时，config 保留 adapterId 供 server 选择适配器。
 * config 会逐项传播这里声明的能力，避免把 fresh-only CLI 错报为可恢复。
 */
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

export const PTY_AGENT_CONTRIBUTIONS: PtyAgentContribution[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', adapterId: 'claude-code', capabilities: { pause: false, resume: true } },
  { id: 'claude-code', name: 'Claude', command: 'claude', adapterId: 'claude-code', capabilities: { pause: false, resume: true } },
  { id: 'codex', name: 'Codex', command: 'codex', adapterId: 'codex', capabilities: { pause: false, resume: true } },
  { id: 'codex-cli', name: 'Codex (terminal)', command: 'codex', adapterId: 'codex', capabilities: { pause: false, resume: true } },
  { id: 'gemini', name: 'Gemini', command: 'gemini', adapterId: 'gemini', capabilities: { pause: false, resume: false } },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', adapterId: 'opencode', capabilities: { pause: false, resume: true } },
  { id: 'grok-build', name: 'Grok Build', command: 'grok', adapterId: 'grok', capabilities: { pause: false, resume: true } },
  { id: 'grok', name: 'Grok Build', command: 'grok', adapterId: 'grok', capabilities: { pause: false, resume: true } },
  { id: 'cursor', name: 'Cursor', command: 'cursor-agent', adapterId: 'cursor', capabilities: { pause: false, resume: true } },
  { id: 'kimi', name: 'Kimi', command: 'kimi', adapterId: 'kimi', capabilities: { pause: false, resume: true } },
  { id: 'traex', name: 'TRAE', command: 'traex', adapterId: 'traex', capabilities: { pause: false, resume: true } },
  // ---- 扩展 CLI（command / name 逐条核对供应商可执行文件与
  //      CLI_DISPLAY_NAMES；resume 按各适配器 buildArgs 是否真接 resume 参数）----
  { id: 'antigravity', name: 'Antigravity', command: 'agy', adapterId: 'antigravity', capabilities: { pause: false, resume: true } },
  { id: 'coco', name: 'CoCo', command: 'coco', adapterId: 'coco', capabilities: { pause: false, resume: true } },
  { id: 'opencode2', name: 'OpenCode 2', command: 'opencode2', adapterId: 'opencode2', capabilities: { pause: false, resume: true } },
  // MTR is intentionally not auto-discovered: its executable name collides
  // with the ubiquitous network diagnostic `/usr/bin/mtr`. Until discovery
  // has a reliable vendor fingerprint, users of the AI CLI can opt in with
  // DUTYDECK_AGENTS_JSON instead of exposing a guaranteed-broken false Agent.
  { id: 'hermes', name: 'Hermes', command: 'hermes', adapterId: 'hermes', capabilities: { pause: false, resume: true } },
  { id: 'pi', name: 'Pi', command: 'pi', adapterId: 'pi', capabilities: { pause: false, resume: true } },
  { id: 'oh-my-pi', name: 'Oh My Pi', command: 'omp', adapterId: 'oh-my-pi', capabilities: { pause: false, resume: true } },
  { id: 'copilot', name: 'Copilot', command: 'copilot', adapterId: 'copilot', capabilities: { pause: false, resume: true } },
  { id: 'kiro-cli', name: 'Kiro', command: 'kiro-cli', adapterId: 'kiro-cli', capabilities: { pause: false, resume: true } },
  { id: 'reasonix', name: 'Reasonix', command: 'reasonix', adapterId: 'reasonix', capabilities: { pause: false, resume: true } },
  { id: 'dsh-tui', name: 'DeepSeek Harness TUI', command: 'dsh-tui', adapterId: 'dsh-tui', capabilities: { pause: false, resume: false } },
  { id: 'seed', name: 'Seed', command: 'seed', adapterId: 'seed', capabilities: { pause: false, resume: true } },
  { id: 'relay', name: 'Relay', command: 'relay', adapterId: 'relay', capabilities: { pause: false, resume: true } },
  { id: 'aiden', name: 'Aiden', command: 'aiden', adapterId: 'aiden', capabilities: { pause: false, resume: true } },
  { id: 'genius', name: 'Genius', command: 'genius', adapterId: 'genius', capabilities: { pause: false, resume: true } },
  // ⚠️ 未登记：mir / dsh / codex-app / mojo / riff / mira —— 适配器都已移植可用
  // （createCliAdapter 取得到），但**都不能由 dutydeck 直接 spawn**，登记进来只会
  // 让它们出现在 UI 列表里、用户一点就失败：
  //
  //  - mir / dsh / codex-app 是 runner 类：适配器 buildArgs 产出的是 *runner* 的
  //    参数，外部 runner 脚本尚未接入。其内部登记的
  //    `mircli` / `dsh-jsonrpc-agent` / `codex` 是 runner 自己再去 spawn 的**二段
  //    依赖**，不是 argv 的接收方。尤其 codex-app 的 `codex` 在多数开发机上真实
  //    存在，commandExists 会放行它，于是 runner 参数被喂给真实 codex 而失败。
  //  - mojo 的 worker 从不直接 spawn 它（需要外部后端按回合调度），
  //    当前没有对应后端作为执行主体。
  //  - riff / mira 是 API-backed，底层由外部后端/HTTP 处理，不通过本地 command 启动，
  //    本接口 command 必填，无从填写。
  //
  // 接入 runner / 对应后端后，把 command 改指向 runner 入口（形如
  // `node dist/<id>-runner.js`）再登记。
];


/** 编译期对齐守卫：本包的贡献数据必须能赋给 @dutydeck/config 的
 *  PtyAgentContribution 形状（config 不被本包依赖，用结构子集断言代替
 *  跨包 import）。形状漂移时这行会编译失败。 */
type ConfigContributionShape = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  builtin?: boolean;
  adapterId?: string;
};
const _alignmentCheck: ConfigContributionShape[] = PTY_AGENT_CONTRIBUTIONS;
void _alignmentCheck;
