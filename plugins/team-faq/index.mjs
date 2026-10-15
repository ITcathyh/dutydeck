import { createRunbookProvider } from './provider.mjs';

/** Dutydeck 插件入口：用 userConfig 里的 runbook 目录注册场景 provider `runbook`。 */
export default function register(api) {
  api.registerScenarioProvider(createRunbookProvider({ docsDir: api.config.docs_dir }));
}
