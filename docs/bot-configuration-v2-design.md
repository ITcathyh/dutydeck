# Bot 配置 V2：数据、确认与事务接口

状态：四组契约已通过独立返修复核，controller 已补齐唯一剩余的实际依赖来源定义，可分单实施。接续 [激活设计](bot-activation-design.md) 和 [字段映射](bot-configuration-field-map.md)，不改变真实配置。本稿拆分配置数据与接口；listener、App 撤销和导入的完整旅程仍须一起交付。

## 数据结构

复用 channel_bots、channel_bot_policies、group_bindings、role_assignments、secret_refs 和现有身份事实，不建另一份可运行的 Bot JSON。现有 V1 严格 schema 保留给迁移解码；新运行投影只解 V2。数据库列迁移和权威切换分开，schema 加列不自动启动 Bot。

| 对象 | V2 变化 |
| --- | --- |
| ChannelBot | schemaVersion=2；state 为 staged/enabled/disabled/deleted；desiredListenerState 为 receiving/paused；platformDisplayName 可空，displayName 为用户备注；保留 ID、channel、externalAppId、brand、credentialRef 和时间 |
| Bot 版本 | Bot.revision 成为组合编辑 revision；authorizationRevision、connectionGeneration 为独立正整数列；任何关联 Policy、角色、群绑定和凭据变更通过统一短事务更新相应版本 |
| Policy | schemaVersion=2；保留 defaults、groupToolsPolicy；扩展 routingDefaults、accessPolicy、execution、presentation，字段唯一归属见映射表 |
| GroupBinding | schemaVersion=2；增加 enabled 状态，保留 staged/disabled/needs_review/archived；激活仍要求真实群事实；覆盖字段保持 inherit/set/clear 语义 |
| FullTrustConfirmation | 新表按确认 ID 保存不可变范围、范围摘要、确认人、时间、来源和撤销状态；Bot 不保存独立可写 true 值 |
| 配置权威 | singleton marker 为 legacy/v2，包含迁移 ID、来源 collection digest、提交时间；旧 lark.bots 在 v2 下只作受保护快照 |
| 配置变更 | 单调 sequence、Bot ID、新三个版本和变更种类；与配置同事务保存，供 server 启动恢复和在线 CLI 刷新 |

删除使用 tombstone，保留对象映射和授权撤销版本。新建相同 externalAppId 必须显式恢复或处理原 tombstone，迟到向导/导入不能复活旧 Bot。原表的 channel + externalAppId 唯一性继续约束单一 App；brand 变更使身份事实与连接失效，不额外创建一份同 App Bot。

Policy.routingDefaults 的 p2pMode 明确为 chat/thread；groupReplyMode 为现有枚举或 runtime_default，后者保持旧字段缺省时的实际分支。旧 mentionPolicy 缺省按当前归一化结果转换。JSON 中禁止 undefined；可清字段使用 null 或明确 override，不把省略理解成清空。

execution 包含 permissionMode、preInjectPrompt、highRiskAccess、riskControlMode 和 highRiskPattern。presentation 逐项校验 webBaseUrl、structuredAskCards、groupCardMention、pushIntervalMs、traceLimit、hideTraceOnComplete；不允许任意扩展 JSON。env/startupCommands 仅留历史快照。

## 人类与 Bot 权限规则

身份选择器为严格判别联合：principal_id、open_id、email、mobile、union_id。open_id 和 union_id 绑定所属 App；email/mobile 保留种类和规范化规则，不能直接当作 open_id。Policy 所属 channelBotId 是选择器范围的一部分。未解析不是空名单，也不是 open。

```ts
type AccessRules =
  | { mode: 'owner_only' }
  | { mode: 'allowlist'; selectors: IdentitySelector[] }
  | { mode: 'open' };
type BotAccessRules = { mode: 'open' }
  | { mode: 'allowlist'; selectors: IdentitySelector[]; peerEnabled: boolean };
type EntryRules<T> = { p2p: T; managedGroup: T; newGroup: T };
type HighRiskRule = { mode: 'entry_authorized' }
  | { mode: 'allowlist'; selectors: IdentitySelector[] };
interface BotAccessPolicy {
  humanTalk: EntryRules<AccessRules>;
  botTalk: EntryRules<BotAccessRules>;
  defaultOperate: { rules: OwnRunRule[] };
  p2pOperate: { mode: 'none' } | { mode: 'own_runs'; humans: AccessRules; bots: BotAccessRules };
}
interface OwnRunRule {
  id: string;
  groups: { profile: 'managed_group' | 'new_group'; bindingIds: 'all_verified' | string[] };
  subjects: { mode: 'all_chat_members' } | { mode: 'allowlist'; selectors: IdentitySelector[] }
    | { mode: 'bots'; access: BotAccessRules };
  expiresAt?: string;
  actionGates: { terminalWrite: false; highRisk: false; groupToolsSend: boolean };
}
// Policy.execution 中保存：
// highRiskAccess: EntryRules<HighRiskRule>
```

人类及高风险 allowlist 必须非空；Bot allowlist 允许空，peerEnabled=false 时拒绝所有 Bot，true 时仅允许当前入口确已验证的可信 peer。Bot 规则只匹配可信身份事实证明为 Bot 的主体，人类规则只匹配人类；两者可复用 locator 类型，不能从名称推断主体种类。未知身份保持 unresolved。peer 仍需原有通道、groupTools 与 chat 条件，不以一个布尔值跳过它们。

三个入口分别保存规则。V2 的每个群要验证成员事实并建立 Binding，accessProfile 固定为 managed_group 或 new_group；同步发现新群不改变 profile。管理者切 profile 时显示权限差异并检查 revision/确认范围。新 Bot 的人类三个默认规则均 owner_only，Bot 三个规则均空名单且 peerEnabled=false，defaultOperate.rules=[]、p2pOperate=none。

| 来源和动作 | V2 转换 |
| --- | --- |
| 旧私聊/非托管群人类新任务 | users 非空只取 users；否则 emails 非空取 emails；否则 open，写 p2p/newGroup |
| 原托管群继承 App 提问 | users/emails 并集；群开放、override、oncall、角色资格分别保留，写 managedGroup；实际开放情况由旧 effective access 一并转换 |
| 旧高风险私聊/非托管群 | users 非空只取 users，否则取 emails；都空为 entry_authorized |
| 原托管群高风险 | users/emails 并集；都空为 entry_authorized；仍与入口授权、enforced 模式、独立 highRisk gate 相交 |
| 私聊/非托管群 Bot 新任务 | 人类名单不受限时 open；否则复制 allowedBots 与 peer 条件，写 p2p/newGroup |
| 原托管群 Bot 新任务 | 不 OR 非托管 allowedBots/peer；按实际 canTalk 的 App allowedUsers/email、群开放/oncall/覆盖及角色条件转换，写 managedGroup 和群规则 |
| 原托管群操作 | 当时 canTalk 规则展开成独立 own_runs，已有 can_operate 保留 scope/gates |
| 私聊/非托管群操作 | 旧静态操作门的人类 users/emails 并集、Bot/peer 条件独立复制，限定 own_runs 和原 requester |

托管群旧代码未按主体种类区分 canTalk：oncall、全群和 principal 角色也可能授予 Bot。转换分别产生人类规则和 Bot 规则；例如旧 oncall 全成员资格产生 human all_chat_members 与 bot open，范围均为该 Binding。App allowedUsers 中的 open_id 和有效 email 条件也按原身份匹配表达，不能先假定全部是人类而丢掉旧资格；未能取得必要主体事实则 readiness 阻塞。原托管 allowedBots-only 的 Bot 仍不因此获准。实际成员身份、规则到期时间、groupToolsSend 上限必须保留。

原托管展开限定 managed_group，原非托管静态集合限定 new_group；私聊用独立 p2pOperate。all_chat_members 只匹配人类；Bot 操作资格用独立 subjects.bots 复制原条件并要求原 Task requester。新 can_talk、botTalk 或全群提问规则不再自动增加 operate，转换出的 OwnRunRule 有独立 ID/来源说明，后续显式管理。已有 can_operate RoleAssignment 原样保留，安装者的固有管理资格单独表达。

旧非托管部分控制只查静态名单而未证明任务归属；这种宽操作不转换成 group_runs/bot_runs。迁移报告列出缺 requester 的旧任务，要求补齐证明或显式有范围角色，这项收窄记入兼容报告。发布/修复、配置和终端写入继续走管理/独立 gate，不把旧不限名单变成全员管理。

entry_authorized 仅表示没有额外高风险名单限制，不能跳过入口、风险模式或独立 gate。角色、profile、规则变化均提升 authorizationRevision 并重算确认范围。最低矩阵覆盖三入口 users+emails 仅 email 命中、allowedBots-only 的托管拒绝/新群允许、Bot deny-all/peer-only、oncall/覆盖/到期角色的 own_runs 与 gate 保留。

安装者身份由本地已认证入口固定；通道 actor 用 App 内 open_id 解析为现有 opaque principal ID。email/mobile/union_id 匹配只接受可信目录响应或当前有效的已验证映射，不接受消息正文、自报字段或导入名称。解析事实固定 App、凭据版本、实际 open_id 和有效期；远端失败返回 unresolved blocker。具体目录端点和权限必须用真实样本验收，未接通的 locator 保持可修复状态，不开放执行。

群的 all_chat_members/oncall 只增加提问资格，不增加 defaultOperate。独立 terminalWrite/highRisk/groupToolsSend gate 继续由角色与应用上限决定。私聊同样执行 App humanTalk/p2pOperate，不能借无 GroupBinding 绕过 App 停用。

## Full-trust 确认范围

确认由已认证安装者或有明确管理权限的主体提交，输入必须带当前 Bot.revision 和 scopeDigest。prepareFullTrust 返回服务端计算的候选范围、摘要和版本，界面展示这些具体内容，再调用独立 confirmFullTrust 命令；提交事务重算范围并核对摘要和版本。客户端不能提交任意范围冒充已确认。兼容 API 的 fullTrustConfirmed 仅表示“当前候选范围已有有效确认”；通用 PATCH 中旧客户端的 true 不产生确认，未满足确认时返回明确的需要确认响应及预览入口，不能猜测旧页面已展示新范围。

FullTrustScopeV1 保存关联授权项，不能把调用者、群和执行配置各存一份集合再分别求子集：

```ts
interface FullTrustScopeV1 {
  version: 1;
  channelBotId: string;
  externalAppId: string;
  brand: 'feishu' | 'lark';
  entries: FullTrustScopeEntry[];
}
interface FullTrustScopeEntry {
  entry: { kind: 'p2p' } | { kind: 'group'; profile: 'managed_group' | 'new_group';
    bindingIds: 'all_verified' | string[] };
  subject: { kind: 'human'; rule: AccessRules } | { kind: 'bot'; rule: BotAccessRules };
  actions: PolicyAction[];
  operateScope: 'none' | 'own_runs' | 'group_runs' | 'bot_runs';
  executionDigest: string;
  directoryIdentityDigest: string;
  gates: { terminalWrite: boolean; highRisk: boolean; groupToolsSend: boolean };
  expiresAt?: string;
}
type ConfigurationDependency =
  | { kind: 'agent_config'; id: string; digest: string }
  | { kind: 'channel_bot_policy' | 'group_binding'; id: string; revision: number; digest: string };
interface ExecutionScopeEvidence {
  agentDefinitionId: string;
  agentDefinitionDigest: string;
  directoryIdentityDigest: string;
  executionDigest: string;
  directory: { requestedPath: string; source: 'policy' | 'binding' | 'agent' | 'process_cwd';
    sourceId?: string; absolutePath: string };
  configurationDependencies: ConfigurationDependency[];
}
```

executionDigest 包含实际 command/args/protocol、权限和隔离设置、环境来源引用、permissionMode、preInjectPrompt、riskControlMode/pattern；不只 hash agentId。目录身份包含最终规范目录与当前文件系统身份。模型/推理强度不扩展权限，单独改变不撤销确认。连接凭据轮换不扩大范围，App/brand 改变不匹配。

范围构造器按实际入口、Binding/profile、主体、角色动作/scope、执行定义和 gate 展开关联项；只可合并除单一集合维度外完全相同的项。候选每一项必须被同一确认项完整覆盖：App/brand、入口、执行/目录摘要相同；固定 Binding 集合为子集或确认 all_verified；动作/operateScope 不增加（none→own→group→bot 仅在同一实际入口和目标归属内比较）；同种身份规则收窄；gates 不从 false 升 true；有效期不延长。不能跨多个确认项拼接维度。Alice/群A/配置X 和 Bob/群B/配置Y 的确认绝不覆盖 Alice/群B/配置X。

owner_only 只被同一安装者的 owner_only、open，或显式含该安装者 principal_id 的人类名单覆盖，不能当任意名单的子集。不同 locator 种类不猜等价，Bot peerEnabled 只可收窄。群和角色仍需当前事实及独立授权。新增群仅在同 profile 的 all_verified 关联项和同一其他条件下被覆盖；新增执行定义需重新确认。角色扩权也必须被关联项覆盖。

外层在 SQL 事务前读取 Agent 定义、验证最终目录并准备 ExecutionScopeEvidence；仓储 prepareFullTrust 同步核对真实 agent_configs 内容摘要、Policy/Binding 的 revision 和内容摘要及所属 Bot，计算实际候选范围与 scopeDigest。确认命令携带同一 evidence 与 digest，在事务里重算并核对 Bot 及依赖；同 agentId 的 command/args 变化也冲突，不能只核对 Bot.revision。Agent 没有数据库 revision，不用 version/updatedAt 冒充；目录路径关联实际 Policy/Binding/Agent 来源，process.cwd fallback 在准备时固定，不要求不存在的 workspace 定义行。完整 Agent 行摘要用于 prepare/confirm 冲突，长期 executionDigest 仅含权限相关字段。证据仅由本地受信服务准备，公开 API 不接收任意客户端摘要；证据形成后目录变化在实际提交前重新验证。SQLite 不原子锁住外部文件系统，遇到身份变化阻塞并重新准备，不声称该证据永久有效。

迁移来源中 false/缺失从不生成确认。true 仅在完整等价转换并能计算范围时保存 source=legacy_live、原来源摘要及确认时间未知的标记，不虚构原确认人或时间；转换缺字段时 readiness 阻塞。导入 Botmux 的 true 不作为目标环境的有效确认。ask 模式不要求 full-trust 确认，但仍执行所有 App、群和工具权限规则。

FullTrustConfirmation 按 source 判别：user_action 必须有真实 confirmedBy 与 confirmedAt；legacy_live 的二者必须为 null，另带 legacySourceDigest 和 recordedAt（本次转换记录时间）。不能用迁移操作者或转换时间填入历史确认人/确认时间。邮箱和手机选择器只保存 email/mobile 一个身份值；不接收独立可写的 normalizedEmail/normalizedMobile。邮箱按 trim+小写、手机仅按 trim 规范化，不推测国家码。覆盖与摘要使用同一规范化结果，安装者只认 principal_installation_owner。

## 同步事务接口

storage 提供 configuration 仓储，公开写入口封装为命令；不向业务层暴露任意 SQLite callback。管理访问使用现有数据库 control access，运行态提交另外持有 Runtime claim。所有下列 commit 均在业务连接的 BEGIN IMMEDIATE 内完成，不 await 文件、平台或 Runtime.stop。

```ts
interface BotSnapshot {
  bot: ChannelBotV2;
  policy: ChannelBotPolicyV2;
  credential?: SecretRefMetadata;
  confirmations: FullTrustConfirmation[];
}
type ManagementActor = { kind: 'installation_owner'; principalId: 'principal_installation_owner' }
  | { kind: 'principal'; principalId: string; channelBotId: string };
interface ManagementOperation { operationId: string; actor: ManagementActor }
interface BotChangeRef extends ManagementOperation { botId: string; expectedRevision: number }
interface CreateBotV2 extends ManagementOperation {
  botId: string;
  externalAppId: string;
  expectedAppState: 'absent';
  bot: CreateChannelBotV2Fields;
  policy: CreateChannelBotPolicyV2Fields;
  preparedCredential?: PreparedCredentialRef;
}
interface BotRelatedMutation {
  policy?: { expectedRevision: number; patch: ChannelBotPolicyPatchV2 };
  bindings?: BindingMutationV2[];
  roles?: RoleMutationV2[];
}
interface SharedSecretChangeRef extends ManagementOperation {
  secretId: string;
  expectedSecretRevision: number;
  bots: Array<{ botId: string; expectedRevision: number }>;
}
interface ConfigurationRepository {
  read(botId: string): BotSnapshot | undefined;
  readByApp(appId: string): BotSnapshot | undefined;
  listChanges(afterSequence: number, limit: number): BotConfigChange[];
  create(input: CreateBotV2): BotSnapshot;
  update(ref: BotChangeRef, patch: BotConfigPatchV2): BotSnapshot;
  mutateRelated(ref: BotChangeRef, change: BotRelatedMutation): BotSnapshot;
  setReceiving(ref: BotChangeRef, receiving: boolean): BotSnapshot;
  setEnabled(ref: BotChangeRef, enabled: boolean): BotSnapshot;
  delete(ref: BotChangeRef): BotSnapshot;
  restoreDeleted(ref: BotChangeRef, prepared: PreparedBotRestore): BotSnapshot;
  restoreVersion(ref: BotChangeRef, versionId: string, prepared: PreparedBotRestore): BotSnapshot;
  prepareFullTrust(botId: string, evidence: ExecutionScopeEvidence[]): FullTrustPreview;
  confirmFullTrust(ref: BotChangeRef, scopeDigest: string, evidence: ExecutionScopeEvidence[]): BotSnapshot;
  revokeConfirmation(ref: BotChangeRef, confirmationId: string): BotSnapshot;
  bindPreparedCredential(ref: BotChangeRef, prepared: PreparedCredentialRef): BotSnapshot;
  rotateSharedSecret(ref: SharedSecretChangeRef, prepared: PreparedCredentialRef): BotSnapshot[];
  commitLegacyConversion(op: ManagementOperation, prepared: LegacyConversionInput): MigrationResult;
}
```

ManagementActor 复用安装者/已认证 principal 的管理身份判别联合；API 认证中间件或可信本地 CLI 注入，不能把 HTTP body 自报 actor 当认证。仓储每个命令在同一事务验证当前管理资格。operationId 持久去重并核对稳定载荷（含 actor、原目标、prepared fingerprint，不含用于首次比较的 expectedRevision）；重投仍需当前管理资格。异载荷冲突。客户端缺 revision 的旧接口从本次读取固定，提交冲突返回 409，不能盲写最新行。

CreateChannelBotV2Fields 只含名称、brand、初始 staged 状态/paused 意图；CreateChannelBotPolicyV2Fields 是完整严格 V2 Policy 去除 ID、revision、时间和 owner ID。create 在事务内验证 botId 及同 App 均不存在，原 tombstone 也算存在；同操作重投返回原对象。恢复走固定 botId+tombstone revision 的 restoreDeleted，不让迟到向导借 create 复活。后台作业持久原 operationId/actor/版本条件。

BindingMutationV2 与 RoleMutationV2 为严格 create/update 联合：create 带固定 id、expectedRevision=0 和现有 create 字段；update 带 id、expectedRevision 和现有严格 patch。全部实体须属 ref.botId，禁止移动 owner；一次 mutateRelated 先在事务内校验组合 revision 和所有实体的原 revision，完成全部更新后 Bot 只提升一次相应版本并追加一个变更记录，不在批内反复撞自己的 CAS。删除角色用现有 state 撤销；群归档保留 identity。Policy 字段同样经过此入口。

V2 下旧 foundation/GroupPolicy 的 Bot、Policy、Binding、Role 管理写入口返回 `CONFIGURATION_COMMAND_REQUIRED`；API/CLI/群管理逐一改调上述命令。保留旧只读和 legacy 写路径供切换前使用，内部 SQL 实现复用但不公开无 context 写口。groupPolicy.transact 的配置编辑和 tx.config.set 同样受门禁；通用 config.set/compareAndSet 与任何事务底层都禁止修改配置 authority、受保护 legacy collection/live-owner 映射。只有迁移命令私有代码可以写这些键，不能用可伪造的参数 bypass。

远端身份/成员事实刷新不是管理编辑。其既有严格 upsert/invalidate 接口保留，V2 增加服务持有的事实写 context（Bot ID、authorizationRevision、credentialRef/revision、原事实 revision）；事务核对当前关联及来源可信验证通道，不接收普通客户端自报验证成功。事实到期/退群立即影响实际授权；无需伪造一个管理 actor 或把每次成功刷新都提升 Bot 组合版本。创建/改群配置仍走 mutateRelated，不借事实刷新修改策略。旧 remoteChatFacts.create/update 在 V2 下封口；名称收尾使用只改展示字段、保留原事实有效性的窄接口，详见 [仓储接线](bot-configuration-storage-design.md)。

共享 SecretRef rotate 在事务内检查 secret revision 和实际引用 Bot 的完整集合恰好等于 ref.bots（含 deleted 的保留引用），逐一比较组合 revision并验证操作者对所有 Bot 的管理资格，再切准备好的不可变引用、失效旧凭据事实、每个 Bot 一次提升三个版本并追加变更。准备期间新增引用、删引用、改 Bot 均冲突；不得只更新调用入口那个 Bot。还存在调度引用时遵循[仓储接线](bot-configuration-storage-design.md)中的安装者资格，不仅按当前 Bot 绑定授权。未引用 secret 使用独立 Secret CLI 的带 actor/opId/revision 命令，不能借它绕开六类实际外键引用检查。

PreparedBotRestore 固定目标历史版本摘要、当前源对象集合摘要及已回读 PreparedCredentialRef；恢复服务先解析/校验完整目标配置与真实文件，再提交。restoreVersion/restoreDeleted 都产生新组合/授权/连接版本，state=staged、receiving=paused，历史确认仅留审计不恢复有效，用户重新激活/确认。底层 rollbackLast 在 V2 返回 `CONFIGURATION_RESTORE_PREPARATION_REQUIRED`，不能恢复旧计数、旧凭据文件内容或确认有效性。共享 SecretRef 的历史恢复仍走全引用集合 rotate，不能悄悄改变其他 Bot。

名称/展示只提升组合版本；执行默认值提升组合和授权版本；角色/群/上限提升组合和授权版本；App/brand/凭据、停用、删除提升三个版本；暂停接收只提升组合和连接代际。重新接收也创建新代际。每条记录变化均有 sequence；没有变化的同操作重投不增加版本。

## 凭据准备与权威迁移

凭据文件由 SecretProvider 先以新引用写入并回读，得到只在本次操作使用的 PreparedCredentialRef，包含 secretId、provider/referenceKey/fingerprint/预期 SecretRef revision，不包含可公开的 secret 值。expectedRevision=0 表示该 secretId 必须不存在；正整数匹配已有元数据行。provider/referenceKey 没有数据库唯一约束，不能用它们代替 secretId。共享轮换时 prepared.secretId 与 ref.secretId 必须一致。metadata 的 configured 不能代替文件回读。最终事务检查原 Bot/凭据版本及来源 digest，再关联新引用。事务失败后按原引用和 fingerprint 清理未引用文件；有引用的文件不能删除。正常 rotate 保留旧版本到引用和回滚窗口结束，不能覆盖原文件让旧引用悄悄变值。

LegacyConversionInput 固定 source fence 与 prepared target：

```ts
interface LegacyConversionInput {
  migrationId: string;
  source: {
    authority: 'legacy';
    legacyCollectionDigest: string;
    appIds: string[];
    nativeConfigurationDigest: string;
    mappingDigest: string;
  };
  targetDigest: string;
  bots: PreparedBotConversion[];
}
```

legacyCollectionDigest 覆盖完整原 KV（缺失与空集合不同）；mappingDigest 覆盖实际消费的 live-owner、导入源及 Session/source 对象映射。App 集合从最新完整 legacy collection、源映射与全部原生 channel_bots 自然键的并集重算，不接受客户端删减检查范围。nativeConfigurationDigest 对该完整集合的 Bot/Policy/Binding/Role/SecretRef 行、参与确认的 Agent/工作区定义及确实消费的身份事实引用做规范摘要，包含完整集合成员和 ID/revision/内容、tombstone；不能只保存准备时已见行的 revision。没有 KV/源映射的原生草稿也须等价转换，缺 Policy 时补不授予执行能力的禁用缺配置目标；未纳入的 V1 配置行阻止全局切换。准备后新增 App/Role/Binding、移除和新凭据引用均重新检查；未消费的高频运行事实不进入摘要。

最终短事务重新读取/转换来源并核对全部 source fence 和 targetDigest，再复用现有 ID 写入 V2 对象/确认、受保护历史、版本/变更记录，最后切 marker。已有 live_lark_config SecretRef 的同 ID 搬迁属于该私有事务：核对原元数据和全引用 Bot 集合、写准备后的真实引用并增加凭据 revision、失效旧事实；不能事先改来源或新增另一 secretId。具体匹配和回滚规则见仓储接线稿。prepared target 是经过严格转换的 private 数据，不是公开脱敏 manifest。任一原生配置变动，即便 lark.bots 不变，也必须冲突并重新准备。凭据源及引用版本属于 fence；事实版本变化只在参与准备证据时导致重算。

全量转换一次提交；未决同 App 冲突阻止切换，不部分激活。固定 migrationId 与对象映射支持同作业重投，authority 已 v2 时仅相同已存操作可读回事实，迟到其他作业拒绝。凭据准备期间旧写入、新增 draft、Role、oncall、群 override 或 SecretRef 变化都不得覆盖。事务失败保留原 marker 与全体对象，未引用的新文件按 fingerprint 清理。

切换后的 readLarkConfigs 只能从 V2 生成执行投影，不再 CAS 写 legacy 风险字段或 fallback 凭据。API、向导、CLI、群事务授权和 listener 全部读同一 marker。转换成功前后反复打开都不能生成第二组对象。只准备 schema/转换函数的中间版本保留 legacy 权威，不把历史快照当运行权威。

## 执行授权与撤销的事务接缝

App 准备授权返回只读证据：Bot ID/authorizationRevision、凭据版本、可选 Binding/Role 版本、主体、允许动作、事实有效期及确认引用。Runtime 的接受/提交命令在同一业务事务检查这些实际行，才保存接收或 markSubmissionPending；不能在另一连接 assert 后再写。展示版本变化不使执行证明失效，connectionGeneration 只在接收新入站时校验。

Session 的 App 来源一旦接受就持久化；WorkItem/Automation 的派生任务保留同一授权来源和原操作者，不能只按 source=lark 枚举撤销目标。停用/删除先提交授权版本和影响记录，退出 App 序列后安排 Runtime.stop；运行器每项外部动作也检查当前授权。外部调用已进入后无法撤回其副作用，收口记录实际结果；不宣称撤销与远端操作是同一原子事务。

在线 CLI 的版本变化由 server 消费持久变更序列并主动补查，重开从当前目标状态恢复 listener；每次入站和执行提交仍直接校验数据库，不依赖补查时机。服务关闭先撤销接收，再等已经进入的配置/身份/入站本地提交与交付尾声，最后关闭仓储。

## 拆分与验收

设计审查通过后，先交 ccflash 实现纯 V2 schema、字段转换、确认覆盖和真实 SQLite 命令，默认保留 legacy marker；接着实现凭据准备与所有旧入口，最后在同一整合版切 listener/授权/API。代码单元之间可独立，但 P1 验收必须覆盖三种来源的真实激活与撤销。

必测：完整旧字段读回、三入口名单优先/并集与 own_runs 不扩大、未解析 locator、收窄/扩大确认范围、角色绕过确认、标题修改保留确认、凭据回读失败、原生配置/集合成员变化的来源 CAS 冲突、事务回滚、同作业重投、迟到创建撞 tombstone、CLI rotate 与运行提交交错、暂停保留已接受工作、停用覆盖私聊及派生任务、重开继续配置变更消费。真实平台身份和消息未运行时保持未完成。
