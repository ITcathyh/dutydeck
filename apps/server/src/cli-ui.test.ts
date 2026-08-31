import { describe, expect, it } from 'vitest';
import { createCliUi, shouldUseColor, symbolFor, type CliUiOptions, type StatusLevel } from './cli-ui.js';

/** CSI 前缀。用转义写法，避免源码里出现裸控制字符。 */
const ANSI = '\u001b[';
const LEVELS: StatusLevel[] = ['ok', 'done', 'warn', 'fail', 'info', 'skip', 'pending'];

/** 累积字符串的假 target：测试永远不碰真实 process.stdout / stderr。 */
const fakeTarget = (isTTY?: boolean) => {
  let buffer = '';
  return {
    isTTY,
    write(chunk: string) { buffer += chunk; },
    text: () => buffer
  };
};

/** 构造 ui + 两个假流；env 默认为空对象，避免测试进程的真实 env 泄漏进来。 */
const harness = (options: Omit<CliUiOptions, 'stdout' | 'stderr'> = {}) => {
  const stdout = fakeTarget(options.tty);
  const stderr = fakeTarget(options.tty);
  const ui = createCliUi({ env: {}, ...options, stdout, stderr });
  return { ui, stdout, stderr };
};

/** 把每个公开方法都调一次，用于「整份输出里不该出现 X」这类全局断言。 */
const exerciseEverything = (ui: ReturnType<typeof harness>['ui']) => {
  ui.section('环境检查');
  ui.status('ok', 'Node 版本', 'v22.3.0');
  ui.status('fail', '缺少配置');
  ui.line('普通行');
  ui.line();
  ui.hint('可以这样修');
  ui.command('dockmux setup');
  ui.keyValues([['host', '127.0.0.1'], ['port', '4300']]);
  ui.summary('接下来', [{ text: '启动服务', command: 'dockmux start' }]);
  ui.json({ ok: true });
  ui.progress('正在安装依赖');
  ui.notice('端口被占用');
};

describe('createCliUi 的流分工', () => {
  it('结果走 stdout，进度与提示走 stderr', () => {
    const { ui, stdout, stderr } = harness();
    exerciseEverything(ui);

    const out = stdout.text();
    for (const fragment of ['环境检查', 'Node 版本', '缺少配置', '普通行', '可以这样修', '$ dockmux setup', 'host', '接下来', '启动服务', '{"ok":true}']) {
      expect(out).toContain(fragment);
    }

    const err = stderr.text();
    expect(err).toContain('正在安装依赖');
    expect(err).toContain('端口被占用');
  });

  it('进度文本绝不污染 stdout —— `dockmux doctor | head -1` 靠这一条', () => {
    const { ui, stdout, stderr } = harness();
    ui.progress('正在探测 acpx');
    ui.notice('注意这个');
    expect(stdout.text()).toBe('');

    ui.status('ok', '一切正常');
    expect(stdout.text()).toBe(`${symbolFor('ok')} 一切正常\n`);
    expect(stdout.text()).not.toContain('正在探测 acpx');
    expect(stdout.text()).not.toContain('注意这个');
    expect(stderr.text()).not.toContain('一切正常');
  });

  it('progress 用 pending 符号、notice 用 warn 符号，各自独占一行', () => {
    const { ui, stderr } = harness();
    ui.progress('第一步');
    ui.progress('第二步');
    ui.notice('小心');
    expect(stderr.text()).toBe(`${symbolFor('pending')} 第一步\n${symbolFor('pending')} 第二步\n${symbolFor('warn')} 小心\n`);
  });
});

describe('shouldUseColor 的优先级', () => {
  it('FORCE_COLOR 压过 NO_COLOR', () => {
    expect(shouldUseColor({ FORCE_COLOR: '1', NO_COLOR: '1' }, false)).toBe(true);
    expect(shouldUseColor({ FORCE_COLOR: 'true', NO_COLOR: '1', TERM: 'dumb' }, false)).toBe(true);
  });

  it('FORCE_COLOR 为空或 0 时不算强制开启', () => {
    expect(shouldUseColor({ FORCE_COLOR: '' }, false)).toBe(false);
    expect(shouldUseColor({ FORCE_COLOR: '0' }, true)).toBe(true); // 退回 isTTY
    expect(shouldUseColor({ FORCE_COLOR: '0', NO_COLOR: '1' }, true)).toBe(false);
  });

  it('NO_COLOR 为空字符串不禁用颜色', () => {
    expect(shouldUseColor({ NO_COLOR: '' }, true)).toBe(true);
    expect(shouldUseColor({ NO_COLOR: '' }, false)).toBe(false);
  });

  it('NO_COLOR=0 依然禁用 —— 按 no-color.org，看的是「存在」而不是值', () => {
    expect(shouldUseColor({ NO_COLOR: '0' }, true)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: 'false' }, true)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: '1' }, true)).toBe(false);
  });

  it('TERM=dumb 禁用颜色', () => {
    expect(shouldUseColor({ TERM: 'dumb' }, true)).toBe(false);
    expect(shouldUseColor({ TERM: 'xterm-256color' }, true)).toBe(true);
  });

  it('没有任何环境变量时以 isTTY 为准', () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
  });
});

describe('无颜色输出', () => {
  it('NO_COLOR 下整份输出没有一个 ANSI 序列', () => {
    const { ui, stdout, stderr } = harness({ env: { NO_COLOR: '1' }, tty: true });
    expect(ui.color).toBe(false);
    exerciseEverything(ui);
    expect(stdout.text()).not.toContain(ANSI);
    expect(stderr.text()).not.toContain(ANSI);
  });

  it('非 TTY 下整份输出没有一个 ANSI 序列', () => {
    const { ui, stdout, stderr } = harness();
    expect(ui.color).toBe(false);
    expect(ui.tty).toBe(false);
    exerciseEverything(ui);
    expect(stdout.text()).not.toContain(ANSI);
    expect(stderr.text()).not.toContain(ANSI);
  });

  it('tty 由注入的 stderr.isTTY 推断，也可被显式覆盖', () => {
    const stdout = fakeTarget(false);
    const stderr = fakeTarget(true);
    expect(createCliUi({ stdout, stderr, env: {} }).tty).toBe(true);
    expect(createCliUi({ stdout, stderr, env: {} }).color).toBe(true);
    expect(createCliUi({ stdout, stderr, env: {}, tty: false }).tty).toBe(false);
    expect(createCliUi({ stdout, stderr, env: {}, color: false }).color).toBe(false);
  });
});

describe('有颜色输出', () => {
  it('color: true 时状态符号被上色并以 reset 收尾', () => {
    const { ui, stdout } = harness({ color: true });
    ui.status('ok', '已配置');
    ui.status('fail', '失败了');
    expect(stdout.text()).toBe(`${ANSI}32m${symbolFor('ok')}${ANSI}0m 已配置\n${ANSI}31m${symbolFor('fail')}${ANSI}0m 失败了\n`);
  });

  it('section / hint / command / summary 也各自带 reset', () => {
    const { ui, stdout } = harness({ color: true });
    ui.section('标题');
    ui.hint('提示');
    ui.command('dockmux doctor');
    ui.summary('接下来', [{ text: '一步', command: 'dockmux start' }]);
    const out = stdout.text();
    expect(out).toContain(`${ANSI}1m标题${ANSI}0m`);
    expect(out).toContain(`${ANSI}90m提示${ANSI}0m`);
    expect(out).toContain(`${ANSI}36m$ dockmux doctor${ANSI}0m`);
    expect(out).toContain(`${ANSI}36m$ dockmux start${ANSI}0m`);
    // 每段上色都自己收尾：CSI 总数正好是 reset 数的两倍（一开一闭）。
    const resets = out.split(`${ANSI}0m`).length - 1;
    const sequences = out.split(ANSI).length - 1;
    expect(sequences).toBe(resets * 2);
  });

  it('progress / notice 在有颜色时也上色，但仍然只在 stderr', () => {
    const { ui, stdout, stderr } = harness({ color: true });
    ui.progress('跑着呢');
    ui.notice('留神');
    expect(stderr.text()).toBe(`${ANSI}90m${symbolFor('pending')}${ANSI}0m 跑着呢\n${ANSI}33m${symbolFor('warn')}${ANSI}0m 留神\n`);
    expect(stdout.text()).toBe('');
  });
});

describe('刻意没有 spinner', () => {
  for (const [name, options] of [['非 TTY', { tty: false }], ['TTY + 颜色', { tty: true, color: true }]] as const) {
    it(`${name} 下都不出现回车覆盖或清行控制符`, () => {
      const { ui, stdout, stderr } = harness(options);
      exerciseEverything(ui);
      ui.progress('第二次进度');
      ui.progress('第三次进度');
      for (const text of [stdout.text(), stderr.text()]) {
        expect(text).not.toContain('\r');
        expect(text).not.toContain('2K'); // \x1b[2K 清行
        expect(text).not.toContain('1K');
        expect(text).not.toContain(`${ANSI}?25`); // 隐藏/显示光标
        expect(text).not.toMatch(/\u001b\[\d*[ABCDGJK]/); // 光标移动 / 擦除
      }
      // 两次 progress 就是两行，不是两次覆盖同一行。
      expect(stderr.text().split('\n').filter(line => line.includes('进度')).length).toBe(2);
    });
  }
});

describe('symbolFor', () => {
  it('ok（本来就满足）与 done（这次做了变更）是不同的符号', () => {
    expect(symbolFor('ok')).not.toBe(symbolFor('done'));
  });

  it('每个等级都有唯一符号', () => {
    const symbols = LEVELS.map(symbolFor);
    expect(new Set(symbols).size).toBe(LEVELS.length);
  });

  it('每个符号都是单个窄字形、非 emoji（否则列对齐会崩）', () => {
    for (const level of LEVELS) {
      const symbol = symbolFor(level);
      expect([...symbol]).toHaveLength(1);
      expect(symbol).not.toMatch(/\p{Emoji_Presentation}/u);
      expect(symbol).not.toContain('️'); // emoji 变体选择符
      expect(symbol).not.toContain('‍'); // ZWJ 组合
    }
  });
});

describe('json', () => {
  it('输出单行可解析 JSON', () => {
    const { ui, stdout } = harness();
    ui.json({ status: 'ok', checks: [{ name: 'acpx', ok: true }] });
    const raw = stdout.text();
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(raw)).toEqual({ status: 'ok', checks: [{ name: 'acpx', ok: true }] });
  });

  it('即使开了颜色也绝不掺 ANSI —— jq 要能直接吃', () => {
    const { ui, stdout, stderr } = harness({ color: true, tty: true });
    ui.json({ 中文: '值' });
    expect(stdout.text()).not.toContain(ANSI);
    expect(JSON.parse(stdout.text())).toEqual({ 中文: '值' });
    expect(stderr.text()).toBe('');
  });
});

describe('排版细节', () => {
  it('首个 section 不带前导空行，后续 section 带', () => {
    const { ui, stdout } = harness();
    ui.section('第一节');
    expect(stdout.text()).toBe('第一节\n');
    ui.section('第二节');
    expect(stdout.text()).toBe('第一节\n\n第二节\n');
    ui.section('第三节');
    expect(stdout.text()).toBe('第一节\n\n第二节\n\n第三节\n');
  });

  it('section 计数是每个 ui 实例独立的', () => {
    const first = harness();
    first.ui.section('A');
    const second = harness();
    second.ui.section('B');
    expect(second.stdout.text()).toBe('B\n');
  });

  it('keyValues 用 padEnd 对齐键', () => {
    const { ui, stdout } = harness();
    ui.keyValues([['a', '1'], ['longer', '2']]);
    expect(stdout.text()).toBe('  a       1\n  longer  2\n');
  });

  it('keyValues 空数组什么都不写', () => {
    const { ui, stdout } = harness();
    ui.keyValues([]);
    expect(stdout.text()).toBe('');
  });

  it('summary 给条目编号，并把命令单独缩进一行', () => {
    const { ui, stdout } = harness();
    ui.summary('接下来做什么', [
      { text: '打开面板' },
      { text: '跑一次自检', command: 'dockmux doctor' }
    ]);
    expect(stdout.text()).toBe('\n接下来做什么\n  1. 打开面板\n  2. 跑一次自检\n     $ dockmux doctor\n');
  });

  it('status 的 detail 渲染在括号里，没有 detail 就不留括号', () => {
    const { ui, stdout } = harness();
    ui.status('warn', '版本偏旧', 'v18.0.0');
    ui.status('skip', '跳过');
    expect(stdout.text()).toBe(`${symbolFor('warn')} 版本偏旧 (v18.0.0)\n${symbolFor('skip')} 跳过\n`);
  });

  it('line 不带参数时输出一个空行', () => {
    const { ui, stdout } = harness();
    ui.line();
    ui.line('文本');
    expect(stdout.text()).toBe('\n文本\n');
  });
});
