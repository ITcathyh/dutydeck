import { launchAgent } from './launcher-process.mjs';
import { existsSync, readFileSync } from 'node:fs';

// The bundled server ships this beside the launcher. Standalone ACP packages
// resolve the same policy from their declared shared dependency.
const policyUrl = new URL('./child-environment.mjs', import.meta.url);
const { childEnvironment } = await import(existsSync(policyUrl) ? policyUrl.href : '@dutydeck/shared/child-environment');

const carrierKey = 'dutydeck_agent_env_file';
const digestKey = 'dutydeck_agent_env_digest';
const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('Dutydeck ACP environment launcher requires a command.\n');
  process.exit(2);
}

let bridged = {};
try {
  const environmentFile = process.env[carrierKey];
  if (!environmentFile) throw new Error('missing runtime environment file');
  bridged = JSON.parse(readFileSync(environmentFile, 'utf8'));
  if (!bridged || typeof bridged !== 'object' || Array.isArray(bridged)) throw new Error('expected an object');
  if (Object.values(bridged).some(value => typeof value !== 'string')) throw new Error('all values must be strings');
} catch (error) {
  process.stderr.write(`Invalid Dutydeck ACP environment: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const env = childEnvironment(process.env, bridged);
delete env[carrierKey];
delete env[digestKey];
launchAgent(command, args, env);
