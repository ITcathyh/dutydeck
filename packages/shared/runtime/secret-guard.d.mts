export interface SecretGuardFinding { label: string; match: string }
export const secretGuardToolMatcher: string;
export function probeClaudeHookFailureBlock(options: { command: string; env: Record<string, string>; cwd?: string }): Promise<boolean>;
export function protectedPathFinding(path: unknown, options?: { cwd?: string; home?: string }): SecretGuardFinding | undefined;
export function secretGuardFinding(event: unknown, options?: { home?: string }): SecretGuardFinding | undefined;
export function highRiskBlockedReason(reason: string, prefix?: string): string;
export function recordRiskDenial(root: string, sessionId: string | undefined, policy: unknown, event: unknown): void;
export function hasRiskDenial(root: string, sessionId: string, token: string, command: string): boolean;
export function riskRequestInvocation(event: unknown, prefix?: string): boolean;
export function liveRiskApproval(policy: unknown): Promise<boolean>;
export function highRiskCheckFailedReason(detail: string): string;
export function secretGuardReason(finding: SecretGuardFinding): string;
export function secretGuardScriptPath(): string;
export function secretGuardHookCommand(options: { nodePath?: string; policyRoot: string }): string;
export function secretGuardActive(options: { root: string; sessionId?: string }): boolean;
