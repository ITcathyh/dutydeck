# Lark identity/App×Chat preflight

This surface performs an explicit, read-only verification for a staged or disabled `ChannelBot`. It never starts a listener, sends a message, changes a chat, enables a Bot, or grants cutover authority.

## CLI

```bash
dockmux lark preflight <channel-bot-id>
dockmux lark preflight <channel-bot-id> \
  --group-binding <binding-id> \
  --group-binding <another-binding-id>
```

The command connects only to the locally recorded Dockmux daemon. In token mode it reads that daemon's access token from the recorded database and sends it as a Bearer credential; an explicitly configured no-auth trusted devhost sends no token. Tokens and SecretRef values are never printed.

Exit status is `0` for passed evidence, `2` when the read-only probe completed but returned blockers, and `1` for request/configuration errors.

## Management API

- `POST /api/foundation/channel-bots/:id/identity-preflight` runs the probe. The optional strict JSON body is `{ "groupBindingIds": ["binding-id"] }`; omitting it checks every binding for the Bot.
- `GET /api/foundation/channel-bots/:id/identity-preflight` reads persisted fact validity without contacting Lark.

Both endpoints require the installation owner/admin principal. Token deployments require normal API authentication; the explicit trusted-devhost no-auth deployment resolves to its marked installation-owner principal. Concurrent probes use revision CAS. A loser receives HTTP 409 with the current allowlisted facts and may retry.

The probe resolves only the `ChannelBot`'s selected strict Lark credential SecretRef under the purpose-fixed `identity_preflight` secret boundary. It calls only tenant-token authentication, application identity readback, bot identity readback, `is_in_chat`, and chat metadata GET endpoints. Evidence expires within four hours.

Public API/CLI output includes opaque bot/tenant refs, booleans, timestamps, revisions, membership/chat type, validity, and blocker codes. It excludes credential/App fingerprints, SecretRef bindings, raw App/chat/open IDs, display names, access tokens, app secrets, and other PII. Fingerprints and credential/identity revision bindings remain private in the fact repositories.

Passing the preflight does not change `ChannelBot.state`, `desiredListenerState`, listener readiness, or activation. `listener_lease` and `activation_unavailable` remain explicit blockers. No real-Lark request runs at daemon startup or during a fact-only GET; a real request occurs only after an owner/admin explicitly invokes POST or the CLI command.
