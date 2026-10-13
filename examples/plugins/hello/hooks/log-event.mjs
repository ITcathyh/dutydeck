// 把收到的 hook 输入追加到插件数据目录的 events.jsonl；不输出决定，即放行。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const dir = process.env.DUTYDECK_PLUGIN_DATA;
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(JSON.parse(input))}\n`);
