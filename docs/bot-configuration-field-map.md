# Bot 配置归并字段与写入边界

状态：字段及写边界已通过独立复核，按 V2 冻结契约分单实施。接续已通过的 [激活设计](bot-activation-design.md)。本稿固定现有字段的唯一归属与迁移不变量；纯 schema/转换和配置仓储先交 ccflash，完整 listener/授权调用接线仍需共同验收。

## 归属

保留 ChannelBot 和 ChannelBotGroupPolicy 的 ID，扩充为 V2，不再增加另一份能独立生效的 StoredLarkConfig。Policy 继续承担已有 defaults/routing/access/groupTools；新增执行与展示字段也放在这个经过校验的关联对象中。原 legacy env/startupCommands 不重新启用。

| 当前 StoredLarkConfig 字段 | V2 权威位置 | 转换要求 |
| --- | --- | --- |
| appId、brand | ChannelBot.externalAppId/brand | App 身份与连接域；变化失效身份、群事实及旧连接代际 |
| appSecret | SecretProvider 的 Lark credential bundle，由 ChannelBot.credentialRef 引用 | 写入、读回验证后才能事务切换；不进入公开投影或新的 Policy |
| name、displayName | ChannelBot.platformDisplayName/displayName | 平台名称与用户备注分开；旧 tabLabel 显示规则保留，普通编辑不撤销连接 |
| revision | 配置服务的组合 revision | 覆盖 Bot、Policy、确认与目标凭据引用的修改；不能只返回某一张表的 revision |
| listening | ChannelBot.desiredListenerState | 表达接收/暂停；Bot 的 enabled/disabled 独立表达执行授权 |
| defaultAgentId、workspace、defaultModel、defaultReasoningEffort | Policy.defaults 现有字段 | 复用 agentDefinitionId/workspace/model/reasoningEffort；保留未配置与显式清除语义 |
| permissionMode、preInjectPrompt | Policy.execution.permissionMode/preInjectPrompt | 原 permissionMode 缺省为 full-trust，不能在迁移中误读成 ask；执行确认单独校验 |
| fullTrustConfirmed | 有范围的 FullTrustConfirmation | 不再是可直接 PATCH true 的布尔开关；兼容布尔是当前有效确认的计算投影 |
| p2pMode | Policy.routingDefaults.p2pMode | 旧缺省 chat；与群落点独立 |
| groupReplyMode、mentionPolicy | Policy.routingDefaults 现有字段 | 保留旧 groupReplyMode 未配置时的运行分支，不能统一写 chat 使消息换会话 |
| allowedUsers、allowedEmails | Policy.accessPolicy 的 App 范围人类允许规则，引用身份 locator/principal | 按动作和入口转换：托管群和静态操作入口取并集，非托管发送入口在 users 非空时仅使用 users；email 未解析不能降级为 open |
| allowedBots、peerBotsAllowed | Policy.accessPolicy 的 Bot 允许规则 | 按私聊/托管/新群分别保存；托管不能 OR 非托管 allowedBots/peer，空 Bot 名单可表达 deny-all/peer-only |
| highRiskAllowedUsers、highRiskAllowedEmails | Policy.execution.highRiskAccess | 与普通提问和运行操作权限分开；私聊/非托管入口 users 非空时优先 users，托管群实际风险策略取 users/emails 并集，分 profile 保存 |
| highRiskPattern、riskControlMode | Policy.execution.riskControlMode/highRiskPattern | 复用原正则校验与 off/guidance/enforced；enforced 的 hook 检查仍在实际激活流程完成 |
| groupToolsEnabled、groupToolsAllowSend | Policy.groupToolsPolicy 现有 ceilings/defaults | 开 read/discover 不授 send；群级 override 不能超过 App 上限 |
| webBaseUrl、structuredAskCards、groupCardMention、pushIntervalMs、traceLimit、hideTraceOnComplete | Policy.presentation | 明确标注哪些只影响新展示、哪些需要刷新在途卡片；保持原校验与默认值 |
| managedGroup | 每条消息的运行投影 | 永不保存进 Bot 配置；groupBinding/revision/principal 来源于本次授权 |
| env、startupCommands | 受保护的 legacy 迁移快照 | 保留可审阅来源数据，继续不注入/不执行/不公开，不复制进新 Policy 的 opaque JSON |

兼容 SaveLarkConfigInput 的 stage、expectedRevision、originalAppId 是操作参数，不成为运行字段。gateEnabled/softGateEnabled/hardGateEnabled 在转换边界按当前归一化规则转 riskControlMode；hookTrustConfirmed 继续不授予执行权。allowedBotNames 只用于远端解析的输入，不能作为权限 identity。

旧权限必须保留“可提问”和“可操作自己的任务”的实际语义，同时使两项在 V2 可单独管理。现 group.authorize 对整个 canTalk 判定临时补 can_operate/own_runs，包含 oncall、全群、群名单、继承 App allowedUsers/email 和显式 can_talk 角色；托管入口不读取非托管 allowedBots/peer；groupToolsSend 还继承 App 开关。主体还包括满足这些条件的 Bot，不能转换时只保留人类。迁移将当时的授权规则展开为独立 own_runs 规则，保留群范围、主体条件、到期时间和 action gate；新 can_talk 不再隐含 can_operate，更不能变为 group_runs。具体类型见 [V2 设计稿](bot-configuration-v2-design.md)。

## 凭据与配置快照

每个 App 的配置快照至少返回 ChannelBot、Policy、credential metadata、当前组合 revision、authorization revision、connection generation，以及只读 readiness。组合 revision 用于用户编辑 CAS；authorization revision 用于执行决定；connection generation 用于真实连接回调。各自变化规则必须显式，不能以一个全局“配置变了”替代。

| 修改 | 必须产生的效果 |
| --- | --- |
| 名称/展示参数 | 更新配置投影；保留有效连接，后续回调读最新展示设置 |
| Agent/目录/模型/注入提示 | 后续指令使用新配置；已接受输入仍是原快照，重新授权；确认范围按最终规则核对 |
| 权限、角色、工具上限 | 提升授权版本；旧 prepare 不能越过提交，必要时撤销已接受和在途动作 |
| 凭据引用/版本、App ID、brand | 提升连接代际并失效身份事实；旧 pending start、重连和回调不再接收，回收自己连接 |
| 暂停接收 | 撤销入站连接；保留已接受任务的执行资格复核，不伪装为任务已停止 |
| 停用/删除 | 撤销 App 执行授权、入站及工具动作；枚举群、私聊和派生任务，安排 Runtime 停止，未证明退出继续阻塞 |

管理 CLI 可以与 Runtime 同时访问数据库。因此凭据 rotate、直接仓储更新和回滚必须在同一事务提升对应版本，不能依赖仅在 server 进程里的事件回调。server 还需从持久配置变更恢复 listener 刷新；每次入站/执行提交先校验数据库当前版本，不能等刷新轮询后才撤销。该提交与 P0 markSubmissionPending 的事务接缝需在 Runtime 整合时定清楚。

## 权威切换与历史

权威标记按完整 legacy collection 与全部原生 Bot 集合一起切换，不能出现一部分 getter 读新表、另一部分 fallback 又创建 lark.bots。转换准备固定完整旧 collection、全部原生 Bot/Policy/Binding/Role/SecretRef 与确实消费的定义/事实版本、对象映射的内容和集合成员摘要；写文件期间新增/删除/编辑原生对象同样使最终 CAS 冲突。转换事务重新核对最终源、写 V2 对象/引用/版本、保存源映射并切换 authority。失败保留旧运行链路，未引用的新凭据文件按实际 fingerprint 清理。

已有 lark.live-owner 的 Bot、SecretRef、GroupBinding、RoleAssignment、Session/source ID 必须复用；同 App 已有不同来源 draft 时输出具体对象冲突，不能按新前缀再建一份可监听 Bot。迁移不能将 staged 对象当已激活、将没确认过的 full-trust 设 true，或将无法解析的人类 locator 改成 open。

legacy KV 切换后仅作受保护快照；readLarkConfigs 的 risk flags/单条凭据 fallback 不再写它。现有 CLI/API 通过配置服务生成 StoredLarkConfig 的临时执行投影。出站临时 input/env 凭据仍是独立显式调用，不会自动创建管理对象或启动 listener；setup 若要实现“配置后可收消息”，必须接正式配置与激活流程。

## 必须接入的写路径

实施时按实际源码覆盖以下集合，不能只修 Web 保存按钮：

1. readLarkConfigs 的读时 CAS 迁移、save/mutate/delete、普通 PUT、hooks/install。
2. app-creation 后台保存及重试、创建 CLI 的 agent 阶段保存；都须 expectedRevision/tombstone，迟到结果不得复活已删除 App。
3. group ensureOwner 的三次分离创建、syncOnce/save 中两处直接读取 tx.config 的授权依据。
4. foundation Bot/Policy/GroupBinding/Role/RemoteFact 管理写入口与底层 rollbackLast；手工事实不冒充真实平台验证。
5. Secret CLI set/rotate/remove 与 foundation 凭据更新、brand/App 重绑；在线 CLI 变更不能绕过版本提升。
6. 新导入作业的固定映射与应用事务；公开脱敏 manifest 不作为实际 apply 载荷。

现有 listener 的真实启停也需改：pool 在 start 前登记代际，覆盖 pending start；ask 模式不能被 fullTrustConfirmed 过滤；brand 属于连接身份；普通配置刷新保留连接而更新投影；service.close 等待已进入的入站、群同步、欢迎消息、交付和创建作业的尾声。该部分沿用激活设计，不在字段 converter 中塞网络动作。

## 下一批拆分的进入条件

先冻结 V2 schema、身份 locator/默认 own_runs 兼容、FullTrustConfirmation 的确切覆盖规则，以及统一配置事务 API/authority marker。然后拆为纯字段转换与真实 SQLite CAS/凭据准备单元、listener 生命周期单元、App 授权与撤销单元、导入/管理入口单元。各单元有独立 worktree 和故障测试，最终共同验收新建、现有和导入三条旅程。

本稿未实现上述字段或改变任何真实 Bot 配置。平台成员事件、真实凭据轮换和跨平台运行仍须实测，不能把接线清单计成能力已补齐。
