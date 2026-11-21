import { createHash } from 'node:crypto';
import { isAgentCommandAutoApproval } from '@dutydeck/shared';
import type { Command } from 'commander';
import { expect, it } from 'vitest';
import { createCliProgram } from '../cli-program.js';
import { dutydeckGroupToolsCommand, larkCommandPrompt } from '../lark/agent-tools.js';

const expectedPrefix = "'/example/bin/node' '/example/releases/current/dist/internal-agent-cli.js'";
const prefix = dutydeckGroupToolsCommand('/example/releases/current/dist/internal-agent-cli.js', '/example/bin/node');
const env = { dutydeck_group_tools_command: prefix, dutydeck_group_tools_url: 'http://localhost/example', dutydeck_group_tools_token: 'sample' };
const approved = (invocation: string) => isAgentCommandAutoApproval({
  permissionMode: 'ask', kind: 'execute', command: prefix + ' ' + invocation, env
});

it('preserves the complete help output and approval decision of each Agent command and legacy alias', () => {
  expect(prefix).toBe(expectedPrefix);
  expect(larkCommandPrompt(prefix, '', 'sample')).toContain(prefix + ' agent --turn sample，');
  const program = createCliProgram('0.0.0');
  const help = createHash('sha256');
  const decisions: Record<string, boolean> = {};
  function visit(command: Command, path: string) {
    let output = '';
    command.configureOutput({ writeOut: text => { output += text; }, getOutHelpWidth: () => 80 });
    command.outputHelp();
    help.update(path + '\0' + output + '\0');
    const invocations = path === 'collaborate'
      ? ['status', 'followup-create', 'followup-update', 'mandate-create', 'mandate-update', 'feedback'].map(name => 'collaborate ' + name + ' --turn sample')
      : [path.startsWith('agent ') ? path.replace('agent ', 'agent --turn sample ') :
        path.startsWith('work ') ? path.replace('work ', 'work --turn sample ') :
        /^(group|memory|history) /.test(path) ? '--agent-turn sample ' + path : path];
    for (const invocation of invocations) decisions[invocation] = approved(invocation);
    for (const sub of command.commands) {
      if (path === 'memory' && sub.name() === 'manage') continue;
      visit(sub, path + ' ' + sub.name());
    }
  }
  for (const command of program.commands) {
    if (['agent', 'group', 'work', 'history', 'memory', 'command', 'collaborate'].includes(command.name())) visit(command, command.name());
    if (command.name() === 'schedule') visit(command.commands.find(sub => sub.name() === 'request')!, 'schedule request');
  }
  expect(help.digest('hex')).toMatchSnapshot('complete help including examples and inherited options');
  expect(decisions).toMatchSnapshot('runtime approval matcher');
});
