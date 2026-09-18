# 通用协作扩展与回放基础 (Collaboration Extensions & Evaluation)

本文档说明通用协作体系中的两个核心模块：`CollaborationExtensions` 与 `CollaborationEvaluation`。模块只提供通用通道扩展与离线回放评测能力，不绑定任何具体的业务产品或报警适配器。

---

## 1. 架构定位与设计原则

1. **Programmatic 注册**：所有 Source、Query、Action 均由系统可信启动代码（如服务启动时的 `configure` 回调）静态注册，不提供暴露给终端 HTTP 用户的动态注册接口。重复注册同名 ID 会直接抛出异常（防覆盖与配置漂移）。
2. **严格授权边界**：每个操作在进入业务逻辑前均必须通过 `authorize(scope, actorId, action)` 校验；Action 采用“入口首次授权 → 意图落库 → 发送前再次授权 → 执行”的多阶段授权机制，防止提权与并发越权。
3. **Fail-Closed 与未知状态恢复**：外部动作执行若因网络断开、超时或未决响应失败，一律标为 `unknown` 状态，严禁盲目自动重试。只能通过注册的 `reconcile` 幂等查询外部收据进行 CAS 状态校准；缺失 handler 时安全保持 `unknown`。
4. **历史快照回放无污染**：`CollaborationEvaluation` 仅使用决策时持久化落库的 `decision.inputSnapshot`（直接快照），禁止调用实时接口拉取当前数据“假装”历史完整；全流程纯只读，绝不触发外部调用或群发送。

---

## 2. 通用扩展 (CollaborationExtensions)

### 2.1 构造函数

```typescript
export interface CollaborationExtensionsOptions {
  repository: CollaborationRepository;
  authorize: (
    scope: CollaborationScope,
    actorId: string,
    action: 'event' | 'query' | 'action'
  ) => Promise<boolean>;
  now?: () => Date;
  onObservation?: (snapshot: CollaborationSnapshot) => void | Promise<void>;
}

const extensions = new CollaborationExtensions({
  repository,
  authorize: async (scope, actorId, action) => {
    // 权限校验：event / query / action
    return true;
  },
  onObservation: async (snapshot) => {
    // 材料更新通知，由主控决策是否调度模型，扩展内部绝不执行模型
  }
});
```

### 2.2 外部来源事件摄入 (Source / Ingest)

通过 `registerSource` 注册外部输入适配器，通过 `ingest` 接收事件。

```typescript
extensions.registerSource('mock-webhook', {
  verify: async ({ body, headers }) => {
    // 校验签名并提取可信作用域和操作人身份
    if (headers['x-signature'] !== 'secret') return undefined;
    return {
      scope: { appId: 'cli_test', chatId: 'oc_chat_1' },
      actorId: 'user_trusted_1'
    };
  },
  parse: (body: any) => ({
    eventId: body.event_id,
    occurredAt: body.timestamp,
    senderKind: 'human', // human | bot | system
    text: body.message,
    refs: body.links ?? []
  })
});

// 接收外部请求
const result = await extensions.ingest('mock-webhook', requestBody, headers);
// result: { observation, created, changed, contextRevision }
```

- **安全约束**：请求体中携带的任何 scope / actorId 会被丢弃，强制使用 `verify` 提取的可信身份。
- **幂等去重**：以 `(scope, source, eventId)` 为联合键，相同事件重复进入不推进 contextRevision。
- **来源标记**：所有摄入材料的 `origin` 强制落库为 `external`。

### 2.3 只读查询扩展 (Query)

注册群外部只读数据源，供决策或上下文检索使用。

```typescript
extensions.registerQuery('doc-search', {
  parse: (input: any) => ({ query: String(input.query) }),
  query: async (input, { scope, actorId }) => {
    return {
      evidence: [
        {
          id: 'ev_1',
          scope, // 必须与调用群一致
          text: `Document hit for ${input.query}`,
          occurredAt: new Date().toISOString()
        }
      ],
      missing: []
    };
  }
});

const data = await extensions.query('doc-search', scope, actorId, { query: 'release' });
```

- **越群防护 (Cross-Scope Defense)**：返回的每条 `evidence` 的 `scope` 必须严格等于入参 `scope`，出现越群数据直接抛错拒绝。
- **有界防护**：严格校验 `id` (<=128)、`text` (<=16000)、时间合法性与最大返回数量 (<=100)。

### 2.4 外部动作执行与核对 (Action / Execute / Reconcile)

```typescript
extensions.registerAction('document-publish', {
  parse: (input: any) => ({ docId: String(input.docId) }),
  execute: async (input, { scope, actorId, actionId }) => {
    // 外部调用
    return { receipt: `publish_ack_${actionId}` };
  },
  reconcile: async ({ scope, actorId, action }) => {
    // 查询外部实际完成状态，返回 succeeded / failed / unknown
    const externalStatus = await checkExternalPublishStatus(action.id);
    return { status: 'succeeded', receipt: externalStatus.receipt };
  }
});

// 执行动作
const action = await extensions.execute(
  'document-publish',
  scope,
  actorId,
  actionId,
  { docId: 'doc_123' }
);
```

#### 状态机与未知结果处理流程：
1. **入口首次授权**：未授权直接 403，不留存任何意图记录。
2. **意图落库**：调用 `repository.beginAction(kind='extension:' + id)`。
   - 相同 actionId 且参数一致，返回已有状态；参数不同则抛出 `409 Conflict`。
   - 若已有状态为 `succeeded`，直接返回包含回执的动作记录。
   - 若已有状态为 `sending` 或 `unknown`，**绝不重复执行**，自动触发 `reconcile` 核对。
   - 若已有状态为 `failed` 或 `suppressed`，不隐式新执行。
3. **发送前再次授权**：进入 `sending` 前再次调用 `authorize`。若撤权则抛出 `403`，阻止外部调用。
4. **状态跃迁为 `sending` 并调用外部接口**。
5. **异常转入 `unknown`**：外部抛错时将落库状态置为 `unknown`，绝不静默判定成功。
6. **显式 Reconcile**：通过注册的 `reconcile` 钩子核验状态，通过 CAS 更新最终结果；missing handler 保留 `unknown`。

---

## 3. 决策回放评测 (CollaborationEvaluation)

`CollaborationEvaluation` 用于离线或准实时针对群内过去的自动化决策执行回放重评，用于策略迭代与安全评估。

```typescript
const evaluation = new CollaborationEvaluation({
  repository,
  evaluate: async (snapshot, policyVersion) => {
    // 仅基于快照中的历史数据判定决策
    return {
      action: 'reply',
      reason: 'User explicitly requested document collaboration',
      evidenceIds: ['obs_1']
    };
  }
});

const result = await evaluation.replay(scope, {
  decisionIds: ['dec_1', 'dec_2'],
  policyVersion: 'v2'
});
```

### 3.1 评测结果语义定义 (`passed` / `failed` / `missing`)

回放返回结构为 `{ results: [...], passed, failed, missing }`，三者语义严格隔离：

| 判定状态 | 语义与触发条件 | evaluate 是否调用 | 通过率统计说明 |
| :--- | :--- | :---: | :--- |
| **`missing`** | **历史材料不足**。<br>1. 原 decision 记录不存在于当前 scope<br>2. 快照缺失 settings 或 observations 基础字段<br>3. bootstrap 含有未决缺失材料（`bootstrap.missing` 非空）<br>4. 快照中任一 observation 自身含有 missing（历史材料被阶段性截断）<br>5. 原 decision 的 evidenceIds 引用的历史材料已不存在或残缺 | **否** | **不计入通过率分母**。<br>单列统计，严禁将缺材料样本判定为 passed 或计为模型策略错误。 |
| **`failed`** | **策略结果不符 / 越权违规**。<br>1. 快照顶层或任一嵌套实体（settings / bootstrap / observation / followup / mandate）跨 scope 越权（不调用 evaluate）<br>2. 完整材料下，模型动作不符预期（`actual !== expected`）<br>3. 完整材料下，模型输出非 `silent` 动作却没有任何证据支撑（无证据）<br>4. 完整材料下，模型引用了快照中不存在的 observation ID（幻觉证据）<br>5. 模型返回了非法动作、非法字段或抛出异常 | 跨 scope 时**否**；<br>策略错误时**是** | **计入通过率分母**，作为失败样本。 |
| **`passed`** | **策略完全符合且证据充分**。<br>1. 历史材料完整且无越权数据<br>2. 模型输出格式与字段完全合法<br>3. 动作与预期完全一致（支持人工反馈 `expectedAction` 优先覆盖）<br>4. 所引用的证据全部真实存在于快照中且完整无 missing | **是** | **计入通过率分子与分母**。 |

### 3.2 评测防作弊与安全原则
1. **仅依赖保存的快照**：只读取 `decision.inputSnapshot`，禁止调用 `repository.snapshot(scope)` 获取实时数据。
2. **嵌套范围防护 (Scope Defense)**：不仅校验顶层 scope，递归校验 settings、bootstrap、observations、followups、mandates 全部嵌套实体的 scope，跨群立即判 `failed`。
3. **人工纠正优先**：如果存在针对该 decision 的 feedback 且指定了 `expectedAction`，以最新的人工纠正为判定基准；否则以原决策的 `action` 为基准。
4. **纯只读绝不执行动作**：评测全过程不访问任何发送通道或 Action 执行器，历史决策记录与反馈数据保持不可变。

---

## 4. 常见错误代码对照

| 错误码 | HTTP Status | 场景 |
| :--- | :--- | :--- |
| `COLLABORATION_FORBIDDEN` | 403 | 来源签名验证失败、未授权的操作人或被撤销权限 |
| `COLLABORATION_SOURCE_NOT_FOUND` | 404 | 尝试摄入未注册的 sourceId |
| `COLLABORATION_QUERY_NOT_FOUND` | 404 | 查询未注册的 queryId |
| `COLLABORATION_ACTION_HANDLER_NOT_FOUND` | 404 | 执行未注册的 actionId |
| `COLLABORATION_NOT_FOUND` | 404 | 目标 Action 或 Decision 不存在 |
| `COLLABORATION_REVISION_CONFLICT` | 409 | CAS 版本冲突 |
| `COLLABORATION_ACTION_CONFLICT` | 409 | 相同 actionId 存在不同 payload / 参数冲突 |
| `CROSS_SCOPE_EVIDENCE` | 400 | Query 插件返回了跨群的数据 |
| `COLLABORATION_INVALID_INPUT` | 400 | 输入校验不通过（如非法的 senderKind） |
| `ACTION_EXECUTION_UNKNOWN` | 500 | 外部调用异常，动作已标记为 unknown |
