import type { AgentCapabilities, AgentConfig, Session, StartSessionInput } from './index.js';
import { backgroundSource } from './background-kinds.js';
import { parseLarkSourceId } from './lark-source-id.js';
import { RuntimeError } from './runtime-error.js';

export interface SessionKindSpec {
  source: string;
  idPattern: RegExp;
  invalidIdentity(): RuntimeError;
  publicStartError?(): RuntimeError;
  renameError?(): RuntimeError;
  validate(existing: Session | undefined, input: StartSessionInput, agent?: AgentConfig, protocol?: AgentCapabilities['protocol']): void;
}
export interface SessionKinds {
  workItem: SessionKindSpec;
  collaboration: SessionKindSpec;
  memory: SessionKindSpec & { validateScope(input: StartSessionInput): void };
  schedule: SessionKindSpec;
}

function matches(session: Session, expected: Partial<Session>, defaultWorkspace = false) {
  return Object.entries(expected).every(([key, value]) => {
    const actual = key === 'workspaceMode' && defaultWorkspace ? session.workspaceMode ?? 'shared' : session[key as keyof Session];
    return (actual ?? undefined) === (value ?? undefined);
  });
}
export function sessionConfigOf(agent: AgentConfig, input: StartSessionInput) {
  return { cwd: input.cwd ?? agent.cwd ?? process.cwd(), model: input.model ?? agent.model, codexProfile: input.codexProfile ?? agent.codexProfile, reasoningEffort: input.reasoningEffort ?? agent.reasoningEffort, permissionMode: input.permissionMode ?? agent.permissionMode };
}

function frozen(input: StartSessionInput, agent: AgentConfig) {
  return { source: input.source, sourceId: input.sourceId, agentId: input.agentId, systemPrompt: agent.systemPrompt, ...sessionConfigOf(agent, input) };
}
function memoryScope(input: StartSessionInput) {
  return input.source === backgroundSource.memory && /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:memory$/.test(input.sourceId ?? '');
}

export const dutydeckSessionKinds: SessionKinds = {
  workItem: {
    source: 'work_item', idPattern: /^ses_work_[a-f0-9]{64}$/,
    publicStartError: () => new RuntimeError('INVALID_WORK_SESSION', 'Work-item sessions require the internal admission API', 403),
    renameError: () => new RuntimeError('INVALID_WORK_SESSION', 'Work-item managed sessions cannot be renamed', 400),
    invalidIdentity: () => new RuntimeError('INVALID_WORK_SESSION', 'Invalid work-item session identity', 400),
    validate(existing, input) {
      if (input.source !== this.source || !input.sourceId) throw this.invalidIdentity();
      if (existing && !matches(existing, { source: this.source, sourceId: input.sourceId, agentId: input.agentId })) {
        throw new RuntimeError('WORK_SESSION_CONFLICT', 'Work-item session identity conflict', 409);
      }
    }
  },
  collaboration: {
    source: 'lark', idPattern: /^ses_collab_[a-f0-9]{64}$/,
    invalidIdentity: () => new RuntimeError('INVALID_BACKGROUND_SESSION', 'Background sessions require a stable authorized Lark group scope and shared workspace', 400),
    validate(existing, input, agent) {
      if (input.source !== this.source || !/^[^:]+:[^:]+:group:collaboration:.+$/.test(input.sourceId ?? '') || input.workspaceMode === 'worktree') throw this.invalidIdentity();
      if (existing && !matches(existing, frozen(input, agent!))) throw new RuntimeError('BACKGROUND_SESSION_CONFLICT', 'Background session immutable configuration changed', 409);
    }
  },
  memory: {
    source: backgroundSource.memory, idPattern: /^ses_memory_[a-f0-9]{64}$/,
    invalidIdentity: () => new RuntimeError('INVALID_MEMORY_SESSION', 'Memory sessions require a stable authorized Lark group scope and shared workspace', 400),
    validateScope(input) { if (!memoryScope(input)) throw new RuntimeError('INVALID_MEMORY_SESSION', 'Invalid memory session scope', 400); },
    validate(existing, input, agent, protocol) {
      if (!memoryScope(input) || input.workspaceMode === 'worktree') throw this.invalidIdentity();
      if (existing && !matches(existing, { ...frozen(input, agent!), protocol, workspaceMode: input.workspaceMode ?? 'shared' }, true)) throw new RuntimeError('MEMORY_SESSION_CONFLICT', 'Memory session immutable configuration changed', 409);
    }
  },
  schedule: {
    source: 'schedule', idPattern: /^ses_schedule_[a-f0-9]{64}$/,
    publicStartError: () => new RuntimeError('INVALID_SCHEDULE_SESSION', 'Schedule sessions require the internal admission API', 403),
    invalidIdentity: () => new RuntimeError('INVALID_SCHEDULE_SESSION', 'Schedule sessions require a stable identity and an explicit workspace mode', 400),
    validate(existing, input, agent, protocol) {
      if (input.source !== this.source || !input.sourceId || (input.workspaceMode !== 'worktree' && input.workspaceMode !== 'shared')) throw this.invalidIdentity();
      if (!existing) return;
      const { cwd, ...configuration } = frozen(input, agent!);
      if (existing.workspaceSourceCwd !== cwd || !matches(existing, { ...configuration, protocol, workspaceMode: input.workspaceMode }, true)) throw new RuntimeError('SCHEDULE_SESSION_CONFLICT', 'Schedule session immutable configuration changed', 409);
    }
  }
};

export const channelExecutionAppId = (session: Session) => session.source === 'lark' ? parseLarkSourceId(session.sourceId).appId : undefined;
