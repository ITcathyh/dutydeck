/**
 * setup 向导的输入层：所有提问都必须经过这里。
 *
 * 为什么要一个「唯一收口」：
 *   - 交互与非交互必须共用同一套校验器。如果脚本路径自己再写一遍校验，
 *     加一个问题就会静默漂移（避免脚本把答案通过管道喂入时发生错位）。
 *   - 非 TTY 下必须能确定性退化：给出编号列表 + 默认值，stdin 关闭即取默认值，
 *     绝不无限重问——管道不会长出一个人来回答第二遍。
 *   - 因此我们优先推荐「字段 flag」而非「喂答案」：flag 走的是同一个 validator。
 *
 * 提示语与回显一律走 stderr，答案本身不写 stdout，避免污染结果流。
 */
import { createInterface } from 'node:readline';
import type { CliUi } from '../cli-ui.js';

/** 用户在非交互环境下要求交互输入时抛出；由命令层翻译成「该加哪个 flag」。 */
export class PromptUnavailableError extends Error {
  readonly code = 'SETUP_INPUT_REQUIRED';
  /** 能让这次调用不再需要交互的 flag，例如 `--cwd <目录>`。 */
  readonly remedyFlag: string;
  constructor(question: string, remedyFlag: string) {
    super(`无法在非交互环境下询问「${question}」。请改用 ${remedyFlag} 显式提供，或加 --yes 接受默认值。`);
    this.remedyFlag = remedyFlag;
  }
}

/** 用户主动中断（Ctrl-C / Ctrl-D / Esc）。调用方必须据此放弃写入，不留半成品。 */
export class PromptAbortedError extends Error {
  readonly code = 'SETUP_ABORTED';
  constructor(message = '已取消，未写入任何配置。') { super(message); }
}

export interface ReadLineIO {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export interface PrompterOptions {
  ui: CliUi;
  /** 是否可交互。false 时一切提问走「默认值或报错」路径。 */
  interactive: boolean;
  /** --yes：无条件接受默认值，且是唯一能跳过危险确认的开关。 */
  assumeYes?: boolean;
  io?: ReadLineIO;
}

/** 校验器：把原始输入规整成目标类型，或抛出带中文原因的错误。 */
export type Validator<T> = (raw: string) => T | Promise<T>;

export interface AskOptions<T> {
  /** 中文问题文案。 */
  question: string;
  /** 非交互且无默认值时，告诉用户该加什么 flag。 */
  remedyFlag: string;
  /** 默认值；非交互或直接回车时采用。 */
  defaultValue?: T;
  /** 默认值的展示形式。 */
  defaultLabel?: string;
  /** 与 flag 路径共用的校验器。 */
  validate: Validator<T>;
}

export interface ChoiceOption<T> {
  value: T;
  label: string;
  /** 附加说明，渲染在标签之后。 */
  detail?: string;
}

export interface Prompter {
  readonly interactive: boolean;
  /** 自由文本提问。 */
  ask<T>(options: AskOptions<T>): Promise<T>;
  /** 编号单选。非 TTY 下同样渲染编号列表，便于用户看懂该传什么。 */
  choose<T>(options: {
    question: string;
    remedyFlag: string;
    choices: Array<ChoiceOption<T>>;
    defaultIndex?: number;
  }): Promise<T>;
  /**
   * 危险动作确认。--yes 是唯一能跳过它的方式；
   * 非交互且没有 --yes 时一律拒绝（fail closed），不默默继续。
   */
  confirm(options: { question: string; dangerous?: boolean; defaultValue?: boolean }): Promise<boolean>;
  close(): void;
}

export function createPrompter(options: PrompterOptions): Prompter {
  const { ui, interactive, assumeYes = false } = options;
  const io = options.io ?? { input: process.stdin, output: process.stderr };
  let readline: ReturnType<typeof createInterface> | undefined;
  /**
   * stdin 是否已经走到尽头。一旦 readline 触发过 close，后续任何 once('close')
   * 都不会再被调用——如果不记住这个事实，第二次提问会永久挂住（管道场景下必然
   * 发生：第一问吃掉 EOF，第二问就再也等不到任何事件）。
   */
  let inputExhausted = false;
  /**
   * 已到达但还没被 readLine 取走的行。
   *
   * 为什么需要缓冲：readline 一旦创建就持续消费输入并 emit 'line'，而两次提问
   * **之间**是没有 line 监听器的窗口。落在这个窗口里的行会被直接丢弃——校验失败
   * 重问、或调用方在两问之间做异步工作时，都会踩到。缓冲让「行何时到达」与
   * 「谁在等它」彻底解耦：早到就排队，晚到就唤醒等待者。
   */
  const bufferedLines: string[] = [];
  /** 正在等待下一行的解析器；同一时刻最多一个（提问是串行的）。 */
  let waiting: ((line: string | undefined) => void) | undefined;

  /**
   * 全生命周期只挂一对监听器。
   *
   * 早前的写法是每次提问挂一对、结束时摘掉，这既漏行（见 bufferedLines），
   * 又在忘记摘除时线性堆积，第 11 次触发 MaxListenersExceededWarning——直接打进
   * 向导自己的 stderr。改成常驻监听后两个问题一起消失。
   */
  const ensureReadline = () => {
    if (readline) return readline;
    readline = createInterface({ input: io.input, output: io.output, terminal: false });
    readline.on('line', line => {
      const waiter = waiting;
      if (waiter) {
        waiting = undefined;
        waiter(line);
        return;
      }
      bufferedLines.push(line);
    });
    readline.on('close', () => {
      inputExhausted = true;
      const waiter = waiting;
      if (waiter) {
        waiting = undefined;
        waiter(undefined);
      }
    });
    return readline;
  };

  /** 读一行。stdin 关闭（EOF）时返回 undefined，交由调用方取默认值——绝不重问。 */
  const readLine = async (prompt: string): Promise<string | undefined> => {
    io.output.write(prompt);
    ensureReadline();
    // 窗口期到达的行先用掉，再考虑等待——否则它会被 EOF 判断跳过。
    if (bufferedLines.length > 0) return bufferedLines.shift();
    // 已经 EOF 且没有余量：直接返回，别挂一个永远等不到的监听器。
    if (inputExhausted) return undefined;
    return await new Promise<string | undefined>(resolve => { waiting = resolve; });
  };

  const defaultSuffix = <T>(defaultValue: T | undefined, label?: string) =>
    defaultValue === undefined ? '' : ` [${label ?? String(defaultValue)}]`;

  return {
    interactive,

    async ask<T>({ question, remedyFlag, defaultValue, defaultLabel, validate }: AskOptions<T>): Promise<T> {
      if (!interactive || assumeYes) {
        if (defaultValue !== undefined) return await validate(String(defaultValue));
        throw new PromptUnavailableError(question, remedyFlag);
      }
      // 交互下最多重试 3 次；仍然无效就当作放弃，避免把人困在循环里。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const raw = await readLine(`${question}${defaultSuffix(defaultValue, defaultLabel)}: `);
        if (raw === undefined) {
          // stdin 关闭：取默认值，没有默认值就报「该加什么 flag」。
          if (defaultValue !== undefined) return await validate(String(defaultValue));
          throw new PromptUnavailableError(question, remedyFlag);
        }
        const trimmed = raw.trim();
        if (trimmed === '' && defaultValue !== undefined) return await validate(String(defaultValue));
        try {
          return await validate(trimmed);
        } catch (error) {
          ui.notice(error instanceof Error ? error.message : String(error));
        }
      }
      throw new PromptAbortedError('连续输入无效，已放弃，未写入任何配置。');
    },

    // 参数类型显式标注：泛型方法写在对象字面量里时，接口的上下文类型不会流进
    // 解构参数，省略标注会退化成隐式 any。
    async choose<T>({ question, remedyFlag, choices, defaultIndex }: {
      question: string;
      remedyFlag: string;
      choices: Array<ChoiceOption<T>>;
      defaultIndex?: number;
    }): Promise<T> {
      if (choices.length === 0) throw new Error(`「${question}」没有可选项。`);
      const fallback = defaultIndex ?? 0;
      const render = () => {
        io.output.write(`${question}\n`);
        choices.forEach((choice: ChoiceOption<T>, index: number) => {
          const marker = index === fallback ? '*' : ' ';
          io.output.write(`  ${marker} ${index + 1}) ${choice.label}${choice.detail ? ` — ${choice.detail}` : ''}\n`);
        });
      };
      if (!interactive || assumeYes) {
        // 非交互也渲染列表：用户看到的是「我们替你选了哪一项，以及还有什么」。
        render();
        const chosen = choices[fallback]!;
        io.output.write(`  → 非交互模式，采用默认：${chosen.label}（用 ${remedyFlag} 可显式指定）\n`);
        return chosen.value;
      }
      render();
      const validateIndex: Validator<T> = raw => {
        const index = Number.parseInt(raw, 10);
        if (!Number.isInteger(index) || index < 1 || index > choices.length) {
          throw new Error(`请输入 1-${choices.length} 之间的编号。`);
        }
        return choices[index - 1]!.value;
      };
      return await this.ask<T>({
        question: '请选择编号',
        remedyFlag,
        defaultValue: choices[fallback]!.value,
        defaultLabel: String(fallback + 1),
        validate: validateIndex
      });
    },

    async confirm({ question, dangerous = false, defaultValue = false }) {
      if (assumeYes) return true;
      if (!interactive) {
        // 危险动作在非交互下 fail closed：--yes 是唯一的放行方式。
        if (dangerous) return false;
        return defaultValue;
      }
      const raw = await readLine(`${question} ${defaultValue ? '[Y/n]' : '[y/N]'}: `);
      if (raw === undefined) return dangerous ? false : defaultValue;
      const answer = raw.trim().toLowerCase();
      if (answer === '') return defaultValue;
      return answer === 'y' || answer === 'yes';
    },

    close() {
      readline?.close();
      readline = undefined;
    }
  };
}
