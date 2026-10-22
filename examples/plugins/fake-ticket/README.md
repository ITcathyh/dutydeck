# Fake ticket business tools

Self-contained example: `npm pack` includes every runtime file; no node_modules or SDK runtime dependency is needed. Configure a binding with `endpoint` and a secret reference named `ticket_token`. The example never ships credentials.

The example API implements GET /tickets/:id, POST /tickets/:id/close and GET /actions/:actionId. Closing accepts an Idempotency-Key and returns `{ "receipt": "..." }`; reconciliation returns `{ "status": "succeeded|failed|unknown", "receipt": "..." }`. This is an example contract, not a production ticket integration.

Grant the task's trusted actor access to `fake-ticket/get` (read) or `fake-ticket/close` (write), the exact binding and `ticket:<id>` resource. Invocation and reconciliation grants are separate. The server also rechecks the original requester's invocation grant before reconciliation.

Use `dutydeck tool list --turn <current-token>`, then `dutydeck tool call fake-ticket/close --json '{"ticket":"T-1"}' --call-id close-T-1 --turn <current-token>`. Preserve call-id on retries; if status is unknown use `dutydeck tool reconcile <action-id> --turn <current-token>`. The MCP endpoint exposes the same schema and gate.
