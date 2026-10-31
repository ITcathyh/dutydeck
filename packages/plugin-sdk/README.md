# @dutydeck/plugin-sdk

Self-contained author contracts for Dutydeck API version 1. No server or private workspace dependency is required.

```ts
import { definePlugin } from '@dutydeck/plugin-sdk';
export default definePlugin(api => {
  api.registerQuery({
    name: 'project-name', description: 'Read the bound project name', version: '1',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    resource: (_input, binding) => String(binding.config.project),
    execute: async (_input, { binding }) => ({ project: String(binding.config.project) })
  });
});
```

Declare `apiVersion: 1`, `providers: "dist/index.mjs"` and typed `bindingConfig` in `.dutydeck-plugin/plugin.json`. Compile the entrypoint before packaging. Query/action grants default to deny and are configured by the installation administrator. Use `binding.getSecret` for declared secret fields; do not expose credentials in results.

Action authors return a durable receipt and keep execution/reconciliation semantics stable within their declared `version`. `actionId` comes from the host; reconciliation preserves the original identity, binding and handler contract.

Provider authors can also use the independent `CiProvider` and `PluginResultTool` contracts with `api.registerCiProvider` and `api.registerResultTool`. These types are defined in this package so provider entrypoints do not need a server or private shared dependency.

Plugin installation unpacks the package without installing npm dependencies. Bundle runtime imports (including `definePlugin`) into your provider before publishing, e.g. `esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs`. Include the bundle and manifest in npm files and do not externalize this SDK. Type-only imports require no SDK runtime dependency.

A query may explicitly opt in to direct chat commands by declaring `commandOutput: 'chat'` (`PluginChatQuery`). Its `execute` receives either the usual task identity or a host-authenticated `PluginCommandIdentity` with `kind: 'command'`, `eventId`, actor, bot, chat and workspace. Check `'kind' in context.identity` before accessing task fields. Queries without this opt-in retain the original `PluginQuery` task-only contract; action identities are unchanged.

Declare a command in `commands/ticket-status.md` with frontmatter `query: status` and `argument: ticket`, plus optional `description` and `argument-hint`, and an empty body. The remaining command text is passed unchanged (apart from outer whitespace) as the single string property `ticket`; normal schema validation applies. A query must be registered in the same plugin and opt in to chat output. Prompt commands keep their Markdown body and `$ARGUMENTS` behavior. Include `commands` in the npm package files.

The host verifies the current binding, actor, read effect, exact resource and tool grants before execution and again before exposing results. A chat/talk permission alone grants no business resource access. Queries run within the host's time/output budgets; replies use the originating chat, a stable delivery key and one UTF-8/JSON-bounded text message, with a truncation notice if needed. Returned values are public to that chat: never opt in private exports, credentials or per-user confidential results. Use `PluginResultTool` for private file delivery.

Direct commands persist an inbound claim before execution. Repeated events do not execute or deliver again. A restart during execution or delivery leaves an unknown command receipt and never automatically starts a model or replays the query; the user may issue a new event to query again. A provider that performs writes must register an action and use the existing action ledger instead. This does not add a service-child RPC interface; direct commands use the same registered provider query as task tools.
