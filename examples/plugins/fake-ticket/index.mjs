export default function register(api) {
  const inputSchema = { type: 'object', properties: { ticket: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['ticket'], additionalProperties: false };
  const resource = (input) => `ticket:${input.ticket}`;
  const request = async (path, context, init = {}) => {
    const endpoint = String(context.binding.config.endpoint);
    const token = await context.binding.getSecret('ticket_token');
    if (!token) throw new Error('TICKET_CREDENTIAL_REQUIRED');
    const response = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, { ...init, signal: context.signal, headers: { authorization: `Bearer ${token}`, 'x-requester': context.identity.actor.id, ...init.headers } });
    if (!response.ok) throw new Error('TICKET_REQUEST_FAILED');
    return response.json();
  };
  api.registerQuery({ name: 'get', description: 'Read a ticket', version: '1', inputSchema, resource,
    execute: (input, context) => request(`/tickets/${encodeURIComponent(input.ticket)}`, context) });
  api.registerAction({ name: 'close', description: 'Close a ticket once; unknown results require reconciliation', version: '1', inputSchema, resource,
    async execute(input, context) {
      return request(`/tickets/${encodeURIComponent(input.ticket)}/close`, context, { method: 'POST', headers: { 'idempotency-key': context.actionId } });
    },
    async reconcile(context) {
      return request(`/actions/${encodeURIComponent(context.actionId)}`, context, { headers: { 'x-original-requester': context.original.original.actor.id } });
    }
  });
}
