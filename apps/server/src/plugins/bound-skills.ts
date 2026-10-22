import type { Session } from '@dutydeck/shared';
import { prepareSkillPrompt, type PrepareSkillPromptOptions } from '../skill-delivery.js';
import type { PluginHost } from './host.js';
import { PluginRuntimeHooks, sessionHookContext } from './integration.js';

/** Shared by explicit tasks and deny-all collaboration tasks, before runtime freezes input. */
export async function prepareBoundTaskPrompt(host: PluginHost, hooks: PluginRuntimeHooks, session: Session, prompt: string, skills?: string[], context?: Pick<PrepareSkillPromptOptions, 'promptPolicyVersion' | 'promptParts' | 'homeDirectory'>) {
  const scope = sessionHookContext(session);
  const requiredSkills = await host.requiredSkillRequests({ ...scope, cwd: session.workspaceSourceCwd ?? session.cwd });
  const prepared = await prepareSkillPrompt(session.cwd, prompt, skills, { ...context, pluginWorkspaceRoot: session.workspaceSourceCwd ?? session.cwd, requiredSkills, chatId: scope.chatId, ...(scope.botAppId ? { botAppId: scope.botAppId } : {}) });
  return hooks.beforeRun(session, prepared, context?.promptPolicyVersion);
}
