import { alertKeyProvider } from './alert-key.mjs';

/** 内置告警包的 providers 入口：注册「同一告警规则」的识别。 */
export default function register(api) {
  api.registerScenarioProvider(alertKeyProvider);
}
