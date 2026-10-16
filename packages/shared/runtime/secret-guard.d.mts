export interface SecretGuardFinding { label: string; match: string }
export const secretGuardToolMatcher: string;
export function protectedPathFinding(path: unknown, options?: { cwd?: string; home?: string }): SecretGuardFinding | undefined;
export function secretGuardFinding(event: unknown, options?: { home?: string }): SecretGuardFinding | undefined;
export function secretGuardReason(finding: SecretGuardFinding): string;
export function secretGuardScriptPath(): string;
export function secretGuardHookCommand(options: { nodePath?: string; policyRoot: string }): string;
export function secretGuardActive(options: { root: string; sessionId?: string }): boolean;
