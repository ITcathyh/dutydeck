import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Freed local ports are reused by parallel tests and probed by host tools, so a fake server only records requests that
 * `accept` lets through. A non-target `/api/` request is more likely our own client on a wrong route than a stray, so it
 * is kept for an afterEach assertion instead of letting the test hang until its timeout.
 */
export function targetGuard(isTarget: (request: IncomingMessage) => boolean): { accept(request: IncomingMessage, response: ServerResponse): boolean; strayRequests: string[] } {
  const strayRequests: string[] = [];
  return {
    strayRequests,
    accept(request, response) {
      if (isTarget(request)) return true;
      if (request.url?.startsWith('/api/')) strayRequests.push(`${request.method} ${request.url}`);
      request.resume();
      response.writeHead(404).end();
      return false;
    }
  };
}
