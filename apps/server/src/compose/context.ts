import type { AppConfig } from '@dutydeck/config';
import type { createRepositories } from '@dutydeck/storage';
import type { FastifyBaseLogger } from 'fastify';
import type { StartLocalServerOptions } from '../service.js';
import type { ServerLifecycle } from './lifecycle.js';

export interface ComposeContext {
  repos: ReturnType<typeof createRepositories>;
  config: AppConfig;
  env: NodeJS.ProcessEnv;
  options: StartLocalServerOptions;
  log: FastifyBaseLogger;
  lifecycle: ServerLifecycle;
}
