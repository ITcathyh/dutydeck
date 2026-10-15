import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import type { ScenarioParam } from '@dutydeck/shared';
import { ApiError, collaborationApi, type CollaborationDuty, type CollaborationScenario, type UpdateCollaborationDutyInput } from '../api';
import { Banner, Button, Field, Input, Select } from './primitives';

type Responder = 'none' | 'self' | 'other';
/** 一个场景包的草稿：参数按输入框里的文字存，提交时再按类型转换。 */
type PackDraft = { enabled: boolean; params: Record<string, string> };
type Draft = { responder: Responder; packs: Record<string, PackDraft> };

/** 列表参数只按逗号（中英文）和换行分隔：路径和关键字里可以有空格。 */
const listItems = (text: string) => [...new Set(text.split(/[,，\n]+/).map(item => item.trim()).filter(Boolean))];

/** integer 显示成数字，string_list、bot_list 用逗号分隔（bot_list 只显示 appId）。没有绑定时用包的默认值。 */
function paramText(param: ScenarioParam, value: unknown): string {
  if (param.type === 'integer') return String(typeof value === 'number' ? value : param.default);
  const list = Array.isArray(value) ? value : param.type === 'string_list' ? param.default : [];
  return list.map(item => param.type === 'bot_list' ? (item as { appId: string }).appId : String(item)).join(', ');
}

function packDraftOf(scenario: CollaborationScenario): PackDraft {
  return {
    enabled: scenario.binding?.enabled ?? false,
    params: Object.fromEntries(Object.entries(scenario.params).map(([name, param]) => [name, paramText(param, scenario.binding?.params[name])]))
  };
}

function draftOf(duty: CollaborationDuty, scenarios: CollaborationScenario[], appId: string): Draft {
  return {
    responder: !duty.responder ? 'none' : duty.responder.appId === appId ? 'self' : 'other',
    packs: Object.fromEntries(scenarios.map(scenario => [scenario.id, packDraftOf(scenario)]))
  };
}

/** 输入框文字转成参数值；bot_list 的名字只用于展示，沿用已有绑定里的。取值范围由服务端按包的声明校验。 */
function paramValue(param: ScenarioParam, text: string, current: unknown): unknown {
  if (param.type === 'integer') return Number(text);
  if (param.type === 'string_list') return listItems(text);
  const names = new Map(Array.isArray(current) ? current.map((item: { appId: string; name?: string }) => [item.appId, item.name]) : []);
  return listItems(text).map(id => { const name = names.get(id); return { appId: id, ...(name ? { name } : {}) }; });
}

/** 开启时来源机器人参数（role 为 source 的 bot_list）至少要填一个。 */
const missingSourceParams = (scenario: CollaborationScenario, pack: PackDraft) => pack.enabled
  ? Object.entries(scenario.params).filter(([name, param]) => param.type === 'bot_list' && param.role === 'source' && !listItems(pack.params[name] ?? '').length).map(([name]) => name)
  : [];

/** 群设置里的分工：接话人和各场景包的开关与参数。只提交改动的那几项。 */
export function GroupDutySettings({ appId, chatId, botName, duty, scenarios, onSaved }: { appId: string; chatId: string; botName?: string; duty: CollaborationDuty; scenarios: CollaborationScenario[]; onSaved(): Promise<unknown> }) {
  const saved = draftOf(duty, scenarios, appId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const value = draft ?? saved;
  const update = (patch: Partial<Draft>) => { setDraft({ ...value, ...patch }); setNotice(null); };
  // 编辑中概览新增了包时，草稿里还没有它，用已保存的值。
  const packOf = (id: string) => value.packs[id] ?? saved.packs[id]!;
  const updatePack = (id: string, patch: Partial<PackDraft>) => update({ packs: { ...value.packs, [id]: { ...packOf(id), ...patch } } });
  const responderChanged = value.responder !== saved.responder;
  const changedParams = (id: string) => Object.keys(packOf(id).params).filter(name => packOf(id).params[name] !== saved.packs[id]!.params[name]);
  const changedPacks = scenarios.filter(scenario => packOf(scenario.id).enabled !== saved.packs[scenario.id]!.enabled || changedParams(scenario.id).length);
  const blocked = changedPacks.some(scenario => missingSourceParams(scenario, packOf(scenario.id)).length);
  const other = duty.responder && duty.responder.appId !== appId ? duty.responder : undefined;

  const save = useMutation({
    mutationFn: () => {
      const body: UpdateCollaborationDutyInput = { expectedRevision: duty.revision };
      if (responderChanged) body.responder = value.responder === 'self' ? 'self' : null;
      // 参数只给改动的键，服务端按包默认 → 已有绑定 → 这次的值合并。
      if (changedPacks.length) body.scenarios = Object.fromEntries(changedPacks.map(scenario => {
        const pack = packOf(scenario.id);
        const names = changedParams(scenario.id);
        return [scenario.id, { enabled: pack.enabled, ...(names.length ? { params: Object.fromEntries(names.map(name =>
          [name, paramValue(scenario.params[name]!, pack.params[name]!, scenario.binding?.params[name])])) } : {}) }];
      }));
      return collaborationApi.updateDuty(appId, chatId, body);
    },
    onSuccess: async result => {
      setDraft(null);
      setError(null);
      setNotice(result.announced === false
        ? { tone: 'warning', text: `已保存，但群里的接话人声明没发出去，其他机器人可能还不知道。${result.duty.responder
          ? '可以在群里 @本 Bot 说「你负责接话」重发声明。' : '需要别的机器人接时，在群里 @它 说「你负责接话」。'}` }
        : { tone: 'success', text: '群分工已保存。' });
      await onSaved();
    },
    onError: failure => setError(failure instanceof ApiError && failure.code === 'COLLABORATION_REVISION_CONFLICT'
      ? '群分工已被修改，请放弃修改后重新编辑。' : failure instanceof Error ? failure.message : '保存失败')
  });

  return (
    <div className="space-y-4 rounded-lg border border-subtle p-4">
      <div className="text-body font-semibold text-primary">群分工</div>
      {error && <Banner tone="danger">{error}</Banner>}
      {notice && <Banner tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Banner>}
      <Field label="接话人" hint="群里有多个机器人时，没 @ 机器人的消息只由接话人接，其他机器人只接 @ 和自己接手的话题。设成本 Bot 或取消时，本 Bot 会在群里发一条声明，其他 Dutydeck 机器人据此同步。">
        <Select value={value.responder} onChange={e => update({ responder: e.target.value as Responder })}>
          <option value="none">未指定</option>
          <option value="self">本 Bot{botName ? `（${botName}）` : ''}</option>
          {other && <option value="other" disabled>{other.name ?? other.appId}（另一个机器人，在群里声明的）</option>}
        </Select>
      </Field>
      {scenarios.map(scenario => {
        const pack = packOf(scenario.id);
        // direct 包要以在群里确认过的人的名义发起；大版本过期的要先在群里重新确认。已开着的仍可以关掉。
        const needsRequester = scenario.requiresRequester && !scenario.binding?.requesterId;
        const missing = missingSourceParams(scenario, pack);
        return (
          <div key={scenario.id} className="space-y-4 border-t border-subtle pt-4">
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-default text-action focus:ring-action"
                checked={pack.enabled}
                disabled={(needsRequester || scenario.versionStale) && !pack.enabled}
                onChange={e => updatePack(scenario.id, { enabled: e.target.checked })}
              />
              <span>
                <span className="block text-caption font-semibold text-primary">{scenario.title}</span>
                <span className="mt-1 block text-meta text-subtle">{needsRequester ? scenario.description : scenario.webDescription ?? scenario.description}</span>
                {needsRequester && <span className="mt-1 block text-meta text-subtle">{scenario.enableHint ?? '请先在群里 @机器人 说开启并点确认，之后可以在这里改设置。'}</span>}
                {scenario.versionStale && <span className="mt-1 block text-meta text-warning">场景包已升级到 v{scenario.version}，要先在群里重新确认才能开启。</span>}
              </span>
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              {Object.entries(scenario.params).map(([name, param]) => (
                <Field key={name} label={param.label} {...(param.hint ? { hint: param.hint } : {})} {...(missing.includes(name) ? { error: '开启时至少填一个来源' } : {})}>
                  {param.type === 'integer'
                    ? <Input type="number" min={param.min} max={param.max} className="w-32" value={pack.params[name]} onChange={e => updatePack(scenario.id, { params: { ...pack.params, [name]: e.target.value } })} />
                    : <Input value={pack.params[name]} onChange={e => updatePack(scenario.id, { params: { ...pack.params, [name]: e.target.value } })} {...(param.type === 'bot_list' ? { placeholder: 'cli_xxx' } : {})} />}
                </Field>
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" disabled={!draft || save.isPending} onClick={() => { setDraft(null); setError(null); }}>放弃修改</Button>
        <Button variant="primary" disabled={!(responderChanged || changedPacks.length) || blocked} loading={save.isPending} onClick={() => save.mutate()}>
          <Check size={14} className="mr-1.5" />
          保存分工
        </Button>
      </div>
    </div>
  );
}
