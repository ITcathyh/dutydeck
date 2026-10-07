import readline from 'node:readline';

readline.createInterface({ input: process.stdin }).on('line', () => {
  const env = process.env;
  // Report only comparisons against fake values, never environment contents.
  const checks = {
    daemonSecret: env.DUTYDECK_AUTH_TOKEN === undefined,
    larkSecret: env.LARK_APP_SECRET === undefined,
    staleIdentity: env.BOTMUX_SESSION_ID === undefined,
    staleCapability: env.dutydeck_group_tools_token === undefined,
    ordinary: env.OCR_ORDINARY === 'ordinary',
    configured: env.OCR_CONFIGURED === 'configured',
    configuredAccount: env.BYTEDCLI_USER_CODE_JWT === 'fake-configured-account',
    sessionIdentity: env.dutydeck_session_id === 'current-session',
    sessionCapability: env.dutydeck_relay_token === 'fake-current-capability'
  };
  process.stdout.write(`${JSON.stringify({ type: 'text', text: JSON.stringify(checks) })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'completed', stopReason: 'end_turn' })}\n`);
});
