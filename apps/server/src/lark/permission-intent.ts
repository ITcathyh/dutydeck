import { permissionDisplayText, type PermissionRequestData } from '@dutydeck/shared';

const maxIntentLength = 120;
// 执行端交来的事实已脱敏；这里再按卡片展示口径脱敏一次，摘要不会比下方正文暴露更多。
const oneLine = (value: string | undefined) => permissionDisplayText(value).replace(/\s+/g, ' ').trim() || undefined;
const clip = (text: string) => text.length > maxIntentLength ? `${text.slice(0, maxIntentLength - 1)}…` : text;

/**
 * 审批卡顶部那句「要做什么」：只看执行端交来的工具类别和已脱敏的参数，确定性拼出，不调用模型。
 * kind 按 ACP 工具类别（execute / edit / delete / move / read / search / fetch）；
 * 缺 kind 时有命令按执行命令、有资源按操作资源，都没有就用请求标题。
 */
export function permissionIntent(request: Pick<PermissionRequestData, 'title' | 'operation'>): string {
  const operation = request.operation;
  const command = oneLine(operation?.command);
  const resource = oneLine(operation?.resource);
  const title = oneLine(request.title) ?? 'Agent 请求执行受控操作';
  const files = resource && (operation?.resourceCount ?? 0) > 1 ? `${resource} 等 ${operation!.resourceCount} 个` : resource;
  const target = files ?? title;
  switch (operation?.kind) {
    case 'execute': return clip(`执行命令：${command ?? title}`);
    case 'edit': return clip(`修改文件：${target}`);
    case 'delete': return clip(`删除文件：${target}`);
    case 'move': return clip(`移动文件：${target}`);
    case 'read': return clip(`读取：${target}`);
    case 'search': return clip(`搜索：${target}`);
    case 'fetch': return clip(`访问网络：${target}`);
  }
  if (command) return clip(`执行命令：${command}`);
  if (files) return clip(`操作：${files}`);
  return clip(title);
}
