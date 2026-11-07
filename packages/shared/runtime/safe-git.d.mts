export const SAFE_GIT_CONFIG: readonly string[];
export function safeGitEnvironment(
  inherited: Record<string, string | undefined>,
  configured?: Record<string, string | undefined>
): Record<string, string>;
export function safeGitConfigFromListing(listing: string): string[];
export function safeGitConfigFor(
  location: readonly string[],
  options: { env: Record<string, string | undefined>; timeout?: number }
): Promise<string[]>;
export function inspectGitConfig(
  location: readonly string[],
  options: { env: Record<string, string | undefined>; timeout?: number }
): Promise<{ config: string[]; repositoryFilters: string[] }>;
