/** A claim covers one Runtime instance; it never proves an Agent process exited. */
export interface RuntimeControlClaim {
  readonly generation: number;
  assertCurrent(): void;
  release(): void;
}
export interface DatabaseControl {
  readonly accessId: string;
  /** Undefined when no runtime holds the database. Older registrations have no capabilities. */
  runtimeCapabilities(): readonly string[] | undefined;
  attachRuntime(instanceId: string): RuntimeControlClaim;
}
export interface RepositoryOpenOptions {
  mode?: 'runtime' | 'management';
  runtimeCapabilities?: readonly string[];
  upgrade?: 'never' | 'if-idle';
  /** Initial authority only when no user schema exists; existing databases are unchanged. */
  newDatabaseAuthority?: 'legacy' | 'ledger_v1';
  /** Called with the migration duration (ms) when this open ran schema migrations; startup timing only. */
  onMigrated?: (ms: number) => void;
  /** How long this open waits on a locked SQLite file, in ms; defaults to the driver's 5 seconds. */
  busyTimeoutMs?: number;
}
