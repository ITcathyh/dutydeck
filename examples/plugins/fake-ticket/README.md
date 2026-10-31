# Fake ticket business tools

Self-contained example: `npm pack` includes every runtime file; no node_modules or SDK runtime dependency is needed. Configure a binding with `endpoint` and a secret reference named `ticket_token`. The example never ships credentials.

The example API implements GET /tickets/:id, POST /tickets/:id/close and GET /actions/:actionId. Closing accepts an Idempotency-Key and returns `{ "receipt": "..." }`; reconciliation returns `{ "status": "succeeded|failed|unknown", "receipt": "..." }`. This is an example contract, not a production ticket integration.

Grant the task's trusted actor access to `fake-ticket/get` (read) or `fake-ticket/close` (write), the exact binding and `ticket:<id>` resource. Invocation and reconciliation grants are separate. The server also rechecks the original requester's invocation grant before reconciliation.

Use `dutydeck tool list --turn <current-token>`, then `dutydeck tool call fake-ticket/close --json '{"ticket":"T-1"}' --call-id close-T-1 --turn <current-token>`. Preserve call-id on retries; if status is unknown use `dutydeck tool reconcile <action-id> --turn <current-token>`. The MCP endpoint exposes the same schema and gate.

The included `/ticket-status T-1` (or `/fake-ticket:ticket-status T-1`) reads `status` directly, without creating an Agent session. `commands/ticket-status.md` maps the remaining text to the `ticket` input. The `status` query returns only title/status and explicitly declares `commandOutput: 'chat'`: the API response is suitable for everyone in the originating chat. Do not return credentials or private ticket fields from that endpoint.

An administrator must enable a binding for the bot/chat and grant the requesting channel actor `fake-ticket/status`, that binding ID, `read`, `invoke`, and `ticket:T-1` (or an intentional resource wildcard). Bot access alone is insufficient. The host supplies requester identity; command text cannot change the destination or actor. Query failures use a generic receipt, and duplicate events or interrupted commands are never automatically retried. The `close` action remains task-only and uses the action ledger.
