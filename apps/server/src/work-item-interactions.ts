import { z } from 'zod';
import { stripVTControlCharacters } from 'node:util';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { RelayAskBroker } from '@dutydeck/relay';
import { RuntimeError } from '@dutydeck/shared';
import type { WorkItemService } from './work-items.js';
import { workInput } from './work-item-routes.js';

export interface WorkItemRequest {
  stepId: string;
  sessionId: string;
  taskId: string;
  requestId: string;
  kind: 'permission' | 'question';
  text: string;
}

const responseInput = z.object({
  stepId: z.string().min(1), taskId: z.string().min(1), requestId: z.string().min(1),
  kind: z.enum(['permission', 'question']), answer: z.string().trim().min(1).max(4_000)
}).strict();

export class WorkItemInteractions {
  constructor(private readonly work: WorkItemService, private readonly runtime: DutydeckRuntime, private readonly broker: RelayAskBroker,
    private readonly authorizeInteraction: (parentSessionId: string, actorId: string, action: 'high_risk.execute' | 'terminal.write' | 'terminal.read') => Promise<boolean>) {}

  async list(parentSessionId: string, workId: string, actorId?: string): Promise<WorkItemRequest[]> {
    const item = await this.work.get(parentSessionId, workId, actorId);
    if (['cancelling', 'cancelled', 'completed'].includes(item.status)) return [];
    const requests: WorkItemRequest[] = [];
    for (const step of item.steps) {
      const attempt = step.attempts.at(-1);
      if (!attempt?.sessionId || !attempt.taskId || step.status !== 'running') continue;
      const active = this.runtime.getActiveTaskContext(attempt.sessionId);
      if (active?.taskId !== attempt.taskId) continue;
      const binding = { stepId: step.id, sessionId: attempt.sessionId, taskId: attempt.taskId };
      for (const request of this.runtime.getPendingPermissions(attempt.sessionId)) {
        requests.push({ ...binding, requestId: request.id, kind: 'permission', text: request.title });
      }
      for (const request of this.broker.listPending(attempt.sessionId)) {
        requests.push({ ...binding, requestId: request.id, kind: 'question', text: request.question });
      }
    }
    return requests;
  }

  async respond(parentSessionId: string, workId: string, value: unknown, actorId?: string) {
    const input = workInput(responseInput, value);
    return this.work.withActiveStep(parentSessionId, workId, input.stepId, actorId, async () => {
      const requests = await this.list(parentSessionId, workId, actorId);
      const request = requests.find(request => request.stepId === input.stepId && request.taskId === input.taskId && request.requestId === input.requestId && request.kind === input.kind);
      if (!request) throw new RuntimeError('WORK_ITEM_REQUEST_EXPIRED', '原步骤的问题或授权请求已失效，请刷新目标状态', 409);
      if (input.kind === 'permission') {
        if (!['approve', 'reject'].includes(input.answer)) throw new RuntimeError('WORK_ITEM_PERMISSION_INVALID', '工具请求只接受 approve 或 reject', 400);
        if (input.answer === 'approve') await this.authorizeHuman(parentSessionId, actorId, 'high_risk.execute');
        await this.runtime.resolvePermission(request.sessionId, request.requestId, input.answer === 'approve');
      } else await this.broker.answer(request.requestId, input.answer, { sessionId: request.sessionId });
      return { ok: true };
    });
  }

  private async authorizeHuman(parentSessionId: string, actorId: string | undefined, action: 'high_risk.execute' | 'terminal.write' | 'terminal.read') {
    if (!actorId || !await this.authorizeInteraction(parentSessionId, actorId, action)) throw new RuntimeError('WORK_ITEM_APPROVAL_FORBIDDEN', '当前账号已无权执行此操作', 403);
  }

  async terminal(parentSessionId: string, workId: string, stepId: string, actorId?: string) {
    return this.work.withActiveStep(parentSessionId, workId, stepId, actorId, async () => {
      await this.authorizeHuman(parentSessionId, actorId, 'terminal.read');
      const { attempt, stream } = await this.terminalStream(parentSessionId, workId, stepId, actorId);
      try {
        const screen = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new RuntimeError('WORK_ITEM_TERMINAL_TIMEOUT', '终端画面暂不可用，请稍后重试', 504)), 2000);
          stream.onData(() => {}, screen => { clearTimeout(timer); resolve(stripVTControlCharacters(screen.data).slice(-12_000)); });
        });
        return { stepId, taskId: attempt.taskId!, screen };
      } finally { stream.dispose(); }
    });
  }

  async terminalInput(parentSessionId: string, workId: string, value: unknown, actorId?: string) {
    const input = workInput(z.object({ stepId: z.string().min(1), taskId: z.string().min(1),
      text: z.string().min(1).max(2000).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
      key: z.enum(['enter', 'up', 'down', 'left', 'right', 'tab', 'escape', 'ctrl_c']).optional()
    }).strict().refine(value => Boolean(value.text) !== Boolean(value.key), '请指定一行文字或一个按键'), value);
    return this.work.withActiveStep(parentSessionId, workId, input.stepId, actorId, async () => {
      await this.authorizeHuman(parentSessionId, actorId, 'terminal.write');
      const { attempt, stream } = await this.terminalStream(parentSessionId, workId, input.stepId, actorId);
      try {
        if (attempt.taskId !== input.taskId) throw new RuntimeError('WORK_ITEM_REQUEST_EXPIRED', '此终端已不属于原指令', 409);
        const keys = { enter: '\r', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', tab: '\t', escape: '\x1b', ctrl_c: '\x03' };
        stream.write(input.text ? input.text + '\r' : keys[input.key!]);
        return { ok: true };
      } finally { stream.dispose(); }
    });
  }

  private async terminalStream(parentSessionId: string, workId: string, stepId: string, actorId?: string) {
    const item = await this.work.get(parentSessionId, workId, actorId);
    const step = item.steps.find(step => step.id === stepId);
    if (!['running', 'waiting', 'failed'].includes(item.status) || step?.status !== 'running') throw new RuntimeError('WORK_ITEM_REQUEST_EXPIRED', '原步骤已不再接受终端操作', 409);
    const attempt = step.attempts.at(-1);
    if (!attempt?.sessionId || !attempt.taskId || this.runtime.getActiveTaskContext(attempt.sessionId)?.taskId !== attempt.taskId) throw new RuntimeError('WORK_ITEM_REQUEST_EXPIRED', '原步骤已不再执行', 409);
    const driver = this.runtime.getDriver(attempt.sessionId);
    const stream = driver?.createTerminalStream?.();
    if (!stream) throw new RuntimeError('WORK_ITEM_TERMINAL_UNSUPPORTED', '此步骤不支持终端，请使用工具授权或 Agent 提问入口', 409);
    return { attempt, stream };
  }
}
