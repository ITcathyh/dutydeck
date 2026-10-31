import { describe, expect, it } from 'vitest';
import { botFields, parsePairs } from '../settings-cli.js';
import { agentSettingsKeys, parseAgentSettings, showAgentSettings } from './agent-settings.js';

describe('agent settings whitelist and shared value parser', () => {
  it('uses the settings CLI key types for the same values', () => {
    const pairs = ['defaultAgentId=codex', 'defaultModel=custom', 'defaultReasoningEffort=custom', 'p2pMode=thread', 'groupReplyMode=shared', 'notifyQuietHours=22:00-08:00', 'notifyMentionAction=false', 'notifyMentionDone=true', 'busyTriage=true', 'botLoopGuard=true'];
    expect(parseAgentSettings(pairs)).toEqual(parsePairs(pairs, botFields, 'help'));
    expect(Object.keys(showAgentSettings({ appSecret: 'secret', permissionMode: 'full-trust' } as any)).sort()).toEqual([...agentSettingsKeys].sort());
  });
  it.each([[], ['busyTriage=true', 'busyTriage=false'], ['busyTriage'], ['notifyQuietHours=invalid'], ['permissionMode=ask']])('rejects invalid pairs %s', pairs => {
    expect(() => parseAgentSettings(pairs)).toThrow();
  });
  it('maps automatic group replies to the explicit API clear value', () => {
    expect(parseAgentSettings(['groupReplyMode=auto'])).toEqual({ groupReplyMode: null });
  });
  it('allows clearing optional strings without adding model or effort restrictions', () => {
    expect(parseAgentSettings(['defaultModel=', 'defaultReasoningEffort=', 'notifyQuietHours='])).toEqual({ defaultModel: '', defaultReasoningEffort: '', notifyQuietHours: '' });
  });
});
