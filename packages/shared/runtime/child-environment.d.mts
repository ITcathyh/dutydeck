export function childEnvironment(
  inherited: Record<string, string | undefined>,
  configured?: Record<string, string>,
  options?: { stripClaude?: boolean }
): Record<string, string>;
