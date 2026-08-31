/**
 * CLI 展示层：为 setup / doctor / autostart 提供统一的状态符号、分节与总结块。
 *
 * 四条硬约束：
 *   1. 零依赖——只用 Node 内置能力，不引入 chalk / ora 之类的包。
 *   2. 尊重 NO_COLOR 与非 TTY——被管道接收时不输出任何 ANSI 序列。
 *   3. 不使用 spinner。进度只报告离散状态变化，且一律走 stderr；
 *      结果走 stdout，这样 `dockmux doctor | head -1` 仍然有意义。
 *   4. 输出可注入——所有写入都走注入的 target，测试直接断言纯文本。
 */

/**
 * 检查/步骤的结果等级。
 *
 * `ok` 与 `done` 的区分是刻意的，对幂等的 setup 很重要：
 *   ok   = 本来就满足，这次没动它（"已配置"）
 *   done = 这次真正做了变更（"已完成"）
 * 全程 ok 的重跑不该看起来像做了一堆事，反之也不该把真实写入伪装成无操作。
 */
export type StatusLevel = 'ok' | 'done' | 'warn' | 'fail' | 'info' | 'skip' | 'pending';

/** 全部为窄字形：emoji 宽度不一致会破坏列对齐。 */
const SYMBOLS: Record<StatusLevel, string> = {
  ok: '✓',
  done: '✔',
  warn: '!',
  fail: '✖',
  info: 'ℹ',
  skip: '-',
  pending: '…'
};

/** SGR 颜色码；仅在 color 为真时拼接。 */
const COLORS: Record<StatusLevel, string> = {
  ok: '32',      // green
  done: '32',    // green
  warn: '33',    // yellow
  fail: '31',    // red
  info: '36',    // cyan
  skip: '90',    // bright black
  pending: '90'
};

export interface CliUiTarget {
  write(chunk: string): void;
  isTTY?: boolean;
}

export interface CliUiOptions {
  /** 结果输出目标；默认 process.stdout。 */
  stdout?: CliUiTarget;
  /** 进度/提示输出目标；默认 process.stderr。 */
  stderr?: CliUiTarget;
  /** 强制开关颜色；省略时按 env + stderr.isTTY 推断。 */
  color?: boolean;
  /** 强制声明是否可交互；省略时取 stderr.isTTY。 */
  tty?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * 是否启用颜色。优先级：FORCE_COLOR > NO_COLOR > TERM=dumb > isTTY。
 *
 * NO_COLOR 遵循 no-color.org：只要变量存在且非空即视为禁用，不看具体值。
 */
export function shouldUseColor(env: NodeJS.ProcessEnv = process.env, isTTY = false): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return isTTY;
}

/** 该等级的状态符号，与颜色无关，便于测试直接比对。 */
export function symbolFor(level: StatusLevel): string {
  return SYMBOLS[level];
}

export interface SummaryItem {
  /** 一行说明；可执行内容请放进 command。 */
  text: string;
  /** 建议执行的命令，渲染时单独缩进一行。 */
  command?: string;
}

export interface CliUi {
  readonly color: boolean;
  readonly tty: boolean;
  /** 裸文本行（stdout）。 */
  line(text?: string): void;
  /** 分节标题（stdout），前面留一个空行（首节除外）。 */
  section(title: string): void;
  /** 带状态符号的结果行（stdout）；detail 追加在括号里。 */
  status(level: StatusLevel, text: string, detail?: string): void;
  /** 缩进的补充说明（stdout），用于承载「怎么修」。 */
  hint(text: string): void;
  /** 缩进的可执行命令（stdout），用于承载补救动作。 */
  command(command: string): void;
  /** 键值对齐块（stdout）。 */
  keyValues(entries: Array<[string, string]>): void;
  /** 结尾的「接下来做什么」块（stdout）。 */
  summary(title: string, items: SummaryItem[]): void;
  /** 机器消费输出（stdout）；始终无颜色、单行 JSON。 */
  json(value: unknown): void;
  /**
   * 离散进度事件（stderr）。刻意不做 spinner：每次调用就是一行，
   * 管道里读起来是一份可 grep 的时间线，而不是一堆回车控制符。
   */
  progress(text: string): void;
  /** 需要用户注意但不属于结果的提示（stderr）。 */
  notice(text: string): void;
}

const ESC = '[';

export function createCliUi(options: CliUiOptions = {}): CliUi {
  const stdout: CliUiTarget = options.stdout ?? process.stdout;
  const stderr: CliUiTarget = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const tty = options.tty ?? stderr.isTTY === true;
  const color = options.color ?? shouldUseColor(env, tty);
  let sectionsWritten = 0;

  const paint = (code: string, text: string) => color ? `${ESC}${code}m${text}${ESC}0m` : text;
  const statusLine = (level: StatusLevel, text: string, detail?: string) =>
    `${paint(COLORS[level], symbolFor(level))} ${text}${detail ? ` (${detail})` : ''}\n`;

  return {
    color,
    tty,
    line(text = '') {
      stdout.write(`${text}\n`);
    },
    section(title) {
      stdout.write(`${sectionsWritten > 0 ? '\n' : ''}${paint('1', title)}\n`);
      sectionsWritten += 1;
    },
    status(level, text, detail) {
      stdout.write(statusLine(level, text, detail));
    },
    hint(text) {
      stdout.write(`  ${paint('90', text)}\n`);
    },
    command(command) {
      stdout.write(`  ${paint('36', `$ ${command}`)}\n`);
    },
    keyValues(entries) {
      const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
      for (const [key, value] of entries) stdout.write(`  ${key.padEnd(width)}  ${value}\n`);
    },
    summary(title, items) {
      stdout.write(`\n${paint('1', title)}\n`);
      items.forEach((item, index) => {
        stdout.write(`  ${index + 1}. ${item.text}\n`);
        if (item.command) stdout.write(`     ${paint('36', `$ ${item.command}`)}\n`);
      });
    },
    json(value) {
      // JSON 必须可被 jq 直接消费：无颜色、单行、独占 stdout。
      stdout.write(`${JSON.stringify(value)}\n`);
    },
    progress(text) {
      stderr.write(`${paint(COLORS.pending, symbolFor('pending'))} ${text}\n`);
    },
    notice(text) {
      stderr.write(`${paint(COLORS.warn, symbolFor('warn'))} ${text}\n`);
    }
  };
}
