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
