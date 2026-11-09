import { createCodebaseProvider } from './provider.mjs';

export default function register(api) {
  api.registerCiProvider(createCodebaseProvider({ host: api.config.host, webhookSecret: api.config.webhook_secret }));
}
