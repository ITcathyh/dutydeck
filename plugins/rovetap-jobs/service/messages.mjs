// Operator/user-facing Chinese copy for thread receipts. Kept free of secrets
// and of untrusted-material interpretation: forwarded text is only ever sent to
// pairfob as data, never evaluated here.

import { buildTaskUrl } from './weblink.mjs';
import { ROVE_ENTRY_CODEPOINTS } from './materials.mjs';

const PROJECT_LABEL = 'RoveTap';

export function replyText(kind, job, config) {
  if (kind === 'denial') return denialText(job, config);
  if (kind === 'need') return needText(job?.reasonCode, job?.reasonDetail);
  if (kind === 'pending') {
    return '委托已记录。' + PROJECT_LABEL + ' 接单结果暂时未知，我会按原来源键只读核对，不会重复建单。';
  }
  if (kind === 'accepted') return acceptedText(job, config);
  if (kind === 'rejected') return rejectedText(job);
  if (kind.startsWith('phase:')) {
    const phase = kind.slice('phase:'.length);
    return phaseText(phase, job, config);
  }
  return '';
}

function denialText(job, config) {
  switch (job?.reasonCode) {
    case 'forbidden':
      return '你没有在这个派单群使用 /job 的权限，本次命令已停止且不会创建任务。';
    case 'unknown_project':
      return '不明确的项目：当前只支持 rovetap。可使用 `/job rovetap <给 leader 的指令>`，或直接发 `/job <指令>`。';
    case 'instruction_too_long': {
      const limit = config?.limits?.maxInstructionChars ?? ROVE_ENTRY_CODEPOINTS;
      return `指令过长：指令上限为 ${limit} 个 Unicode 码点（汉字、字母、emoji 均按码点计；上游固定上限 ${ROVE_ENTRY_CODEPOINTS}，本实例只能调小）。请精简后重新发送 /job。`;
    }
    default:
      return '该 /job 命令未被接受。';
  }
}

function rejectedText(job) {
  const code = job?.submit?.code ? String(job.submit.code) : '';
  const suffix = code ? `（${code}）` : '';
  switch (code) {
    case 'configuration_error':
      return `⚠️ ${PROJECT_LABEL} 派单服务配置有误${suffix}，本次委托没有发出。请联系管理员核对 pairfob socket 与令牌文件配置；系统不会自行重复提交。`;
    case 'not_found':
      return `⚠️ ${PROJECT_LABEL} 项目 leader 绑定不存在${suffix}，本次委托未能建单。请联系管理员核对项目与 leader 绑定后重新发送 /job。`;
    case 'project_closed':
      return `⚠️ ${PROJECT_LABEL} 项目已关闭${suffix}，不再接受新委托；如需继续请联系管理员。系统不会自行重复提交。`;
    default:
      return `${PROJECT_LABEL} 建单未被接受${suffix}。请联系管理员核对；系统不会自行重复提交。`;
  }
}

function needText(reason, detail) {
  if (reason === 'incomplete' && (detail === 'command_time_unknown' || detail === 'candidate_time_unknown')) {
    return '无法证明话题里的转发材料发在你的 /job 命令之前（缺少可核对的消息时间）。为避免把命令之后才到的内容当成材料，请直接引用那条反馈，再发送 /job。';
  }
  if (reason === 'none' && detail === 'no_forward_before_command') {
    return '话题里能识别到的转发晚于你的 /job 命令，不能自动当作本次材料。请直接引用那条反馈（或更早的材料），再发送 /job。';
  }
  switch (reason) {
    case 'multiple':
      return '当前话题里有多条可识别的转发，请**引用**你要交给项目 leader 的那一条，再发送 /job。';
    case 'cross_scope':
      return '引用的消息不属于当前群或话题，已拒绝。请引用本群/本话题内已核对的反馈，系统不会猜测同事的原私聊。';
    case 'inaccessible':
      return '用机器人权限读不到被引用的消息（可能已删除，或缺少消息读取权限）。请重新引用或把内容转发到本话题后再试。';
    case 'no_text':
      return '这条材料没有可读取的文字。首版只接收文字、图文或合并转发正文中的文本，请引用含文字的反馈。';
    case 'none':
    default:
      return '当前话题没有找到可派的转发材料。请引用那条反馈后发送 /job，或先把它转发到本话题；存在多条转发时请显式引用其中一条。';
  }
}

function acceptedText(job, config) {
  const id = job?.pairfob?.taskId ? `\n任务：${job.pairfob.taskId}` : '';
  const url = safeUrl(config.webBaseUrl, job?.pairfob?.taskId, job?.pairfob?.leaderId);
  const link = url ? `\n打开项目任务：${url}` : '';
  return `✅ ${PROJECT_LABEL} 项目已接单，leader 将跟进这条委托。${id}${link}`;
}

function phaseText(phase, job, config) {
  const url = safeUrl(config.webBaseUrl, job?.pairfob?.taskId, job?.pairfob?.leaderId);
  const link = url ? `\n${url}` : '';
  switch (String(phase).toLowerCase()) {
    case 'doing':
      // The upstream `doing` projection can also cover waiting for a human.
      // Say only that the project is processing; never claim a worker/leader
      // dispatch that the phase does not prove.
      return `🛠 ${PROJECT_LABEL}：项目正在处理（doing）。`;
    case 'done':
    case 'succeeded':
    case 'completed':
    case 'complete':
    case 'verified':
      return `✅ ${PROJECT_LABEL}：任务已完成（${phase}），可在项目中查看验收结果。${link}`;
    case 'failed':
    case 'error':
      return `⚠️ ${PROJECT_LABEL}：任务进入失败状态（${phase}），请在项目中查看。${link}`;
    case 'cancelled':
    case 'canceled':
      return `ℹ️ ${PROJECT_LABEL}：任务已取消（${phase}）。${link}`;
    default:
      return `ℹ️ ${PROJECT_LABEL} 项目阶段更新：${phase}。${link}`;
  }
}

function safeUrl(base, taskId, leaderId) {
  if (!base || !taskId || !leaderId) return '';
  try { return buildTaskUrl(base, taskId, leaderId) ?? ''; } catch { return ''; }
}
