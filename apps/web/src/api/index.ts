import { agentRequests } from './agents';
import { sessionRequests } from './sessions';
import { workItemRequests } from './work-items';
import { automationRequests } from './automation';
import { settingsRequests } from './settings';
import { workspaceRequests } from './workspaces';
import { inboxRequests } from './inbox';
import { memoryRequests } from './memory';
import { larkRequests } from './lark';
import { usageRequests } from './usage';
import { pluginRequests } from './plugins';

export const api = {
  ...agentRequests,
  ...sessionRequests,
  ...workItemRequests,
  ...automationRequests,
  ...settingsRequests,
  ...workspaceRequests,
  ...inboxRequests,
  ...memoryRequests,
  ...larkRequests,
  ...usageRequests,
  ...pluginRequests
};
