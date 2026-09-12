const TOOL_ENVIRONMENT_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM'] as const;

/** Environment for user-repository tools without Dutydeck service credentials. */
export function minimalToolEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of TOOL_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (process.env.CI === 'true') environment.CI = 'true';
  return environment;
}
