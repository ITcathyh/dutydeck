import { describe, expect, it } from 'vitest';
import { appLocationPath, parseAppLocation, routeFromPath, sessionPath } from './app-route';

describe('路径解析', () => {
  it('根路径是任务中心，会话路径带出 sessionId', () => {
    expect(routeFromPath('/')).toEqual({ kind: 'overview' });
    expect(routeFromPath('/sessions/s1')).toEqual({ kind: 'session', sessionId: 's1' });
  });

  it('会话 id 会解码，解码失败时退回原文而不是崩掉整页', () => {
    expect(routeFromPath('/sessions/a%2Fb')).toEqual({ kind: 'session', sessionId: 'a/b' });
    expect(routeFromPath('/sessions/%E0%A4%A')).toEqual({ kind: 'session', sessionId: '%E0%A4%A' });
  });

  it.each(['/foo', '/sessions', '/sessions/a/extra', '/sessions/'])('%s 判为 not-found', pathname => {
    expect(routeFromPath(pathname)).toEqual({ kind: 'not-found' });
  });

  it('sessionPath 与解析互为逆运算', () => {
    expect(sessionPath(undefined)).toBe('/');
    expect(routeFromPath(sessionPath('a b'))).toEqual({ kind: 'session', sessionId: 'a b' });
  });
});

describe('浮层的 URL 表示', () => {
  it('没有 panel 参数时不开任何浮层', () => {
    expect(parseAppLocation('/', '')).toEqual({ route: { kind: 'overview' }, overlay: undefined });
    expect(parseAppLocation('/', '?foo=bar').overlay).toBeUndefined();
  });

  it('设置中心可深链到指定分区', () => {
    expect(parseAppLocation('/', '?panel=settings&section=lark').overlay).toEqual({ kind: 'settings', section: 'lark' });
    expect(parseAppLocation('/', '?panel=settings&section=automation').overlay).toEqual({ kind: 'settings', section: 'automation' });
  });

  it('section 缺失或写错时回落到 agents，不把整个 panel 判为无效', () => {
    // 用户手改 URL 打错一个词，应该看到设置页，而不是「什么都没发生」。
    expect(parseAppLocation('/', '?panel=settings').overlay).toEqual({ kind: 'settings', section: 'agents' });
    expect(parseAppLocation('/', '?panel=settings&section=nope').overlay).toEqual({ kind: 'settings', section: 'agents' });
  });

  it('飞书向导、群配置、自动化各有独立的 panel 值', () => {
    expect(parseAppLocation('/', '?panel=lark-setup').overlay).toEqual({ kind: 'lark-setup' });
    expect(parseAppLocation('/', '?panel=groups').overlay).toEqual({ kind: 'groups' });
    expect(parseAppLocation('/', '?panel=automation').overlay).toEqual({ kind: 'automation' });
  });

  it('未知 panel 值当作没有浮层', () => {
    expect(parseAppLocation('/', '?panel=archive-confirm').overlay).toBeUndefined();
  });

  it('危险确认与瞬态浮层没有 URL 表示', () => {
    // 归档确认：深链等于让一条链接对别人的任务弹出不可逆操作的确认框。
    // 命令面板 / 快捷键帮助：按一下就开、Escape 就关，进 URL 只污染历史记录。
    for (const panel of ['confirm', 'archive', 'palette', 'help', 'new-session']) {
      expect(parseAppLocation('/sessions/s1', `?panel=${panel}`).overlay, panel).toBeUndefined();
    }
  });

  it('浮层可以叠在任务详情上，路径与 query 各管各的', () => {
    expect(parseAppLocation('/sessions/s1', '?panel=settings&section=groups')).toEqual({
      route: { kind: 'session', sessionId: 's1' },
      overlay: { kind: 'settings', section: 'groups' }
    });
  });

  it('页面本身不存在时不解析浮层', () => {
    // 在 not-found 上叠一个设置弹层，用户关掉后落到的还是死页面。
    expect(parseAppLocation('/foo', '?panel=settings')).toEqual({ route: { kind: 'not-found' } });
  });
});

describe('反向序列化', () => {
  it('无浮层时只有路径', () => {
    expect(appLocationPath({ route: { kind: 'overview' } })).toBe('/');
    expect(appLocationPath({ route: { kind: 'session', sessionId: 's1' } })).toBe('/sessions/s1');
  });

  it('支持主导航 bots 和 groups 的 URL 序列化与解析', () => {
    const botsLoc = parseAppLocation('/', '?nav=bots&appId=cli_123');
    expect(botsLoc).toEqual({
      route: { kind: 'overview' },
      nav: 'bots',
      appId: 'cli_123'
    });
    expect(appLocationPath(botsLoc)).toBe('/?nav=bots&appId=cli_123');

    const groupsLoc = parseAppLocation('/', '?nav=groups&chatId=oc_abc&appId=cli_123');
    expect(groupsLoc).toEqual({
      route: { kind: 'overview' },
      nav: 'groups',
      chatId: 'oc_abc',
      appId: 'cli_123'
    });
    expect(appLocationPath(groupsLoc)).toBe('/?nav=groups&appId=cli_123&chatId=oc_abc');
  });

  it('浮层序列化后解析回来完全一致', () => {
    const cases: Parameters<typeof appLocationPath>[0][] = [
      { route: { kind: 'overview' }, overlay: { kind: 'settings', section: 'agents' } },
      { route: { kind: 'overview' }, overlay: { kind: 'settings', section: 'lark' } },
      { route: { kind: 'session', sessionId: 's1' }, overlay: { kind: 'lark-setup' } },
      { route: { kind: 'session', sessionId: 'a b' }, overlay: { kind: 'groups' } },
      { route: { kind: 'overview' }, overlay: { kind: 'automation' } }
    ];
    for (const location of cases) {
      const path = appLocationPath(location);
      const [pathname, search] = path.split('?');
      expect(parseAppLocation(pathname, search ? `?${search}` : ''), path).toEqual(location);
    }
  });
});


it('round-trips explicit Bot editing and new modes without changing the underlying selected Bot', () => {
  for (const target of ['new' as const, { appId: 'cli_two' }]) {
    const location = { route: { kind: 'overview' as const }, nav: 'bots' as const, appId: 'cli_original', overlay: { kind: 'lark-setup' as const, target } };
    const url = new URL(appLocationPath(location), 'http://localhost');
    expect(parseAppLocation(url.pathname, url.search)).toEqual(location);
  }
});
