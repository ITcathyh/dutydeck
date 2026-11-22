import { getCliProfile, nativeProfiles } from '@dutydeck/cli-adapters';
export const TRANSCRIPT_ADAPTER_IDS: readonly string[] = nativeProfiles.filter(id => getCliProfile(id)?.transcript);
