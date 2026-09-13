import { randomUUID } from 'node:crypto';
import type { AgentRepository, ConfigRepository } from '@dutydeck/shared';
import type { LarkCreateCliOptions } from '../cli-program.js';
import { createCliUi, type CliUi } from '../cli-ui.js';
import { InvalidWorkingDirectoryError, validateWorkingDirectory } from '../setup/detect.js';
import { renderQrToTerminal } from '../setup/lark-bind.js';
import { LarkAppCreationError, LarkAppCreationJobManager, type LarkAppCreationJob } from './app-creation.js';
import { LarkServiceError } from './service.js';
import { publicLarkConfig, readLarkConfig, saveLarkConfig, type PublicLarkConfig } from './config.js';
import { connectLarkOpenPlatformSession } from './open-platform-session.js';

interface Context {
  config: ConfigRepository;
  agents: AgentRepository;
  database: string;
  ui?: CliUi;
  connect?: typeof connectLarkOpenPlatformSession;
  configure?: ConstructorParameters<typeof LarkAppCreationJobManager>[0]['configure'];
  renderQr?: typeof renderQrToTerminal;
}

export interface LarkCreateCliResult {
  ok: boolean;
  job?: Omit<LarkAppCreationJob, 'qrDataUrl'>;
  bot?: PublicLarkConfig;
  restartRequired?: boolean;
  next: string;
  error?: string;
}

class LarkCreateCliError extends Error {}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const active = (job: LarkAppCreationJob) => ['preparing', 'waiting_for_scan', 'creating', 'configuring'].includes(job.status);

/** The CLI owns its creation run; persisted jobs and Bot configs are shared with the Dashboard. */
export async function runLarkCreate(name: string | undefined, options: LarkCreateCliOptions, context: Context): Promise<LarkCreateCliResult> {
  const ui = context.ui ?? createCliUi();
  let job: LarkAppCreationJob | undefined;
  let next = 'dutydeck lark create --help';
  const finish = (result: LarkCreateCliResult) => {
    if (options.json) ui.json(result);
    else {
      if (result.job) ui.keyValues([['任务', result.job.id], ['状态', result.job.status], ...(result.job.appId ? [['应用', result.job.appId] as [string, string]] : [])]);
      if (result.error) ui.status('fail', result.error);
      if (result.job?.status === 'completed') ui.status('done', '应用已创建、配置并发布，已回读确认');
      if (result.job?.status === 'pending_review') ui.notice('应用已完成配置并提交发布，正在等待飞书管理员审核。');
      if (result.bot?.defaultAgentId) ui.status('ok', '执行 Agent', result.bot.defaultAgentId);
      if (result.restartRequired) ui.hint('监听配置已保存；启动或重启 Dutydeck 后生效。');
      ui.hint(result.next);
    }
    return result;
  };
  const publicJob = () => {
    if (!job) return undefined;
    const { qrDataUrl: _qr, ...value } = job;
    return value;
  };
  try {
    if (options.resume && name !== undefined) throw new LarkCreateCliError('--resume 与新机器人名称不能同时使用。');
    if (options.status && !options.resume) throw new LarkCreateCliError('--status 需要 --resume <任务 ID>。');
    if (options.status && (options.agent || options.workspace || options.listen || options.fullTrust)) throw new LarkCreateCliError('--status 只查询状态，不能同时修改 Agent 或监听配置。');
    if (!options.resume && (!name?.trim() || name.trim().length > 50)) throw new LarkCreateCliError('请提供 1–50 字机器人名称。');
    if (options.resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.resume)) throw new LarkCreateCliError('任务 ID 必须是有效的 UUID。');
    if ((options.listen || options.workspace || options.fullTrust) && !options.agent) throw new LarkCreateCliError('--listen、--workspace、--full-trust 需要同时指定 --agent <ID>。');
    if (options.agent && !options.fullTrust) throw new LarkCreateCliError('绑定执行 Agent 需要 --full-trust，明确允许飞书任务无人值守执行。');
    if (!options.status && (options.json || !ui.tty)) throw new LarkCreateCliError('创建或续跑需要在终端扫码；请去掉 --json 并在交互终端执行。脚本可用 --resume <任务 ID> --status --json 查询。');
    const workspace = options.workspace === undefined ? undefined : validateWorkingDirectory(options.workspace);
    if (options.agent && !await context.agents.get(options.agent)) {
      throw new LarkCreateCliError(`未知执行 Agent：${options.agent}。可用 ID：${(await context.agents.list()).map(agent => agent.id).join(', ') || '无'}。`);
    }
    const id = options.resume ?? randomUUID();
    const resume = `dutydeck lark create --resume ${id} --database ${quote(context.database)}`;
    next = `${resume}${options.agent ? ` --agent ${quote(options.agent)} --full-trust` : ''}${workspace ? ` --workspace ${quote(workspace)}` : ''}${options.listen ? ' --listen' : ''}`;
    let renderedPayload: string | undefined;
    const manager = new LarkAppCreationJobManager({
      config: context.config,
      agents: context.agents,
      configure: context.configure,
      connect: async connectOptions => {
        const connected = await (context.connect ?? connectLarkOpenPlatformSession)({
          ...connectOptions,
          onQrUpdate: async update => {
            await connectOptions?.onQrUpdate?.(update);
            if (update.status === 'scan_confirmed') ui.progress('已确认扫码，正在建立开放平台会话…');
            else if (renderedPayload !== update.qrPayload) {
              renderedPayload = update.qrPayload;
              ui.notice('请用飞书扫码确认账号和企业；确认后将创建应用、配置权限并提交发布。');
              ui.progress(await (context.renderQr ?? renderQrToTerminal)(update.qrPayload));
            }
          },
        });
        ui.progress(`账号「${connected.owner.userName}」 / 企业「${connected.owner.tenantName}」；正在创建或继续配置…`);
        return connected;
      },
    });
    if (options.resume) {
      job = await manager.get(id);
      if (!job) throw new LarkCreateCliError('创建任务不存在，请核对任务 ID 和 --database。');
    }
    if (!options.status) {
      // Print recovery information before the first request, including the exact database.
      ui.notice(`中断后续跑同一任务：${next}`);
      if (!job) job = await manager.start(id, name);
      else if (job.status === 'failed' && job.retryable) job = await manager.retry(id);
      await manager.wait(id);
      job = await manager.get(id);
    }
    if (!job) throw new LarkCreateCliError('无法读取创建任务，请使用上面的任务 ID 查询。');
    let bot = job.appId ? await readLarkConfig(context.config, job.appId) : undefined;
    const configured = job.status === 'completed' || job.status === 'pending_review';
    if (!options.status && configured && options.agent) {
      if (!bot) throw new LarkCreateCliError('应用已创建，但本地机器人配置不存在，请在 Dashboard 核对。');
      const listening = options.listen ?? bot.listening;
      if (bot.defaultAgentId !== options.agent || !bot.fullTrustConfirmed || bot.permissionMode === 'ask' || (workspace !== undefined && bot.workspace !== workspace) || bot.listening !== listening) {
        const bots = await saveLarkConfig(context.config, context.agents, {
          stage: 'agent', originalAppId: bot.appId, expectedRevision: bot.revision,
          defaultAgentId: options.agent, workspace, fullTrustConfirmed: true,
          permissionMode: 'full-trust', listening,
        });
        bot = bots.find(value => value.appId === job!.appId)!;
      }
    }
    const restartRequired = !options.status && configured && bot?.listening === true;
    let instruction = next;
    if (job.status === 'completed') instruction = bot?.defaultAgentId
      ? bot.listening ? `监听配置已保存。请执行：dutydeck restart --database ${quote(context.database)}（尚未启动时用 dutydeck start --database ${quote(context.database)}）` : '机器人已配置，监听未启用；可在 Dashboard 启用。'
      : `凭据已保存。可在 Dashboard 选择 Agent，或执行：${resume} --agent <Agent-ID> --full-trust --listen`;
    else if (job.status === 'pending_review') instruction = `版本已提交审核，审核通过后生效。查看审核进度：https://open.feishu.cn/app/${job.appId}${bot?.defaultAgentId ? '' : '；可在 Dashboard 继续选择执行 Agent。'}${bot?.listening ? ` 监听配置已保存。请执行：dutydeck restart --database ${quote(context.database)}（尚未启动时用 dutydeck start --database ${quote(context.database)}）` : ''}`;
    else if (active(job)) instruction = `任务仍在原进程运行，请在原终端或 Dashboard 查看扫码进度。查询：${resume} --status --json`;
    else if (!job.retryable) instruction = `请到 https://open.feishu.cn/app 核对应用状态${job.botSaved ? '，并在 Dashboard 继续配置已保存的机器人' : ''}；本任务不会自动创建第二个应用。`;
    return finish({ ok: configured || (options.status === true && active(job)), job: publicJob(), ...(bot ? { bot: publicLarkConfig(bot) } : {}), ...(restartRequired ? { restartRequired } : {}), next: instruction, ...(job.error ? { error: job.error } : {}) });
  } catch (error) {
    // Only locally generated validation messages are surfaced; the manager redacts upstream failures.
    return finish({ ok: false, job: publicJob(), next, error: error instanceof LarkCreateCliError || error instanceof LarkAppCreationError || error instanceof InvalidWorkingDirectoryError || error instanceof LarkServiceError ? error.message : '本地存储操作失败，请使用同一任务 ID 查询；不要重新创建应用。' });
  }
}
