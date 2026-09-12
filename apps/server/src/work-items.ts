import { createHash } from 'node:crypto';
import { createWorkItemSchema, installationOwnerTaskActor, RuntimeError, workPlanSchema, type CreateWorkItemInput, type PermissionMode, type RepositoryBundle, type Session, type TaskRecord, type ToolRiskPolicy, type WorkItem, type WorkPlan, type WorkStep, type WorkTemplate } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';

const PREFIX = 'work_item:';
const TEMPLATES = 'work_template:';
const OUTPUT_BYTES = 512 * 1024;
const TIMEOUT_MS = 60 * 60_000;
const PREPARE_TIMEOUT_MS = 60_000;
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RuntimeError('WORK_ITEM_TIMEOUT', 'Execution preparation or stop timed out; resource state requires reconciliation', 409)), Math.max(1, milliseconds));
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const time = () => new Date().toISOString();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const last = (step: WorkStep) => step.attempts.at(-1);
const settled = (step: WorkStep) => ['completed', 'skipped'].includes(step.status);
const fingerprint = (value: unknown) => hash(JSON.stringify(value));
interface FrozenAgent { fingerprint: string; permissionMode: PermissionMode }
interface StoredWork {
  item: WorkItem;
  actorId: string;
  inputHash: string;
  parentFingerprint: string;
  cwd: string;
  riskPolicy?: ToolRiskPolicy;
  agents: Record<string, FrozenAgent>;
  stoppedAttempts: string[];
}
interface StoredTemplate { template: WorkTemplate; actorId: string }
interface RecordState { raw: string; value: StoredWork }
export interface WorkItemServiceOptions {
  repositories: RepositoryBundle;
  runtime: DutydeckRuntime;
  authorize: (parentSessionId: string, actorId?: string) => Promise<boolean>;
  authorizeAgent?: (parentSessionId: string, actorId: string, agentId: string) => Promise<boolean>;
  prepareDelivery?: (parentSessionId: string, workId: string, idempotencyKey: string) => Promise<void>;
  deliver?: (item: WorkItem) => Promise<void>;
  notify?: (item: WorkItem, actorId: string) => Promise<void>;
}

/** One daemon owns graph progression; Config CAS also fences stale continuations. */
export class WorkItemService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private ticking?: Promise<void>;
  private readonly effects = new Map<string, Promise<void>>();
  private closed = false;
  private timer?: NodeJS.Timeout;
  constructor(private readonly options: WorkItemServiceOptions) {
    if (!options.repositories.config.compareAndSet || !options.repositories.config.list) throw new Error('Work items require ConfigRepository CAS and list');
  }
  /** Start only after Runtime recovery and application wiring are ready. */
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000);
    this.timer.unref();
  }
  private get repos() {
    if (this.closed) throw new RuntimeError('WORK_ITEM_CLOSED', 'Work-item service is closed', 503);
    return this.options.repositories;
  }
  private effect(key: string, action: () => Promise<void>) {
    if (this.closed || this.effects.has(key)) return;
    const run = Promise.resolve().then(async () => { if (!this.closed) await action(); }).catch(() => {});
    this.effects.set(key, run);
    void run.finally(() => { if (this.effects.get(key) === run) this.effects.delete(key); });
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  private async read(id: string): Promise<RecordState> {
    const raw = await this.repos.config.get(PREFIX + id);
    if (!raw) throw new RuntimeError('WORK_ITEM_NOT_FOUND', 'Work item not found', 404);
    return { raw, value: JSON.parse(raw) as StoredWork };
  }
  private async write(state: RecordState) {
    state.value.item.revision++;
    state.value.item.updatedAt = time();
    const raw = JSON.stringify(state.value);
    if (!await this.repos.config.compareAndSet!(PREFIX + state.value.item.id, state.raw, raw)) throw new RuntimeError('WORK_ITEM_CONFLICT', 'Work item changed; refresh before continuing', 409);
    state.raw = raw;
  }
  private async records(): Promise<StoredWork[]> {
    return (await this.repos.config.list!(PREFIX)).map(row => JSON.parse(row.value) as StoredWork);
  }
  private parentFingerprint(session: Session) {
    return fingerprint({ agentId: session.agentId, cwd: session.cwd, permissionMode: session.permissionMode, model: session.model, reasoningEffort: session.reasoningEffort, systemPrompt: session.systemPrompt, source: session.source, sourceId: session.sourceId });
  }
  private async access(parentSessionId: string, actorId?: string): Promise<Session> {
    if (!actorId || !await this.options.authorize(parentSessionId, actorId)) throw new RuntimeError('WORK_ITEM_FORBIDDEN', 'Work-item access denied', 403);
    const parent = await this.repos.sessions.get(parentSessionId);
    if (!parent || parent.source === 'work_item') throw new RuntimeError('WORK_ITEM_PARENT_INVALID', 'A work item requires an active parent session', 409);
    return parent;
  }
  private async owned(parentSessionId: string, id: string, actorId?: string): Promise<RecordState> {
    await this.access(parentSessionId, actorId);
    const state = await this.read(id);
    if (state.value.item.parentSessionId !== parentSessionId || (actorId !== state.value.actorId && actorId !== installationOwnerTaskActor)) throw new RuntimeError('WORK_ITEM_FORBIDDEN', 'Work-item access denied', 403);
    return state;
  }
  private revision(state: RecordState, expected: number) {
    if (state.value.item.revision !== expected) throw new RuntimeError('WORK_ITEM_CONFLICT', 'Work item changed; refresh before continuing', 409);
  }
  private async assertExecution(record: StoredWork, allowTerminal = false) {
    const parent = await this.access(record.item.parentSessionId, record.actorId);
    if (parent.archivedAt || ['stopped', 'failed'].includes(parent.state)) throw new RuntimeError('WORK_ITEM_PARENT_INACTIVE', 'Parent session is not runnable', 409);
    if (!allowTerminal && ['cancelling', 'cancelled', 'completed', 'blocked'].includes(record.item.status)) throw new RuntimeError('WORK_ITEM_TASK_REVOKED', 'Work item no longer accepts execution', 409);
    if (this.parentFingerprint(parent) !== record.parentFingerprint) throw new RuntimeError('WORK_ITEM_CONFIG_DRIFT', 'Parent configuration changed; this work item is blocked', 409);
    for (const [agentId, frozen] of Object.entries(record.agents)) {
      if (this.options.authorizeAgent && !await this.options.authorizeAgent(record.item.parentSessionId, record.actorId, agentId)) throw new RuntimeError('WORK_ITEM_AGENT_FORBIDDEN', 'Agent selection is no longer authorized', 403);
      const agent = await this.repos.agents.get(agentId);
      if (!agent || fingerprint(agent) !== frozen.fingerprint) throw new RuntimeError('WORK_ITEM_CONFIG_DRIFT', 'Agent configuration changed; this work item is blocked', 409);
    }
  }
  async parentForSession(sessionId: string): Promise<{ parentSessionId: string; actorId: string; workId: string; stepId: string } | undefined> {
    const record = (await this.records()).find(record => record.item.steps.some(step => step.attempts.some(attempt => attempt.sessionId === sessionId)));
    if (!record) return undefined;
    const step = record.item.steps.find(step => step.attempts.some(attempt => attempt.sessionId === sessionId))!;
    return { parentSessionId: record.item.parentSessionId, actorId: record.actorId, workId: record.item.id, stepId: step.id };
  }
  async authorizeExecution(sessionId: string, actorId?: string): Promise<boolean> {
    const binding = await this.parentForSession(sessionId);
    if (!binding) {
      if ((await this.repos.sessions.get(sessionId))?.source === 'work_item') throw new RuntimeError('WORK_ITEM_TASK_REVOKED', 'Orphaned work-item session', 403);
      return false;
    }
    const { value } = await this.read(binding.workId);
    const step = value.item.steps.find(step => step.id === binding.stepId)!;
    if (actorId !== value.actorId || last(step)?.sessionId !== sessionId || step.status !== 'running' || this.closed || Date.now() - Date.parse(last(step)!.createdAt) >= TIMEOUT_MS) throw new RuntimeError('WORK_ITEM_TASK_REVOKED', 'Work attempt is no longer active', 403);
    try {
      await this.assertExecution(value);
      const session = await this.repos.sessions.get(sessionId);
      if (session) {
        const definition = value.item.plan.steps.find(definition => definition.id === step.id)!;
        const agent = await this.repos.agents.get(definition.agentId!);
        if (session.agentId !== definition.agentId || session.source !== 'work_item' || session.sourceId !== last(step)!.id || session.permissionMode !== value.agents[definition.agentId!]!.permissionMode || (session.model ?? undefined) !== agent?.model || (session.reasoningEffort ?? undefined) !== agent?.reasoningEffort || (session.systemPrompt ?? undefined) !== agent?.systemPrompt) throw new Error('Child execution configuration changed');
        const workspace = await this.options.runtime.getWorkspace(sessionId);
        if (workspace && (workspace.cwd !== session.cwd || workspace.sourceCwd !== value.cwd || workspace.mode !== (definition.workspaceMode ?? 'shared'))) throw new Error('Child workspace changed');
      }
    }
    catch (error) { throw new RuntimeError('WORK_ITEM_TASK_REVOKED', errorText(error), 403); }
    return true;
  }
  async authorizeTask(session: Session, task: TaskRecord, _phase: 'prepare' | 'submit'): Promise<void> {
    if (session.source !== 'work_item') return;
    await this.authorizeExecution(session.id, task.executionContext?.actorId);
    const binding = await this.parentForSession(session.id);
    const { value } = await this.read(binding!.workId);
    const attempt = last(value.item.steps.find(step => step.id === binding!.stepId)!);
    if (attempt?.taskId !== task.id) throw new RuntimeError('WORK_ITEM_TASK_REVOKED', 'Unexpected task for work attempt', 403);
  }
  async create(parentSessionId: string, input: CreateWorkItemInput, actorId?: string): Promise<WorkItem> {
    input = createWorkItemSchema.parse(input);
    const parent = await this.access(parentSessionId, actorId);
    if (parent.archivedAt || ['stopped', 'failed'].includes(parent.state)) throw new RuntimeError('WORK_ITEM_PARENT_INACTIVE', 'Parent session is not runnable', 409);
    const id = 'work_' + hash(JSON.stringify([parentSessionId, actorId, input.idempotencyKey]));
    return this.serial(id, async () => {
      const existing = await this.repos.config.get(PREFIX + id);
      const inputHash = fingerprint(input);
      if (existing) {
        const record = JSON.parse(existing) as StoredWork;
        if (record.inputHash !== inputHash) throw new RuntimeError('WORK_ITEM_IDEMPOTENCY_CONFLICT', 'Request key already belongs to another plan', 409);
        return record.item;
      }
      const agents: Record<string, FrozenAgent> = {};
      const rank: PermissionMode[] = ['deny-all', 'ask', 'approve-reads', 'full-trust'];
      for (const step of input.plan.steps) if (step.kind === 'agent') {
        if (this.options.authorizeAgent && !await this.options.authorizeAgent(parentSessionId, actorId!, step.agentId!)) throw new RuntimeError('WORK_ITEM_AGENT_FORBIDDEN', 'Agent selection is not authorized', 403);
        const agent = await this.repos.agents.get(step.agentId!);
        if (!agent) throw new RuntimeError('AGENT_NOT_FOUND', `Unknown agent: ${step.agentId}`, 404);
        const permissionMode = rank[Math.min(rank.indexOf(parent.permissionMode ?? 'ask'), rank.indexOf(agent.permissionMode))]!;
        agents[agent.id] = { fingerprint: fingerprint(agent), permissionMode };
      }
      const currentTask = this.options.runtime.getActiveTaskContext(parentSessionId);
      const parentTask = currentTask ? (await this.repos.tasks.listBySession(parentSessionId)).find(task => task.id === currentTask.taskId) : undefined;
      const timestamp = time();
      const item: WorkItem = { id, parentSessionId, title: input.plan.title, goal: input.goal, revision: 1, status: 'running', plan: input.plan, steps: input.plan.steps.map(step => ({ id: step.id, status: 'pending', attempts: [] })), createdAt: timestamp, updatedAt: timestamp, delivery: { status: this.options.deliver ? 'pending' : 'not_requested', attempts: 0 } };
      const record: StoredWork = { item, actorId: actorId!, inputHash, parentFingerprint: this.parentFingerprint(parent), cwd: parent.cwd, agents, stoppedAttempts: [], riskPolicy: parentTask?.executionContext?.riskPolicy };
      await this.options.prepareDelivery?.(parentSessionId, id, input.idempotencyKey);
      await this.access(parentSessionId, actorId);
      if (!await this.repos.config.compareAndSet!(PREFIX + id, undefined, JSON.stringify(record))) throw new RuntimeError('WORK_ITEM_CONFLICT', 'Work-item creation conflicted', 409);
      return structuredClone(item);
    });
  }
  async listBySession(parentSessionId: string, actorId?: string): Promise<WorkItem[]> {
    await this.access(parentSessionId, actorId);
    return (await this.records()).filter(record => record.item.parentSessionId === parentSessionId && (record.actorId === actorId || actorId === installationOwnerTaskActor)).map(record => record.item);
  }
  async get(parentSessionId: string, id: string, actorId?: string): Promise<WorkItem> { return (await this.owned(parentSessionId, id, actorId)).value.item; }

  async cancel(parentSessionId: string, id: string, expectedRevision: number, actorId?: string): Promise<WorkItem> {
    // The durable intent does not wait for an in-progress driver start or send.
    await this.serial('control:' + id, async () => {
      const state = await this.owned(parentSessionId, id, actorId);
      this.revision(state, expectedRevision);
      if (['completed', 'cancelled'].includes(state.value.item.status)) return;
      state.value.item.status = 'cancelling';
      state.value.item.delivery.status = 'not_requested';
      await this.write(state);
    });
    if ((await this.read(id)).value.item.status !== 'cancelling') return (await this.read(id)).value.item;
    await this.serial('control:' + id, () => this.cancelChildren(id));
    return (await this.read(id)).value.item;
  }
  private async cancelChildren(id: string) {
    const state = await this.read(id);
    let unresolved = false;
    for (const step of state.value.item.steps) {
      if (settled(step) || step.status === 'cancelled') continue;
      const attempt = last(step);
      if (attempt?.sessionId && ['running', 'blocked'].includes(step.status)) {
        let stopped = state.value.stoppedAttempts.includes(attempt.id);
        try { stopped ||= await bounded(this.options.runtime.stopWorkItemSession(attempt.sessionId), 10_000); } catch { /* Unknown resources remain blocked. */ }
        if (!stopped && await this.repos.sessions.get(attempt.sessionId)) {
          attempt.status = 'blocked'; attempt.error = 'Cannot prove the owned execution resource stopped'; step.status = 'blocked'; unresolved = true; continue;
        }
        if (stopped) state.value.stoppedAttempts.push(attempt.id);
      }
      step.status = 'cancelled';
      if (attempt && attempt.status !== 'completed') { attempt.status = 'cancelled'; attempt.updatedAt = time(); }
    }
    state.value.item.status = unresolved ? 'blocked' : 'cancelled';
    state.value.item.error = unresolved ? 'Cancellation requires execution-resource reconciliation' : undefined;
    await this.write(state);
  }
  /** Serializes short permission decisions with the durable cancellation intent. */
  async withActiveStep<T>(parentSessionId: string, id: string, stepId: string, actorId: string | undefined, action: () => Promise<T>): Promise<T> {
    return this.serial('control:' + id, async () => {
      const { value } = await this.owned(parentSessionId, id, actorId);
      const step = value.item.steps.find(step => step.id === stepId);
      if (!['running', 'waiting', 'failed'].includes(value.item.status) || step?.status !== 'running') throw new RuntimeError('WORK_ITEM_TASK_REVOKED', 'Work step no longer accepts decisions', 409);
      await this.assertExecution(value);
      return action();
    });
  }

  async retryStep(parentSessionId: string, id: string, stepId: string, expectedRevision: number, actorId?: string): Promise<WorkItem> {
    return this.serial(id, async () => {
      const state = await this.owned(parentSessionId, id, actorId); this.revision(state, expectedRevision);
      const step = state.value.item.steps.find(step => step.id === stepId);
      if (!step || step.status !== 'failed' || step.attempts.length >= 3 || ['cancelled', 'cancelling'].includes(state.value.item.status) || state.value.item.delivery.status === 'not_requested' && state.value.item.error?.startsWith('Cancellation')) throw new RuntimeError('WORK_ITEM_RETRY_UNSAFE', 'Only a settled failed step can be retried, at most three attempts', 409);
      await this.assertExecution(state.value);
      step.status = 'pending'; state.value.item.status = 'running'; delete state.value.item.error;
      await this.write(state); return state.value.item;
    });
  }
  async answer(parentSessionId: string, id: string, stepId: string, answer: string, expectedRevision: number, actorId?: string): Promise<WorkItem> {
    if (!answer.trim() || answer.length > 4000) throw new RuntimeError('WORK_ITEM_ANSWER_INVALID', 'Answer must contain 1–4000 characters', 400);
    return this.serial(id, async () => {
      const state = await this.owned(parentSessionId, id, actorId); this.revision(state, expectedRevision);
      const step = state.value.item.steps.find(step => step.id === stepId);
      if (!step || step.status !== 'waiting' || !['waiting', 'running'].includes(state.value.item.status)) throw new RuntimeError('WORK_ITEM_NOT_WAITING', 'This step is not awaiting an answer', 409);
      await this.assertExecution(state.value);
      step.answer = answer; step.status = 'completed'; state.value.item.status = 'running';
      await this.write(state); return state.value.item;
    });
  }
  async saveTemplate(parentSessionId: string, workId: string, name: string, actorId?: string): Promise<WorkTemplate> {
    if (!name.trim() || name.length > 200) throw new RuntimeError('WORK_TEMPLATE_NAME_INVALID', 'Template name must contain 1–200 characters');
    const { value } = await this.owned(parentSessionId, workId, actorId);
    const id = 'template_' + hash(JSON.stringify([parentSessionId, actorId, name.trim()]));
    return this.serial(id, async () => {
      const records = (await this.repos.config.list!(TEMPLATES + id + ':')).map(row => JSON.parse(row.value) as StoredTemplate);
      const version = Math.max(0, ...records.map(record => record.template.version)) + 1;
      const template: WorkTemplate = { id, parentSessionId, name: name.trim(), version, plan: workPlanSchema.parse(value.item.plan), createdAt: time() };
      if (!await this.repos.config.compareAndSet!(TEMPLATES + id + ':' + version, undefined, JSON.stringify({ template, actorId: value.actorId }))) throw new RuntimeError('WORK_TEMPLATE_CONFLICT', 'Template version changed', 409);
      return template;
    });
  }
  async listTemplates(parentSessionId: string, actorId?: string): Promise<WorkTemplate[]> {
    await this.access(parentSessionId, actorId);
    return (await this.repos.config.list!(TEMPLATES)).map(row => JSON.parse(row.value) as StoredTemplate).filter(record => record.template.parentSessionId === parentSessionId && (record.actorId === actorId || actorId === installationOwnerTaskActor)).map(record => record.template);
  }
  async runTemplate(parentSessionId: string, templateId: string, version: number, goal: string, idempotencyKey: string, actorId?: string): Promise<WorkItem> {
    const template = (await this.listTemplates(parentSessionId, actorId)).find(template => template.id === templateId && template.version === version);
    if (!template) throw new RuntimeError('WORK_TEMPLATE_NOT_FOUND', 'Template version not found', 404);
    return this.create(parentSessionId, { goal, plan: template.plan, idempotencyKey }, actorId);
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const run = this.runTick(); this.ticking = run;
    void run.finally(() => { if (this.ticking === run) this.ticking = undefined; }).catch(() => {});
    return run;
  }
  private async runTick() {
    for (const record of await this.records()) {
      if (this.closed) break;
      try { await this.serial(record.item.id, () => this.drive(record.item.id)); }
      catch (error) {
        if (this.closed) break;
        if (error instanceof RuntimeError && error.code === 'WORK_ITEM_CONFLICT') continue;
        const state = await this.read(record.item.id);
        if (['cancelling', 'cancelled', 'completed'].includes(state.value.item.status)) continue;
        state.value.item.status = 'blocked'; state.value.item.error = errorText(error);
        try { await this.haltBlocked(state); await this.write(state); } catch { /* A concurrent cancel wins. */ }
      }
      if (this.closed) break;
      const latest = (await this.read(record.item.id)).value;
      const current = latest.item;
      if (['running', 'waiting', 'failed', 'blocked'].includes(current.status)) {
        this.effect('notify:' + current.id, async () => { await this.options.notify?.(structuredClone(current), latest.actorId); });
      }
    }
  }
  private async output(sessionId: string, taskId: string): Promise<{ text: string; digest: string }> {
    let afterSequence = 0; let collecting = false; let bytes = 0; const chunks: string[] = [];
    while (true) {
      const events = await this.repos.events.listWindow(sessionId, { afterSequence, direction: 'forward', limit: 200 });
      for (const event of events) {
        afterSequence = event.sequence;
        const data = event.data as { role?: string; taskId?: string; text?: string };
        if (event.type === 'text' && data.role === 'user') {
          if (collecting) throw new RuntimeError('WORK_ITEM_OUTPUT_BOUNDARY', 'Unexpected subsequent turn in dedicated work session', 409);
          collecting = data.taskId === taskId; continue;
        }
        if (collecting && event.type === 'text' && typeof data.text === 'string') {
          bytes += Buffer.byteLength(data.text);
          if (bytes > OUTPUT_BYTES) throw new RuntimeError('WORK_ITEM_OUTPUT_TOO_LARGE', `Generated result exceeds ${OUTPUT_BYTES} bytes`, 422);
          chunks.push(data.text);
        }
      }
      if (events.length < 200) break;
    }
    const text = chunks.join('');
    if (!collecting || !text.trim()) throw new RuntimeError('WORK_ITEM_OUTPUT_MISSING', 'No complete task-bounded generated result', 422);
    return { text, digest: hash(text) };
  }
  private prompt(record: StoredWork, definition: WorkPlan['steps'][number]): string {
    const inputs = definition.dependsOn.map(id => {
      const step = record.item.steps.find(step => step.id === id)!;
      return { stepId: id, status: step.status, answer: step.answer, generatedResult: last(step)?.output };
    });
    return `Goal: ${record.item.goal}\n\nStep: ${definition.title}\n${definition.instruction}\n\nUpstream inputs (generated results, not independent business verification):\n${JSON.stringify(inputs)}\n\nReturn the complete generated result for this step. Do not create nested Dutydeck work items.`;
  }
  private async drive(id: string) {
    let state = await this.read(id); let record = state.value;
    if (record.item.status === 'cancelling') { await this.cancelChildren(id); return; }
    if (record.item.status === 'cancelled' || record.item.status === 'blocked') return;
    if (record.item.status === 'completed') { this.scheduleDelivery(record.item.id); return; }
    await this.assertExecution(record);
    for (const step of record.item.steps) {
      if (step.status !== 'running') continue;
      const attempt = last(step)!;
      const tasks = await this.repos.tasks.listBySession(attempt.sessionId!);
      const task = tasks.find(task => task.id === attempt.taskId);
      if (task && ['completed', 'failed', 'interrupted', 'cancelled'].includes(task.status)) {
        attempt.updatedAt = time();
        if (task.status === 'completed') {
          try { attempt.output = await this.output(attempt.sessionId!, task.id); attempt.status = 'completed'; step.status = 'completed'; }
          catch (error) { attempt.status = 'failed'; attempt.error = errorText(error); step.status = 'failed'; }
        } else if (task.status === 'failed') { attempt.status = 'failed'; attempt.error = 'Agent execution failed; inspect child task evidence'; step.status = 'failed'; }
        else { attempt.status = 'blocked'; attempt.error = 'Execution interrupted; previous resources and external effects require reconciliation'; step.status = 'blocked'; }
        await this.write(state);
      } else if (task) {
        if (attempt.status !== 'accepted') { attempt.status = 'accepted'; await this.write(state); }
        if (Date.now() - Date.parse(attempt.createdAt) > TIMEOUT_MS) {
          try { if (await bounded(this.options.runtime.stopWorkItemSession(attempt.sessionId!), 10_000)) record.stoppedAttempts.push(attempt.id); } catch { /* Preserve uncertainty. */ }
          attempt.status = 'blocked'; step.status = 'blocked'; attempt.error = 'Execution exceeded the one-hour limit; inspect external effects before retry'; await this.write(state);
        }
      } else if (attempt.status === 'preparing') {
        await this.launch(state, step);
      }
    }
    if (record.item.steps.some(step => step.status === 'blocked')) { record.item.status = 'blocked'; record.item.error = 'An execution requires reconciliation'; await this.haltBlocked(state); await this.write(state); return; }
    if (record.item.steps.some(step => step.status === 'failed')) { if (record.item.status !== 'failed') { record.item.status = 'failed'; await this.write(state); } return; }
    for (const definition of record.item.plan.steps) {
      const step = record.item.steps.find(step => step.id === definition.id)!;
      if (step.status !== 'pending' || !definition.dependsOn.every(id => settled(record.item.steps.find(step => step.id === id)!))) continue;
      if (definition.when && record.item.steps.find(step => step.id === definition.when!.stepId)?.answer !== definition.when.equals || definition.dependsOn.length > 0 && definition.dependsOn.every(id => record.item.steps.find(step => step.id === id)?.status === 'skipped')) {
        step.status = 'skipped'; await this.write(state); continue;
      }
      if (definition.kind === 'wait') { step.status = 'waiting'; await this.write(state); continue; }
      const globalActive = (await this.records()).reduce((sum, record) => sum + record.item.steps.filter(step => step.status === 'running' || step.status === 'blocked' && !!last(step)?.sessionId && !record.stoppedAttempts.includes(last(step)!.id)).length, 0);
      if (record.item.steps.filter(step => step.status === 'running').length >= 3 || globalActive >= 6) break;
      const number = step.attempts.length + 1;
      const attemptId = `${id}:${step.id}:${number}`;
      const sessionId = 'ses_work_' + hash(attemptId);
      const taskId = 'task_' + hash(`${sessionId}\0${attemptId}`);
      step.attempts.push({ id: attemptId, number, sessionId, taskId, status: 'preparing', createdAt: time(), updatedAt: time() });
      step.status = 'running'; await this.write(state);
      await this.launch(state, step);
      if (record.item.steps.some(step => step.status === 'blocked')) { await this.haltBlocked(state); await this.write(state); return; }
    }
    const output = record.item.steps.find(step => step.id === record.item.plan.outputStepId)!;
    if (output.status === 'completed') {
      record.item.output = { ...last(output)!.output!, stepId: output.id }; record.item.status = 'completed'; await this.write(state); this.scheduleDelivery(record.item.id);
    } else {
      const status = record.item.steps.some(step => step.status === 'running') ? 'running' : record.item.steps.some(step => step.status === 'waiting') ? 'waiting' : output.status === 'skipped' ? 'blocked' : 'running';
      if (status !== record.item.status) { record.item.status = status; await this.write(state); }
    }
  }
  private async launch(state: RecordState, step: WorkStep) {
    const record = state.value; const attempt = last(step)!;
    const definition = record.item.plan.steps.find(definition => definition.id === step.id)!;
    try {
      await this.authorizeExecution(attempt.sessionId!, record.actorId);
      const existing = await this.repos.sessions.get(attempt.sessionId!);
      if (existing && ['created', 'starting', 'failed', 'stopped', 'interrupted'].includes(existing.state)) throw new RuntimeError('WORK_ITEM_START_UNCERTAIN', 'Previous session startup or execution cannot safely be repeated', 409);
      const accepted = await bounded((async () => {
        const session = await this.options.runtime.startWorkItemSession({ agentId: definition.agentId!, cwd: record.cwd, permissionMode: record.agents[definition.agentId!]!.permissionMode, workspaceMode: definition.workspaceMode ?? 'shared', source: 'work_item', sourceId: attempt.id }, attempt.sessionId!, async () => { await this.authorizeExecution(attempt.sessionId!, record.actorId); });
        await this.authorizeExecution(session.id, record.actorId);
        const prompt = this.prompt(record, definition);
        return this.options.runtime.dispatch(session.id, prompt, 'queue', prompt, record.riskPolicy, record.actorId, attempt.id, definition.skills);
      })(), Math.min(PREPARE_TIMEOUT_MS, TIMEOUT_MS - (Date.now() - Date.parse(attempt.createdAt))));
      if (accepted.id !== attempt.taskId) throw new Error('Runtime task identity did not match persisted attempt');
      attempt.status = 'accepted'; attempt.updatedAt = time(); await this.write(state);
    } catch (error) {
      if (this.closed) return;
      // The receiving queue is authoritative after a lost dispatch response.
      const task = (await this.repos.tasks.listBySession(attempt.sessionId!)).find(task => task.id === attempt.taskId);
      if (task) { attempt.status = 'accepted'; await this.write(state); return; }
      const current = await this.read(record.item.id);
      if (current.raw !== state.raw) throw new RuntimeError('WORK_ITEM_CONFLICT', 'Work item changed during launch', 409);
      attempt.error = errorText(error);
      attempt.status = 'blocked'; step.status = 'blocked'; record.item.status = 'blocked'; record.item.error = attempt.error;
      await this.write(state);
    }
  }
  private async haltBlocked(state: RecordState) {
    for (const step of state.value.item.steps) {
      if (!['running', 'blocked'].includes(step.status)) continue;
      const attempt = last(step);
      if (!attempt || state.value.stoppedAttempts.includes(attempt.id)) continue;
      try {
        if (await bounded(this.options.runtime.stopWorkItemSession(attempt.sessionId!), 10_000)) state.value.stoppedAttempts.push(attempt.id);
      } catch { /* A failed stop is explicitly unresolved. */ }
      step.status = 'blocked'; attempt.status = 'blocked'; attempt.updatedAt = time();
      attempt.error = state.value.stoppedAttempts.includes(attempt.id) ? 'Execution stopped because the parent work is blocked; inspect effects before retry' : 'Parent work is blocked; execution-resource stop could not be proven';
    }
  }

  private scheduleDelivery(id: string) {
    if (!this.options.deliver) return;
    this.effect('delivery:' + id, async () => {
      let state = await this.read(id);
      const item = state.value.item;
      if (item.status !== 'completed' || !['pending', 'error'].includes(item.delivery.status)) return;
      try { await this.assertExecution(state.value, true); }
      catch (error) {
        if (this.closed) return;
        item.delivery.status = 'error'; item.delivery.error = errorText(error); await this.write(state); return;
      }
      item.delivery.attempts++; await this.write(state);
      let failure: string | undefined;
      try { await this.options.deliver!(structuredClone(item)); }
      catch (error) { failure = errorText(error); }
      if (this.closed) return;
      // A late external response may only update this delivery attempt. Never
      // overwrite a newer graph, cancellation, or independently retried send.
      state = await this.read(id);
      const current = state.value.item;
      if (current.status !== 'completed' || current.delivery.attempts !== item.delivery.attempts || current.output?.digest !== item.output?.digest || !['pending', 'error'].includes(current.delivery.status)) return;
      current.delivery.status = failure === undefined ? 'delivered' : 'error';
      if (failure === undefined) delete current.delivery.error; else current.delivery.error = failure;
      await this.write(state);
    });
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    // External sends are owned/aborted by the host. Their late continuations
    // are fenced above and must never touch repositories after close.
    await bounded(Promise.allSettled([this.ticking, ...this.locks.values()]), 1000).catch(() => {});
  }
}
