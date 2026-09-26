/**
 * 同机另起的 Dutydeck 实例（例如独立运行的 Tag bot 服务）在主服务 dashboard 里的视图。
 *
 * 页面路径带 `/instances/<id>` 前缀，刷新和深链都能留在该实例；API 改走
 * `/api/instances/<id>/...`，由主服务转发。登录与实例列表始终属于主服务。
 */
const INSTANCE_PATH = /^\/instances\/([a-z0-9-]+)(?=\/|$)/;
let instanceId: string | undefined;

export const instanceFromPath = (pathname: string) => INSTANCE_PATH.exec(pathname)?.[1];
export const setInstance = (id: string | undefined) => { instanceId = id; };
export const currentInstance = () => instanceId;

/** 去掉实例前缀后的页面路径，供路由解析。 */
export const stripInstancePath = (pathname: string) => pathname.replace(INSTANCE_PATH, '') || '/';
/** 某个实例的首页；undefined 表示主服务。 */
export const instanceHomePath = (id: string | undefined) => id ? `/instances/${id}/` : '/';
/** 当前实例下的页面路径。 */
export const instancePagePath = (path: string) => instanceId ? `/instances/${instanceId}${path}` : path;
/** 当前实例下的 API 地址。 */
export const instanceApiUrl = (url: string) =>
  instanceId && url.startsWith('/api/') && !url.startsWith('/api/auth/') && url !== '/api/instances'
    ? `/api/instances/${instanceId}${url.slice('/api'.length)}`
    : url;
