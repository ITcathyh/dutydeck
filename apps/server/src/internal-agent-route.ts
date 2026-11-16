export type InternalAgentRoute = 'agent' | 'session' | 'tool' | 'plugin-tool';

const relayCommands = new Set(['send', 'report', 'ask', 'ask-result', 'ask-wait', 'native-ask', 'permission-hook']);
// Keep in sync with createCliProgram's root --agent-turn, addServerOptions and --version options.
const rootGlobalOptions = new Set([
  '--agent-turn', '--host', '--local-only', '--auth', '--no-auth', '--unsafe-no-auth', '--port', '--cwd', '--database',
  '--bot-app-id', '--driver-idle-cpu-action', '--idle-timeout-ms', '--cleanup-interval-ms', '--lark-app-id',
  '--lark-app-secret', '--lark-receive-id', '--lark-chat-id', '--lark-receive-id-type', '--lark-agent-name',
  '--lark-base-url', '--no-lark-listen', '-V', '--version'
]);

function hasRootGlobalOption(args: string[], allowAgentCwd: boolean): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') break;
    const flag = arg.split('=', 1)[0]!;
    if (!rootGlobalOptions.has(flag)) continue;
    // session new/fork declare their own --cwd. Every other occurrence belongs to the public root command.
    if (allowAgentCwd && flag === '--cwd' && index >= 3) continue;
    return true;
  }
  return false;
}

export function internalAgentRoute(argv: string[]): InternalAgentRoute | undefined {
  const args = argv.slice(2);
  const route = args[0] === 'agent' ? 'agent'
    : args[0] === 'session' && relayCommands.has(args[1] ?? '') ? 'session'
      : args[0] === 'tool' ? 'tool'
        : args[0] === 'plugin-tool' ? 'plugin-tool'
          : undefined;
  if (!route) return undefined;
  const agentCwd = route === 'agent' && args[1] === 'session' && (args[2] === 'new' || args[2] === 'fork');
  return hasRootGlobalOption(args, agentCwd) ? undefined : route;
}
