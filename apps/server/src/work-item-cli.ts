import { open } from 'node:fs/promises';
import { AgentGroupToolHttpClient } from './lark/agent-tools-cli.js';

export async function runWorkCommand(operation: string, args: string[], options: { file?: string; key?: string; turn?: string } = {}, clientOptions: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {}): Promise<Record<string, unknown>> {
  const client = new AgentGroupToolHttpClient(clientOptions);
  if (!options.turn) throw new Error('编排工具需要本轮提示中提供的 --turn 凭证');
  const request = (path: string, init: RequestInit = {}) => client.request(path, { ...init, headers: { 'x-dutydeck-work-turn': options.turn! } });
  const path = '/work-items';
  if (operation === 'list' || operation === 'templates') return request(path);
  if (operation === 'agents' || operation === 'skills') return request(`${path}/${operation}`);
  if (operation === 'show') return request(`${path}/${encodeURIComponent(args[0] ?? '')}`);
  if (operation === 'create' || operation === 'delegate') {
    if (!options.file) throw new Error(`work ${operation} 需要 --file JSON文件`);
    const handle = await open(options.file, 'r');
    let body: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 512_000) throw new Error('工作计划必须是小于 512 KB 的普通 JSON 文件');
      body = await handle.readFile('utf8');
      if (Buffer.byteLength(body) > 512_000) throw new Error('工作计划超出 512 KB');
      JSON.parse(body);
    } finally { await handle.close(); }
    return request(operation === 'create' ? path : `${path}/delegations`, { method: 'POST', body });
  }
  if (operation === 'save') return request(`${path}/${encodeURIComponent(args[0] ?? '')}/template`, { method: 'POST', body: JSON.stringify({ name: args.slice(1).join(' ') }) });
  if (operation === 'run') {
    if (!options.key) throw new Error('work run 需要 --key 稳定请求键');
    return request(`${path}/templates/${encodeURIComponent(args[0] ?? '')}/run`, { method: 'POST', body: JSON.stringify({ version: Number(args[1]), goal: args.slice(2).join(' '), idempotencyKey: options.key }) });
  }
  throw new Error(`不支持的 work 操作：${operation}`);
}
