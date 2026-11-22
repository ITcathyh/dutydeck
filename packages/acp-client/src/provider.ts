import { AcpxAdapter, listAcpxBuiltinAgents, readNativeCreationRecord } from './index.js';
import type { DriverProvider } from '@dutydeck/shared';

export const acpDriverProvider: DriverProvider = {
  protocol: 'acp',
  resourceProtocol: 'controlled',
  capabilities: () => ({
    permissionPosture: true,
    operations: ['compact', 'steer', 'prepareSubmission', 'resourceCapabilities', 'isIdle', 'isStopped', 'stopUnverifiable',
      'resolvePermission', 'setModel', 'setReasoningEffort', 'setRiskPolicy', 'processIds', 'subscribeTranscriptSource',
      'configureNative', 'nativeConfiguration'],
  }),
  restoreAgent(agent) {
    if (!agent.builtin || agent.protocol !== 'pty-cli') return agent;
    const builtin = listAcpxBuiltinAgents().find(candidate => candidate.id === agent.id);
    return builtin ? { ...agent, command: builtin.argv[0]!, args: builtin.argv.slice(1), protocol: 'acp',
      adapterId: undefined, capabilities: { pause: false, resume: true } } : agent;
  },
  readNativeCreationRecord,
  create({ agent, session, context, onEvent, log, resolveRiskPolicy, awaitingAnswer }) {
    return new AcpxAdapter({ ...agent, env: { ...agent.env, dutydeck_session_id: session.id } },
      { sessionKey: session.id, context, onEvent, log, resolveRiskPolicy, awaitingAnswer });
  },
};
