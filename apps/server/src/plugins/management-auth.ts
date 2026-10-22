import type { FastifyRequest } from 'fastify';
import { extractBearerToken } from '../auth/auth.js';
import { createInstallationPrincipalResolver, type InstallationPrincipalResolverOptions } from '../foundation-policy.js';

/** Task capabilities never grant installation management, including trusted-local mode. */
export function hasPluginTaskCredentials(request: Pick<FastifyRequest, 'headers'>): boolean {
  return ['x-dutydeck-tool-turn', 'x-dutydeck-work-turn', 'x-dutydeck-result-turn'].some(header => request.headers[header] !== undefined)
    || Boolean(extractBearerToken(request.headers.authorization)?.startsWith('v1.'));
}
export function createPluginManagementAuthorizer(options: InstallationPrincipalResolverOptions) {
  const installation = createInstallationPrincipalResolver(options);
  const explicitCredential = createInstallationPrincipalResolver({ ...options, authEnabled: true, mode: 'token' });
  return async (request: FastifyRequest): Promise<boolean> => {
    if (hasPluginTaskCredentials(request)) return false;
    // A raw attempt token has the same format as an access token. Verify all explicit
    // Authorization headers instead of letting local/open mode ignore their value.
    return Boolean(await (request.headers.authorization === undefined ? installation : explicitCredential)(request));
  };
}
