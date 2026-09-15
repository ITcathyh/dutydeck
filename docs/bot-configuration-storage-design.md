# Bot 配置仓储接线

状态：三项边界修订已通过独立增量复核，按本稿分单实施。补齐 [V2 数据与事务设计](bot-configuration-v2-design.md) 在当前 SQLite 表和读取接口上的接缝，暂不切换 authority。配置模型和覆盖算法已有独立实现；本稿不重复字段及权限转换矩阵。

## 当前约束

已读 foundation.ts、group-policy.ts、storage/index.ts、shared/index.ts、shared/group-policy.ts 及 v11/v12 迁移。三个配置表仍有 schema_version=1 和 V1 状态的 CHECK；只加 TypeScript 类型不能保存 V2。旧 Bot/Policy/Binding getter 按 V1 严格解码，不能把 enabled 对象伪装成 disabled V1 返回。SecretRef 的 provider/reference_key 没有唯一约束，实际身份为 id。

配置事务的 callback 虽然同步，内部方法也能被调用者带出 callback 后调用。因此 V2 门禁必须在每个实际写方法执行时检查，不能只检查 transact 入口。通用 config.set/compareAndSet 和 groupPolicy 的 tx.config.set 目前都可直接写 KV。

## 读取与历史接口

ConfigurationRepository 增加以下同步读取，类型与实现一起落在仓储单元；当前纯 schema 单元不返工这些接口。

```ts
authority(): 'legacy' | 'v2';
listBots(options?: { afterId?: string; limit?: number }): ChannelBotV2[];
listVersions(botId: string, options?: { beforeRevision?: number; limit?: number }): BotConfigurationVersionMetadata[];
readVersion(botId: string, versionId: string): BotConfigurationVersion | undefined;
```

BotSnapshot 增加 bindings:GroupBindingV2[] 和 roles:RoleAssignment[]。read/readByApp 在一个 SQLite 读事务内返回完整配置集合、当前 SecretRef metadata 与确认；不能用既有 list 的 200/500 上限截断授权或恢复输入。管理列表按 Bot ID 升序分页，limit 默认 200、最大 500；调用者需要完整集合时读到空页。版本按组合 revision 降序分页，默认 50、最大 200；游标是最后一条 revision，不依赖时间戳。

BotConfigurationVersionMetadata 固定 versionId、botId、revision、changeSequence、changeKind、operationId、createdAt、snapshotDigest。BotConfigurationVersion 在此基础上包含该时刻的完整 BotSnapshot。版本记录不可改写，包含当时的凭据引用元数据和确认审计，不包含 secret 值。恢复先读取确切版本与当前集合，准备凭据后提交既有 PreparedBotRestore；不能凭客户端自报的历史 JSON 恢复。

V2 的这些配置读取在 legacy authority 下明确返回 CONFIGURATION_LEGACY_AUTHORITY；authority 本身可在两种状态读取。旧 Bot/Policy/Binding V1 读取在 V2 下返回 CONFIGURATION_READER_REQUIRED，列出改用 configuration 的入口；不能静默漏掉 V2 行或把状态降级。Role/SecretRef/远端事实仍使用其真实 V1 数据结构，可保留只读接口。最终切换前须逐一改完 API、CLI、群管理、预检与运行授权的 V1 调用者，这个明确错误只是中间版本保护，不是最终产品体验。

## 表和升级

通过已有唯一迁移外层事务重建 channel_bots、channel_bot_policies、group_bindings；保留 V1 行和全部自然键、索引、外键，CHECK 按 schema_version 分支允许合法 V1/V2。Bot 增 authorization_revision、connection_generation、platform_display_name；Policy 增 execution/presentation JSON；Binding 增 access_profile。V1 尚未转换时新列为空，不填入虚假的生效配置。旧 full_trust_confirmed 列只供 V1 兼容，V2 不从它授予确认。

另建 configuration_authority 单例、configuration_operations、configuration_versions、configuration_changes、full_trust_confirmations。配置权威使用独立表，不借 configs 的普通可写值作权限门。schema 升级只初始化 legacy marker；正式转换才改为 v2。corrupt/未知 marker 拒绝写入，不能回退 legacy。新增 migration 的版本号取实施时实际下一号，不与并行单元占用同号。

版本快照、变更 sequence、操作去重和确认同配置一起提交。配置 changeSequence 使用数据库自增序号；Bot 组合/授权/连接版本在每次累加前检查安全整数上界，溢出整笔回滚。高频远端事实观察不进入配置版本历史。

## 命令事务和管理范围

每个命令执行 BEGIN IMMEDIATE，再检查当前 authority、管理资格、operationId 的稳定载荷、实体与集合 CAS，计算并完整解析最终对象，写配置与历史。入口先做严格 JSON 编码校验，再做 Zod parse；不让 stringify 丢掉显式 undefined 或执行 getter。事务内不调用网络、文件或 Runtime。

安装者仅接受真实 principal_installation_owner。principal actor 的 channelBotId 必须与目标相同；Bot 级命令要求当前有效且没有 groupBindingId 的 admin 角色。mutateRelated 若含 Policy、新建 Binding 或 App 级 Role，同样要求 App admin；仅编辑既有 Binding 及其群内 Role 时，可以由对每个目标群均有效的 admin 执行。群 admin 不能创建 App 角色或把角色移出自己的群。所有目标与原 revision 先统一核对，不能先改角色再用自己刚写的权限授权余下操作。

同 operationId 重投仍检查当下的管理资格，再返回原操作结果；同 ID 异 action/actor/目标/稳定载荷为冲突。首次 expectedRevision 不进入稳定载荷。一个批次重复操作同一 Binding/Role ID 明确拒绝，避免批内顺序改变原 CAS 含义。未发生内容变化的新操作仍保存操作审计，但不增加配置版本或变更序号；重放不再次追加记录。

setEnabled/setReceiving 保存配置与接收意图，不能代替激活事实。listener 和执行接收仍须依照激活设计检查真实凭据、身份、配置与确认范围。停用/删除原子撤销授权及连接版本；停止实际运行在事务提交后进行。删除保留 tombstone 和凭据引用，旧操作不能通过 create 复活。

## 旧入口封口与准备边界

在 V2 下，foundation 的 Bot 与被引用 SecretRef 管理写、groupPolicy 的 Bot Policy/Binding/Role 写统一返回 CONFIGURATION_COMMAND_REQUIRED；旧 rollbackLast 返回 CONFIGURATION_RESTORE_PREPARATION_REQUIRED。检查放在实际 SQL 写前，并覆盖 callback 带出的方法。非 V2 时保持原行为。

V2 下 remoteChatFacts.create/update 的旧正向事实写一并拒绝，覆盖公开 repos、groupPolicy、remoteFacts 和 callback 带出的方法；旧 update 不能清 invalidatedAt、延长 expiresAt 或改变 membershipState 后复用原证明。正向刷新统一走服务持有 context 的 upsert。群改名收尾使用窄 updateDisplayName(context, id, expectedRevision, displayName)，只改名称、记录 revision/updatedAt，原有效期、成员状态、失效标记和凭据/身份版本全部保留；该方法不能使已失效事实重新有效。context 与 upsert 同样核对当前 Bot/授权/凭据和原事实版本。invalidate 保持保守撤销，但仍核对合法服务 context，不开放客户端事实写入。

通用 KV 的受保护范围按实际键枚举：lark.bots、lark.credentials、lark.live-owner. 前缀，以及新增迁移快照/来源映射的明确前缀。V2 下 set/compareAndSet/tx.config.set 均拒绝；迁移使用私有 SQL，不暴露 boolean bypass。运行中的 lark.run-context. 与工作项/自动化 KV 仍按各自执行契约写入，不能用整个 lark. 前缀封禁正常运行。

SecretRef 的 bind/rotate 必须使用真实 readback 的 PreparedCredentialRef。bind 不借已有 secretId 改它的 provider/key：revision>0 时元数据必须完全匹配，只有 rotateSharedSecret 可以更换共享行引用并检查全部引用 Bot；revision=0 才创建新行。恢复历史版本若需要改变共享 secret 的实际引用，仍走完整集合 rotate，不通过单 Bot restore 偷换。未引用 SecretRef 使用下列独立命令，不保留无身份的 V2 原写口。

当前 SecretRef 还被 schedule_definitions、schedule_generations、schedule_leases 引用。三表任一保有引用时，shared rotate 的当前管理资格要求安装者，包括缓存重放；现有 lease 无可核验的 Bot 管理域，不能从 leaseKey 推断委派权限。该检查与原 Bot 集合读取都在同一写事务内。ref.bots 仍只包含实际 channel_bots.credential_ref 集合，逐 Bot CAS、三个版本与历史沿用原规则，不伪造调度所属 Bot 的凭据绑定或修改调度历史。没有调度引用时保留既有 Bot 管理资格；旧 identity/chat 证明的保留引用不额外触发安装者要求。

未引用凭据的命令签名固定为 `createUnboundSecret(op:ManagementOperation, kind:SecretRefKind, prepared:PreparedCredentialRef):SecretRefMetadata`、`rotateUnboundSecret(op:ManagementOperation, prepared:PreparedCredentialRef):SecretRefMetadata`、`removeUnboundSecret(op:ManagementOperation, secretId:string, expectedRevision:number):SecretRefMetadata`。三者仅安装者可执行，因为未绑定凭据没有可委派的 App 管理范围。create 要求 expectedRevision=0；rotate/remove 要求正安全整数原 revision，首次执行在同一事务重查所有 Bot（含 tombstone）、身份/群事实及上述三类调度外键引用，已有引用即给领域冲突，包括同位置 no-op；不依赖 DELETE 的 SQLite 外键异常代替此检查。旧 generation 和仍保有 secret_ref 的 lease 不因历史或状态标签被忽略。rotate 保持 kind，create/rotate 的 configured 只来自真实回读准备；删除返回原元数据供服务按 fingerprint 处理文件，事务本身不删文件。操作去重、当前资格复核、异载荷冲突与版本溢出沿用配置命令；不增加虚假的 Bot 版本历史。

FullTrust 范围构建和 legacy 转换使用与公开预览相同的纯函数，最终 SQL 事务重读实际来源再调用，不能仅核对客户端提供的 targetDigest。纯转换器须位于 storage 可依赖的模块，不能让 storage 反向导入 server 的 config.ts；旧原始 KV 的摘要与历史快照仍覆盖完整原字节，已归一化的字段不能代替来源防并发校验。

当前 PreparedBotConversion 只保存目标 Bot/Policy/Binding/Role/确认，尚无把新 SecretRef 的回读元数据交给最终事务的字段。仓储单元同时补 `preparedCredential?:PreparedCredentialRef` 与 `executionEvidence:ExecutionScopeEvidence[]`：目标有 credentialRef 时必须有同 secretId 的准备证明；未配置凭据的 draft 可省略。一个 SecretRef 被多个目标引用时，所有准备证据必须相同，事务只创建、匹配或执行下述 legacy live 搬迁一次元数据；不能先经低层写口建立 SecretRef，再声称转换全有或全无。executionEvidence 用于对准备的历史 full-trust 范围重算；未产生确认时可为空，不能从 scope 中的自报 digest 反推已验证目录或 Agent 配置。这些字段属于私有目标摘要，不进入公开 preview。

commitLegacyConversion 的私有事务允许已有 `provider=live_lark_config` 的 SecretRef 保持 ID 搬到真实 provider/key：prepared.expectedRevision 匹配原行，原 id/revision/provider/key 和全部实际引用 Bot 集合由 source fence 覆盖，所有引用 Bot 必须在本次目标集合。SQL 重查完整集合后，将同一 prepared 引用写入原行，SecretRef revision 增一，失效旧身份/群事实，再写目标 Bot、历史和最终 marker；任一步失败全部回滚。无需搬迁的真实 provider 仍只匹配原元数据，正常 V2 bind 仍无覆盖权。共享行的每个目标使用完全相同的准备证据；准备后新增共享引用或同 ID 元数据改变均冲突，同作业重投只读回原提交。此操作是一次全量 legacy 转换的内部步骤，不能先通过旧低层 writer 或 V2 rotate 修改来源。

全局 authority 切换必须覆盖完整原生 Bot 集合：App 集合取完整 legacy collection、源映射和全部 channel_bots 自然键的并集；nativeConfigurationDigest 包含这些 Bot 的全部 Policy/Binding/Role/SecretRef、集合成员与 tombstone。最终事务拒绝任何未纳入目标的 V1 Bot/Policy/Binding，准备期间新增无 KV/映射的 App 同样使 fence 变化。无 legacy 映射的原生草稿保持原 ID 转成 staged/paused 的 V2 对象；没有 Policy 时生成严格的禁用入口/工具、无新增执行授权的缺配置 Policy，使对象可管理且不能启动。非法或冲突对象给明确诊断并阻止整份切换，不过滤掉旧行。高频事实仍只摘要转换真正消费的证明。

legacy 原始读取也必须无写入。当前 readLarkConfigs 会在读取时 CAS 迁移风险字段或 fallback 凭据，不能直接用于准备前后 source fence。抽取可复用的纯归一化/转换函数时保留正常旧字段规则，严格返回无效记录、重复 App 和同 App 对象冲突；不得像兼容 reader 那样静默过滤后把剩余数组算成“完整迁移”。正常 legacy reader 的兼容行为留到配置服务切换时统一替换，转换器不借用 @dutydeck/config：该包目前依赖 Runtime，storage 依赖它会形成循环。

真实文件/目录准备在事务外，提交核对固定引用、实际 Agent 配置内容、关联行和原集合摘要。远端事实刷新按 V2 设计使用服务持有的上下文及版本核验；配置命令不能通过写一条“预检成功”事实绕过平台验证。

## 单元验收

真实非空 V1 表升级后，原行/索引/外键保持，marker 仍 legacy；故障注入回滚所有表和 marker。V2 命令覆盖同操作重开、异载荷冲突、跨 App/跨群管理拒绝、批内重复 ID、集合成员并发变化、共享凭据全引用 CAS、tombstone 与历史恢复。事务带出方法和通用 KV 写均须有实际反例；保留旧事实复活反例，验证窄名称编辑不恢复有效性。空 legacy 加原生草稿、缺 Policy、准备后新增原生 App、live SecretRef 同 ID 搬迁及共享引用变化都必须通过成功/冲突/回滚/同作业重投测试。list/read/history 使用超过旧 500 项上限的集合验证完整性，V1 getter 在切换后不能伪装或漏读。

这一单元完成后仍需配置服务、旧入口、真实凭据与身份、listener、Runtime 授权接线的联合门禁，才可执行正式 authority 切换。
