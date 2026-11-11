import { describe, expect, it } from 'vitest';
import { childEnvironment } from '@dutydeck/shared/child-environment';

describe('child environment policy', () => {
  it('scrubs inherited authority without changing the parent or removing explicit CLI accounts', () => {
    const inherited = {
      BOTMUX_SESSION_ID: 'old-session', BOTMUX_OWNER_OPEN_ID: 'old-owner',
      BOTMUX_MCP_GATEWAY_SOCKET: '/old/gateway', BOTMUX_IDENTITY_BIN: '/old/cli-identity/old.bin',
      BYTEDCLI_USER_CLOUD_JWT: 'old-user', LARKSUITE_CLI_USER_ACCESS_TOKEN: 'old-lark',
      LARK_APP_SECRET: 'host-secret', DUTYDECK_WEBHOOK_SECRET: 'host-webhook',
      DUTYDECK_SERVICE_TOKEN: 'host-github', dutydeck_group_tools_token: 'old-scope',
      dutydeck_relay_token: 'old-relay', dutydeck_session_id: 'old-dutydeck',
      dutydeck_launcher_group: '1', dutydeck_launcher_report: '/old/launchers', dutydeck_terminal_launch_id: 'old-launch',
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

  it('drops inherited service configuration and Lark/Feishu app secrets but keeps provider keys and explicit values', () => {
    const inherited = {
    DUTYDECK_DRIVER_IDLE_CPU_ACTION: 'retire',
      DUTYDECK_AGENTS_JSON: '[{"env":{"ANTHROPIC_AUTH_TOKEN":"other-agent"}}]', DUTYDECK_INSTANCES_JSON: '[]',
      DUTYDECK_DATABASE_URL: '/srv/dutydeck.db', DUTYDECK_PLUGIN_SECRETS: 'plugin', DUTYDECK_DAEMON_RESTART_HOST: '0.0.0.0',
      FEISHU_APP_SECRET: 'feishu', LARK_ENCRYPT_KEY: 'lark-encrypt', FEISHU_VERIFICATION_TOKEN: 'feishu-verify',
      DUTYDECK_DAEMON_DIR: '/srv/.dutydeck/daemon', DUTYDECK_BOT_APP_ID: 'cli_placeholder',
      DUTYDECK_CLAUDE_ACP_COMMAND: '/usr/bin/node', DUTYDECK_CLAUDE_ACP_ARGS_JSON: '[]',
      LARK_APP_ID: 'cli_placeholder', OPENAI_API_KEY: 'provider', PATH: '/usr/bin'
    };
    expect(childEnvironment(inherited, { DUTYDECK_PLUGIN_NAME: 'explicit', FEISHU_APP_SECRET: 'explicit-feishu' })).toEqual({
      DUTYDECK_DAEMON_DIR: '/srv/.dutydeck/daemon', DUTYDECK_BOT_APP_ID: 'cli_placeholder',
      DUTYDECK_CLAUDE_ACP_COMMAND: '/usr/bin/node', DUTYDECK_CLAUDE_ACP_ARGS_JSON: '[]',
      LARK_APP_ID: 'cli_placeholder', OPENAI_API_KEY: 'provider', PATH: '/usr/bin',
      DUTYDECK_PLUGIN_NAME: 'explicit', FEISHU_APP_SECRET: 'explicit-feishu'
    });
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

  it('drops the daemon\'s inherited tmux pane but keeps explicitly configured values', () => {
    const inherited = { TMUX: '/tmp/tmux-1000/default,123,0', TMUX_PANE: '%7', TMUX_TMPDIR: '/run/tmux', PATH: '/usr/bin' };
    expect(childEnvironment(inherited)).toEqual({ TMUX_TMPDIR: '/run/tmux', PATH: '/usr/bin' });
    expect(childEnvironment(inherited, { TMUX_PANE: '%1' })).toEqual({ TMUX_TMPDIR: '/run/tmux', PATH: '/usr/bin', TMUX_PANE: '%1' });
    expect(inherited.TMUX).toBe('/tmp/tmux-1000/default,123,0');
  });

  it('recognizes the exact identity bin even outside the conventional identity directory', () => {
    expect(childEnvironment({ BOTMUX_IDENTITY_BIN: '/runtime/wrapper/', PATH: '/usr/bin:/runtime/wrapper/:/runtime/wrapper-ordinary', GIT_ASKPASS: '/runtime/wrapper/askpass', GIT_CONFIG_COUNT: '0' })).toEqual({ PATH: '/usr/bin:/runtime/wrapper-ordinary' });
  });
});
