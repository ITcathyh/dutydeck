import { join } from 'node:path';
import { createRuntimeStore } from 'acpx/runtime';
import { inferAcpInsightClient } from '@dutydeck/acp-client';
import { readCodexSessionUsage, readNativeTranscriptUsage, verifyTranscriptCheckpoint, transcriptClientForAdapter, realCwd, claudeProjectDir, claudeDataDir, codexHome, type NativeUsageSource } from '@dutydeck/pty-driver';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import { contextUsage, rateLimitWindow, taskExecutionSchemas, type RepositoryBundle, type SessionUsageSnapshot } from '@dutydeck/shared';

/** Recover measurements beyond the UI event window, with each quota window independent. */
export async function sessionUsageSnapshot(repos: RepositoryBundle, sessionId: string, serverEnv: NodeJS.ProcessEnv = process.env): Promise<SessionUsageSnapshot> {
  const snapshot: SessionUsageSnapshot = {};
  const events = await repos.events.listLatestUsage?.(sessionId) ?? [];
  for (const event of events) {
    const data = event.data as any;
    if (event.type !== 'status' || data?.state !== 'usage') continue;
    const context = contextUsage(data.used, data.size, event.timestamp);
    if (context && (!snapshot.context || Date.parse(context.observedAt) > Date.parse(snapshot.context.observedAt))) snapshot.context = context;
    for (const key of ['fiveHour', 'sevenDay'] as const) {
      const raw = data.rateLimits?.[key];
      const window = rateLimitWindow(raw?.usedPercent, raw?.resetsAt, raw?.observedAt ?? event.timestamp);
      if (window && (!snapshot.rateLimits?.[key] || Date.parse(window.observedAt) > Date.parse(snapshot.rateLimits[key]!.observedAt))) {
        snapshot.rateLimits ??= {}; snapshot.rateLimits[key] = window;
      }
    }
  }

  const session = await repos.sessions.get(sessionId);
  const agent = session ? await repos.agents.get(session.agentId) : undefined;
  if (!session || !agent) return snapshot;
  const client = session.protocol === 'pty-cli' || !session.protocol && agent.protocol === 'pty-cli' ? transcriptClientForAdapter(agent.adapterId ?? agent.id) : inferAcpInsightClient(agent);
  if (client !== 'codex' && client !== 'claude') return snapshot;
  try {
    const env = childEnvironment(serverEnv, agent.env, ...(session.protocol === 'pty-cli' ? [{ stripClaude: true }] : []));
    const selected = repos.execution.getNativeContext(sessionId);
    let nativeId: string | undefined;
    if (selected) {
      const identity = taskExecutionSchemas.nativeIdentitySchema.parse(selected.resource.identity?.locator);
      if (realCwd(identity.cwd) !== realCwd(session.cwd) || identity.agent !== agent.id || selected.resource.purpose !== 'acp_native_context') return snapshot;
      nativeId = identity.agentSessionId ?? (client === 'codex' ? identity.backendSessionId : undefined);
    }
    const mainSources = repos.insight.listSources(sessionId).filter(source => source.client === client && typeof source.cwd === 'string' && realCwd(source.cwd) === realCwd(session.cwd) && source.nativeSessionId && source.streamIdentity?.kind === 'main');
    let candidates = mainSources;
    if (selected) candidates = mainSources.filter(source => nativeId && source.nativeSessionId === nativeId);
    else {
      const anchors = repos.execution.getResources(sessionId).filter(resource => resource.runId === session.runId && resource.stage === 'created' && (resource.kind === 'local_only' && resource.identity || resource.kind === 'operation' && ['lifecycle', 'strict-context-restore'].includes(resource.operationScope?.kind ?? '')));
      const anchor = anchors.at(-1);
      const driverId = anchor?.kind === 'local_only' ? anchor.resourceId : anchor?.driverInstanceId;
      const current = mainSources.filter(source => source.activeRunId === session.runId && source.proofKind === 'launch_observed' && (!driverId || source.driverInstanceId === driverId));
      if (driverId && !current.length) return snapshot;
      if (current.length) candidates = current;
    }
    const distinct = new Map(candidates.map(source => [JSON.stringify([source.dataRoot, source.nativeSessionId]), source]));
    // Multiple historical contexts cannot be promoted to a current context by recency.
    if (distinct.size > 1) return snapshot;
    const source = [...distinct.values()][0];
    let native: SessionUsageSnapshot | undefined;
    if (source) {
      const path = source.verifiedPath ?? (client === 'claude' ? join(claudeProjectDir(session.cwd, { CLAUDE_CONFIG_DIR: source.dataRoot }), `${source.nativeSessionId}.jsonl`) : undefined);
      native = path ? await readNativeTranscriptUsage({ client, path, dataRoot: source.dataRoot, nativeSessionId: source.nativeSessionId!, cwd: session.cwd })
        : await readCodexSessionUsage(source.nativeSessionId!, { CODEX_HOME: source.dataRoot }, session.cwd);
    } else {
      if (!selected && (agent.protocol === 'acp' || agent.protocol === 'auto')) {
        const record = await createRuntimeStore({ stateDir: join(session.cwd, '.dutydeck', 'acpx') }).load(session.id);
        if (record?.cwd === session.cwd && record.name === session.id) nativeId = record.agentSessionId ?? (client === 'codex' ? record.acpSessionId : undefined);
      }
      if (nativeId) {
        native = client === 'codex' ? await readCodexSessionUsage(nativeId, env, session.cwd)
          : await readNativeTranscriptUsage({ client, path: join(claudeProjectDir(session.cwd, env), `${nativeId}.jsonl`), dataRoot: claudeDataDir(env), nativeSessionId: nativeId, cwd: session.cwd });
      } else if (!selected && session.protocol === 'pty-cli' && repos.execution.authority() === 'ledger_v1') {
        const dataRoot = client === 'claude' ? claudeDataDir(env) : codexHome(env);
        const paths = new Set(repos.execution.getSessionExecutions(sessionId).flatMap(execution => execution.attempts.flatMap(attempt => attempt.recoveryControllers.flatMap(recovered => recovered.evidence.kind === 'original_turn' && recovered.evidence.recovery?.transcript?.path ? [recovered.evidence.recovery.transcript.path] : []))));
        if (paths.size === 1) {
          const path = [...paths][0]!; const key = JSON.stringify([sessionId, session.runId, path, dataRoot]);
          let bound = checkpointSources.get(key);
          if (!bound) {
            const verified = verifyTranscriptCheckpoint(client, path, dataRoot, { sessionId, cwd: session.cwd });
            if (verified) {
              bound = { client, path: verified.verifiedPath, dataRoot, nativeSessionId: verified.nativeSessionId, cwd: session.cwd };
              checkpointSources.set(key, bound);
              if (checkpointSources.size > 32) checkpointSources.delete(checkpointSources.keys().next().value!);
            }
          }
          if (bound) native = await readNativeTranscriptUsage(bound);
        }
      }
    }
    if (native?.nativeTokens) snapshot.nativeTokens = native.nativeTokens;
    if (native?.context && (!snapshot.context || Date.parse(native.context.observedAt) > Date.parse(snapshot.context.observedAt))) snapshot.context = native.context;
    for (const key of ['fiveHour', 'sevenDay'] as const) {
      const window = native?.rateLimits?.[key];
      if (window && (!snapshot.rateLimits?.[key] || Date.parse(window.observedAt) > Date.parse(snapshot.rateLimits[key]!.observedAt))) {
        snapshot.rateLimits ??= {}; snapshot.rateLimits[key] = window;
      }
    }
  } catch { snapshot.error = '原生会话用量读取失败'; }
  return snapshot;
}
const checkpointSources = new Map<string, NativeUsageSource>();
