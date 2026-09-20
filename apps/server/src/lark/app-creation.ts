import { randomUUID } from 'node:crypto';
import type { AgentRepository, ConfigRepository } from '@dutydeck/shared';
import QRCode from 'qrcode';
import { LARK_APP_ICON_BASE64 } from './app-icon.js';
import { readLarkConfig, saveLarkConfig } from './config.js';
import { configureLarkOpenPlatformApp, isValidLarkAppId, larkSlashCommandDefinitions, LarkOpenPlatformConfigurationError } from './open-platform-configurator.js';
import { connectLarkOpenPlatformSession, OpenPlatformRequestError, OpenPlatformSessionError } from './open-platform-session.js';
import { createLarkCardService } from './service.js';

/** 与 repair.ts 同一个判据：这条权限被跳过时命令菜单不可用，同步注定 403，不必发请求。 */
const SLASH_COMMAND_SCOPE = 'application:app_slash_command:write';

export interface LarkAppCreationJob {
  id: string;
  name: string;
  status: 'preparing' | 'waiting_for_scan' | 'creating' | 'configuring' | 'completed' | 'pending_review' | 'failed' | 'cancelled';
  appId?: string;
  botSaved?: boolean;
  qrDataUrl?: string;
  scanConfirmed?: boolean;
  accountName?: string;
  tenantName?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  retryable: boolean;
}

export class LarkAppCreationError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

interface Options {
  config: ConfigRepository;
  agents?: AgentRepository;
  fetcher?: typeof fetch;
  connect?: typeof connectLarkOpenPlatformSession;
  configure?: typeof configureLarkOpenPlatformApp;
  save?: typeof saveLarkConfig;
  /** 默认用新应用自己的机器人凭据同步斜杠命令；测试注入替身。 */
  syncSlashCommands?: (input: { appId: string; appSecret: string }) => Promise<unknown>;
  qrDataUrl?: (payload: string) => Promise<string>;
  now?: () => Date;
}

const key = (id: string) => `lark.app_creation.${id}`;
const ownerKey = (id: string) => `lark.app_creation_owner.${id}`;
const canCancel = (job: LarkAppCreationJob) => job.status === 'preparing' || job.status === 'waiting_for_scan';
interface StoredJob extends LarkAppCreationJob { runner?: { pid: number; instanceId: string } }
const isActive = (job: LarkAppCreationJob) => canCancel(job) || job.status === 'creating' || job.status === 'configuring';
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Persistent request IDs are tombstones: a lost creation response must never create a second app. */
export class LarkAppCreationJobManager {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly runner = { pid: process.pid, instanceId: randomUUID() };
  private readonly runs = new Map<string, Promise<void>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly options: Options) {}

  private timestamp() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  private serialize(job: StoredJob) {
    const { qrDataUrl: _qr, ...stored } = job;
    return JSON.stringify(stored);
  }
  private publicJob(job: StoredJob): LarkAppCreationJob {
    const { runner: _runner, ...publicJob } = job;
    const local = this.jobs.get(job.id);
    if (canCancel(job) && job.runner?.instanceId === this.runner.instanceId && local?.qrDataUrl) {
      publicJob.qrDataUrl = local.qrDataUrl;
    }
    return publicJob;
  }
  private async compareAndSet(id: string, expected: string | undefined, job: StoredJob) {
    const repository = this.options.config;
    if (!repository.compareAndSet) throw new LarkAppCreationError(503, '配置存储不支持原子认领，无法安全创建应用');
    return repository.compareAndSet(key(id), expected, this.serialize(job));
  }
  private async load(id: string, readOnly = false): Promise<{ job: StoredJob; raw: string } | undefined> {
    // Always read durable state: another instance may cancel, finish or claim a retry.
    for (;;) {
      const raw = await this.options.config.get(key(id));
      if (!raw) return undefined;
      const job = JSON.parse(raw) as StoredJob;
      if (!isActive(job) || (job.runner && processIsAlive(job.runner.pid))) return { job, raw };
      const safe = canCancel(job);
      job.status = 'failed';
      job.retryable = safe;
      job.error = safe ? '服务已重启，请重试继续' : '服务重启前的创建或发布结果未知，请到飞书开放平台核对，禁止自动重试';
      job.updatedAt = this.timestamp();
      delete job.runner;
      if (job.appId && await readLarkConfig(this.options.config, job.appId, { readOnly })) job.botSaved = true;
      if (readOnly) return { job, raw };
      if (await this.compareAndSet(id, raw, job)) return { job, raw: this.serialize(job) };
    }
  }
  async get(id: string, options: { readOnly?: boolean } = {}): Promise<LarkAppCreationJob | undefined> {
    if (!isUuid(id)) return undefined;
    const state = await this.load(id, options.readOnly);
    return state && this.publicJob(state.job);
  }
  async start(requestId: unknown, name: unknown, options: { forceLogin?: boolean } = {}): Promise<LarkAppCreationJob> {
    if (!isUuid(requestId) || typeof name !== 'string' || !name.trim() || name.trim().length > 50) {
      throw new LarkAppCreationError(400, '请提供有效的请求 ID 和 1–50 字机器人名称');
    }
    return this.locked(requestId, async () => {
      const existing = await this.load(requestId);
      if (existing) return this.publicJob(existing.job);
      const job: StoredJob = { id: requestId, name: name.trim(), status: 'preparing', retryable: false, createdAt: this.timestamp(), updatedAt: this.timestamp(), runner: this.runner };
      if (!await this.compareAndSet(requestId, undefined, job)) {
        return this.publicJob((await this.load(requestId))!.job);
      }
      this.jobs.set(requestId, job);
      this.launch(job.id, options);
      return this.publicJob(job);
    });
  }
  async cancel(id: string): Promise<LarkAppCreationJob> {
    return this.locked(id, async () => {
      for (;;) {
        const state = await this.load(id);
        if (!state) throw new LarkAppCreationError(404, '创建任务不存在');
        const { job, raw } = state;
        if (job.status === 'cancelled') return this.publicJob(job);
        if (!canCancel(job)) throw new LarkAppCreationError(409, '应用创建已经开始，无法取消');
        Object.assign(job, { status: 'cancelled', retryable: false, updatedAt: this.timestamp() });
        delete job.runner;
        if (await this.compareAndSet(id, raw, job)) return this.publicJob(job);
      }
    });
  }
  async retry(id: string, options: { forceLogin?: boolean } = {}): Promise<LarkAppCreationJob> {
    return this.locked(id, async () => {
      const state = await this.load(id);
      if (!state) throw new LarkAppCreationError(404, '创建任务不存在');
      const { job, raw } = state;
      if (job.status !== 'failed' || !job.retryable || this.runs.has(id)) throw new LarkAppCreationError(409, '当前任务无法安全重试，请核对飞书开放平台状态');
      Object.assign(job, { status: 'preparing', retryable: false, updatedAt: this.timestamp(), runner: this.runner });
      delete job.error;
      delete job.scanConfirmed;
      if (!await this.compareAndSet(id, raw, job)) throw new LarkAppCreationError(409, '任务已被其他服务实例认领，请刷新状态');
      this.jobs.set(id, job);
      this.launch(id, options);
      return this.publicJob(job);
    });
  }
  async wait(id: string): Promise<void> { await this.runs.get(id); }
  private launch(id: string, options: { forceLogin?: boolean }) {
    // Defer until the caller's state transaction has released its lock.
    const run = Promise.resolve().then(() => this.run(id, options)).finally(() => this.runs.delete(id));
    this.runs.set(id, run);
  }
  private async cancelled(id: string) {
    const raw = await this.options.config.get(key(id));
    return !raw || (JSON.parse(raw) as StoredJob).status === 'cancelled';
  }
  private async update(id: string, fields: Partial<LarkAppCreationJob>): Promise<boolean> {
    return this.locked(id, async () => {
      for (;;) {
        const state = await this.load(id);
        if (!state || state.job.status === 'cancelled') return false;
        const { job, raw } = state;
        if (job.runner?.instanceId !== this.runner.instanceId) throw new LarkAppCreationError(409, '任务已由其他服务实例接管');
        const qrDataUrl = fields.qrDataUrl ?? this.jobs.get(id)?.qrDataUrl;
        Object.assign(job, fields, { updatedAt: this.timestamp() });
        if (canCancel(job) && qrDataUrl) job.qrDataUrl = qrDataUrl;
        else delete job.qrDataUrl;
        if (!isActive(job)) delete job.runner;
        if (await this.compareAndSet(id, raw, job)) {
          this.jobs.set(id, job);
          return true;
        }
      }
    });
  }
  private async run(id: string, options: { forceLogin?: boolean }) {
    let retryable = true;
    let message = '飞书开放平台登录失败，请重新扫码重试';
    try {
      const connected = await (this.options.connect ?? connectLarkOpenPlatformSession)({
        forceLogin: options.forceLogin === true,
        fetchImpl: this.options.fetcher,
        onQrUpdate: async update => {
          if (await this.cancelled(id)) return;
          const qrDataUrl = await (this.options.qrDataUrl ?? (payload => QRCode.toDataURL(payload)))(update.qrPayload);
          if (await this.cancelled(id)) return;
          await this.update(id, { status: 'waiting_for_scan', qrDataUrl, scanConfirmed: update.status === 'scan_confirmed' });
        },
      });
      if (await this.cancelled(id)) return;
      message = '登录已完成，但读取账号信息或保存创建进度失败，请重试';
      const { client, owner } = connected;
      if (!owner.userId || !owner.tenantId || !owner.userName || !owner.tenantName) throw new Error('incomplete owner');
      const originalOwner = await this.options.config.get(ownerKey(id));
      if (await this.cancelled(id)) return;
      const identity = JSON.stringify({ userId: owner.userId, tenantId: owner.tenantId });
      if (originalOwner && originalOwner !== identity) {
        message = '请使用首次登录的同一账号和企业继续配置';
        throw new Error('owner mismatch');
      }
      await this.options.config.set(ownerKey(id), identity);
      if (await this.cancelled(id)) return;
      if (!await this.update(id, { accountName: owner.userName, tenantName: owner.tenantName, scanConfirmed: true })) return;
      let appId = this.jobs.get(id)!.appId;
      if (!appId) {
        message = '登录已完成，但机器人图标上传失败，请重试；尚未创建应用';
        const form = new FormData();
        form.append('file', new Blob([Buffer.from(LARK_APP_ICON_BASE64, 'base64')], { type: 'image/png' }), 'dutydeck.png');
        form.append('uploadType', '4');
        form.append('isIsv', 'false');
        form.append('scale', JSON.stringify({ width: 512, height: 512 }));
        const uploaded = await client.postForm('/developers/v1/app/upload/image', form);
        if (await this.cancelled(id)) return;
        const avatar = payloadString(uploaded, ['url']);
        if (!avatar) throw new Error('missing icon url');
        // Persist the irreversible boundary before sending the external write.
        retryable = false;
        message = '应用创建结果未知，请到飞书开放平台核对；为避免重复创建，已禁止重试';
        if (!await this.update(id, { status: 'creating' })) return;
        let created: unknown;
        try {
          created = await client.postJson('/developers/v1/manifest/upsert_by_template', {
            appManifestTemplateID: 'developer_console',
            createAppUserCustomField: { i18n: { zh_cn: { name: this.jobs.get(id)!.name, description: 'AI coding assistant powered by Dutydeck' } }, avatar, primaryLang: 'zh_cn' },
            cid: id,
            HTTPHead: {},
          });
        } catch (error) {
          if (error instanceof OpenPlatformRequestError && error.statusCode < 500 && error.statusCode !== 408 && (error.apiCode !== undefined || error.statusCode >= 400)) {
            retryable = true;
            message = '飞书明确拒绝了应用创建请求，可重新扫码重试';
          }
          throw error;
        }
        appId = payloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
        if (!appId || !isValidLarkAppId(appId)) throw new Error('missing app id');
        await this.update(id, { appId });
      }
      retryable = true;
      message = '应用已创建，但读取凭据或保存草稿失败；重试会继续处理同一个应用';
      if (!await readLarkConfig(this.options.config, appId)) {
        const secret = payloadString(await client.postJson(`/developers/v1/secret/${appId}`, {}), ['secret']);
        if (!secret) throw new Error('missing app secret');
        try {
          await (this.options.save ?? saveLarkConfig)(this.options.config, this.options.agents, { stage: 'lark', appId, appSecret: secret, name: this.jobs.get(id)!.name, listening: false });
        } catch (error) {
          // Another local editor may have saved the same app while credentials were read.
          if (!await readLarkConfig(this.options.config, appId)) throw error;
        }
      }
      await this.update(id, { botSaved: true });
      retryable = false;
      message = '应用草稿已保存，但自动配置或发布未完成；请继续配置该机器人并核对开放平台状态';
      await this.update(id, { status: 'configuring' });
      const configured = await (this.options.configure ?? configureLarkOpenPlatformApp)(client, appId, { creatorUserId: owner.userId, newApp: true });
      await this.syncSlashCommands(appId, configured?.skippedScopes ?? []);
      await this.update(id, { status: 'completed', retryable: false });
    } catch (error) {
      // Never copy upstream errors: they may contain cookies, secrets or private IDs.
      if (error instanceof OpenPlatformSessionError) message = error.message;
      if (error instanceof LarkOpenPlatformConfigurationError) {
        message = `应用草稿已保存：${error.message}（${error.code}）。请继续处理该应用`;
        // Preflight failures never submit a publication; retries reuse and verify the same draft.
        retryable = [
          'scope_catalog_read_failed', 'scope_catalog_incomplete', 'scope_update_failed',
          'scope_verification_read_failed', 'scope_verification_failed', 'robot_enable_failed',
          'event_mode_failed', 'event_read_failed', 'event_update_failed', 'event_verification_failed',
          'callback_read_failed', 'callback_mode_failed', 'callback_update_failed', 'callback_verification_failed',
          'version_list_failed', 'version_list_unreadable', 'visibility_read_failed', 'visibility_unreadable',
          'privilege_read_failed', 'privilege_update_failed', 'privilege_verification_failed',
          'draft_read_failed', 'draft_visibility_mismatch', 'approval_prediction_failed',
          'approval_prediction_unreadable', 'publish_requires_review',
        ].includes(error.code);
      }
      const pendingReview = error instanceof LarkOpenPlatformConfigurationError && error.code === 'publish_pending_review';
      try { await this.update(id, { status: pendingReview ? 'pending_review' : 'failed', retryable, error: pendingReview ? undefined : message }); }
      catch { /* The persisted boundary remains fail-closed if storage is unavailable. */ }
    }
  }

  /**
   * 首配完成后同步一次原生斜杠命令（飞书输入框里的 `/` 菜单）。
   *
   * 时机与 /repair 相同，依据也相同：application:app_slash_command:write 是刚补进草稿的
   * 权限，要等版本确认发布之后才对 tenant_access_token 生效，发布前写必然 403。
   * configureLarkOpenPlatformApp 正常返回就意味着它内部的 publish_verify 已经通过；
   * 审核中（publish_pending_review）会抛错走上面的 catch，同样不会走到这里。
   *
   * 任何失败都只是没有命令菜单——那是输入便利，不改变「应用已建好并配置完成」的结论，
   * 因此一律吞掉，不把建应用判成失败；用户随时可以再跑一次 /repair 补齐。
   */
  private async syncSlashCommands(appId: string, skippedScopes: readonly string[]) {
    if (skippedScopes.includes(SLASH_COMMAND_SCOPE)) return;
    try {
      const saved = await readLarkConfig(this.options.config, appId);
      if (!saved?.appSecret) return;
      if (this.options.syncSlashCommands) await this.options.syncSlashCommands({ appId, appSecret: saved.appSecret });
      else await createLarkCardService(process.env, this.options.fetcher, { appId, appSecret: saved.appSecret })
        .syncSlashCommands(larkSlashCommandDefinitions());
    } catch { /* 命令菜单缺失不改变建应用的结论；重跑 /repair 可补齐。 */ }
  }
}

function payloadString(payload: unknown, names: string[]): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  for (const source of [record.data, record]) {
    if (!source || typeof source !== 'object') continue;
    for (const name of names) {
      const value = (source as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}
