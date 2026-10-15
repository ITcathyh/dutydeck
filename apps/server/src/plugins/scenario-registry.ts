import { createHash } from 'node:crypto';
import { scenarioBindingStatus, type ScenarioBinding, type ScenarioPack } from '@dutydeck/shared';
import type { ScenarioProviderCaller } from './scenario-providers.js';
import { scopeApplies, type PluginScopeContext } from './scope.js';

export interface RegisteredScenarioPack {
  plugin: string;
  builtin: boolean;
  scope: string;
  pack: ScenarioPack;
  /** 包内容的 sha256，冻结到场景记录和快照里。 */
  digest: string;
  /** 包引用的 provider，按 id；只能经截止时间封装调用。 */
  providers: ReadonlyMap<string, ScenarioProviderCaller>;
}

export const scenarioPackDigest = (pack: ScenarioPack) => createHash('sha256').update(JSON.stringify(pack)).digest('hex');

/**
 * 已加载的场景包。顺序就是加载顺序：内置插件在前，外部插件按名字；同一插件内按包 id。
 * 包 id 全局唯一，后加载的同名包由宿主跳过并记诊断。
 */
export class ScenarioRegistry {
  private readonly entries: RegisteredScenarioPack[] = [];

  has(id: string): boolean { return this.entries.some(entry => entry.pack.id === id); }
  get(id: string): RegisteredScenarioPack | undefined { return this.entries.find(entry => entry.pack.id === id); }
  list(): readonly RegisteredScenarioPack[] { return this.entries; }

  add(entries: RegisteredScenarioPack[]) {
    for (const entry of entries) if (this.has(entry.pack.id)) throw new Error(`场景包 ${entry.pack.id} 已经登记`);
    this.entries.push(...entries);
  }

  /** 插件作用域适用的包（不看群绑定），例如群设置里列出可开启的包。 */
  forScope(context: PluginScopeContext): RegisteredScenarioPack[] {
    return this.entries.filter(entry => scopeApplies(entry.scope, context));
  }

  /** 作用域适用、且本群绑定已开启、大版本一致、direct 包来源不为空的包。 */
  applicable(context: PluginScopeContext, bindings: Readonly<Record<string, ScenarioBinding | undefined>>): Array<{ entry: RegisteredScenarioPack; binding: ScenarioBinding }> {
    return this.forScope(context).flatMap(entry => {
      const binding = bindings[entry.pack.id];
      return binding && scenarioBindingStatus(entry.pack, binding) === 'enabled' ? [{ entry, binding }] : [];
    });
  }
}
