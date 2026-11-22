import { acpDriverProvider } from '@dutydeck/acp-client/provider';
import { createPtyCliProvider } from '@dutydeck/pty-driver';
import { transportProviders } from '@dutydeck/transports';
import type { DriverProvider } from '@dutydeck/shared';

export function defaultDriverProviders(terminal: DriverProvider = createPtyCliProvider()): DriverProvider[] {
  return [acpDriverProvider, terminal, ...transportProviders];
}
