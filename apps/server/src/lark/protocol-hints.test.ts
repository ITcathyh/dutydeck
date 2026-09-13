import { describe, expect, it } from 'vitest';
import { TERMINAL_PROTOCOL_NOTE, isTerminalProtocol, protocolModeNote } from './protocol-hints.js';

describe('isTerminalProtocol', () => {
  it('pty / pty-cli 为终端模式', () => {
    expect(isTerminalProtocol('pty')).toBe(true);
    expect(isTerminalProtocol('pty-cli')).toBe(true);
  });

  it('其他协议与空值不是终端模式，auto 不臆断', () => {
    expect(isTerminalProtocol('acp')).toBe(false);
    expect(isTerminalProtocol('jsonl')).toBe(false);
    expect(isTerminalProtocol('pipe')).toBe(false);
    expect(isTerminalProtocol('auto')).toBe(false);
    expect(isTerminalProtocol(undefined)).toBe(false);
  });
});

describe('protocolModeNote', () => {
  it('pty / pty-cli 返回终端模式提示，点明电脑前响应、飞书不能批', () => {
    expect(protocolModeNote('pty')).toBe(TERMINAL_PROTOCOL_NOTE);
    expect(protocolModeNote('pty-cli', 'ask')).toBe(TERMINAL_PROTOCOL_NOTE);
    expect(TERMINAL_PROTOCOL_NOTE).toContain('电脑');
    expect(TERMINAL_PROTOCOL_NOTE).toContain('飞书');
  });

  it('acp 返回 undefined（远程审批可用，无需标注）', () => {
    expect(protocolModeNote('acp')).toBeUndefined();
    expect(protocolModeNote('acp', 'ask')).toBeUndefined();
  });

  it('auto / 其他结构化协议 / 未知 / 空值一律不臆断', () => {
    expect(protocolModeNote('auto')).toBeUndefined();
    expect(protocolModeNote('auto', 'ask')).toBeUndefined();
    expect(protocolModeNote('jsonl')).toBeUndefined();
    expect(protocolModeNote('pipe')).toBeUndefined();
    expect(protocolModeNote(undefined)).toBeUndefined();
  });

  it('permissionMode=full-trust 仍展示：终端通道缺失是 pty 内禀属性，不因运行时不问而消失', () => {
    expect(protocolModeNote('pty', 'full-trust')).toBe(TERMINAL_PROTOCOL_NOTE);
  });
});
