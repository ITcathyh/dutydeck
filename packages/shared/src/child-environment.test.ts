import { describe, expect, it } from 'vitest';
import { childEnvironment } from '@dutydeck/shared/child-environment';

describe('child environment policy', () => {
  it('scrubs inherited authority without changing the parent or removing explicit CLI accounts', () => {
    const inherited = {
      BOTMUX_SESSION_ID: 'old-session', BOTMUX_OWNER_OPEN_ID: 'old-owner',
      BOTMUX_MCP_GATEWAY_SOCKET: '/old/gateway', BOTMUX_IDENTITY_BIN: '/old/cli-identity/old.bin',
      BYTEDCLI_USER_CLOUD_JWT: 'old-user', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'old-lark',
      LARK_APP_SECRET: 'host-secret', DUTYDECK_CODEBASE_WEBHOOK_SECRET: 'host-webhook',
      DUTYDECK_GITHUB_TOKEN: 'host-github', dutydeck_group_tools_token: 'old-scope',
      dutydeck_relay_token: 'old-relay', dutydeck_session_id: 'old-dutydeck',
      dutydeck_launcher_group: '1', dutydeck_terminal_launch_id: 'old-launch',
      HERDR_PANE_ID: 'old:p1', ANTHROPIC_API_KEY: 'daemon-account',
      HTTP_PROXY: 'http://proxy', NODE_EXTRA_CA_CERTS: '/cert.pem',
      CODEX_HOME: '/cli/config', ORDINARY_TOKEN: 'cli-owned',
      PATH: '/usr/bin:/old/cli-identity/old.bin:/tools/bin',
      GIT_ASKPASS: '/old/cli-identity/old.bin/askpass',
      BASH_ENV: '/old/cli-identity/old.bin/bash-env', ZDOTDIR: '/old/cli-identity/old.bin',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'old-wrapper'
    };
    const before = { ...inherited };
    const configured = {
      BYTEDCLI_USER_CLOUD_JWT: 'configured-user', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'configured-lark',
      ANTHROPIC_API_KEY: 'configured-account', dutydeck_group_tools_token: 'current-scope',
      dutydeck_relay_token: 'current-relay', dutydeck_herdr_session: 'current-herdr', HERDR_PANE_ID: 'fake:p1'
    };
    expect(childEnvironment(inherited, configured, { stripClaude: true })).toEqual({
      HTTP_PROXY: 'http://proxy', NODE_EXTRA_CA_CERTS: '/cert.pem', CODEX_HOME: '/cli/config',
      ORDINARY_TOKEN: 'cli-owned', PATH: '/usr/bin:/tools/bin',
      BYTEDCLI_USER_CLOUD_JWT: 'configured-user', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'configured-lark',
      ANTHROPIC_API_KEY: 'configured-account', dutydeck_group_tools_token: 'current-scope',
      dutydeck_relay_token: 'current-relay', dutydeck_herdr_session: 'current-herdr'
    });
    expect(inherited).toEqual(before);
  });

  it('preserves ordinary shell/git configuration and similarly named tool directories', () => {
    const env = {
      PATH: '/usr/bin:/tools/cli-identity-helper:/tools/cli-identity/normal/bin',
      GIT_ASKPASS: '/tools/askpass', BASH_ENV: '/shell/env', ZDOTDIR: '/shell/zsh',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/work',
      BOTMUX_WORK_DIR: '/installation', ANTHROPIC_API_KEY: 'acp-account'
    };
    expect(childEnvironment(env)).toEqual(env);
  });

  it('recognizes the exact identity bin even outside the conventional identity directory', () => {
    expect(childEnvironment({ BOTMUX_IDENTITY_BIN: '/runtime/wrapper/', PATH: '/usr/bin:/runtime/wrapper/:/runtime/wrapper-ordinary', GIT_ASKPASS: '/runtime/wrapper/askpass', GIT_CONFIG_COUNT: '0' })).toEqual({ PATH: '/usr/bin:/runtime/wrapper-ordinary' });
  });
});
