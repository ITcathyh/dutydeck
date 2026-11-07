const WHITESPACE = ' \t\n\r';
const NEWLINE = '\n\r';
const DOUBLE_QUOTE_ESCAPABLE = '"\\`$';

/**
 * `systemctl show` 打印字符串数组（如 Environment）时以空格分隔各项；含空白或 shell 特殊字符的项整体包进
 * 双引号，其中的 `"`、`\`、`` ` ``、`$` 前加反斜杠。按空白切分会把带空格的值拆坏。
 */
export function splitSystemdShowStrings(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let at = 0; at < value.length; at++) {
    const c = value[at]!;
    if (quoted) {
      if (c === '\\' && at + 1 < value.length) current += value[++at];
      else if (c === '"') quoted = false;
      else current += c;
    } else if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ' ' || c === '\t') {
      if (started) items.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) items.push(current);
  return items;
}

type EnvFileState = 'preKey' | 'key' | 'preValue' | 'value' | 'valueEscape' | 'single' | 'double' | 'doubleEscape' | 'comment' | 'commentEscape';

/**
 * 按 systemd 读 `EnvironmentFile=` 的规则解析（与 Node 的 .env 解析不同）：`#`、`;` 开头的行是注释；
 * 键和未加引号的值去掉首尾空白，值内部空白原样保留；未加引号时反斜杠转义下一个字符、行尾反斜杠续行；
 * 单引号内原样保留且可跨行；双引号内只有 `"`、`\`、`` ` ``、`$` 可转义，其余反斜杠连同后一个字符保留。
 * 同一个键后出现的覆盖先出现的。
 */
export function parseSystemdEnvironmentFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  let state: EnvFileState = 'preKey';
  let key = '';
  let value = '';
  let keyTrailingSpace = -1;
  let valueTrailingSpace = -1;
  const push = (trimValue: boolean) => {
    env[keyTrailingSpace < 0 ? key : key.slice(0, keyTrailingSpace)] = trimValue && valueTrailingSpace >= 0 ? value.slice(0, valueTrailingSpace) : value;
    key = '';
    value = '';
  };
  for (const c of text) {
    switch (state) {
      case 'preKey':
        if (c === '#' || c === ';') state = 'comment';
        else if (!WHITESPACE.includes(c)) { state = 'key'; key = c; keyTrailingSpace = -1; }
        break;
      case 'key':
        if (NEWLINE.includes(c)) { state = 'preKey'; key = ''; }
        else if (c === '=') { state = 'preValue'; valueTrailingSpace = -1; }
        else {
          if (!WHITESPACE.includes(c)) keyTrailingSpace = -1;
          else if (keyTrailingSpace < 0) keyTrailingSpace = key.length;
          key += c;
        }
        break;
      case 'preValue':
        if (NEWLINE.includes(c)) { state = 'preKey'; push(false); }
        else if (c === "'") state = 'single';
        else if (c === '"') state = 'double';
        else if (c === '\\') state = 'valueEscape';
        else if (!WHITESPACE.includes(c)) { state = 'value'; value += c; }
        break;
      case 'value':
        if (NEWLINE.includes(c)) { state = 'preKey'; push(true); }
        else if (c === '\\') { state = 'valueEscape'; valueTrailingSpace = -1; }
        else {
          if (!WHITESPACE.includes(c)) valueTrailingSpace = -1;
          else if (valueTrailingSpace < 0) valueTrailingSpace = value.length;
          value += c;
        }
        break;
      case 'valueEscape':
        state = 'value';
        if (!NEWLINE.includes(c)) value += c;
        break;
      case 'single':
        if (c === "'") state = 'preValue';
        else value += c;
        break;
      case 'double':
        if (c === '"') state = 'preValue';
        else if (c === '\\') state = 'doubleEscape';
        else value += c;
        break;
      case 'doubleEscape':
        state = 'double';
        if (DOUBLE_QUOTE_ESCAPABLE.includes(c)) value += c;
        else if (c !== '\n') value += `\\${c}`;
        break;
      case 'comment':
        if (c === '\\') state = 'commentEscape';
        else if (NEWLINE.includes(c)) state = 'preKey';
        break;
      case 'commentEscape':
        state = NEWLINE.includes(c) ? 'preKey' : 'comment';
        break;
    }
  }
  if (state === 'preValue' || state === 'value' || state === 'valueEscape' || state === 'single' || state === 'double' || state === 'doubleEscape') push(state === 'value');
  return env;
}
