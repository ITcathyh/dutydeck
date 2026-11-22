import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertNativeContextRecord, createRuntimeStore, type AcpSessionStore } from 'acpx/runtime';
import { canonicalExecutionJson, taskExecutionSchemas, type NativeContextExpected, type NativeContextIdentity } from '@dutydeck/shared';

/** `<cwd>/.dutydeck` holds session credentials inside the Agent's workspace: private directories, never in the repository. */
export function privateWorkspaceDirectory(cwd: string, ...segments: string[]) {
  const root = join(cwd, '.dutydeck');
  const directory = join(root, ...segments);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let current = directory; ; current = dirname(current)) { chmodSync(current, 0o700); if (current === root) break; }
  try { writeFileSync(join(root, '.gitignore'), '*\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return directory;
}

/** acpx writes records with the process umask; they carry relay and group-tool tokens. */
export function privateSessionStore(cwd: string): AcpSessionStore {
  const store = createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') });
  const sessionFile = (id: string) => join(privateWorkspaceDirectory(cwd, 'acpx', 'sessions'), `${encodeURIComponent(id)}.json`);
  return {
    async load(sessionId) {
      const file = sessionFile(sessionId);
      const record = await store.load(sessionId);
      if (record) chmodSync(file, 0o600);
      return record;
    },
    async save(record) {
      const file = sessionFile(record.acpxRecordId);
      await store.save(record);
      chmodSync(file, 0o600);
    }
  };
}

/** Read the first durable creation receipt without creating or connecting a client. */
export async function readNativeCreationRecord(expected: NativeContextExpected): Promise<NativeContextIdentity | undefined> {
  const store=privateSessionStore(expected.cwd);
  const record=await store.load(expected.sessionKey);if(!record)return;
  const raw=record.acpx?.dutydeck_native_identity;if(!raw)return;
  const identity=taskExecutionSchemas.nativeIdentitySchema.parse(JSON.parse(raw));
  const {acpxRecordId,backendSessionId,agentSessionId,defaults,...saved}=identity;
  if(canonicalExecutionJson(saved)!==canonicalExecutionJson(expected))throw new Error('NATIVE_CONTEXT_IDENTITY_CONFLICT');
  assertNativeContextRecord(record,identity);
  return identity;
}
