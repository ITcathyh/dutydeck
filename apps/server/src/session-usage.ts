import { join } from 'node:path';
import { createRuntimeStore } from 'acpx/runtime';
import { readCodexSessionUsage } from '@dutydeck/pty-driver';
import { contextUsage, rateLimitWindow, taskExecutionSchemas, type RepositoryBundle, type SessionUsageSnapshot } from '@dutydeck/shared';

/** Recover measurements beyond the UI event window, with each quota window independent. */
export async function sessionUsageSnapshot(repos: RepositoryBundle, sessionId: string): Promise<SessionUsageSnapshot> {
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
  if (!session || !agent || (agent.adapterId ?? agent.id) !== 'codex') return snapshot;
  try {
    const selected = repos.execution.getNativeContext(sessionId);
    let nativeId: string | undefined;
    if (selected) {
      const identity = taskExecutionSchemas.nativeIdentitySchema.parse(selected.resource.identity?.locator);
      if (identity.cwd !== session.cwd || identity.agent !== agent.id || selected.resource.purpose !== 'acp_native_context') return snapshot;
      nativeId = identity.agentSessionId ?? identity.backendSessionId;
    } else if (agent.protocol === 'acp' || agent.protocol === 'auto') {
      const record = await createRuntimeStore({ stateDir: join(session.cwd, '.dutydeck', 'acpx') }).load(session.id);
      if (record?.cwd === session.cwd && record.name === session.id) nativeId = record.agentSessionId ?? record.acpSessionId;
    }
    if (nativeId) {
      const native = await readCodexSessionUsage(nativeId, { ...process.env, ...agent.env }, session.cwd);
      if (native?.context && (!snapshot.context || Date.parse(native.context.observedAt) > Date.parse(snapshot.context.observedAt))) snapshot.context = native.context;
      for (const key of ['fiveHour', 'sevenDay'] as const) {
        const window = native?.rateLimits?.[key];
        if (window && (!snapshot.rateLimits?.[key] || Date.parse(window.observedAt) > Date.parse(snapshot.rateLimits[key]!.observedAt))) {
          snapshot.rateLimits ??= {}; snapshot.rateLimits[key] = window;
        }
      }
    }
  } catch { snapshot.error = '原生会话用量读取失败'; }
  return snapshot;
}
