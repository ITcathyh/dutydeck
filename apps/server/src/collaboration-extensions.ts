import { createHash } from 'node:crypto';
import {
  RuntimeError,
  type CollaborationAction,
  type CollaborationObservation,
  type CollaborationRepository,
  type CollaborationScope,
  type CollaborationSnapshot,
  type SenderKind
} from '@dutydeck/shared';

export interface ObservationInput {
  id?: string;
  eventId: string;
  occurredAt: string;
  receivedAt?: string;
  senderKind: SenderKind;
  threadId?: string;
  messageId?: string;
  text: string;
  refs?: string[];
  missing?: string[];
}

export interface RegisteredSource {
  verify: (input: {
    body: unknown;
    headers: Record<string, string | undefined>;
  }) => Promise<{ scope: CollaborationScope; actorId: string } | undefined>;
  parse: (body: unknown) => ObservationInput;
}

export interface RegisteredQuery<TInput = unknown> {
  parse: (input: unknown) => TInput;
  query: (
    input: TInput,
    context: { scope: CollaborationScope; actorId: string }
  ) => Promise<{
    evidence: Array<{ id: string; scope: CollaborationScope; text: string; occurredAt: string }>;
    missing: string[];
  }>;
}

export interface RegisteredAction<TInput = unknown> {
  parse: (input: unknown) => TInput;
  execute: (
    input: TInput,
    context: { scope: CollaborationScope; actorId: string; actionId: string }
  ) => Promise<{ receipt: string }>;
  reconcile?: (context: {
    scope: CollaborationScope;
    actorId: string;
    action: CollaborationAction;
  }) => Promise<{
    status: 'succeeded' | 'failed' | 'unknown';
    receipt?: string;
    error?: string;
  }>;
}

export interface CollaborationExtensionsOptions {
  repository: CollaborationRepository;
  authorize: (
    scope: CollaborationScope,
    actorId: string,
    action: 'event' | 'query' | 'action'
  ) => Promise<boolean>;
  now?: () => Date;
  onObservation?: (snapshot: CollaborationSnapshot) => void | Promise<void>;
}

const ALLOWED_SENDER_KINDS = new Set<SenderKind>(['human', 'bot', 'system']);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',') +
    '}'
  );
}

export class CollaborationExtensions {
  private readonly repository: CollaborationRepository;
  private readonly authorize: (
    scope: CollaborationScope,
    actorId: string,
    action: 'event' | 'query' | 'action'
  ) => Promise<boolean>;
  private readonly now: () => Date;
  private readonly onObservation?: (snapshot: CollaborationSnapshot) => void | Promise<void>;

  private readonly sources = new Map<string, RegisteredSource>();
  private readonly queries = new Map<string, RegisteredQuery>();
  private readonly actions = new Map<string, RegisteredAction>();

  constructor(options: CollaborationExtensionsOptions) {
    this.repository = options.repository;
    this.authorize = options.authorize;
    this.now = options.now ?? (() => new Date());
    this.onObservation = options.onObservation;
  }

  registerSource(id: string, source: RegisteredSource): void {
    if (this.sources.has(id)) {
      throw new Error(`Source '${id}' is already registered`);
    }
    this.sources.set(id, source);
  }

  async ingest(
    sourceId: string,
    body: unknown,
    headers: Record<string, string | undefined>
  ): Promise<{
    observation: CollaborationObservation;
    created: boolean;
    changed: boolean;
    contextRevision: number;
  }> {
    const source = this.sources.get(sourceId);
    if (!source) {
      throw new RuntimeError('COLLABORATION_SOURCE_NOT_FOUND', `Source '${sourceId}' is not registered`, 404);
    }

    let verified: { scope: CollaborationScope; actorId: string } | undefined;
    try {
      verified = await source.verify({ body, headers });
    } catch {
      throw new RuntimeError('COLLABORATION_FORBIDDEN', `Source '${sourceId}' verification failed`, 403);
    }

    if (!verified || !verified.scope || !verified.scope.appId || !verified.scope.chatId || !verified.actorId) {
      throw new RuntimeError('COLLABORATION_FORBIDDEN', `Source '${sourceId}' verification returned invalid identity`, 403);
    }

    const isAuthorized = await this.authorize(verified.scope, verified.actorId, 'event');
    if (!isAuthorized) {
      throw new RuntimeError('COLLABORATION_FORBIDDEN', `Actor '${verified.actorId}' unauthorized for event ingestion`, 403);
    }

    const parsed = source.parse(body);
    if (!ALLOWED_SENDER_KINDS.has(parsed.senderKind)) {
      throw new RuntimeError('COLLABORATION_INVALID_INPUT', `Invalid senderKind: '${parsed.senderKind}'`, 400);
    }

    // body 不能覆盖 scope/actor, origin 强制 external, source 强制 sourceId
    const receivedAt = parsed.receivedAt || this.now().toISOString();
    const result = await this.repository.observe({
      id: parsed.id,
      scope: verified.scope,
      source: sourceId,
      eventId: parsed.eventId,
      occurredAt: parsed.occurredAt,
      receivedAt,
      senderId: verified.actorId,
      senderKind: parsed.senderKind,
      threadId: parsed.threadId,
      messageId: parsed.messageId,
      text: parsed.text,
      refs: parsed.refs ?? [],
      origin: 'external',
      missing: parsed.missing ?? []
    });

    if (this.onObservation && (result.created || result.changed)) {
      try {
        const snapshot = await this.repository.snapshot(verified.scope);
        await Promise.resolve(this.onObservation(snapshot));
      } catch {
        // 通知材料变化，由主控决定参与，失败不阻断摄入
      }
    }

    return result;
  }

  registerQuery(
    id: string,
    queryDef: {
      parse: (input: unknown) => unknown;
      query: (
        input: unknown,
        context: { scope: CollaborationScope; actorId: string }
      ) => Promise<{
        evidence: Array<{ id: string; scope: CollaborationScope; text: string; occurredAt: string }>;
        missing: string[];
      }>;
    }
  ): void {
    if (this.queries.has(id)) {
      throw new Error(`Query '${id}' is already registered`);
    }
    this.queries.set(id, queryDef);
  }

  async query(
    id: string,
    scope: CollaborationScope,
    actorId: string,
    input: unknown
  ): Promise<{
    evidence: Array<{ id: string; scope: CollaborationScope; text: string; occurredAt: string }>;
    missing: string[];
  }> {
    const q = this.queries.get(id);
    if (!q) {
      throw new RuntimeError('COLLABORATION_QUERY_NOT_FOUND', `Query '${id}' is not registered`, 404);
    }

    const isAuthorized = await this.authorize(scope, actorId, 'query');
    if (!isAuthorized) {
      throw new RuntimeError('COLLABORATION_FORBIDDEN', `Actor '${actorId}' unauthorized for query`, 403);
    }

    const parsedInput = q.parse(input);
    const result = await q.query(parsedInput, { scope, actorId });

    if (!result || !Array.isArray(result.evidence)) {
      throw new RuntimeError('COLLABORATION_INVALID_QUERY_OUTPUT', 'Query must return evidence array', 400);
    }

    if (result.evidence.length > 100) {
      throw new RuntimeError('COLLABORATION_INVALID_QUERY_OUTPUT', 'Evidence count exceeds maximum allowed of 100', 400);
    }

    for (const item of result.evidence) {
      if (!item.id || typeof item.id !== 'string' || item.id.length > 128) {
        throw new RuntimeError('COLLABORATION_INVALID_QUERY_OUTPUT', 'Invalid evidence item id', 400);
      }
      if (!item.scope || item.scope.appId !== scope.appId || item.scope.chatId !== scope.chatId) {
        throw new RuntimeError('CROSS_SCOPE_EVIDENCE', `Cross-scope evidence detected for item '${item.id}'`, 400);
      }
      if (typeof item.text !== 'string' || item.text.length > 16000) {
        throw new RuntimeError('COLLABORATION_INVALID_QUERY_OUTPUT', 'Invalid evidence item text length', 400);
      }
      if (!item.occurredAt || Number.isNaN(Date.parse(item.occurredAt))) {
        throw new RuntimeError('COLLABORATION_INVALID_QUERY_OUTPUT', 'Invalid evidence item occurredAt date', 400);
      }
    }

    const missing = Array.isArray(result.missing) ? result.missing.map(String).slice(0, 100) : [];

    return {
      evidence: result.evidence,
      missing
    };
  }

  registerAction(
    id: string,
    actionDef: {
      parse: (input: unknown) => unknown;
      execute: (
        input: unknown,
        context: { scope: CollaborationScope; actorId: string; actionId: string }
      ) => Promise<{ receipt: string }>;
      reconcile?: (context: {
        scope: CollaborationScope;
        actorId: string;
        action: CollaborationAction;
      }) => Promise<{
        status: 'succeeded' | 'failed' | 'unknown';
        receipt?: string;
        error?: string;
      }>;
    }
  ): void {
    if (this.actions.has(id)) {
      throw new Error(`Action '${id}' is already registered`);
    }
    this.actions.set(id, actionDef);
  }

  async execute(
    id: string,
    scope: CollaborationScope,
    actorId: string,
    actionId: string,
    input: unknown
  ): Promise<CollaborationAction> {
    const handler = this.actions.get(id);
    if (!handler) {
      throw new RuntimeError('COLLABORATION_ACTION_HANDLER_NOT_FOUND', `Action handler '${id}' is not registered`, 404);
    }

    // 入口首次授权：撤权时不落任何意图
    const entryAuthorized = await this.authorize(scope, actorId, 'action');
    if (!entryAuthorized) {
      throw new RuntimeError('COLLABORATION_FORBIDDEN', `Actor '${actorId}' unauthorized for action execution`, 403);
    }

    const parsedInput = handler.parse(input);
    const inputDigest = createHash('sha256').update(canonicalJson(parsedInput)).digest('hex');
    const payload =
      typeof parsedInput === 'object' && parsedInput !== null
        ? (parsedInput as Record<string, unknown>)
        : { value: parsedInput };

    const kind = `extension:${id}`;

    // 1. 意图落库：beginAction
    const { action: initialAction, created } = await this.repository.beginAction({
      id: actionId,
      scope,
      kind,
      requesterId: actorId,
      inputDigest,
      payload
    });

    // 2. 如果不是新建（已存在同 ID 动作）
    if (!created) {
      if (initialAction.status === 'succeeded') {
        return initialAction;
      }
      if (initialAction.status === 'sending' || initialAction.status === 'unknown') {
        return await this.reconcile(actionId, scope, actorId);
      }
      if (initialAction.status === 'failed' || initialAction.status === 'suppressed') {
        return initialAction;
      }
    }

    // 3. 再次授权
    let currentAction = initialAction;
    const isAuthorized = await this.authorize(scope, actorId, 'action');
    if (!isAuthorized) {
      throw new RuntimeError('COLLABORATION_FORBIDDEN', `Actor '${actorId}' unauthorized for action execution`, 403);
    }

    // 4. sending 落库
    currentAction = await this.repository.updateAction(scope, actionId, {
      expectedRevision: currentAction.revision,
      status: 'sending'
    });

    // 5. 外部调用
    let executeResult: { receipt: string };
    try {
      executeResult = await handler.execute(parsedInput, { scope, actorId, actionId });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.repository.updateAction(scope, actionId, {
        expectedRevision: currentAction.revision,
        status: 'unknown',
        error: errorMessage
      });
      throw new RuntimeError(
        'ACTION_EXECUTION_UNKNOWN',
        `Action execution resulted in unknown status: ${errorMessage}`,
        500
      );
    }

    // 6. succeeded 落库
    currentAction = await this.repository.updateAction(scope, actionId, {
      expectedRevision: currentAction.revision,
      status: 'succeeded',
      receipt: executeResult.receipt
    });

    return currentAction;
  }

  async reconcile(
    actionId: string,
    scope: CollaborationScope,
    actorId: string
  ): Promise<CollaborationAction> {
    const isAuthorized = await this.authorize(scope, actorId, 'action');
    if (!isAuthorized) {
      throw new RuntimeError('COLLABORATION_FORBIDDEN', `Actor '${actorId}' unauthorized for action reconcile`, 403);
    }

    const action = await this.repository.getAction(scope, actionId);
    if (!action) {
      throw new RuntimeError('COLLABORATION_NOT_FOUND', `Action '${actionId}' not found in scope`, 404);
    }

    const id = action.kind.startsWith('extension:')
      ? action.kind.slice('extension:'.length)
      : action.kind;

    const handler = this.actions.get(id);
    if (!handler || !handler.reconcile) {
      return action;
    }

    let outcome: {
      status: 'succeeded' | 'failed' | 'unknown';
      receipt?: string;
      error?: string;
    };
    try {
      outcome = await handler.reconcile({ scope, actorId, action });
    } catch {
      // 插件核对自身异常时保持原状态，绝不据此误报成功或失败
      return action;
    }

    if (
      outcome.status !== 'succeeded' &&
      outcome.status !== 'failed' &&
      outcome.status !== 'unknown'
    ) {
      return action;
    }

    if (
      outcome.status === action.status &&
      outcome.receipt === action.receipt &&
      outcome.error === action.error
    ) {
      return action;
    }

    // CAS / 终态迁移错误向上传播，调用方可重试；unknown 仅能显式核对到终态
    return await this.repository.updateAction(scope, actionId, {
      expectedRevision: action.revision,
      status: outcome.status,
      receipt: outcome.receipt,
      error: outcome.error
    });
  }
}
