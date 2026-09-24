import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import {
  configureLarkOpenPlatformApp,
  isValidLarkAppId,
  type LarkOpenPlatformClient,
} from './open-platform-configurator.js';
import {
  connectLarkOpenPlatformSession,
  safeOpenPlatformError,
  type ConnectOpenPlatformSessionOptions,
  type ConnectedOpenPlatformSession,
} from './open-platform-session.js';

export type OpenPlatformConfigurationResult = Awaited<ReturnType<typeof configureLarkOpenPlatformApp>>;
export type OpenPlatformConfigurationJobStatus =
  | 'preparing'
  | 'waiting_for_scan'
  | 'configuring'
  | 'completed'
  | 'failed';

/** Public polling state. It deliberately contains no cookie, CSRF, secret, user ID or email. */
export interface OpenPlatformConfigurationJobState {
  id: string;
  appId: string;
  status: OpenPlatformConfigurationJobStatus;
  createdAt: string;
  updatedAt: string;
  qrDataUrl?: string;
  scanConfirmed?: boolean;
  accountName?: string;
  tenantName?: string;
  result?: OpenPlatformConfigurationResult;
  slashCommands?: 'configured' | 'skipped_scope' | 'skipped_credentials' | 'failed';
  error?: string;
}

export interface StartOpenPlatformConfigurationOptions {
  forceLogin?: boolean;
}

type Connect = (options: ConnectOpenPlatformSessionOptions) => Promise<ConnectedOpenPlatformSession>;
type Configure = (
  client: LarkOpenPlatformClient,
  appId: string,
) => Promise<OpenPlatformConfigurationResult>;
type QrDataUrl = (payload: string) => Promise<string>;

export interface OpenPlatformConfigurationJobManagerOptions {
  connect?: Connect;
  configure?: Configure;
  syncSlashCommands?: (appId: string) => Promise<'skipped_credentials' | void>;
  qrDataUrl?: QrDataUrl;
  now?: () => Date;
  retainedJobLimit?: number;
}

/**
 * Runs configuration outside request latency. One active job per app is reused
 * because version creation/publish cannot be safely replayed after an unknown
 * transport outcome.
 */
export class OpenPlatformConfigurationJobManager {
  private readonly jobs = new Map<string, OpenPlatformConfigurationJobState>();
  private readonly activeByApp = new Map<string, string>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly connect: Connect;
  private readonly configure: Configure;
  private readonly syncSlashCommands?: (appId: string) => Promise<'skipped_credentials' | void>;
  private readonly qrDataUrl: QrDataUrl;
  private readonly now: () => Date;
  private readonly retainedJobLimit: number;

  constructor(options: OpenPlatformConfigurationJobManagerOptions = {}) {
    this.connect = options.connect ?? connectLarkOpenPlatformSession;
    this.configure = options.configure ?? configureLarkOpenPlatformApp;
    this.syncSlashCommands = options.syncSlashCommands;
    this.qrDataUrl = options.qrDataUrl ?? (payload => QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
    }));
    this.now = options.now ?? (() => new Date());
    this.retainedJobLimit = Math.max(1, options.retainedJobLimit ?? 100);
  }

  start(appId: string, options: StartOpenPlatformConfigurationOptions = {}): OpenPlatformConfigurationJobState {
    const normalizedAppId = appId.trim();
    if (!isValidLarkAppId(normalizedAppId)) throw new Error('飞书应用 ID 格式无效，应为 cli_*');

    const activeId = this.activeByApp.get(normalizedAppId);
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && isActive(active.status)) return snapshot(active);
      this.activeByApp.delete(normalizedAppId);
    }
    for (const [activeAppId, id] of this.activeByApp) {
      const active = this.jobs.get(id);
      if (active && isActive(active.status)) {
        throw new Error(`飞书应用 ${activeAppId} 的自动配置仍在进行，请完成后再配置其他应用`);
      }
      this.activeByApp.delete(activeAppId);
    }

    const now = this.now().toISOString();
    const state: OpenPlatformConfigurationJobState = {
      id: randomUUID(),
      appId: normalizedAppId,
      status: 'preparing',
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(state.id, state);
    this.activeByApp.set(normalizedAppId, state.id);
    const run = this.run(state.id, options).finally(() => {
      this.runs.delete(state.id);
      if (this.activeByApp.get(normalizedAppId) === state.id) this.activeByApp.delete(normalizedAppId);
      this.pruneTerminalJobs();
    });
    this.runs.set(state.id, run);
    return snapshot(state);
  }

  get(jobId: string): OpenPlatformConfigurationJobState | undefined {
    const state = this.jobs.get(jobId);
    return state ? snapshot(state) : undefined;
  }

  getActiveForApp(appId: string): OpenPlatformConfigurationJobState | undefined {
    const id = this.activeByApp.get(appId.trim());
    return id ? this.get(id) : undefined;
  }

  /** Primarily useful to orderly-shutdown callers and deterministic tests. */
  async wait(jobId: string): Promise<OpenPlatformConfigurationJobState | undefined> {
    await this.runs.get(jobId);
    return this.get(jobId);
  }

  private async run(jobId: string, options: StartOpenPlatformConfigurationOptions): Promise<void> {
    const state = this.jobs.get(jobId);
    if (!state) return;
    try {
      const connected = await this.connect({
        forceLogin: options.forceLogin,
        onQrUpdate: async update => {
          const current = this.jobs.get(jobId);
          if (!current) return;
          const dataUrl = await this.qrDataUrl(update.qrPayload);
          this.replace(jobId, {
            ...current,
            status: 'waiting_for_scan',
            qrDataUrl: dataUrl,
            scanConfirmed: update.status === 'scan_confirmed',
          });
        },
      });
      if (!hasCompleteOwner(connected)) {
        throw new Error('开放平台未返回当前登录账号和企业信息；为避免配置到错误企业，已停止操作');
      }
      const current = this.jobs.get(jobId);
      if (!current) return;
      this.replace(jobId, {
        ...withoutQr(current),
        status: 'configuring',
        accountName: connected.owner.userName,
        tenantName: connected.owner.tenantName,
      });
      const result = await this.configure(connected.client, state.appId);
      let slashCommands: NonNullable<OpenPlatformConfigurationJobState['slashCommands']>;
      if (['application:app_slash_command:read', 'application:app_slash_command:write']
        .some(scope => result.skippedScopes.includes(scope))) slashCommands = 'skipped_scope';
      else if (!this.syncSlashCommands) slashCommands = 'skipped_credentials';
      else {
        try {
          slashCommands = await this.syncSlashCommands(state.appId) === 'skipped_credentials'
            ? 'skipped_credentials' : 'configured';
        } catch {
          slashCommands = 'failed';
        }
      }
      const configuring = this.jobs.get(jobId);
      if (!configuring) return;
      this.replace(jobId, {
        ...withoutQr(configuring),
        status: 'completed',
        result,
        slashCommands,
      });
    } catch (error) {
      const current = this.jobs.get(jobId);
      if (!current) return;
      this.replace(jobId, {
        ...withoutQr(current),
        status: 'failed',
        error: safeOpenPlatformError(error),
      });
    }
  }

  private replace(jobId: string, state: OpenPlatformConfigurationJobState): void {
    this.jobs.set(jobId, { ...state, updatedAt: this.now().toISOString() });
  }

  private pruneTerminalJobs(): void {
    const terminal = [...this.jobs.values()]
      .filter(job => !isActive(job.status))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const job of terminal.slice(0, Math.max(0, terminal.length - this.retainedJobLimit))) {
      this.jobs.delete(job.id);
    }
  }
}

function isActive(status: OpenPlatformConfigurationJobStatus): boolean {
  return status === 'preparing' || status === 'waiting_for_scan' || status === 'configuring';
}

function hasCompleteOwner(session: ConnectedOpenPlatformSession): boolean {
  const owner = session.owner;
  return Boolean(owner?.userId && owner.userName && owner.tenantId && owner.tenantName);
}

function withoutQr(state: OpenPlatformConfigurationJobState): OpenPlatformConfigurationJobState {
  const { qrDataUrl: _qrDataUrl, scanConfirmed: _scanConfirmed, ...safe } = state;
  return safe;
}

function snapshot(state: OpenPlatformConfigurationJobState): OpenPlatformConfigurationJobState {
  return {
    ...state,
    ...(state.result ? { result: { ...state.result } } : {}),
  };
}
