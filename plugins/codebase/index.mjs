import { createCodebaseProvider } from './provider.mjs';

export default function register(api) {
  api.registerCiProvider(createCodebaseProvider({ webhookSecret: api.config.webhook_secret }));
}
