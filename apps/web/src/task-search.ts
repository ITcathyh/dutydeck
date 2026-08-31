import type { Agent, RunSummary, Session } from './api';
import { fallbackRunTitle } from './run-summary';
import { workspaceName } from './workspace-model';

export type TaskSearchField = 'goal' | 'workspace' | 'agent';
export type TaskSearchMatch = { session: Session; score: number; fields: TaskSearchField[] };
export type TaskSearchHaystack = Record<TaskSearchField, string>;
export type TaskSearchInput = { sessions: Session[]; summaries: Record<string, RunSummary>; agents: Agent[]; query: string };

// 排序规则（打分只依赖文本，与当前时间无关，便于测试与预期一致）：
// 1. 字段优先级：任务目标 300 > 工作区 200 > Agent 100。同一个词在多个字段命中时按最高权重字段计分，
//    字段间差值 100 大于字段内最高加成 90，因此「目标命中」永远排在「工作区命中」之前。
// 2. 字段内：前缀命中 +60，再按命中位置越靠前加 (30 - index) 分，所以前缀优于中段、靠前优于靠后。
// 3. 多词查询取每个词的最高得分求和（同一次查询词数相同，可直接比较）。
// 4. 得分相同时按 updatedAt 倒序（缺失则用 createdAt），仍相同时按 id 升序，保证顺序稳定可预测。
const searchFields: TaskSearchField[] = ['goal', 'workspace', 'agent'];
const fieldWeight: Record<TaskSearchField, number> = { goal: 300, workspace: 200, agent: 100 };
const prefixBonus = 60;
const positionBonus = 30;

/** 归一化检索文本：NFKC（全角转半角）+ 大小写折叠 + 空白合并，中文不做分词。 */
export function normalizeSearchQuery(query: string): string {
  return query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 查询词：按空白切分成多个词，全部命中才算匹配（AND）；中文本身无空格，单词即整串子串。 */
export function taskSearchTerms(query: string): string[] {
  const normalized = normalizeSearchQuery(query);
  return normalized ? normalized.split(' ') : [];
}

/** 一个任务在各字段上的候选检索串：工作区同时收录短名与完整 cwd，Agent 同时收录展示名与原始 id。 */
export function taskSearchCandidates(session: Session, summary?: RunSummary, agent?: Agent): Record<TaskSearchField, string[]> {
  const cwd = session.cwd?.trim() ?? '';
  const unique = (values: Array<string | undefined>) => [...new Set(values.map(value => normalizeSearchQuery(value ?? '')).filter(Boolean))];
  return {
    goal: unique([summary?.prompt, summary?.prompt?.trim() ? undefined : fallbackRunTitle(session.source)]),
    workspace: unique([workspaceName(cwd), cwd]),
    agent: unique([agent?.name, session.agentId])
  };
}

/** 归一化后的字段检索文本（候选串以空格连接）；查询词不含空格，因此不会跨候选串误命中。 */
export function taskSearchHaystack(session: Session, summary?: RunSummary, agent?: Agent): TaskSearchHaystack {
  const candidates = taskSearchCandidates(session, summary, agent);
  return { goal: candidates.goal.join(' '), workspace: candidates.workspace.join(' '), agent: candidates.agent.join(' ') };
}

function bestIndex(term: string, values: string[]): number {
  let best = -1;
  for (const value of values) {
    const index = value.indexOf(term);
    if (index < 0) continue;
    if (best < 0 || index < best) best = index;
  }
  return best;
}

function scoreSession(terms: string[], candidates: Record<TaskSearchField, string[]>): { score: number; fields: TaskSearchField[] } | undefined {
  const hitFields = new Set<TaskSearchField>();
  let score = 0;
  for (const term of terms) {
    let termScore = -1;
    for (const field of searchFields) {
      const index = bestIndex(term, candidates[field]);
      if (index < 0) continue;
      hitFields.add(field);
      // 字段权重从高到低遍历，第一个命中的字段即该词的计分字段。
      if (termScore < 0) termScore = fieldWeight[field] + (index === 0 ? prefixBonus : 0) + Math.max(0, positionBonus - index);
    }
    if (termScore < 0) return; // 有词落空 → 整条不匹配（AND 语义）
    score += termScore;
  }
  return { score, fields: searchFields.filter(field => hitFields.has(field)) };
}

/**
 * 按任务目标 / 工作区 / Agent 做大小写无关的子串检索。
 * 空查询返回 []（由调用方决定「没有查询时展示什么」），结果不做任何条数截断，
 * 也不过滤归档任务：可见范围是调用方的展示决策。
 */
export function searchTasks({ sessions, summaries, agents, query }: TaskSearchInput): TaskSearchMatch[] {
  const terms = taskSearchTerms(query);
  if (!terms.length) return [];
  const agentById = new Map(agents.map(agent => [agent.id, agent]));
  const matches: TaskSearchMatch[] = [];
  for (const session of sessions) {
    const hit = scoreSession(terms, taskSearchCandidates(session, summaries[session.id], agentById.get(session.agentId)));
    if (hit) matches.push({ session, score: hit.score, fields: hit.fields });
  }
  return matches.sort((left, right) => right.score - left.score
    || (right.session.updatedAt || right.session.createdAt || '').localeCompare(left.session.updatedAt || left.session.createdAt || '')
    || left.session.id.localeCompare(right.session.id));
}
