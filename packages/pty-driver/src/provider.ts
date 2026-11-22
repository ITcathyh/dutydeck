import { createCliAdapter } from '@dutydeck/cli-adapters';
import { RuntimeError, supportsNativeFork, supportsRemoteApproval, type DriverProvider } from '@dutydeck/shared';
import { childProcessIdentity, observeProcess } from '@dutydeck/shared/execution';
import type { HerdrBackend } from '@dutydeck/session-backends';
import { createPtyCliDriver, type PtyCliDriverOptions } from './driver.js';
import { createDutydeckPersistentBackend } from './persistent-backend.js';
import { createPtyRetirementControl } from '@dutydeck/session-backends';

export interface PtyProviderOptions {
  herdrBackend(sessionId: string): HerdrBackend;
  claudeResumeSource(sessionId: string): PtyCliDriverOptions['claudeResumeSource'];
}

export function createPtyCliProvider(options?: PtyProviderOptions): DriverProvider {
  const processProbe = { identify: childProcessIdentity, observe: observeProcess };
  return {
    protocol: 'pty-cli',
    resourceProtocol: 'local',
    retirement: options && createPtyRetirementControl(processProbe, session => options.herdrBackend(session.id)),
    capabilities(agent) {
      const remoteApproval = !!agent && supportsRemoteApproval({ ...agent, protocol: 'pty-cli' });
      return { persistentTerminal: true, permissionPosture: true, nativeFork: !!agent && supportsNativeFork(agent), remoteApproval,
        operations: ['compact', 'checkpoint', 'canRecoverTurn', 'recover', 'isIdle', 'quiescence', 'hasBackgroundWork',
          'confirmTranscriptSource', 'idleCpuProof', 'beginIdleCpuRetirement', 'prepareForIdleRetirement',
          'prepareForDaemonShutdown', 'drainExitedOutput', 'isDetachedForShutdown', 'processIds', 'isStopped',
          'subscribeTranscriptSource', 'createTerminalStream', 'persistentTerminalIdentity', 'attachTerminal',
          ...(remoteApproval ? ['requestPermission', 'resolvePermission', 'setPermissionMode'] as const : [])] };
    },
    create({ agent, session, context, onEvent, onExit, log, awaitingAnswer }) {
      if (!options) throw new RuntimeError('DRIVER_UNAVAILABLE', 'protocol 为 pty-cli 的 agent 需要注入 ptyDriverFactory（@dutydeck/pty-driver）', 503);
      return createPtyCliDriver({
        agent: { ...agent, env: { ...agent.env, dutydeck_session_id: session.id, dutydeck_terminal_backend: session.terminalBackend ?? 'tmux' } },
        adapter: createCliAdapter(agent.adapterId ?? agent.id),
        backend: session.terminalBackend === 'herdr' ? options.herdrBackend(session.id) : createDutydeckPersistentBackend(session.id, log),
        log, processProbe, onEvent, onExit, sessionId: session.id, awaitingAnswer,
        nativeForkSessionId: context.nativeForkSessionId, claudeResumeSource: options.claudeResumeSource(session.id),
      });
    },
  };
}
