#!/usr/bin/env node
import { Command } from 'commander';
import { prepareCliEnvironment } from './cli-environment.js';
import { internalAgentRoute } from './internal-agent-route.js';
import { addSessionRelayCommands, createSessionRelayCliHandlers } from './session-relay-cli.js';

const route = internalAgentRoute(process.argv);

// Unsupported argv must reach the public CLI before .env or legacy migration can emit output twice.
if (!route) {
  await import('./cli.js');
} else {
  prepareCliEnvironment();
  const program = new Command().name('dutydeck').description('Run the Dutydeck local session server').showHelpAfterError();
  try {
    if (route === 'agent') {
      const { addAgentCommands, runAgentCli } = await import('./agent-cli.js');
      addAgentCommands(program, (operation, args, options) => runAgentCli(operation, args, options));
    } else if (route === 'session') {
      const session = program.command('session').enablePositionalOptions().description('Relay messages to the user who owns the current Dutydeck session');
      addSessionRelayCommands(session, createSessionRelayCliHandlers());
    } else if (route === 'tool') {
      const { registerBusinessToolCli } = await import('./plugins/tool-cli.js');
      registerBusinessToolCli(program);
    } else {
      const { registerPluginResultCli } = await import('./plugins/result-cli.js');
      registerPluginResultCli(program);
    }
    await program.parseAsync();
  } catch (error) {
    if (route === 'agent') {
      const { AgentCliError, agentCliErrorBody } = await import('./agent-cli.js');
      const { AgentGroupToolCliError } = await import('./lark/agent-tools-cli.js');
      if (error instanceof AgentCliError) process.stdout.write(`${JSON.stringify({ ok: false, error: agentCliErrorBody(error) })}\n`);
      else if (error instanceof AgentGroupToolCliError) process.stderr.write(`${JSON.stringify({ ok: false, error: error.error })}\n`);
      else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (route === 'session') {
      const { RelayCliError } = await import('@dutydeck/relay');
      process.exit(error instanceof RelayCliError ? error.exitCode : 1);
    }
    process.exit(1);
  }
}
