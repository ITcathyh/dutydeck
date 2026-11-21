type Scope = 'instance' | 'bot' | 'session' | 'global';
type Deletion = 'never' | 'pending-prompt' | 'recovered-finding' | 'ignored-inbox';
export interface ConfigKey {
  prefix: string;
  owner: string;
  scope: Scope;
  /** Conditions for removal through ConfigRepository.remove. */
  deletion: Deletion;
  retention: string;
  /** The first component after the prefix is its owner ID. Other keys require domain evidence. */
  ownerInKey?: boolean;
  /** Split shards share the original instance's login and signing credentials. */
  shareOnSplit?: boolean;
}

function keys(owner: string, scope: Scope, prefixes: string[], options: Partial<Pick<ConfigKey, 'deletion' | 'retention' | 'ownerInKey' | 'shareOnSplit'>> = {}): ConfigKey[] {
  return prefixes.map(prefix => ({ prefix, owner, scope, deletion: 'never', retention: 'none', ...options }));
}

const entries = [
  ...keys('auth', 'instance', ['auth.accessToken', 'auth.passwordHash', 'auth.shareLinkSecret'], { shareOnSplit: true }),
  ...keys('relay', 'instance', ['relay.signing_secret'], { shareOnSplit: true }),
  ...keys('lark/group-tools', 'instance', ['lark.group_tools.signing_secret'], { shareOnSplit: true }),
  ...keys('insight', 'instance', ['insight.instance_id']),
  ...keys('bot-process', 'instance', ['dutydeck.bot_process', 'dutydeck.bot_process_migration', 'dutydeck.bot_session_routes']),
  ...keys('lark/listener', 'instance', ['lark.listener.status']),
  ...keys('terminal-settings', 'instance', ['dutydeck.terminal_backend']),
  ...keys('agent-model-settings', 'instance', ['dutydeck.agent_model.']),
  ...keys('agent-model-settings', 'bot', ['dutydeck.bot_agent_model.'], { ownerInKey: true }),
  ...keys('workspace', 'instance', ['workspace_organization:v1', 'project_memory:v1']),
  ...keys('lark/config', 'bot', ['lark.bots', 'lark.credentials']),
  ...keys('agent-runtime', 'session', ['runtime_workspace:', 'runtime_execution_workspace:', 'runtime_driver_configuration:',
    'runtime_driver_stop_block:', 'runtime_native_context:', 'runtime_pty_retirement:', 'runtime_verification:', 'legacy_retirement:'], { ownerInKey: true }),
  ...keys('agent-runtime', 'session', ['runtime_idle_terminal:', 'runtime_notice:']),
  ...keys('session-name', 'session', ['session_name:'], { ownerInKey: true }),
  ...keys('turn-diff', 'session', ['turn_diff.'], { ownerInKey: true }),
  ...keys('plan-routes', 'session', ['plan.web.'], { ownerInKey: true }),
  ...keys('tasks', 'session', ['task_authorization/', 'task_report/', 'client_audit/']),
  ...keys('leader-mode', 'session', ['leader_delegation:', 'leader_mode:']),
  ...keys('collaboration', 'bot', ['collaboration.policy.']),
  ...keys('collaboration', 'bot', ['collaboration.mandate-card.'], { ownerInKey: true }),
  ...keys('token-efficiency', 'global', ['token_efficiency']),
  ...keys('plugins', 'instance', ['plugin.tools.grant.', 'plugin.tools.action.']),
  ...keys('lark/prompt-versions', 'bot', ['bot_prompt_version/'], { ownerInKey: true }),
  ...keys('lark/prompt-versions', 'bot', ['bot_prompt_version/pending/'], { ownerInKey: true, deletion: 'pending-prompt' }),
  ...keys('lark/prompt-versions', 'session', ['bot_prompt_version/usage/']),
  ...keys('lark/task-inbox', 'bot', ['lark.inbox.'], { ownerInKey: true, deletion: 'ignored-inbox', retention: 'ignored: 30 days; ignored bot body: 1 hour' }),
  ...keys('lark/memory', 'bot', ['lark.memory.', 'lark.memory.state.', 'lark.memory.ignore.'], { ownerInKey: true }),
  ...keys('lark/memory', 'session', ['lark.memory.turns.'], { ownerInKey: true }),
  ...keys('lark', 'bot', ['lark.context.', 'lark.interaction.', 'lark.reaction.', 'lark.live-owner.', 'lark.welcomed.',
    'lark.verification_suggestion.', 'lark.verification_auto.', 'lark.pin.', 'lark.group-context.', 'lark.redispatch.', 'lark.relaunch.',
    'lark.relaunch_retained.', 'lark.settled.', 'lark.continue.', 'lark.result_follow_up.', 'lark.result_schedule.',
    'lark.reaction-trigger.', 'lark.pr_proposal.', 'lark.task_dashboard.', 'lark.taskagent.'], { ownerInKey: true }),
  ...keys('lark', 'bot', ['lark.delivery.', 'lark.delivery_claim.', 'lark.reaction_claim.', 'lark.principal.', 'lark.app_creation.',
    'lark.app_creation_owner.', 'lark.explicit_final.', 'lark.send.', 'lark.reply_polish.', 'lark.unknown_task.', 'lark.recovery.']),
  ...keys('lark', 'session', ['lark.run-context.', 'lark.artifact_delivery.'], { ownerInKey: true }),
  ...keys('session-automation', 'session', ['session_automation/schedule/', 'session_automation/occurrence/', 'session_automation/ci/',
    'session_automation/task/', 'session_automation/stop_request/', 'session_automation/overdue/', 'session_automation/streak/',
    'session_automation/precondition/', 'session_automation/precondition_status/', 'session_automation/fresh_retry/']),
  ...keys('automation-integration', 'bot', ['automation.delivery-target.']),
  ...keys('ci-webhook', 'session', ['ci_webhook/subscription/', 'ci_webhook/codebase/']),
  ...keys('relay', 'session', ['relay.ask.']),
  ...keys('work-items', 'session', ['work_item:', 'work_template:']),
  ...keys('pull-requests', 'session', ['pull_request/record/', 'pull_request/task/', 'pull_request/claim/', 'pull_request/verify/']),
  ...keys('watch', 'bot', ['watch_findings/'], { ownerInKey: true, deletion: 'recovered-finding', retention: 'recovered: 7 days' }),
  ...keys('artifact-snapshots', 'session', ['artifact.snapshot.']),
  ...keys('lark/workbench', 'session', ['workbench.origin.', 'workbench.target.', 'workbench.notice.'])
].sort((a, b) => b.prefix.length - a.prefix.length);

/** Singleton names match exactly. Match the most specific namespace before its parent. */
export function configKeyDefinition(key: string): ConfigKey | undefined {
  return entries.find(entry => key === entry.prefix || /[.:/]$/.test(entry.prefix) && key.startsWith(entry.prefix));
}
