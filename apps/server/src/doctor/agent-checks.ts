/**
 * Agent 配置与可用性检查（纯判定，取数在 doctor.ts）。
 *
 *   · agents.dropped.<id>：DUTYDECK_AGENTS_JSON 里命令找不到、没被登记的 Agent。
 *   · agents.default：机器人默认 Agent 的可用性。默认 Agent 存在 lark.bots 的 defaultAgentId 里，
 *     不是环境变量；没有机器人就没有默认 Agent，如实说明而不是编一个。
 */
import { agentProbeTarget, describeDroppedAgent, type DroppedAgent } from '@dutydeck/config';
import type { AgentProbeResult, DoctorCheck, DoctorConfig } from './types.js';

export function checkDroppedAgents(dropped: ReadonlyArray<DroppedAgent>): DoctorCheck[] {
  return dropped.map(agent => {
    const described = describeDroppedAgent(agent);
    return { id: `agents.dropped.${agent.id}`, label: `Agent ${agent.id}`, level: 'fail', ...described };
  });
}

export interface DefaultAgentBot { appId: string; agentId: string }

/** 从 lark.bots 原始值取出各机器人的默认 Agent；解析失败当作没有（lark.config 已单独报告）。 */
export function readDefaultAgents(raw: string | undefined): DefaultAgentBot[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(entry => {
      const bot = entry as { appId?: unknown; defaultAgentId?: unknown };
      return typeof bot?.appId === 'string' && typeof bot.defaultAgentId === 'string' && bot.defaultAgentId.trim()
        ? [{ appId: bot.appId, agentId: bot.defaultAgentId.trim() }] : [];
    });
  } catch { return []; }
}

function probeTargetOf(agent: DoctorConfig['agents'][number]) {
  return agentProbeTarget({ id: agent.id, command: agent.command, protocol: agent.protocol === 'pty-cli' ? 'pty-cli' : 'acp', builtin: agent.builtin === true, ...(agent.adapterId ? { adapterId: agent.adapterId } : {}) });
}

/** 需要探测的 Agent：每个机器人默认 Agent 去重后，在已登记列表里找到的那些。 */
export function agentsToProbe(bots: ReadonlyArray<DefaultAgentBot>, agents: DoctorConfig['agents']) {
  const ids = [...new Set(bots.map(bot => bot.agentId))];
  return ids.flatMap(id => {
    const agent = agents.find(candidate => candidate.id === id);
    if (!agent) return [];
    return [{ id, ...probeTargetOf(agent) }];
  });
}

const quote = (value: string) => /^[\w./@+:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

interface Verdict { level: 'ok' | 'warn' | 'fail'; detail: string; remedy?: string; command?: string }

function judge(id: string, command: string, execute: boolean, result: AgentProbeResult | undefined, timeoutMs: number): Verdict {
  const run = `${quote(command)} --version`;
  if (!execute) return { level: 'ok', detail: `${id}：自定义包装命令 ${command}，未执行 --version（它可能改动本地设置），只确认命令存在` };
  switch (result?.status) {
    case 'ok': return { level: 'ok', detail: `${id}：${command} --version → ${result.version}` };
    case 'not_found': return {
      level: 'fail',
      detail: `${id}：命令 ${command} 找不到`,
      remedy: `Agent「${id}」依赖的命令 ${command} 不在 PATH 里。先安装它；已安装的话用 command -v 查出绝对路径，把 DUTYDECK_AGENTS_JSON 里该 Agent 的 command 改成绝对路径，改完重启服务。`,
      command: `command -v ${quote(command)}`
    };
    case 'timeout': return {
      level: 'warn',
      detail: `${id}：${command} --version 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`,
      remedy: `Agent「${id}」的命令没有在时限内响应。在终端直接运行一次，看它是不是卡在登录、更新检查或交互提示上；先在终端完成登录/更新后再让 Dutydeck 使用。`,
      command: run
    };
    case 'failed': return {
      level: 'fail',
      detail: `${id}：${command} --version 失败（${result.detail}）`,
      remedy: `Agent「${id}」的命令存在但无法运行。在终端直接运行下面这条看完整报错；常见原因是安装不完整、依赖缺失或没有执行权限。修好后重跑 dutydeck doctor。`,
      command: run
    };
    default: return { level: 'warn', detail: `${id}：没有拿到探测结果`, remedy: '探针没有返回结果，重跑一次 dutydeck doctor。', command: 'dutydeck doctor' };
  }
}

export function checkDefaultAgents(input: {
  bots: ReadonlyArray<DefaultAgentBot>;
  agents: DoctorConfig['agents'];
  dropped: ReadonlyArray<DroppedAgent>;
  results: ReadonlyMap<string, AgentProbeResult>;
  timeoutMs: number;
}): DoctorCheck {
  const { bots, agents, dropped, results, timeoutMs } = input;
  if (bots.length === 0) {
    return {
      id: 'agents.default',
      label: '默认 Agent',
      level: 'skip',
      detail: '没有配置默认 Agent（默认 Agent 保存在飞书机器人配置里；Web 面板里的会话由你逐个选择 Agent）'
    };
  }
  const verdicts: Verdict[] = [];
  for (const id of [...new Set(bots.map(bot => bot.agentId))]) {
    const users = bots.filter(bot => bot.agentId === id).map(bot => bot.appId).join('、');
    const agent = agents.find(candidate => candidate.id === id);
    if (!agent) {
      const drop = dropped.find(candidate => candidate.id === id);
      const available = agents.map(candidate => candidate.id).join('、') || '无';
      verdicts.push(drop
        ? { level: 'fail', detail: `${id}：机器人 ${users} 的默认 Agent 因命令 ${drop.command} 找不到而没有登记`, remedy: describeDroppedAgent(drop).remedy, command: describeDroppedAgent(drop).command }
        : {
          level: 'fail',
          detail: `${id}：机器人 ${users} 的默认 Agent 不在可用 Agent 列表里`,
          remedy: `默认 Agent「${id}」没有被登记，常见原因是它的 CLI 没装或不在 PATH 里。安装该 CLI，或把机器人的默认 Agent 换成当前可用的（${available}）。`,
          command: `dutydeck settings bot set ${bots.find(bot => bot.agentId === id)!.appId} defaultAgentId=<可用 Agent ID>`
        });
      continue;
    }
    const target = probeTargetOf(agent);
    verdicts.push(judge(id, target.command, target.execute, results.get(id), timeoutMs));
  }
  const level = verdicts.some(v => v.level === 'fail') ? 'fail' : verdicts.some(v => v.level === 'warn') ? 'warn' : 'ok';
  const bad = verdicts.filter(v => v.level !== 'ok');
  return {
    id: 'agents.default',
    label: '默认 Agent',
    level,
    detail: verdicts.map(v => v.detail).join('；'),
    ...(bad.length ? { remedy: bad.map(v => v.remedy).filter(Boolean).join(' '), ...(bad[0]!.command ? { command: bad[0]!.command } : {}) } : {})
  };
}
