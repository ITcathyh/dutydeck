import { afterEach, describe, expect, it } from 'vitest';
import { renderLarkCommandHelp } from '../lark/commands.js';
import { expandLarkPluginCommand, larkPluginCommandHelp, setLarkPluginCommands } from '../lark/plugin-commands.js';
import { describePluginCommand, expandCommandTemplate, PluginCommandRegistry } from './commands.js';

const registry = () => new PluginCommandRegistry([
  { name: 'alpha', scope: 'global', commands: [{ name: 'greet', description: '打招呼', argumentHint: '<名字>', template: '你好 $ARGUMENTS！' }, { name: 'deploy', template: '部署' }] },
  { name: 'beta', scope: 'global', commands: [{ name: 'greet', template: 'hi' }] },
  { name: 'gamma', scope: 'bot:cli_g', commands: [{ name: 'ship', template: 'ship it' }] }
]);

describe('PluginCommandRegistry', () => {
  it('expands $ARGUMENTS or appends arguments', () => {
    expect(expandCommandTemplate('a $ARGUMENTS b $ARGUMENTS', 'x')).toBe('a x b x');
    expect(expandCommandTemplate('do it', 'now')).toBe('do it\n\nARGUMENTS: now');
    expect(expandCommandTemplate('do it', '')).toBe('do it');
  });

  it('requires /<plugin>:<name> when two plugins share a command name', () => {
    const commands = registry();
    expect(commands.expand('/greet bob', {})).toBeUndefined();
    expect(commands.expand('/alpha:greet bob', {})).toBe('你好 bob！');
    expect(commands.expand('/BETA:greet', {})).toBe('hi');
    expect(commands.expand('/deploy', {})).toBe('部署');
    expect(commands.expand('/deployx', {})).toBeUndefined();
    expect(commands.expand('/help', {})).toBeUndefined();
    expect(commands.list({}).filter(command => !command.shortNameAvailable).map(command => command.qualifiedName)).toEqual(['alpha:greet', 'beta:greet']);
  });

  it('keeps Agent-native command names for the Agent and only allows /<plugin>:<name>', () => {
    const commands = new PluginCommandRegistry([{ name: 'alpha', scope: 'global', commands: ['compact', 'clear', 'init', 'review'].map(name => ({ name, template: `plugin ${name}` })) }]);
    for (const name of ['compact', 'clear', 'init', 'review']) {
      expect(commands.expand(`/${name} now`, {})).toBeUndefined();
      expect(commands.expand(`/alpha:${name} now`, {})).toBe(`plugin ${name}\n\nARGUMENTS: now`);
    }
    expect(describePluginCommand(commands.commands[0]!).usage).toBe('/alpha:compact');
  });

  it('scopes commands to their bot', () => {
    const commands = registry();
    expect(commands.expand('/ship', {})).toBeUndefined();
    expect(commands.expand('/ship', { botAppId: 'cli_x' })).toBeUndefined();
    expect(commands.expand('/ship', { botAppId: 'cli_g' })).toBe('ship it');
  });

  it('describes commands for help and the web palette', () => {
    const [greet] = registry().commands;
    expect(describePluginCommand(greet!)).toEqual({ name: 'alpha:greet', summary: '打招呼（插件 alpha）', usage: '/alpha:greet <名字>' });
  });
});

describe('Lark plugin commands', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => { dispose?.(); dispose = undefined; });

  it('has no plugin commands and no help group when nothing is registered', () => {
    expect(expandLarkPluginCommand('/deploy', { botAppId: 'cli_a' })).toBeUndefined();
    expect(larkPluginCommandHelp({ botAppId: 'cli_a' })).toEqual([]);
    const help = renderLarkCommandHelp({});
    for (let page = 1; page <= help.totalPages; page++) expect(JSON.stringify(renderLarkCommandHelp({}, { page }))).not.toContain('插件命令');
  });

  it('expands registered commands and lists them in a separate help group', () => {
    dispose = setLarkPluginCommands(registry());
    expect(expandLarkPluginCommand('/alpha:greet 小明', { botAppId: 'cli_a' })).toBe('你好 小明！');
    const help = larkPluginCommandHelp({ botAppId: 'cli_a' });
    expect(help.map(item => item.name)).toEqual(['alpha:greet', 'deploy', 'beta:greet']);
    const first = renderLarkCommandHelp({}, { pluginCommands: help });
    const rendered = JSON.stringify(renderLarkCommandHelp({}, { pluginCommands: help, page: first.totalPages }));
    expect(rendered).toContain('插件命令');
    expect(rendered).toContain('/alpha:greet <名字>');
  });
});
