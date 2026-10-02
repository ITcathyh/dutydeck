import { delimiter } from 'node:path';

// These are turn-owned identities/capabilities, not CLI installation settings.
const sessionKeys = new Set([
  'BOTMUX', 'BOTMUX_SESSION_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_CHAT_TYPE',
  'BOTMUX_ROOT_MESSAGE_ID', 'BOTMUX_TURN_ID', 'BOTMUX_DISPATCH_ATTEMPT',
  'BOTMUX_SESSION_SCOPE', 'BOTMUX_OWNER_OPEN_ID', '__OWNER_OPEN_ID',
  'BOTMUX_ORIGIN_CHANNEL_ID', 'BOTMUX_SEND_RELAY', 'BOTMUX_MCP_GATEWAY_SOCKET',
  'BOTMUX_MCP_GATEWAY_REQUIRED', 'BOTMUX_PLUGIN_CARD_ACTION_CAPABILITIES',
  'BOTMUX_DAEMON_IPC_PORT', 'BOTMUX_READ_ISOLATION', 'BOTMUX_READ_ISOLATED',
  'BOTMUX_API_ONLY', 'BOTMUX_BRAND_LABEL', 'BOTMUX_USAGE_DISPLAY',
  'BOTMUX_REPLY_STYLE', 'BOTMUX_PI_INITIAL_PROMPT_FILE',
  'BOTMUX_CODEX_APP_CONTROL_BOOTSTRAP', 'BOTMUX_READY_COMMAND',
  'BOTMUX_STATUSLINE_CHAIN', 'BOTMUX_LARK_APP_ID',
  'BYTEDCLI_USER_CLOUD_JWT', 'BYTEDCLI_USER_CODE_JWT', 'BYTEDCLI_USER_CB_OAUTH_AT',
  'AIME_USER_CLOUD_JWT', 'AIME_USER_CODE_JWT', 'LARKSUITE_CLI_USER_ACCESS_TOKEN',
  'LARK_APP_SECRET'
]);

/** Build a child-only snapshot; explicit CLI accounts and current scopes win. */
export function childEnvironment(inherited, configured = {}, { stripClaude = false } = {}) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([, value]) => typeof value === 'string'));
  const identityBin = env.BOTMUX_IDENTITY_BIN?.replace(/[\\/]+$/, '');
  const managed = value => !!value && (
    /(?:^|[\\/])cli-identity[\\/][^\\/]+\.bin(?:[\\/]|$)/.test(value)
    || !!identityBin && (value === identityBin || value.startsWith(`${identityBin}/`) || value.startsWith(`${identityBin}\\`))
  );
  if (env.PATH !== undefined) env.PATH = env.PATH.split(delimiter).filter(value => !managed(value.replace(/[\\/]+$/, ''))).join(delimiter);
  // Botmux emits its git config entries together with this managed askpass.
  if (managed(env.GIT_ASKPASS)) {
    for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete env[key];
  }
  for (const key of ['GIT_ASKPASS', 'BASH_ENV', 'ZDOTDIR']) if (managed(env[key])) delete env[key];
  for (const key of Object.keys(env)) {
    if (sessionKeys.has(key) || /^BOTMUX_IDENTITY_/.test(key)
      || /^DUTYDECK_.*(?:TOKEN|SECRET|PASSWORD|AUTH)(?:_|$)/i.test(key)
      || /^dutydeck_(?:group_tools_|relay_|herdr_|agent_env_|session_id$|terminal_backend$|launcher_group$|terminal_launch_id$)/i.test(key)
      || stripClaude && /^(?:ANTHROPIC_|CLAUDE_)/i.test(key)) delete env[key];
  }
  Object.assign(env, configured);
  // Only the backend may assign real Herdr pane identity, after this boundary.
  for (const key of Object.keys(env)) if (/^HERDR_/i.test(key) || typeof env[key] !== 'string') delete env[key];
  return env;
}
