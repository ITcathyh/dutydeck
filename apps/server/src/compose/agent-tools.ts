import { createCollaborationIntegration } from '../collaboration-integration.js';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { localLoopbackUrl } from '../local-api-url.js';
import { TurnAuthority } from '../agent-host/turn-authority.js';
import { loadOrCreateGroupToolsSigningSecret } from '../agent-host/turn-token.js';
import { RelayCapabilityRegistry,loadOrCreateRelaySigningSecret } from '@dutydeck/relay';
import type { ComposeContext } from './context.js';
import type { LarkAgentToolsService } from '../lark/agent-tools.js';

export async function composeCapabilities({ config, repos, lifecycle, options }: ComposeContext) {
  const groupToolsSigningSecret = await loadOrCreateGroupToolsSigningSecret(repos.config);
  const relaySigningSecret = await loadOrCreateRelaySigningSecret(repos.config);
  const capabilities = new TurnAuthority(repos.sessions, localLoopbackUrl(config.host, config.port), groupToolsSigningSecret, options.groupToolsCommand ?? 'dutydeck');
  lifecycle.register('capabilities', () => capabilities.close());
  // 通用回传通道：与飞书无关，任何来源的会话（含 Web 工作台创建的 pty-cli）都注入凭证。
  // command 前缀复用 groupToolsCommand 算出的运行期绝对路径——静态文案拿不到它，
  // 经 env 下发后由 @dutydeck/relay 的 relayHintLines() 在提示块里读回。
  const relayCapabilities = new RelayCapabilityRegistry(
    repos.sessions,
    localLoopbackUrl(config.host, config.port),
    relaySigningSecret,
    options.groupToolsCommand
  );
  return { capabilities, relayCapabilities, relaySigningSecret };
}

type ToolOptions = NonNullable<ConstructorParameters<typeof LarkAgentToolsService>[2]>;
export function composeAgentTools({ repos, config, env, options }: ComposeContext,
  capabilities: TurnAuthority, groupManager: ToolOptions['groupManager'], legacyExecutionPolicy: ToolOptions['executionPolicy'],
  isAutomatedTask: (taskId: string) => boolean,
  { ChannelTools, privatePaths, resolveFinal }: {
    ChannelTools: typeof LarkAgentToolsService;
    privatePaths: typeof import('../lark/artifact-delivery.js').instancePrivatePaths;
    resolveFinal: typeof import('../lark/explicit-final.js').resolveExplicitFinalContext;
  }, ports: Required<Pick<ToolOptions, 'polishReply' | 'previewWork' | 'previewCollaboration' | 'teamSearch'>> & {
    activeTask: DutydeckRuntime['getActiveTaskContext'];
    authorizeTool: ReturnType<typeof createCollaborationIntegration>['background']['authorizeTool'];
  }) {
  return new ChannelTools(capabilities, repos.config, {
    env,
    groupToolsCommand: options.groupToolsCommand,
    artifactPrivatePaths: privatePaths(config.databaseUrl),
    workbenchTask: sessionId => ports.activeTask(sessionId),
    scheduleRequests: true,
    automatedTask: taskId => isAutomatedTask(taskId),
    polishReply: ports.polishReply,
    finalTaskContext: async (binding, task) => resolveFinal(await repos.channelMappings.list(`lark-card:${binding.appId}`), binding, task),
    authorizeTool: (sessionId, action) => ports.authorizeTool(sessionId, action),
    previewTool: (sessionId, action) => ports.authorizeTool(sessionId, action, true),
    previewWork: (sessionId, actorId) => ports.previewWork(sessionId, actorId),
    previewCollaboration: (binding, actorId) => ports.previewCollaboration(binding, actorId),
    executionPolicy: legacyExecutionPolicy,
    groupManager,
    history: repos,
    teamSearch: ports.teamSearch,
  });
}
