import { describe, expect, it } from 'vitest';
import { responderAnnouncementOf, responderClaimText, responderIntentOf, responderReleaseText } from './group-responder.js';

describe('接话人', () => {
  it.each([
    ['这个群由 flash 负责接话', 'flash'],
    ['以后让 bdev 来接话吧', 'bdev'],
    ['你来接话', ''],
    ['接话人改成 Tag 机器人', 'Tag 机器人']
  ])('「%s」→ %s', (text, name) => {
    expect(responderIntentOf(`@_user_1 ${text}`)).toEqual({ name });
  });

  it('问句或说自己不算', () => {
    expect(responderIntentOf('@_user_1 谁来接话')).toBeUndefined();
    expect(responderIntentOf('@_user_1 我来接话')).toBeUndefined();
    expect(responderIntentOf('@_user_1 接话的规则是什么')).toBeUndefined();
  });

  it('声明消息能解析回来', () => {
    expect(responderAnnouncementOf(responderClaimText('bdev-flash'))).toEqual({ kind: 'claim', name: 'bdev-flash' });
    expect(responderAnnouncementOf(responderReleaseText('bdev-flash'))).toEqual({ kind: 'release', name: 'bdev-flash' });
    expect(responderAnnouncementOf('本群没 @ 机器人的消息由我接')).toBeUndefined();
  });
});
