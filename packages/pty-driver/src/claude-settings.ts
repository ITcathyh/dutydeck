import { getCliProfile, ALL_CLI_IDS } from '@dutydeck/cli-adapters';
import { ClaudeLaunchSettings } from '@dutydeck/cli-adapters/claude-terminal';

export const claudeAdapters: ReadonlySet<string> = new Set(ALL_CLI_IDS.filter(id => getCliProfile(id)?.extensions?.settings));
export class ClaudeSettings extends ClaudeLaunchSettings {
  constructor(adapterId: string, sessionId: string, _cwd = process.cwd()) { super(sessionId, claudeAdapters.has(adapterId)); }
}
