import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { CliUi } from '../cli-ui.js';
import { PromptAbortedError, PromptUnavailableError, createPrompter } from './prompts.js';

/** 只有 notice 会被 prompts 用到，其余成员为满足 CliUi 类型而存在。 */
const fakeUi = () => ({
  color: false,
  tty: false,
  line: vi.fn(),
  section: vi.fn(),
  status: vi.fn(),
  hint: vi.fn(),
  command: vi.fn(),
  keyValues: vi.fn(),
  summary: vi.fn(),
  json: vi.fn(),
  progress: vi.fn(),
  notice: vi.fn()
});

/** 采集 output 的假可写流；prompts 只调用 write。 */
const fakeOutput = () => {
  let buffer = '';
  const stream = { write(chunk: string) { buffer += chunk; return true; } };
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => buffer };
};

const build = (config: { interactive: boolean; assumeYes?: boolean; closedInput?: boolean }) => {
  const ui = fakeUi();
  const input = new PassThrough();
  if (config.closedInput) input.end();
  const output = fakeOutput();
  const prompter = createPrompter({
    ui: ui as unknown as CliUi,
    interactive: config.interactive,
    assumeYes: config.assumeYes,
    io: { input, output: output.stream }
  });
  return { ui, input, output, prompter };
};

const trimValidator = (raw: string) => {
  if (raw.trim() === '') throw new Error('不能为空。');
  return raw.trim();
};

describe('ask 的非交互路径', () => {
  it('有默认值时直接返回默认值，且不读 stdin', async () => {
    const { prompter, input, output } = build({ interactive: false });
    input.write('从来不该被读到\n');

    await expect(prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/tmp/project', validate: trimValidator })).resolves.toBe('/tmp/project');
    // 没有写过提示语 == 没有走 readLine。
    expect(output.text()).toBe('');
    expect(input.readableLength).toBeGreaterThan(0);
    prompter.close();
  });

  it('默认值同样经过 validator —— flag 路径与交互路径共用一套校验', async () => {
    const { prompter } = build({ interactive: false });
    const validate = vi.fn((raw: string) => `规整:${raw.trim()}`);

    await expect(prompter.ask({ question: '端口', remedyFlag: '--port <端口>', defaultValue: '  4300  ', validate })).resolves.toBe('规整:4300');
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith('  4300  ');
    prompter.close();
  });

  it('validator 抛错时错误直接冒泡，不会被静默吞掉', async () => {
    const { prompter, ui } = build({ interactive: false });
    await expect(prompter.ask({ question: '端口', remedyFlag: '--port <端口>', defaultValue: 'abc', validate: () => { throw new Error('端口必须是数字。'); } }))
      .rejects.toThrow('端口必须是数字。');
    expect(ui.notice).not.toHaveBeenCalled();
    prompter.close();
  });

  it('没有默认值时抛 PromptUnavailableError，并在消息里点名该加哪个 flag', async () => {
    const { prompter } = build({ interactive: false });
    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', validate: trimValidator });

    await expect(promise).rejects.toBeInstanceOf(PromptUnavailableError);
    const error = await promise.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(PromptUnavailableError);
    const unavailable = error as PromptUnavailableError;
    expect(unavailable.remedyFlag).toBe('--cwd <目录>');
    expect(unavailable.message).toContain('--cwd <目录>');
    expect(unavailable.message).toContain('工作目录');
    expect(unavailable.message).toContain('--yes');
    expect(unavailable.code).toBe('SETUP_INPUT_REQUIRED');
    prompter.close();
  });

  it('assumeYes 在可交互环境下也走默认值分支', async () => {
    const { prompter, output } = build({ interactive: true, assumeYes: true });
    await expect(prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/srv', validate: trimValidator })).resolves.toBe('/srv');
    expect(output.text()).toBe('');
    await expect(prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', validate: trimValidator })).rejects.toBeInstanceOf(PromptUnavailableError);
    prompter.close();
  });

  it('interactive 标记原样暴露', () => {
    expect(build({ interactive: false }).prompter.interactive).toBe(false);
    expect(build({ interactive: true }).prompter.interactive).toBe(true);
  });
});

describe('ask 的交互路径', () => {
  it('读到一行就交给 validator', async () => {
    const { prompter, input, output } = build({ interactive: true });
    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', validate: trimValidator });
    input.write('  /srv/dock  \n');

    await expect(promise).resolves.toBe('/srv/dock');
    expect(output.text()).toBe('工作目录: ');
    prompter.close();
  });

  it('提示语带上默认值，defaultLabel 优先于默认值本身', async () => {
    const { prompter, input, output } = build({ interactive: true });
    const first = prompter.ask({ question: '端口', remedyFlag: '--port <端口>', defaultValue: '4300', validate: trimValidator });
    input.write('4400\n');
    await expect(first).resolves.toBe('4400');
    expect(output.text()).toBe('端口 [4300]: ');

    const second = prompter.ask({ question: '模式', remedyFlag: '--mode <模式>', defaultValue: 'acpx', defaultLabel: '推荐：acpx', validate: trimValidator });
    input.write('pty\n');
    await expect(second).resolves.toBe('pty');
    expect(output.text()).toContain('模式 [推荐：acpx]: ');
    prompter.close();
  });

  it('直接回车（空输入）取默认值', async () => {
    const { prompter, input } = build({ interactive: true });
    const validate = vi.fn(trimValidator);
    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/tmp/default', validate });
    input.write('\n');

    await expect(promise).resolves.toBe('/tmp/default');
    expect(validate).toHaveBeenCalledWith('/tmp/default');
    prompter.close();
  });

  it('只输入空格也算空输入', async () => {
    const { prompter, input } = build({ interactive: true });
    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/tmp/default', validate: trimValidator });
    input.write('    \n');
    await expect(promise).resolves.toBe('/tmp/default');
    prompter.close();
  });

  it('stdin 已关闭（EOF）时取默认值，而不是无限重问', async () => {
    const { prompter } = build({ interactive: true, closedInput: true });
    await expect(prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/tmp/eof', validate: trimValidator })).resolves.toBe('/tmp/eof');
    prompter.close();
  });

  it('stdin 已关闭且没有默认值时抛 PromptUnavailableError', async () => {
    const { prompter, ui } = build({ interactive: true, closedInput: true });
    await expect(prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', validate: trimValidator })).rejects.toBeInstanceOf(PromptUnavailableError);
    expect(ui.notice).not.toHaveBeenCalled();
    prompter.close();
  });

  it('读到一半 stdin 关闭时同样退化到默认值', async () => {
    const { prompter, input } = build({ interactive: true });
    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/tmp/late-eof', validate: trimValidator });
    input.end();
    await expect(promise).resolves.toBe('/tmp/late-eof');
    prompter.close();
  });

  it('EOF 之后的第二次提问不会挂住 —— readline 的 close 只会触发一次', async () => {
    // 回归测试：管道场景下第一问吃掉 EOF，若不记住「已耗尽」，第二问会永久等待
    // 一个再也不会到来的 close 事件。
    const { prompter } = build({ interactive: true, closedInput: true });
    await expect(prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/tmp/first', validate: trimValidator })).resolves.toBe('/tmp/first');
    await expect(prompter.ask({ question: '端口', remedyFlag: '--port <端口>', defaultValue: '4310', validate: trimValidator })).resolves.toBe('4310');
    await expect(prompter.ask({ question: '应用 ID', remedyFlag: '--lark-app-id <cli_xxx>', validate: trimValidator })).rejects.toBeInstanceOf(PromptUnavailableError);
    // confirm 同理：非危险动作退化到 defaultValue，而不是悬停。
    await expect(prompter.confirm({ question: '继续？', defaultValue: true })).resolves.toBe(true);
    prompter.close();
  });

  it('输入无效时通过 ui.notice 报出中文原因并重问，随后接受有效答案', async () => {
    const { prompter, input, ui } = build({ interactive: true });
    // 保留 setImmediate 版本作为「异步补输入」的常规路径；同步补输入另有专门用例。
    ui.notice.mockImplementation(() => { setImmediate(() => input.write('/srv/ok\n')); });
    const validate = vi.fn((raw: string) => {
      if (!raw.startsWith('/')) throw new Error('目录必须是绝对路径。');
      return raw;
    });

    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', validate });
    input.write('relative/path\n');

    await expect(promise).resolves.toBe('/srv/ok');
    expect(ui.notice).toHaveBeenCalledTimes(1);
    expect(ui.notice).toHaveBeenCalledWith('目录必须是绝对路径。');
    expect(validate).toHaveBeenCalledTimes(2);
    prompter.close();
  });

  it('重问的输入即使在监听器挂上之前就到达也不会丢', async () => {
    // 回归防线：readLine 曾经每次提问才挂 line 监听器，两问之间没有监听器，落在
    // 这个窗口里的行会被直接丢弃——于是重问类用例只能靠 setImmediate 把补输入推迟到
    // 下一轮。改成常驻监听 + 缓冲后，同步补输入也必须能被下一轮取到。
    //
    // 先发起 ask、await 一个微任务、再写输入：这样「输入何时到达」不再影响用例结果。
    // 之所以这么排：本例与下一例曾在全量 suite 下偶发 15s 超时，而在隔离运行时
    // 无法复现（约 15 次全绿），根因至今未确认——多次探测（真实 createPrompter，
    // 600 次迭代）在未变异模块上 0 失败，同一探测对「关掉缓冲消费」的变异体却
    // 100% 复现，说明探测有效而竞态不在这一层。所以这个排序是为了确定性，
    // 不是因为已证实存在时序竞态。
    const { prompter, input, ui } = build({ interactive: true });
    ui.notice.mockImplementation(() => { input.write('/srv/sync\n'); });

    const promise = prompter.ask({
      question: '工作目录',
      remedyFlag: '--cwd <目录>',
      validate: (raw: string) => {
        if (!raw.startsWith('/')) throw new Error('目录必须是绝对路径。');
        return raw;
      }
    });
    await Promise.resolve();          // 让 readLine 跑完并挂好等待者
    input.write('relative/path\n');   // 触发校验失败 -> notice 同步补下一行

    await expect(promise).resolves.toBe('/srv/sync');
    expect(ui.notice).toHaveBeenCalledTimes(1);
    prompter.close();
  });

  it('一次到达的多行按顺序分配给连续的提问', async () => {
    // 管道场景：`printf 'a\\nb\\n' | dockmux setup` 会让两行几乎同时到达。
    // 第二行必须排队进 bufferedLines 等第二问，而不是因为「当前没人在等」被丢掉。
    // 关掉 bufferedLines 的消费，本例必然失败——这是它守护的性质。
    // 排序理由同上：为确定性，与是否存在时序竞态无关。
    const { prompter, input } = build({ interactive: true });

    const firstPromise = prompter.ask({ question: '第一个目录', remedyFlag: '--cwd <目录>', validate: trimValidator });
    await Promise.resolve();
    input.write('/first\n/second\n');

    const first = await firstPromise;
    // 第二问必须由缓冲直接满足，不需要任何新输入。
    const second = await prompter.ask({ question: '第二个目录', remedyFlag: '--cwd <目录>', validate: trimValidator });

    expect([first, second]).toEqual(['/first', '/second']);
    prompter.close();
  });

  it('提问进行中被 close 时退化到默认值，而不是悬停', async () => {
    const { prompter } = build({ interactive: true });
    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', defaultValue: '/fallback', validate: trimValidator });
    prompter.close();
    await expect(promise).resolves.toBe('/fallback');
  });

  it('非 Error 的抛出物也会被转成字符串提示', async () => {
    const { prompter, input, ui } = build({ interactive: true });
    ui.notice.mockImplementation(() => { setImmediate(() => input.write('ok\n')); });
    const promise = prompter.ask({
      question: '随便问问',
      remedyFlag: '--whatever',
      validate: (raw: string) => { if (raw !== 'ok') throw '就是不行'; return raw; }
    });
    input.write('nope\n');

    await expect(promise).resolves.toBe('ok');
    expect(ui.notice).toHaveBeenCalledWith('就是不行');
    prompter.close();
  });

  it('连续 3 次无效后抛 PromptAbortedError —— 绝不把人困在循环里', async () => {
    const { prompter, input, ui } = build({ interactive: true });
    let fed = 1;
    ui.notice.mockImplementation(() => { fed += 1; setImmediate(() => input.write(`bad-${fed}\n`)); });
    const validate = vi.fn(() => { throw new Error('还是不行。'); });

    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', validate });
    input.write('bad-1\n');

    await expect(promise).rejects.toBeInstanceOf(PromptAbortedError);
    await expect(promise).rejects.toThrow('连续输入无效，已放弃，未写入任何配置。');
    expect(validate).toHaveBeenCalledTimes(3);
    expect(ui.notice).toHaveBeenCalledTimes(3);
    prompter.close();
  });

  it('PromptAbortedError 默认消息与 code 稳定', () => {
    const error = new PromptAbortedError();
    expect(error.code).toBe('SETUP_ABORTED');
    expect(error.message).toBe('已取消，未写入任何配置。');
  });
});

describe('choose', () => {
  const choices = [
    { value: 'acpx', label: 'ACPX 适配器', detail: '推荐' },
    { value: 'pty', label: 'PTY 直连' },
    { value: 'mock', label: '假后端' }
  ];

  it('非交互也渲染编号列表，采用 defaultIndex 并说明用哪个 flag 可显式指定', async () => {
    const { prompter, output } = build({ interactive: false });
    await expect(prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices, defaultIndex: 1 })).resolves.toBe('pty');

    const rendered = output.text();
    expect(rendered).toContain('选择后端\n');
    expect(rendered).toContain('    1) ACPX 适配器 — 推荐\n');
    expect(rendered).toContain('  * 2) PTY 直连\n');
    expect(rendered).toContain('    3) 假后端\n');
    expect(rendered).toContain('非交互模式，采用默认：PTY 直连');
    expect(rendered).toContain('--backend <名称>');
    prompter.close();
  });

  it('省略 defaultIndex 时非交互取第一项', async () => {
    const { prompter, output } = build({ interactive: false });
    await expect(prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices })).resolves.toBe('acpx');
    expect(output.text()).toContain('  * 1) ACPX 适配器 — 推荐\n');
    prompter.close();
  });

  it('交互模式也渲染同一份编号列表，并解析输入的编号', async () => {
    const { prompter, input, output } = build({ interactive: true });
    const promise = prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices, defaultIndex: 0 });
    input.write('3\n');

    await expect(promise).resolves.toBe('mock');
    const rendered = output.text();
    expect(rendered).toContain('选择后端\n');
    expect(rendered).toContain('  * 1) ACPX 适配器 — 推荐\n');
    expect(rendered).toContain('    2) PTY 直连\n');
    expect(rendered).toContain('    3) 假后端\n');
    expect(rendered).toContain('请选择编号 [1]: ');
    prompter.close();
  });

  it('超出范围的编号被拒绝并给出中文提示，随后接受有效编号', async () => {
    const { prompter, input, ui } = build({ interactive: true });
    ui.notice.mockImplementation(() => { setImmediate(() => input.write('2\n')); });

    const promise = prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices, defaultIndex: 0 });
    input.write('9\n');

    await expect(promise).resolves.toBe('pty');
    expect(ui.notice).toHaveBeenCalledWith('请输入 1-3 之间的编号。');
    prompter.close();
  });

  it('0 与负数同样被拒绝', async () => {
    const { prompter, input, ui } = build({ interactive: true });
    ui.notice.mockImplementation(() => { setImmediate(() => input.write('1\n')); });

    const promise = prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices, defaultIndex: 0 });
    input.write('0\n');

    await expect(promise).resolves.toBe('acpx');
    expect(ui.notice).toHaveBeenCalledWith('请输入 1-3 之间的编号。');
    prompter.close();
  });

  it('非数字输入被拒绝并给出中文提示', async () => {
    const { prompter, input, ui } = build({ interactive: true });
    ui.notice.mockImplementation(() => { setImmediate(() => input.write('1\n')); });

    const promise = prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices, defaultIndex: 0 });
    input.write('acpx\n');

    await expect(promise).resolves.toBe('acpx');
    expect(ui.notice).toHaveBeenCalledWith('请输入 1-3 之间的编号。');
    prompter.close();
  });

  it('连续输入无效编号最终抛 PromptAbortedError', async () => {
    const { prompter, input, ui } = build({ interactive: true });
    ui.notice.mockImplementation(() => { setImmediate(() => input.write('99\n')); });

    const promise = prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices, defaultIndex: 0 });
    input.write('99\n');

    await expect(promise).rejects.toBeInstanceOf(PromptAbortedError);
    expect(ui.notice).toHaveBeenCalledTimes(3);
    prompter.close();
  });

  it('空选项列表直接报错', async () => {
    const { prompter } = build({ interactive: true });
    await expect(prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices: [] })).rejects.toThrow('「选择后端」没有可选项。');
    prompter.close();
  });

  it('stdin 关闭时交互 choose 退化到默认项的编号', async () => {
    const { prompter } = build({ interactive: true, closedInput: true });
    // EOF 走 ask 的默认值分支；defaultValue 是编号 1 对应的值。
    await expect(prompter.choose({ question: '选择后端', remedyFlag: '--backend <名称>', choices: [{ value: 1, label: '一' }, { value: 2, label: '二' }], defaultIndex: 0 })).resolves.toBe(1);
    prompter.close();
  });
});

describe('confirm', () => {
  it('assumeYes 无条件返回 true，且不读输入', async () => {
    const { prompter, input, output } = build({ interactive: true, assumeYes: true });
    input.write('n\n');
    await expect(prompter.confirm({ question: '要覆盖配置吗？' })).resolves.toBe(true);
    await expect(prompter.confirm({ question: '真的要删除吗？', dangerous: true })).resolves.toBe(true);
    await expect(prompter.confirm({ question: '继续？', dangerous: true, defaultValue: false })).resolves.toBe(true);
    expect(output.text()).toBe('');
    expect(input.readableLength).toBeGreaterThan(0);
    prompter.close();
  });

  it('非交互 + dangerous 一律 fail closed，即使默认值为 true', async () => {
    const { prompter, output } = build({ interactive: false });
    await expect(prompter.confirm({ question: '删除现有配置？', dangerous: true, defaultValue: true })).resolves.toBe(false);
    await expect(prompter.confirm({ question: '删除现有配置？', dangerous: true })).resolves.toBe(false);
    expect(output.text()).toBe('');
    prompter.close();
  });

  it('非交互 + 非危险动作返回 defaultValue', async () => {
    const { prompter } = build({ interactive: false });
    await expect(prompter.confirm({ question: '写入配置？', defaultValue: true })).resolves.toBe(true);
    await expect(prompter.confirm({ question: '写入配置？', defaultValue: false })).resolves.toBe(false);
    await expect(prompter.confirm({ question: '写入配置？' })).resolves.toBe(false);
    prompter.close();
  });

  it('交互模式大小写无关地解析 y/yes/n/no', async () => {
    const { prompter, input } = build({ interactive: true });
    for (const [answer, expected] of [['y', true], ['Y', true], ['yes', true], ['YES', true], ['Yes', true], [' y ', true], ['n', false], ['N', false], ['no', false], ['NO', false], ['maybe', false]] as const) {
      const promise = prompter.confirm({ question: '继续？' });
      input.write(`${answer}\n`);
      await expect(promise).resolves.toBe(expected);
    }
    prompter.close();
  });

  it('提示语按默认值显示 [Y/n] 或 [y/N]', async () => {
    const { prompter, input, output } = build({ interactive: true });
    const yes = prompter.confirm({ question: '继续？', defaultValue: true });
    input.write('y\n');
    await yes;
    expect(output.text()).toBe('继续？ [Y/n]: ');

    const no = prompter.confirm({ question: '继续？' });
    input.write('y\n');
    await no;
    expect(output.text()).toBe('继续？ [Y/n]: 继续？ [y/N]: ');
    prompter.close();
  });

  it('直接回车取默认值', async () => {
    const { prompter, input } = build({ interactive: true });
    const yes = prompter.confirm({ question: '继续？', defaultValue: true });
    input.write('\n');
    await expect(yes).resolves.toBe(true);

    const no = prompter.confirm({ question: '继续？', defaultValue: false });
    input.write('   \n');
    await expect(no).resolves.toBe(false);
    prompter.close();
  });

  it('stdin 关闭时非危险动作取默认值、危险动作 fail closed', async () => {
    const safe = build({ interactive: true, closedInput: true });
    await expect(safe.prompter.confirm({ question: '继续？', defaultValue: true })).resolves.toBe(true);
    safe.prompter.close();

    const risky = build({ interactive: true, closedInput: true });
    await expect(risky.prompter.confirm({ question: '删掉？', dangerous: true, defaultValue: true })).resolves.toBe(false);
    risky.prompter.close();
  });
});

describe('close', () => {
  it('连调两次也安全', () => {
    const { prompter } = build({ interactive: true });
    expect(() => { prompter.close(); prompter.close(); }).not.toThrow();
  });

  it('创建过 readline 之后连调两次同样安全', async () => {
    const { prompter, input } = build({ interactive: true });
    const promise = prompter.ask({ question: '工作目录', remedyFlag: '--cwd <目录>', validate: trimValidator });
    input.write('/srv\n');
    await promise;

    expect(() => { prompter.close(); prompter.close(); }).not.toThrow();
  });

  it('从未提问过就 close 也不抛（readline 是懒创建的）', () => {
    const { prompter } = build({ interactive: false });
    expect(() => prompter.close()).not.toThrow();
  });
});
