import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeError, type CiCallContext, type CiProvider, type CiProviderCall, type CiRepository, type PublicCiProvider } from '@dutydeck/shared';

const run = promisify(execFile);

/** provider 没声明 callTimeoutMs 时，宿主给每次异步调用的时限。 */
export const CI_PROVIDER_CALL_TIMEOUT_MS = 25_000;
/**
 * 宿主兜底上限，provider 声明得再长也不超过：
 * - getPipelineStatus：CI 订阅轮询持 30 秒租约，调用必须在租约内结束，否则另一实例会重复领取；
 * - 其余：PR 跟进每 2 分钟看一次，单次调用不超过一个轮询间隔。
 */
export const CI_PROVIDER_CALL_LIMIT_MS: Readonly<Record<CiProviderCall, number>> = {
  getPipelineStatus: 25_000, getFailureLogs: 120_000, createPullRequest: 120_000, listReviewComments: 120_000,
  getPullRequest: 120_000, postComment: 120_000, 'webhook.verify': 120_000, 'webhook.parse': 120_000
};
type CiLog = { warn(data: Record<string, unknown>, message: string): void };

/**
 * 给第三方 provider 的异步方法套上时限：超时即拒绝，调用方按普通失败处理（轮询记一次失败、下轮再查）。
 * 每次调用传入 { signal }，超时时 abort；写操作超时不代表没执行，报错里写明要去平台核对。
 */
function guardProvider(plugin: string, provider: CiProvider, defaultTimeoutMs: number, log?: CiLog): CiProvider {
  const limit = (method: CiProviderCall) => {
    const declared = provider.callTimeoutMs?.[method];
    const wanted = typeof declared === 'number' && Number.isFinite(declared) ? Math.max(declared, 1_000) : defaultTimeoutMs;
    return Math.min(wanted, CI_PROVIDER_CALL_LIMIT_MS[method]);
  };
  const call = <T>(method: CiProviderCall, invoke: (context: CiCallContext) => T | Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const timeoutMs = limit(method);
    let work: Promise<T>;
    try { work = Promise.resolve(invoke({ signal: controller.signal })); } catch (error) { return Promise.reject(error); }
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const write = method === 'createPullRequest' || method === 'postComment';
        log?.warn({ plugin, provider: provider.id, method, timeoutMs }, 'CI 提供方调用超时，本次跳过');
        controller.abort(new Error('timeout'));
        reject(new RuntimeError('CI_PROVIDER_TIMEOUT', `${provider.displayName} 的 ${method} 超过 ${timeoutMs / 1000} 秒未返回${write ? '；平台上可能已经生效，请先核对再重试' : ''}`, 504));
      }, timeoutMs);
      timer.unref?.();
      work.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); });
    });
  };
  const guarded: CiProvider = {
    id: provider.id, displayName: provider.displayName,
    matchRepository: remoteUrl => provider.matchRepository(remoteUrl),
    ...(provider.changeRequestLabel ? { changeRequestLabel: (number: number) => provider.changeRequestLabel!(number) } : {}),
    ...(provider.getPipelineStatus ? { getPipelineStatus: query => call('getPipelineStatus', context => provider.getPipelineStatus!(query, context)) } : {}),
    ...(provider.getFailureLogs ? { getFailureLogs: (repository, runId) => call('getFailureLogs', context => provider.getFailureLogs!(repository, runId, context)) } : {}),
    ...(provider.createPullRequest ? { createPullRequest: (repository, input) => call('createPullRequest', context => provider.createPullRequest!(repository, input, context)) } : {}),
    ...(provider.listReviewComments ? { listReviewComments: (repository, number) => call('listReviewComments', context => provider.listReviewComments!(repository, number, context)) } : {}),
    ...(provider.getPullRequest ? { getPullRequest: (repository, number) => call('getPullRequest', context => provider.getPullRequest!(repository, number, context)) } : {}),
    ...(provider.postComment ? { postComment: (repository, number, body) => call('postComment', context => provider.postComment!(repository, number, body, context)) } : {}),
    ...(provider.webhook ? { webhook: {
      verify: request => call('webhook.verify', context => provider.webhook!.verify(request, context)),
      parse: request => call('webhook.parse', context => provider.webhook!.parse(request, context))
    } } : {})
  };
  return guarded;
}

/** 已加载插件注册的 CI 提供方。没有 CI 插件时为空，/ci 等入口据此回「未安装 CI 插件」。 */
export class CiProviderRegistry {
  private readonly providers = new Map<string, { plugin: string; provider: CiProvider }>();
  constructor(private readonly options: { timeoutMs?: number; log?: CiLog } = {}) {}

  register(plugin: string, provider: CiProvider) {
    if (!provider || typeof provider.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(provider.id)) throw new Error('CI 提供方的 id 必须是小写字母开头的 kebab-case');
    if (typeof provider.displayName !== 'string' || !provider.displayName.trim()) throw new Error(`CI 提供方 ${provider.id} 缺少 displayName`);
    if (typeof provider.matchRepository !== 'function') throw new Error(`CI 提供方 ${provider.id} 缺少 matchRepository`);
    if (provider.webhook && (typeof provider.webhook.verify !== 'function' || typeof provider.webhook.parse !== 'function')) throw new Error(`CI 提供方 ${provider.id} 的 webhook 需要 verify 和 parse`);
    const existing = this.providers.get(provider.id);
    if (existing) throw new Error(`CI 提供方 ${provider.id} 已由插件 ${existing.plugin} 注册`);
    this.providers.set(provider.id, { plugin, provider: guardProvider(plugin, provider, this.options.timeoutMs ?? CI_PROVIDER_CALL_TIMEOUT_MS, this.options.log) });
  }

  get size() { return this.providers.size; }
  get(id: string): CiProvider | undefined { return this.providers.get(id)?.provider; }
  list(): Array<{ plugin: string; provider: CiProvider }> { return [...this.providers.values()]; }

  /** 第一个认领这个远端地址的提供方；filter 用来只看有某项能力的提供方。 */
  match(remoteUrl: string, filter: (provider: CiProvider) => boolean = () => true): { provider: CiProvider; repository: CiRepository } | undefined {
    for (const { provider } of this.providers.values()) {
      if (!filter(provider)) continue;
      let repository: CiRepository | undefined;
      try { repository = provider.matchRepository(remoteUrl); } catch { repository = undefined; }
      if (repository && typeof repository.slug === 'string' && repository.slug) return { provider, repository };
    }
    return undefined;
  }

  describe(): PublicCiProvider[] {
    return this.list().map(({ provider }) => ({ id: provider.id, displayName: provider.displayName, polling: typeof provider.getPipelineStatus === 'function', webhook: Boolean(provider.webhook) }));
  }
}

export const ciProviderLabel = (registry: CiProviderRegistry | undefined, id: string) => registry?.get(id)?.displayName ?? id;
export const changeRequestLabel = (provider: CiProvider | undefined, number: number) => provider?.changeRequestLabel?.(number) ?? `#${number}`;

export async function git(cwd: string, args: string[]) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export interface CiHead { provider: CiProvider; repository: CiRepository; headSha: string }

/**
 * 读取工作区 origin 与 HEAD，交给认领 origin 的 CI 提供方解析仓库。
 * providerId 给定时只认这个提供方；没有提供方认领时抛 CI_REMOTE_UNSUPPORTED。
 */
export async function resolveCiHead(cwd: string, registry: CiProviderRegistry, providerId?: string, filter?: (provider: CiProvider) => boolean): Promise<CiHead> {
  let remote: string;
  let headSha: string;
  try { [remote, headSha] = await Promise.all([git(cwd, ['remote', 'get-url', 'origin']), git(cwd, ['rev-parse', '--verify', 'HEAD'])]); }
  catch { throw new RuntimeError('CI_REPOSITORY_UNAVAILABLE', '工作区需要是带 origin 和 HEAD 的 Git 仓库', 400); }
  headSha = headSha.toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(headSha)) throw new RuntimeError('CI_HEAD_INVALID', '工作区 HEAD 不是完整的提交 SHA', 400);
  if (providerId && !registry.get(providerId)) throw new RuntimeError('CI_PROVIDER_UNAVAILABLE', `CI 插件提供方 ${providerId} 没有加载`, 409);
  const matched = registry.match(remote, provider => (!providerId || provider.id === providerId) && (filter?.(provider) ?? true));
  if (!matched) {
    throw new RuntimeError('CI_REMOTE_UNSUPPORTED', providerId
      ? `当前工作区的 origin 不归 ${ciProviderLabel(registry, providerId)} 处理`
      : registry.size ? '当前工作区的 origin 不属于任何已安装的 CI 插件' : '还没有安装 CI 插件', 400);
  }
  return { ...matched, headSha };
}

/** webhook 续作需要停在本地分支上：分支名会写进交给 Agent 的 git 命令，只接受不含 shell 特殊字符的名字。 */
export async function resolveCiBranchHead(cwd: string, registry: CiProviderRegistry, providerId?: string): Promise<(CiHead & { branch: string }) | undefined> {
  let remote: string;
  try { remote = await git(cwd, ['remote', 'get-url', 'origin']); } catch { return undefined; }
  const matched = registry.match(remote, provider => Boolean(provider.webhook) && (!providerId || provider.id === providerId));
  if (!matched) return undefined;
  let branch = '';
  let headSha = '';
  try { [branch, headSha] = await Promise.all([git(cwd, ['symbolic-ref', '--short', 'HEAD']), git(cwd, ['rev-parse', '--verify', 'HEAD'])]); }
  catch { /* 下方统一报错 */ }
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || !/^[a-f0-9]{40}$/.test(headSha)) {
    throw new RuntimeError('CI_HEAD_UNAVAILABLE', '工作区需要停在一个名字只含字母、数字和 ._/- 的本地分支上，且已有提交', 400);
  }
  return { ...matched, branch, headSha };
}
