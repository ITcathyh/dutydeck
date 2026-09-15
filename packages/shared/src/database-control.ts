/** A claim covers one Runtime instance; it never proves an Agent process exited. */
export interface RuntimeControlClaim {
  readonly generation: number;
  assertCurrent(): void;
  release(): void;
}
export interface DatabaseControl {
  readonly accessId: string;
  attachRuntime(instanceId: string): RuntimeControlClaim;
}
export interface RepositoryOpenOptions {
  mode?: 'runtime' | 'management';
  upgrade?: 'never' | 'if-idle';
  /** Initial authority only when no user schema exists; existing databases are unchanged. */
  newDatabaseAuthority?: 'legacy' | 'ledger_v1';
}
