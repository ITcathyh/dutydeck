import { createGithubProvider } from './provider.mjs';

/** Dutydeck 插件入口：用 userConfig 里的令牌和 webhook 密钥注册 GitHub 提供方。 */
export default function register(api) {
  api.registerCiProvider(createGithubProvider({ token: api.config.token, webhookSecret: api.config.webhook_secret }));
}
