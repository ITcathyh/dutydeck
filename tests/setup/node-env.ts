import { inheritedServiceKeys } from '@dutydeck/shared/child-environment';

// Tests may run inside an agent spawned by a live daemon, or in a shell carrying a unit's variables. Daemon commands
// called without an explicit dir or env, and children spawned with `{ ...process.env }`, would then reach that
// instance instead of the test's temp dirs. Tests that need one of these set it explicitly. Inherited GIT_* (git bisect
// run, hooks) would point the git commands tests run in temp dirs at the outer repository.
const serviceKeys = new Set([...inheritedServiceKeys, 'DUTYDECK_DATABASE_URL', 'DUTYDECK_SUPERVISOR', 'DUTYDECK_SYSTEMD_UNIT']);
for (const key of Object.keys(process.env)) {
  if (serviceKeys.has(key) || key.startsWith('DUTYDECK_DAEMON_RESTART_') || key.startsWith('GIT_')) delete process.env[key];
}
