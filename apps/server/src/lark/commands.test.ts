import { describe, expect, it } from 'vitest';
import {
  authorizeLarkCommandText,
  evaluateLarkCommand,
  isLarkCommandAvailable,
  larkCommandCapabilities,
  larkCommandEcho,
  larkCommandRegistry,
  larkPassthroughMarker,
  listLarkCommands,
  normalizeLarkPassthroughPrompt,
  parseLarkHelpPageValue,
  parseSlashCommand,
  renderLarkCommandHelp,
  resolveLarkCommand,
  routeLarkCommand,
  suggestLarkCommand,
  type LarkCommandCapabilities,
  type LarkCommandContext
} from './commands.js';

const fullCapabilities: LarkCommandCapabilities = {
  getSession: true, send: true, dispatch: true, interrupt: true, cancelQueued: true,
  stop: true, getTasks: true, listAgents: true, listSessions: true
};

/** 含全部可选能力（work/schedule/ci/tasks/answer/approval），12 条命令全部可用。 */
const allCapabilities: LarkCommandCapabilities = {
  ...fullCapabilities,
  ci: true, schedule: true, work: true, tasks: true, answer: true, approval: true
};

const capabilities = (overrides: Partial<LarkCommandCapabilities> = {}): LarkCommandCapabilities =>
  ({ ...fullCapabilities, ...overrides });

const context = (overrides: Partial<LarkCommandContext> = {}): LarkCommandContext => ({
  capabilities: fullCapabilities,
  operator: { kind: 'user', allowlisted: true },
  ...overrides
});

/** 形状非法或不成命令的输入；路由与权限门必须一致地不认。 */
const malformedInputs: unknown[] = [
  '/foo:bar', '/1cmd', '/', '//', '///', '/ help', '/-cmd', '/_cmd', '/help:extra',
  '/usr/bin/foo', '/etc/hosts', '/tmp/some dir/file', 'not /help', '请执行 /status',
  '', '   ', '\n\t ', 'help', '#help', '!help', '@bot /help',
  `/${'a'.repeat(33)}`, '/命令', '/foo.bar', '/foo/bar', '/foo bar:baz'.slice(4),
  undefined, null, 42, {}, [], true
];

describe('parseSlashCommand 唯一的命令形状校验器', () => {
  it('解析合法命令并归一化为小写', () => {
    expect(parseSlashCommand('/help')).toMatchObject({ name: 'help', args: [], argsText: '', raw: '/help' });
    expect(parseSlashCommand('/HELP')?.name).toBe('help');
    expect(parseSlashCommand('/Status')?.name).toBe('status');
  });

  it('trim 首尾空白后仍是命令，argsText 为空', () => {
    const parsed = parseSlashCommand('  /status  ');
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('status');
    expect(parsed!.argsText).toBe('');
    expect(parsed!.args).toEqual([]);
    expect(parsed!.raw).toBe('/status');
  });

  it('argsText 逐字保留命令名之后的原文（含内部空格的目录路径）', () => {
    const parsed = parseSlashCommand('/cwd /tmp/some dir');
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe('cwd');
    expect(parsed!.argsText).toBe('/tmp/some dir');
    expect(parsed!.args).toEqual(['/tmp/some', 'dir']);
  });

  it('允许字母开头的字母数字与 - _ 命名', () => {
    expect(parseSlashCommand('/a')?.name).toBe('a');
    expect(parseSlashCommand('/new-task')?.name).toBe('new-task');
    expect(parseSlashCommand('/new_task')?.name).toBe('new_task');
    expect(parseSlashCommand('/cmd2')?.name).toBe('cmd2');
  });

  it.each(malformedInputs.map(input => [JSON.stringify(input) ?? String(input), input] as const))(
    '拒绝非命令输入 %s',
    (_label, input) => {
      expect(parseSlashCommand(input)).toBeUndefined();
    }
  );

  it('多段路径不会被误认成命令（含 / 不满足命令名字符集）', () => {
    expect(parseSlashCommand('/usr/bin/foo')).toBeUndefined();
    // 单段路径与命令形状无法区分，只能是「未识别命令」，由路由归一化为普通文字透传。
    expect(parseSlashCommand('/tmp')?.name).toBe('tmp');
    expect(routeLarkCommand('/tmp', context()).kind).toBe('unknown_command');
  });
});

describe('注册表与能力门（诚实表达能力）', () => {
  it('CI commands require the automation service and normal operator authorization', () => {
    expect(routeLarkCommand('/ci wait ci.yml', context()).kind).toBe('unavailable');
    const caps = capabilities({ ci: true });
    expect(routeLarkCommand('/ci wait ci.yml', context({ capabilities: caps }))).toMatchObject({ kind: 'intent', command: 'ci', args: ['wait', 'ci.yml'] });
    expect(renderLarkCommandHelp(caps).text).toContain('/ci wait');
    expect(routeLarkCommand('/ci cancel ci_1', context({ capabilities: caps, operator: { kind: 'user', allowlisted: false } })).kind).toBe('denied');
  });
  it('注册表里的命令名与别名本身都满足命令形状规则', () => {
    for (const definition of larkCommandRegistry) {
      for (const key of [definition.name, ...(definition.aliases ?? [])]) {
        expect(parseSlashCommand(`/${key}`)?.name).toBe(key);
      }
    }
  });

  it('全能力时列出全部命令', () => {
    expect(listLarkCommands(fullCapabilities).map(item => item.name))
      .toEqual(['help', 'repair', 'status', 'cancel', 'retry', 'new']);
  });

  it('缺少 interrupt 与 cancelQueued 时 /cancel 从 /help 消失并路由为 unavailable，不产生 intent', () => {
    const caps = capabilities({ interrupt: false, cancelQueued: false });
    expect(listLarkCommands(caps).map(item => item.name)).not.toContain('cancel');
    expect(renderLarkCommandHelp(caps).text).not.toContain('/cancel');
    for (const text of ['/cancel', '/stop']) {
      const route = routeLarkCommand(text, context({ capabilities: caps }));
      expect(route.kind).toBe('unavailable');
      expect(route.kind === 'unavailable' && route.reason).toContain('interrupt');
    }
  });

  it('只剩 cancelQueued 时 /cancel 仍可用（还能真的取消排队轮次）', () => {
    const caps = capabilities({ interrupt: false });
    expect(listLarkCommands(caps).map(item => item.name)).toContain('cancel');
    expect(routeLarkCommand('/cancel', context({ capabilities: caps })).kind).toBe('intent');
  });

  it('缺少 stop 时 /new 停用：清 group 绑定不足以真的开新会话', () => {
    const caps = capabilities({ stop: false });
    expect(listLarkCommands(caps).map(item => item.name)).not.toContain('new');
    const route = routeLarkCommand('/new', context({ capabilities: caps }));
    expect(route.kind).toBe('unavailable');
    expect(route.kind === 'unavailable' && route.reason).toContain('stop');
  });

  it('缺少 getSession 时 /status 停用', () => {
    const caps = capabilities({ getSession: false });
    expect(listLarkCommands(caps).map(item => item.name)).not.toContain('status');
    expect(routeLarkCommand('/status', context({ capabilities: caps })).kind).toBe('unavailable');
  });

  it('缺少 dispatch 与 send 时 /retry 停用；只剩 send 时可用', () => {
    expect(routeLarkCommand('/retry', context({ capabilities: capabilities({ dispatch: false, send: false }) })).kind).toBe('unavailable');
    expect(routeLarkCommand('/retry', context({ capabilities: capabilities({ dispatch: false }) })).kind).toBe('intent');
  });

  it('getTasks 缺失不影响任何命令可用性（/status 只是少一个排队口径）', () => {
    const caps = capabilities({ getTasks: false });
    expect(listLarkCommands(caps).map(item => item.name)).toEqual(['help', 'repair', 'status', 'cancel', 'retry', 'new']);
  });

  it('能力全缺时只剩 /help 与 /repair（二者不依赖运行时能力），其余全部 unavailable，绝不产生 intent', () => {
    const none = larkCommandCapabilities({});
    expect(listLarkCommands(none).map(item => item.name)).toEqual(['help', 'repair']);
    for (const text of ['/status', '/cancel', '/stop', '/retry', '/new']) {
      const route = routeLarkCommand(text, context({ capabilities: none }));
      expect(route.kind).toBe('unavailable');
    }
    // /repair 不依赖 runtime：命令层产生 intent，真正的监听门、人类门与二次确认在 coordinator/卡片侧。
    expect(routeLarkCommand('/repair', context({ capabilities: none })).kind).toBe('intent');
    expect(routeLarkCommand('/help', context({ capabilities: none })).kind).toBe('reply');
  });

  it('larkCommandCapabilities 只把函数认作能力', () => {
    const detected = larkCommandCapabilities({
      getSession: () => undefined, send: () => undefined, interrupt: () => undefined,
      cancelQueued: undefined, dispatch: 'not-a-function', stop: null
    });
    expect(detected.getSession).toBe(true);
    expect(detected.send).toBe(true);
    expect(detected.interrupt).toBe(true);
    expect(detected.cancelQueued).toBe(false);
    expect(detected.dispatch).toBe(false);
    expect(detected.stop).toBe(false);
    expect(larkCommandCapabilities(undefined).getSession).toBe(false);
    expect(larkCommandCapabilities(null).send).toBe(false);
  });

  it('resolveLarkCommand 不做能力门控，区分「没这条命令」与「支撑不了」', () => {
    const parsed = parseSlashCommand('/new')!;
    expect(resolveLarkCommand(parsed)?.name).toBe('new');
    expect(isLarkCommandAvailable(resolveLarkCommand(parsed)!, capabilities({ stop: false }))).toBe(false);
    expect(resolveLarkCommand(parseSlashCommand('/nope')!)).toBeUndefined();
  });
});

describe('别名', () => {
  it('/stop 解析到与 /cancel 完全相同的定义对象', () => {
    const viaAlias = resolveLarkCommand(parseSlashCommand('/stop')!);
    const viaName = resolveLarkCommand(parseSlashCommand('/cancel')!);
    expect(viaAlias).toBe(viaName);
    expect(viaAlias?.name).toBe('cancel');
  });

  it('/STOP 大小写不敏感，路由到 cancel intent', () => {
    const route = routeLarkCommand('/STOP', context());
    expect(route.kind).toBe('intent');
    expect(route.kind === 'intent' && route.command).toBe('cancel');
  });

  it('别名在权限门里与本名同权同名', () => {
    expect(authorizeLarkCommandText('/stop', context())).toEqual(authorizeLarkCommandText('/cancel', context()));
  });
});

describe('权限门与路由使用同一个校验器（提权缺口回归）', () => {
  // 这是本模块最重要的结构性测试：任何畸形输入都必须被两条路径「一致地不认」。
  // 若路由认得而权限门不认（或反之），畸形命令就能绕过白名单执行。
  it.each(malformedInputs.map(input => [JSON.stringify(input) ?? String(input), input] as const))(
    '路由与权限门对畸形输入 %s 判定一致',
    (_label, input) => {
      const parsedRecognized = parseSlashCommand(input) !== undefined;
      const routed = routeLarkCommand(input, context());
      const authorized = authorizeLarkCommandText(input, context());
      // 两条路径都不得把它当成一条已注册命令。
      expect(['not_a_command', 'unknown_command']).toContain(routed.kind);
      expect(authorized.recognized).toBe(false);
      // 两条路径对「形状上是否成命令」的看法也必须一致。
      expect(routed.kind === 'unknown_command').toBe(parsedRecognized);
    }
  );

  it('对所有输入（含合法命令），路由与权限门的识别结论恒等', () => {
    const allInputs: unknown[] = [
      ...malformedInputs,
      '/help', '/HELP', '/status', '/cancel', '/stop', '/retry', '/new', '/new extra args',
      '/cwd /tmp/some dir', '/model gpt-5', '/agent codex', '/relay', '/adopt', '/cli'
    ];
    const contexts = [
      context(),
      context({ operator: { kind: 'user', allowlisted: false } }),
      context({ operator: { kind: 'bot', allowlisted: true } }),
      context({ capabilities: larkCommandCapabilities({}) })
    ];
    for (const input of allInputs) {
      for (const ctx of contexts) {
        const routed = routeLarkCommand(input, ctx);
        const authorized = authorizeLarkCommandText(input, ctx);
        const routeRecognized = routed.kind !== 'not_a_command' && routed.kind !== 'unknown_command';
        expect(authorized.recognized).toBe(routeRecognized);
        if (authorized.recognized && routeRecognized) {
          const routedCommand = 'command' in routed ? routed.command : undefined;
          expect(authorized.command).toBe(routedCommand);
          const expectedDecision = routed.kind === 'denied' ? 'denied' : routed.kind === 'unavailable' ? 'unavailable' : 'allowed';
          expect(authorized.decision).toBe(expectedDecision);
        }
      }
    }
  });

  it('evaluateLarkCommand 是两条路径的共同判定源', () => {
    for (const input of ['/foo:bar', '/1cmd', '/help', '/cancel', '/nope']) {
      const verdict = evaluateLarkCommand(input, context()).verdict;
      const authorized = authorizeLarkCommandText(input, context());
      expect(authorized.recognized).toBe(verdict !== 'not_a_command' && verdict !== 'unknown');
    }
  });
});

describe('mutating 命令的白名单门', () => {
  const denied = context({ operator: { kind: 'user', allowlisted: false } });

  it('非白名单操作人执行 mutating 命令得到 denied（具体简体中文文案）', () => {
    for (const text of ['/cancel', '/stop', '/retry', '/new']) {
      const route = routeLarkCommand(text, denied);
      expect(route.kind).toBe('denied');
      if (route.kind !== 'denied') throw new Error('unreachable');
      expect(route.reason).toContain('当前账号不在机器人白名单中');
      expect(route.reason).toMatch(/\/(cancel|retry|new)/);
      expect(route.reason).toContain('管理员');
    }
  });

  it('白名单内操作人执行 mutating 命令得到 intent', () => {
    for (const [text, command] of [['/cancel', 'cancel'], ['/stop', 'cancel'], ['/retry', 'retry'], ['/new', 'new']] as const) {
      const route = routeLarkCommand(text, context());
      expect(route.kind).toBe('intent');
      if (route.kind !== 'intent') throw new Error('unreachable');
      expect(route.command).toBe(command);
      expect(route.definition.mutating).toBe(true);
    }
  });

  it('非 mutating 命令也受白名单约束（与 coordinator 的访问控制一致）', () => {
    expect(routeLarkCommand('/help', denied).kind).toBe('denied');
    expect(routeLarkCommand('/status', denied).kind).toBe('denied');
  });

  it('白名单判定先于能力门：非白名单账号不会被告知运行时缺哪个能力', () => {
    const route = routeLarkCommand('/new', context({
      operator: { kind: 'user', allowlisted: false },
      capabilities: capabilities({ stop: false })
    }));
    expect(route.kind).toBe('denied');
    expect(route.kind === 'denied' && route.reason).not.toContain('stop');
  });

  it('协作机器人不能执行 mutating 命令，但可以读 /status 与 /help', () => {
    const bot = context({ operator: { kind: 'bot', allowlisted: true } });
    for (const text of ['/cancel', '/retry', '/new']) {
      const route = routeLarkCommand(text, bot);
      expect(route.kind).toBe('denied');
      expect(route.kind === 'denied' && route.reason).toContain('协作机器人');
    }
    expect(routeLarkCommand('/status', bot).kind).toBe('intent');
    expect(routeLarkCommand('/help', bot).kind).toBe('reply');
  });

  it('权限门单独回报 mutating 标记，供 coordinator 决定是否解析身份', () => {
    expect(authorizeLarkCommandText('/status', context())).toMatchObject({ recognized: true, mutating: false, decision: 'allowed' });
    expect(authorizeLarkCommandText('/new', context())).toMatchObject({ recognized: true, mutating: true, decision: 'allowed' });
  });
});

describe('/help 渲染', () => {
  it('正文只用 markdown 元素，结构上不含 note 标签（schema 2.0 ErrCode 200861）', () => {
    const help = renderLarkCommandHelp(fullCapabilities, { pageSize: 20 });
    expect(help.elements.length).toBeGreaterThan(0);
    const body = help.elements.filter(element => element.tag === 'markdown');
    expect(body.length).toBe(help.elements.length);
    const serialized = JSON.stringify(help.elements);
    expect(serialized).not.toContain('"note"');
    expect(serialized).not.toMatch(/"tag"\s*:\s*"note"/);
  });

  it('只列出当前可用命令，停用的命令不出现', () => {
    const caps = capabilities({ stop: false, getSession: false });
    const help = renderLarkCommandHelp(caps);
    expect(help.text).toContain('/help');
    expect(help.text).not.toContain('/new');
    expect(help.text).not.toContain('/status');
    expect(help.text).toContain('/cancel');
  });

  it('文案为简体中文，且列出别名与权限提示', () => {
    const help = renderLarkCommandHelp(fullCapabilities, { pageSize: 20 });
    expect(help.text).toContain('Dutydeck 飞书命令');
    expect(help.text).toContain('当前可用');
    expect(help.text).toContain('/stop');
    expect(help.text).toContain('需白名单权限');
    // 简体中文占比检查：确保不是英文界面。
    expect((help.text.match(/[一-龥]/g) ?? []).length).toBeGreaterThan(40);
  });

  it('分页有界：每页只渲染 pageSize 条，页码可越界夹取', () => {
    const first = renderLarkCommandHelp(fullCapabilities, { page: 1, pageSize: 2 });
    expect(first.totalPages).toBe(3);
    expect(first.page).toBe(1);
    expect(first.text).toContain('/help');
    expect(first.text).not.toContain('/retry');

    const last = renderLarkCommandHelp(fullCapabilities, { page: 99, pageSize: 2 });
    expect(last.page).toBe(3);
    const zero = renderLarkCommandHelp(fullCapabilities, { page: 0, pageSize: 2 });
    expect(zero.page).toBe(1);
    const negative = renderLarkCommandHelp(fullCapabilities, { page: -5, pageSize: 0 });
    expect(negative.page).toBe(1);
    expect(negative.totalPages).toBeGreaterThanOrEqual(1);
  });

  it('元素数与字节数远低于飞书 ~24KB / 180 元素上限（递归计数含 column_set 内嵌组件）', () => {
    // 只数 help.elements.length 会漏掉 column_set 里的 column/button/plain_text，恒为个位数；
    // 必须递归统计所有 tag，与 service.ts cardComponents 的口径一致。
    const countTags = (value: unknown): number => {
      if (Array.isArray(value)) return value.reduce((sum, item) => sum + countTags(item), 0);
      if (!value || typeof value !== 'object') return 0;
      const record = value as Record<string, unknown>;
      return (typeof record.tag === 'string' ? 1 : 0)
        + Object.values(record).reduce<number>((sum, item) => sum + countTags(item), 0);
    };
    // allCapabilities（12 条命令全开、pageSize 20 单页）是正文最大的场景，必须一起量。
    for (const caps of [fullCapabilities, allCapabilities]) {
      for (const pageSize of [1, 2, 6, 20]) {
        for (const page of [1, 2, 99]) {
          const help = renderLarkCommandHelp(caps, { page, pageSize });
          expect(countTags(help.elements)).toBeLessThanOrEqual(180);
          expect(Buffer.byteLength(JSON.stringify(help.elements), 'utf8')).toBeLessThan(24 * 1024);
        }
      }
    }
  });

  it('/help 页码参数由路由透传', () => {
    const route = routeLarkCommand('/help 2', context({ helpPageSize: 2 }));
    expect(route.kind).toBe('reply');
    if (route.kind !== 'reply') throw new Error('unreachable');
    expect(route.text).toContain('第 2/3 页');
    for (const element of route.elements.filter(item => item.tag === 'markdown')) {
      expect(element.tag).toBe('markdown');
    }
  });

  it('非数字页码退回第 1 页，不抛异常', () => {
    const route = routeLarkCommand('/help abc', context({ helpPageSize: 2 }));
    expect(route.kind).toBe('reply');
    expect(route.kind === 'reply' && route.text).toContain('第 1/3 页');
  });

  it('没有任何可用命令时给出诚实的空态说明', () => {
    const help = renderLarkCommandHelp({ ...larkCommandCapabilities({}), getSession: false } as LarkCommandCapabilities, {});
    // /help 自身永远可用，因此不会真的空；这里断言渲染仍然成立且只含 markdown。
    expect(help.elements.every(element => element.tag === 'markdown')).toBe(true);
  });
});

describe('未识别命令的透传归一化', () => {
  it('未识别的 /xxx 归一化后不再是命令，无法影子内建命令', () => {
    const route = routeLarkCommand('/relay do something', context());
    expect(route.kind).toBe('unknown_command');
    if (route.kind !== 'unknown_command') throw new Error('unreachable');
    expect(route.promptText).toContain(larkPassthroughMarker);
    expect(route.promptText).toContain('/relay do something');
    // 关键回归：归一化结果再过一次唯一校验器，必须不是命令。
    expect(parseSlashCommand(route.promptText)).toBeUndefined();
  });

  it('把内建命令字面量当普通文本透传后，round-trip 不会被认成内建命令', () => {
    for (const text of ['/help', '/status', '/cancel', '/stop', '/retry', '/new']) {
      const normalized = normalizeLarkPassthroughPrompt(text);
      const reparsed = parseSlashCommand(normalized);
      expect(reparsed).toBeUndefined();
      // 即使再走一遍完整路由，也不会命中任何内建命令。
      const routed = routeLarkCommand(normalized, context());
      expect(routed.kind).toBe('not_a_command');
      expect(authorizeLarkCommandText(normalized, context()).recognized).toBe(false);
    }
  });

  it('归一化是幂等的，不会重复包裹标记', () => {
    const once = normalizeLarkPassthroughPrompt('/relay x');
    const twice = normalizeLarkPassthroughPrompt(once);
    expect(twice).toBe(once);
    expect(once.split(larkPassthroughMarker).length - 1).toBe(1);
  });

  it('Dutydeck 没有的命令一律走透传，不伪造能力', () => {
    for (const text of ['/relay', '/adopt', '/cli', '/cwd /tmp', '/repo x', '/model gpt-5', '/agent codex']) {
      const route = routeLarkCommand(text, context());
      expect(route.kind).toBe('unknown_command');
    }
  });

  it('非命令消息返回 not_a_command，coordinator 按现有流程建任务', () => {
    for (const text of ['帮我修一下构建', 'not /help', '', '   ']) {
      expect(routeLarkCommand(text, context()).kind).toBe('not_a_command');
    }
  });
});

describe('larkCommandEcho 用户参数回显', () => {
  it('折叠空白、去掉控制字符并限长', () => {
    expect(larkCommandEcho('  /tmp/some   dir \n x ')).toBe('/tmp/some dir x');
    expect(larkCommandEcho('a\u0000b\u001fc\u007fd')).toBe('a b c d');
    expect(larkCommandEcho('x'.repeat(200)).length).toBeLessThanOrEqual(120);
    expect(larkCommandEcho('x'.repeat(200))).toMatch(/…$/);
  });

  it('非字符串输入回显为空串', () => {
    expect(larkCommandEcho(undefined)).toBe('');
    expect(larkCommandEcho(123)).toBe('');
    expect(larkCommandEcho({})).toBe('');
  });

  it('limit 被夹到合理范围，不会产生 0 长或超长回显', () => {
    expect(larkCommandEcho('abcdef', 0).length).toBeGreaterThan(0);
    expect(larkCommandEcho('x'.repeat(1_000), 10_000).length).toBeLessThanOrEqual(512);
  });
});

describe('/help 上一页/下一页（S2）', () => {
  /** 取出翻页导航元素与其中的按钮回调 value。 */
  const navigation = (help: ReturnType<typeof renderLarkCommandHelp>) => {
    const nav = help.elements.find(element => element.element_id === 'command_help_navigation');
    const buttons = nav
      ? nav.columns.flatMap((column: any) => column.elements)
          .filter((element: any) => element.tag === 'button')
          .map((button: any) => ({ id: button.element_id, label: button.text.content, value: button.behaviors[0].value }))
      : [];
    return { nav, buttons };
  };

  it('单页时不渲染任何翻页按钮', () => {
    const help = renderLarkCommandHelp(fullCapabilities, { pageSize: 20 });
    expect(help.totalPages).toBe(1);
    expect(navigation(help).nav).toBeUndefined();
    // 只有 /help 一条可用命令时同样单页无按钮。
    const onlyHelp = renderLarkCommandHelp(larkCommandCapabilities({}), { pageSize: 6 });
    expect(onlyHelp.totalPages).toBe(1);
    expect(navigation(onlyHelp).nav).toBeUndefined();
  });

  it('首页只显示下一页，回调 value 形态为 {dutydeck_help_page, page:String(n)}', () => {
    const help = renderLarkCommandHelp(fullCapabilities, { page: 1, pageSize: 2 });
    expect(help.totalPages).toBe(3);
    const { nav, buttons } = navigation(help);
    expect(nav).toBeDefined();
    expect(buttons).toEqual([
      { id: 'command_help_next', label: '下一页', value: { dutydeck_help_page: '1', page: '2' } }
    ]);
  });

  it('末页只显示上一页，指回 totalPages-1', () => {
    const help = renderLarkCommandHelp(fullCapabilities, { page: 3, pageSize: 2 });
    const { buttons } = navigation(help);
    expect(buttons).toEqual([
      { id: 'command_help_prev', label: '上一页', value: { dutydeck_help_page: '1', page: '2' } }
    ]);
  });

  it('中间页同时有上一页与下一页', () => {
    const help = renderLarkCommandHelp(fullCapabilities, { page: 2, pageSize: 2 });
    const { buttons } = navigation(help);
    expect(buttons.map(button => button.id)).toEqual(['command_help_prev', 'command_help_next']);
    expect(buttons.map(button => button.value.page)).toEqual(['1', '3']);
  });

  it('渲染侧越界夹取：超出末页时停在末页且没有下一页', () => {
    const help = renderLarkCommandHelp(fullCapabilities, { page: 99, pageSize: 2 });
    expect(help.page).toBe(3);
    const { buttons } = navigation(help);
    expect(buttons.map(button => button.id)).toEqual(['command_help_prev']);
  });

  it('路由返回的 reply 元素里带可用的翻页回调', () => {
    const route = routeLarkCommand('/help 1', context({ helpPageSize: 2 }));
    if (route.kind !== 'reply') throw new Error('unreachable');
    const values = JSON.stringify(route.elements);
    expect(values).toContain('"dutydeck_help_page"');
    expect(values).toContain('"page":"2"');
  });
});

describe('parseLarkHelpPageValue 宽进严出（S2）', () => {
  it('接受对象与 JSON 字符串，page 接受字符串或数字', () => {
    expect(parseLarkHelpPageValue({ dutydeck_help_page: '1', page: '2' })).toEqual({ page: 2 });
    expect(parseLarkHelpPageValue('{"dutydeck_help_page":"1","page":"3"}')).toEqual({ page: 3 });
    expect(parseLarkHelpPageValue({ dutydeck_help_page: '1', page: 4 })).toEqual({ page: 4 });
    expect(parseLarkHelpPageValue('  {"dutydeck_help_page":"1","page":"5"}  ')).toEqual({ page: 5 });
  });

  it('动作标记不符、非对象形态一律返回 undefined', () => {
    for (const value of [
      { dutydeck_help_page: '2', page: '1' },
      { dutydeck_task_dashboard: 'page', page: 1 },
      {},
      null, undefined, 42, 'abc', '', '   ',
      [], [{ dutydeck_help_page: '1', page: '1' }],
      'not-json', '{broken'
    ]) {
      expect(parseLarkHelpPageValue(value), `${JSON.stringify(value) ?? String(value)} 应被拒绝`).toBeUndefined();
    }
  });

  it('页码非法（空串/小数/0/负数/非数字/非安全整数）返回 undefined', () => {
    for (const page of ['', '   ', 'abc', '1.5', '0', '-1', '-0', 0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseLarkHelpPageValue({ dutydeck_help_page: '1', page }), `page=${String(page)} 应被拒绝`).toBeUndefined();
    }
  });

  it('解析结果可直接喂给 renderLarkCommandHelp 并由渲染侧夹取到合法页', () => {
    const parsed = parseLarkHelpPageValue({ dutydeck_help_page: '1', page: '99' })!;
    expect(parsed).toEqual({ page: 99 });
    const help = renderLarkCommandHelp(fullCapabilities, { page: parsed.page, pageSize: 2 });
    expect(help.page).toBe(3);
  });
});

describe('未知命令「你是不是想用」建议（S3）', () => {
  it('编辑距离 0/1/2 命中，距离 3 不命中', () => {
    expect(suggestLarkCommand('retry', allCapabilities)?.[0]).toBe('retry');
    expect(suggestLarkCommand('retrx', allCapabilities)?.[0]).toBe('retry');
    expect(suggestLarkCommand('retxx', allCapabilities)).toContain('retry');
    expect(suggestLarkCommand('rexxx', allCapabilities)).toBeUndefined();
  });

  it('前缀命中（含编辑距离超过 2 的截断输入），且近距离笔误排在远距离前缀之前', () => {
    // /sch 与 /schedule 距离 5，仅前缀命中；/ci 距离 2，排序在前。
    expect(suggestLarkCommand('sch', allCapabilities)).toEqual(['ci', 'schedule']);
    // /ta 与 /tasks 距离 3，仅前缀命中；/ci 距离 2 仍排在前。
    expect(suggestLarkCommand('ta', allCapabilities)).toEqual(['ci', 'tasks']);
  });

  it('多候选按编辑距离升序排序并限制为 3 条', () => {
    // /re：ci/new 距离 2（字典序 tie-break），retry 距离 3、reject 距离 4 被截断。
    expect(suggestLarkCommand('re', allCapabilities)).toEqual(['ci', 'new', 'retry']);
  });

  it('别名作为候选，且每条命令只留最接近的一个 token', () => {
    expect(suggestLarkCommand('stpo', allCapabilities)).toEqual(['stop']);
    const tokens = suggestLarkCommand('stopp', allCapabilities)!;
    expect(tokens).toContain('stop');
    expect(tokens).not.toContain('cancel');
  });

  it('无候选返回 undefined', () => {
    expect(suggestLarkCommand('zzzzz', allCapabilities)).toBeUndefined();
    expect(suggestLarkCommand('qqqq', allCapabilities)).toBeUndefined();
  });

  it('路径串与非命令形态不误报（防御性边界，直接调用也安全）', () => {
    for (const name of ['/usr/bin/bash', 'usr/bin/bash', './a/b', '~/foo/bar', '/tmp/x', '', '   ', 'a b', '命令']) {
      expect(suggestLarkCommand(name, allCapabilities), name).toBeUndefined();
    }
  });

  it('只提示当前可用命令：unavailable 命令不进入候选', () => {
    // /statu 距离 /status 为 1；getSession 缺失时 /status 停用，不得提示。
    expect(suggestLarkCommand('statu', capabilities({ getSession: false }))).toBeUndefined();
    expect(suggestLarkCommand('statu', fullCapabilities)).toEqual(['status']);
    // /approev 距离 /approve 为 2；approval 能力缺失时不提示。
    expect(suggestLarkCommand('approev', allCapabilities)).toContain('approve');
    expect(suggestLarkCommand('approev', capabilities({ approval: false }))).toBeUndefined();
    // 可选能力全缺时 work/schedule/ci/tasks 都不提示。
    expect(suggestLarkCommand('wrk', fullCapabilities)).toBeUndefined();
    expect(suggestLarkCommand('wrk', allCapabilities)).toEqual(['work']);
  });

  it('路由层：未知命令带 suggestion 文案，但 promptText 原样透传不被污染', () => {
    const route = routeLarkCommand('/statu', context());
    expect(route.kind).toBe('unknown_command');
    if (route.kind !== 'unknown_command') throw new Error('unreachable');
    expect(route.suggestion).toBe('你是不是想用 `/status`？');
    expect(route.promptText).toContain('/statu');
    expect(route.promptText).not.toContain('你是不是想用');
    // 归一化后的透传文本再过一次解析器仍不是命令。
    expect(parseSlashCommand(route.promptText)).toBeUndefined();
  });

  it('路由层：多候选文案用「或」连接；参数原样保留在透传文本中', () => {
    const route = routeLarkCommand('/sch now', context({ capabilities: allCapabilities }));
    if (route.kind !== 'unknown_command') throw new Error('unreachable');
    expect(route.suggestion).toBe('你是不是想用 `/ci` 或 `/schedule`？');
    expect(route.promptText).toContain('/sch now');
  });

  it('路由层：无候选、多段路径、普通消息均不产出 suggestion；单段路径只提示不改写', () => {
    for (const text of ['/zzzzz', '/usr/bin/bash', './a/b', '~/foo/bar', '帮我跑一下测试', '']) {
      const route = routeLarkCommand(text, context({ capabilities: allCapabilities }));
      if (route.kind === 'unknown_command') expect(route.suggestion).toBeUndefined();
      else expect(route.kind).toBe('not_a_command');
    }
    // 单段路径与命令形状无法区分（parseSlashCommand 既有语义）：可能给出提示，
    // 但仍然是 unknown_command 且原文透传。
    const singleSegment = routeLarkCommand('/tmp', context({ capabilities: allCapabilities }));
    expect(singleSegment.kind).toBe('unknown_command');
    if (singleSegment.kind === 'unknown_command') {
      expect(singleSegment.promptText).toContain('/tmp');
      expect(parseSlashCommand(singleSegment.promptText)).toBeUndefined();
    }
  });

  it('路由层：unavailable 命令本身走 unavailable 回执，不产出建议', () => {
    const route = routeLarkCommand('/status', context({ capabilities: capabilities({ getSession: false }) }));
    expect(route.kind).toBe('unavailable');
  });
});
