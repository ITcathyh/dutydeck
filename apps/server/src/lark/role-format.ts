import { participationLevelBehaviors, type ParticipationLevel } from '@dutydeck/shared';

export interface RoleDescriptor {
  roleTitle?: string;
  roleScope?: string;
}

export function formatRolePrompt(role?: RoleDescriptor): string | undefined {
  const title = role?.roleTitle?.trim();
  const scope = role?.roleScope?.trim();
  if (!title && !scope) return undefined;
  let body = '';
  if (title && scope) {
    body = `你在群里的角色是「${title}」，负责：${scope}。`;
  } else if (title) {
    body = `你在群里的角色是「${title}」。`;
  } else {
    body = `你在群里负责：${scope}。`;
  }
  return `[Dutydeck 角色 · 管理者配置]\n${body}明确向你派发的任务即使在负责范围外也照常处理，角色不改变现有权限。`;
}

export function formatParticipationBehavior(level: ParticipationLevel, role?: RoleDescriptor): string {
  const scope = role?.roleScope?.trim();
  if (!scope || (level !== 'selective' && level !== 'eager')) {
    return participationLevelBehaviors[level];
  }
  if (level === 'eager') {
    return '除了明显是对别人说的、表情和致谢，明确叫我、或负责范围内需要处理的消息我才会接；范围外请 @我';
  }
  return '没 @ 我的消息先判断是否明确叫我、或负责范围内需要处理，是才接；范围外请 @我';
}

export function formatRoleWelcomeIntro(role?: RoleDescriptor): string {
  const title = role?.roleTitle?.trim();
  const scope = role?.roleScope?.trim();
  if (scope) {
    const who = title ? `我是「${title}」` : '我是 **Dutydeck**';
    return `${who}，负责：${scope}。没 @ 我的消息里，我只接这些范围内的事；其他事请 @ 我。`;
  }
  if (title) {
    return `我是「${title}」，可以在群里帮你跑任务、盯进度并把结果发回本群。`;
  }
  return '我是 **Dutydeck**，可以在群里帮你跑任务、盯进度并把结果发回本群。';
}

export function formatRoleStatusLine(role?: RoleDescriptor): string | undefined {
  const title = role?.roleTitle?.trim();
  const scope = role?.roleScope?.trim();
  if (!title && !scope) return undefined;
  if (title && scope) {
    return `**角色**：${title}，负责：${scope}`;
  }
  if (title) {
    return `**角色**：${title}`;
  }
  return `**角色**：负责：${scope}`;
}
