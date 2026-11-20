import type { LarkCardService } from './service.js';

/** Bot events and history can expose an open ID where message details expose the app ID. */
export async function readSenderAppId(service: Partial<Pick<LarkCardService, 'getMessage'>>, messageId: string, signal?: AbortSignal): Promise<string | undefined> {
  const message = await service.getMessage?.(messageId, signal);
  const sender = message?.sender;
  return sender?.idType === 'app_id' || sender?.id?.startsWith('cli_') ? sender.id : undefined;
}
