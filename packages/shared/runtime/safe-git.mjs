import { execFile } from 'node:child_process';
import { childEnvironment } from './child-environment.mjs';

// A repository's own config, attributes and hooks are writable by whoever works in it, agents included.
// Daemon-side git pins every key that can make git start a program; operator values come only from
// system, global and command scope.
const PINNED = [
  ['core.fsmonitor', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.alternateRefsCommand', ''],
  ['core.sshCommand', 'ssh'],
  ['core.askPass', ''],
  ['credential.helper', ''],
  ['protocol.ext.allow', 'never'],
  ['submodule.recurse', 'false'],
  ['fetch.recurseSubmodules', 'false'],
  ['push.recurseSubmodules', 'no'],
  ['log.showSignature', 'false'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false']
];
export const SAFE_GIT_CONFIG = Object.freeze(PINNED.flatMap(([key, value]) => ['-c', `${key}=${value}`]));

const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);
// Program-valued keys git still needs: credential helpers and ssh for remotes, filter drivers (git-lfs) for work tree content.
const PROGRAM_KEY = /^(?:core\.(?:sshcommand|askpass)|credential\.(?:.+\.)?helper|filter\..+\.(?:clean|smudge|process|required))$/;
const FILTER_KEY = /^filter\..+\.(clean|smudge|process|required)$/;

// Keyring-backed credential helpers also need the session bus and display; tokens stay out (helpers read their own stores).
const INHERITED = /^(?:PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|TMP|TEMP|XDG_CONFIG_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|SYSTEMROOT|COMSPEC|PATHEXT|SSH_AUTH_SOCK|SSH_ASKPASS|GNUPGHOME|EMAIL|SSL_CERT_(?:FILE|DIR)|CURL_CA_BUNDLE|(?:HTTPS?|ALL|NO)_PROXY|GCM_\w+|GH_(?:HOST|CONFIG_DIR)|GIT_(?:CONFIG(?:_\w+)?|SSH|SSH_COMMAND|SSH_VARIANT|ASKPASS|EXEC_PATH|PROXY_COMMAND|(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)|SSL_\w+|HTTP_\w+))$/i;

/** Only what git needs for config lookup, identity and transport; daemon secrets never reach git or anything it starts. */
export function safeGitEnvironment(inherited, configured = {}) {
  const picked = Object.fromEntries(Object.entries(inherited).filter(([key]) => INHERITED.test(key)));
  // A set GIT_PROXY_COMMAND, even empty, makes git ignore core.gitProxy, which a later -c cannot override.
  return childEnvironment(picked, { GIT_TERMINAL_PROMPT: '0', GIT_PROXY_COMMAND: picked.GIT_PROXY_COMMAND ?? '', ...configured });
}

/** From `git config --show-scope -z --list`: program keys keep only their system, global and command values; filter keys set only by the repository are disabled. */
export function safeGitConfigFromListing(listing) {
  const trusted = [];
  const trustedKeys = new Set();
  const repositoryFilters = new Map();
  const fields = listing.split('\0');
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const scope = fields[index], entry = fields[index + 1];
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    if (!PROGRAM_KEY.test(key)) continue;
    if (TRUSTED_SCOPES.has(scope)) {
      trusted.push('-c', newline < 0 ? key : `${key}=${entry.slice(newline + 1)}`);
      trustedKeys.add(key);
    } else {
      const filter = FILTER_KEY.exec(key);
      if (filter) repositoryFilters.set(key, filter[1] === 'required' ? 'false' : '');
    }
  }
  const disabled = [...repositoryFilters].filter(([key]) => !trustedKeys.has(key));
  return [...disabled.flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...trusted];
}

/** Config arguments for git that reads or writes work tree content, or talks to a remote. Rejects when the config cannot be listed. */
export function safeGitConfigFor(location, { env, timeout = 10_000 }) {
  return new Promise((resolve, reject) => {
    execFile('git', [...location, 'config', '--show-scope', '-z', '--list'], { env, timeout, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error) return reject(error);
      resolve([...SAFE_GIT_CONFIG, ...safeGitConfigFromListing(stdout)]);
    });
  });
}
