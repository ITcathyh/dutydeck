import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RuntimeError } from '@dutydeck/shared';
import { SHARE_TOKEN_QUERY_KEY } from './auth/auth.js';
import { hasPluginTaskCredentials } from './plugins/management-auth.js';
import { ArtifactSnapshots, artifactSnapshotReferenceSchema } from './artifact-snapshots.js';

export interface ArtifactSnapshotRouteOptions {
  service: ArtifactSnapshots;
  authorize(request: FastifyRequest, sessionId: string): Promise<boolean>;
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('ARTIFACT_STORAGE_FAILED', '快照读写失败，请检查实例存储后重试。', 503);
  }
}
export function registerArtifactSnapshotRoutes(app: FastifyInstance, options?: ArtifactSnapshotRouteOptions) {
  const access = async (request: FastifyRequest, sessionId: string) => {
    if (!options || Object.prototype.hasOwnProperty.call(request.query ?? {}, SHARE_TOKEN_QUERY_KEY) || hasPluginTaskCredentials(request) || !await options.authorize(request, sessionId)) throw new RuntimeError('ARTIFACT_FORBIDDEN', '查看和保存快照需要安装管理员及原会话的查看权限。', 403);
    if (Object.keys((request.query ?? {}) as object).length) throw new RuntimeError('ARTIFACT_INPUT_INVALID', '此接口不接受查询参数。', 400);
    return options.service;
  };
  const path = '/api/sessions/:id/artifact-snapshots';
  app.get<{ Params: { id: string } }>(path, async (request, reply) => {
    const service = await access(request, request.params.id);
    reply.header('Cache-Control', 'no-store');
    return { snapshots: await storage(() => service.list(request.params.id)) };
  });
  app.post<{ Params: { id: string } }>(path, async (request, reply) => {
    const service = await access(request, request.params.id);
    const checked = artifactSnapshotReferenceSchema.safeParse(request.body);
    if (!checked.success) throw new RuntimeError('ARTIFACT_INPUT_INVALID', '只能选择已登记的事件引用，不能指定路径或 URL。', 400);
    reply.header('Cache-Control', 'no-store');
    return storage(() => service.capture(request.params.id, checked.data));
  });
  app.get<{ Params: { id: string; snapshotId: string } }>(`${path}/:snapshotId/preview`, async (request, reply) => {
    const service = await access(request, request.params.id);
    reply.headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return storage(() => service.preview(request.params.id, request.params.snapshotId));
  });
  app.get<{ Params: { id: string; snapshotId: string } }>(`${path}/:snapshotId/download`, async (request, reply) => {
    const service = await access(request, request.params.id);
    const { snapshot, data } = await storage(() => service.read(request.params.id, request.params.snapshotId));
    const filename = encodeURIComponent(snapshot.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.headers({ 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length), 'Content-Disposition': `attachment; filename="artifact.bin"; filename*=UTF-8''${filename}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
    return reply.send(data);
  });
}
