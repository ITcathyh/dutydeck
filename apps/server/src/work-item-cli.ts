import { toolsByName } from './agent-host/tool-table.js';
import { open } from 'node:fs/promises';
import { AgentGroupToolHttpClient } from './agent-host/http-client.js';

export async function runWorkCommand(operation: string, args: string[], options: { file?: string; key?: string; turn?: string; dryRun?: boolean } = {}, clientOptions: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {}): Promise<Record<string, unknown>> {
  const client = new AgentGroupToolHttpClient(clientOptions);
  if (!options.turn) throw new Error('编排工具需要本轮提示中提供的 --turn 凭证');
  const tool = toolsByName.get('work.' + operation);
  if (!tool) throw new Error(`不支持的 work 操作：${operation}`);
  const request = (body?: string) => client.call(tool, [args[0] ?? ''], {
    headers: { 'x-dutydeck-work-turn': options.turn! }, ...(body !== undefined ? { body } : {})
  });
  if (tool.method === 'GET') return request();
  if (operation === 'create' || operation === 'delegate') {
    if (!options.file) throw new Error(`work ${operation} 需要 --file JSON文件`);
    return request(await readPlanFile(options.file));
  }
  if (operation === 'revise') {
    if (!options.file) throw new Error('work revise 需要 --file JSON文件');
    const body = JSON.parse(await readPlanFile(options.file)) as Record<string, unknown>;
    return request(JSON.stringify(options.dryRun ? { ...body, dryRun: true } : body));
  }
  if (operation === 'save') return request(JSON.stringify({ name: args.slice(1).join(' ') }));
  if (operation === 'run') {
    if (!options.key) throw new Error('work run 需要 --key 稳定请求键');
    return request(JSON.stringify({ version: Number(args[1]), goal: args.slice(2).join(' '), idempotencyKey: options.key }));
  }
  throw new Error(`不支持的 work 操作：${operation}`);
}

async function readPlanFile(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 512_000) throw new Error('工作计划必须是小于 512 KB 的普通 JSON 文件');
    const body = await handle.readFile('utf8');
    if (Buffer.byteLength(body) > 512_000) throw new Error('工作计划超出 512 KB');
    JSON.parse(body);
    return body;
  } finally { await handle.close(); }
}
