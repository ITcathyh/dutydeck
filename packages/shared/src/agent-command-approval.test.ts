import { describe, expect, it } from 'vitest';
import { isAgentCommandAutoApproval } from './agent-command-approval.js';

const env = { dutydeck_group_tools_url: 'http://localhost/api/lark/agent-tools',
  dutydeck_group_tools_token: 'fixture-token', dutydeck_group_tools_command: 'dutydeck' };
const input = { permissionMode: 'ask' as const, kind: 'execute', env };

describe('session-scoped agent command auto-approval', () => {
  it.each([
    'dutydeck agent status',
    "dutydeck agent session new --agent codex --task '换 codex 重做：修复登录接口'",
    'dutydeck agent session new --agent codex --dry-run',
    'dutydeck agent session new --task "修复中文接口"',
    '  dutydeck agent status \t',
    'dutydeck\tagent\tstatus',
    "dutydeck agent status --task 'literal ; & | < > ( ) $ ` \\ * ? [ { ~ # text'",
    'dutydeck agent status --task "literal ; & | < > ( ) * ? [ { ~ # text"',
  ])('approves %s', command => expect(isAgentCommandAutoApproval({ ...input, command })).toBe(true));

  it.each(['/x/dutydeck', 'node /x/cli.js', "'/usr/bin/node' '/x/cli.js'"])(
    'matches the injected prefix %s exactly', prefix => {
      const scoped = { ...input, env: { ...env, dutydeck_group_tools_command: prefix } };
      expect(isAgentCommandAutoApproval({ ...scoped, command: `${prefix} agent status` })).toBe(true);
      expect(isAgentCommandAutoApproval({ ...scoped, command: 'dutydeck agent status' })).toBe(false);
    });

  it.each([
    'dutydeck agent status; rm -rf ~', 'dutydeck agent status && x',
    'dutydeck agent status | sh', 'dutydeck agent status $(whoami)',
    'dutydeck agent status `whoami`', 'dutydeck agent status > f',
    'dutydeck agent status\necho x', 'dutydeck agent status\r', '\ndutydeck agent status',
    'dutydeck agent status <<EOF\nx\nEOF', 'dutydeck agent status <<EOF',
    'FOO=1 dutydeck agent status', '/tmp/dutydeck agent status', './dutydeck agent status',
    'dutydeck-agent status', 'dutydeck settings set a=b', 'dutydeck agent', 'dutydeck agent ',
    'dutydeck agentx status', 'dutydeckagent status',
    'dutydeck agent status & x', 'dutydeck agent status < f', 'dutydeck agent status (x)',
    'dutydeck agent status $HOME', 'dutydeck agent status \\x', 'dutydeck agent status *',
    'dutydeck agent status ?', 'dutydeck agent status [a]', 'dutydeck agent status {a,b}',
    'dutydeck agent status ~', 'dutydeck agent status # comment',
    'dutydeck agent status "$(whoami)"', 'dutydeck agent status "`whoami`"',
    'dutydeck agent status "\\x"', "dutydeck agent status 'unfinished", 'dutydeck agent status "unfinished',
    'dutydeck agent status\0',
  ])('holds %s for normal approval', command => expect(isAgentCommandAutoApproval({ ...input, command })).toBe(false));

  it.each([
    { env: undefined }, { env: { ...env, dutydeck_group_tools_token: '' } },
    { env: { ...env, dutydeck_group_tools_command: '' } }, { env: { ...env, dutydeck_group_tools_url: '' } },
    { permissionMode: 'full-trust' as const }, { permissionMode: 'deny-all' as const },
    { kind: 'read' }, { kind: 'other' }, { command: ['dutydeck', 'agent', 'status'] },
  ])('keeps other capabilities and modes unchanged: %j', patch => {
    expect(isAgentCommandAutoApproval({ ...input, command: 'dutydeck agent status', ...patch })).toBe(false);
  });
  it('also works in approve-reads', () => {
    expect(isAgentCommandAutoApproval({ ...input, command: 'dutydeck agent status', permissionMode: 'approve-reads' })).toBe(true);
  });
});
