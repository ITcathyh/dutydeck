import { renderLarkCommandHelp, type LarkCommandContext, type LarkCommandRoute, type ParsedSlashCommand } from '../commands.js';

export function helpReply(parsed: ParsedSlashCommand, context: LarkCommandContext): Extract<LarkCommandRoute, { kind: 'reply' }> {
  const page = Number.parseInt(parsed.args[0] ?? '', 10);
  const help = renderLarkCommandHelp(context.capabilities, {
    ...(Number.isFinite(page) ? { page } : {}),
    ...(context.helpPageSize === undefined ? {} : { pageSize: context.helpPageSize }),
    ...(context.pluginCommands?.length ? { pluginCommands: context.pluginCommands } : {})
  });
  return { kind: 'reply', command: 'help', parsed, elements: help.elements, text: help.text };
}
