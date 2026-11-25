// Operator/user-facing Chinese copy for thread receipts. Material excerpts
// use a single line of quoted text inside each receipt.

import { buildTaskUrl } from './weblink.mjs';
import { ROVE_ENTRY_CODEPOINTS } from './materials.mjs';
import { materialChoiceCode, MAX_MATERIAL_CHOICES } from './commands.mjs';

const PROJECT_LABEL = 'RoveTap';
const NEW_TOPIC_HELP = '也可以把目标反馈单独转发成一个新话题，在那里发送 /job。';

function taskTitleFragment(instruction) {
  if (typeof instruction !== 'string') return '';
  // Match RoveTap's pjiTaskTitle, including Go's Unicode whitespace trimming.
  const joined = instruction.replace(/[\x00-\x1f\x7f]+/gu, ' ')
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  const title = [...joined].slice(0, 200).join('').replace(/\p{White_Space}+$/u, '') || '外部项目委托';
  // The board lowercases the whole card's text, with status and summary
  // adjacent to the title. Check both cased and uncased boundaries so
  // cutting a fragment short cannot change the casing of a letter like Σ.
  const searchable = [title, `A${title}`, `${title}A`, `A${title}A`].map(text => text.toLocaleLowerCase());
  for (const line of title.split(/[\u0085\u2028\u2029]/u)) {
    const chars = [...line.trim()].slice(0, 60);
    while (chars.length) {
      const fragment = chars.join('').trimEnd();
      const query = fragment.toLocaleLowerCase();
      if (searchable.every(text => text.includes(query))) return fragment;
      chars.pop();
    }
  }
  return '';
}

export function replyText(kind, job, config) {
  if (kind === 'denial') return denialText(job, config);
  if (kind === 'need:selected') return '所选材料已无法核验，原委托没有提交。请重新引用要处理的消息，再发送 /job。';
  if (kind === 'need') return materialChoiceText(job, config) || needText(job?.reasonCode, job?.reasonDetail);
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
    case 'selection_usage':
      return '请选择回执中一整行「/job 选 #短码」，其中短码是 10 位十六进制字符。';
    case 'selection_topic_required':
      return '请打开原话题，在话题回复框里重新发送选择命令。';
    case 'selection_unavailable':
      return '该材料选项不可用。只有原发令者能在原话题中选择，短码在选材后或超过 24 小时失效。若未完成选材，请重新引用材料，再发送 /job。';
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
    case 'conflict':
      return `⚠️ ${PROJECT_LABEL} 没有接受这条委托${suffix}。请管理员核对项目 leader 是否已关闭，或这条消息是否已用于不同的委托。`;
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
  if (reason === 'none' && detail === 'topic_root_not_only_source') {
    return `话题里有多条消息，请引用要处理的那条回复，再发送 /job。${NEW_TOPIC_HELP}`;
  }
  if (reason === 'none' && detail === 'root_attribution_missing') {
    return '没有找到可核对的话题起始消息。请把目标反馈单独转发成一个新话题，在那里发送 /job。';
  }
  switch (reason) {
    case 'multiple':
      return `当前话题里有多条可识别的转发，请引用要交给项目 leader 的那一条，再发送 /job。${NEW_TOPIC_HELP}`;
    case 'incomplete':
      return `没能核对完整的话题消息。请引用要处理的那条回复，再发送 /job。${NEW_TOPIC_HELP}`;
    case 'cross_scope':
      return '引用的消息不属于当前群或话题，已拒绝。请引用本群/本话题内已核对的反馈，系统不会猜测同事的原私聊。';
    case 'inaccessible':
      return '机器人读不到这条消息。请重新引用或把内容转发到本话题后再试。原消息已无法打开时，可以补一条文字说明，引用说明后再发送 /job。';
    case 'no_text':
      return '这条材料没有可读取的文字。请引用含文字的反馈，或补一条文字说明，引用说明后再发送 /job。';
    case 'none':
    default:
      return '当前话题没有找到可派的转发材料。请引用那条反馈后发送 /job，或先把它转发到本话题；存在多条转发时请显式引用其中一条。';
  }
}

function quotedPreview(text) {
  if (typeof text !== 'string') return '';
  // Keep each excerpt on its own line, including in the CLI's Markdown card.
  const plain = text.replace(/\p{Cf}/gu, '').replace(/[\s\p{Cc}]+/gu, ' ').trim()
    .replace(/[<>\[\]`*_~|\\@]/g, char => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
    .replace(/\/job/gi, match => `／${match.slice(1)}`)
    .replace(/:\/\//g, '：／／');
  const chars = [...plain];
  return chars.length > 64 ? chars.slice(0, 64).join('') + '…' : plain;
}

function materialChoiceText(job, config) {
  if (!job?.materialChoices?.length) return '';
  const choices = job.materialChoices.slice(0, MAX_MATERIAL_CHOICES).map(({ messageId, preview }) =>
    `材料「${quotedPreview(preview)}」\n/job 选 #${materialChoiceCode(job.sourceKey, messageId)}`);
  const instruction = quotedPreview(job.instruction);
  const mention = config?.selfOpenId ? '\n若群里需要 @机器人，发送时请先 @本机器人。' : '';
  return [
    '这次委托需要你确认材料。',
    ...(instruction ? [`原委托「${instruction}」`] : []),
    '原发令者可在 24 小时内把以下一条命令复制到当前话题，继续同一条派单。',
    ...choices,
    `如果不方便使用短码，请引用话题内的目标回复后重新发 /job。${NEW_TOPIC_HELP}${mention}`,
  ].join('\n');
}

function acceptedText(job, config) {
  const fragment = taskTitleFragment(job?.instruction);
  const titleLine = fragment ? `\n标题片段：${fragment}` : '';
  const locate = fragment ? '其他客户端可按标题片段查找。' : '';
  return `✅ ${PROJECT_LABEL} 项目已接单。${taskNumber(job)}${titleLine}${materialSummary(job)}\n请在已连接总机的 RoveTap 中查看。新版桌面看板优先用完整任务号。${locate}进展会回到本话题。${taskEntryText(job, config)}`;
}

function phaseText(phase, job, config) {
  const context = taskNumber(job) + materialSummary(job);
  const link = taskEntryText(job, config);
  switch (String(phase).toLowerCase()) {
    case 'doing':
      // The upstream `doing` projection can also cover waiting for a human.
      // Say only that the project is processing; never claim a worker/leader
      // dispatch that the phase does not prove.
      return `🛠 ${PROJECT_LABEL}：项目正在处理（doing）。${context}`;
    case 'done':
    case 'succeeded':
    case 'completed':
    case 'complete':
    case 'verified':
      return `✅ ${PROJECT_LABEL}：任务已完成（${phase}），可在项目中查看验收结果。${context}${link}`;
    case 'failed':
    case 'error':
      return `⚠️ ${PROJECT_LABEL}：任务进入失败状态（${phase}），请在项目中查看。${context}${link}`;
    case 'cancelled':
    case 'canceled':
      return `ℹ️ ${PROJECT_LABEL}：任务已取消（${phase}）。${context}${link}`;
    default:
      return `ℹ️ ${PROJECT_LABEL} 项目阶段更新：${phase}。${context}${link}`;
  }
}

function taskNumber(job) {
  return job?.pairfob?.taskId ? `\n任务号：${job.pairfob.taskId}` : '';
}

function materialSummary(job) {
  const summary = quotedPreview(job?.material?.text);
  return summary ? `\n随单材料摘要：「${summary}」` : '';
}

function taskEntryText(job, config) {
  const url = safeUrl(config.webBaseUrl, job?.pairfob?.taskId, job?.pairfob?.leaderId);
  return url ? `\n项目任务入口（仅在已连接总机的 RoveTap 环境可用）：${url}` : '';
}

function safeUrl(base, taskId, leaderId) {
  if (!base || !taskId || !leaderId) return '';
  try { return buildTaskUrl(base, taskId, leaderId) ?? ''; } catch { return ''; }
}
