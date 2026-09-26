# 用量计价与自动任务次数上限

用量页显示的是**已知费用**，不是账单总额。Agent 上报的美元成本优先使用；没有成本、只有 token 时，仅在费率完整的情况下估算。未知型号、缺缓存写入单价记为 `unpriced`，没有用量的 PTY 等记为 `unavailable`。两类均保留次数，不能视为免费；上报的真实零费用仍算已计价。

计价覆盖率 = 有完整费用的记录数 / 总记录数，不是美元或 token 的覆盖比例。没有记录时显示暂无记录；旧服务未返回新字段时显示未知。月度美元上限继续按已结算的已知费用拒绝新根任务，不打断在途任务，也不预留其未来费用。

## 费率配置

`DUTYDECK_USAGE_PRICING_JSON` 可覆盖费率表，金额单位为美元 / 百万 token。例如下面**仅为配置示例，不是实际采购报价**：

```json
{
  "version": "internal-contract-example-v1",
  "default": {
    "inputPerMTok": 1,
    "cachedInputPerMTok": 0.1,
    "cacheWritePerMTok": 1.25,
    "outputPerMTok": 2
  },
  "models": [
    {
      "match": "example-model",
      "inputPerMTok": 2,
      "cachedInputPerMTok": 0.2,
      "cacheWritePerMTok": 2.5,
      "outputPerMTok": 4
    }
  ]
}
```

四种 token 分开计价；输入 token 沿用适配器的非缓存输入口径。旧三费率配置仍可加载，但一旦记录含正数缓存写入 token 而对应费率缺失，整条记录的费用记为未知，不报零或不完整总价。

内置费率保留原有 2025 年末 OpenAI 公开价记录，版本为 `openai-public-2025-end-v1`，没有核对当前采购账单。按完整型号或 `型号-后缀` 的最长匹配项选择；内置表不对未知型号套用默认价。自定义表里的 `default` 是管理员明确提供的兜底估计，记录来源为 `custom_default`。

每条记录保存实际 provider（读数未提供证据时为 `unknown`）、model 及其来源、费率来源、匹配项和带表内容 hash 的版本。Agent 名称不能证明实际 provider。可在某个自定义费率项加 `provider` 约束，仅在读数明确报告同一服务商时匹配；未约束的自定义 default 可跨服务商兜底，仍只代表估计。模型优先使用读数，其次使用任务冻结配置，再退回会话/Agent 配置。

迁移 29 保留已上报账单；旧估价中含缓存写入的记录改为费用未知，保留 token，标记 `legacy_cache_write_rate_unknown`，因此历史已知费用可能减少。其他旧估价保留原值，来源标记 `legacy_unknown`，不补造旧 provider、费率版本或账单证据。

## 自动任务每月次数上限

默认**未启用**。未启用时，未知费用仍没有次数兜底，Web 明确显示覆盖缺口。配置项为 `DUTYDECK_USAGE_BACKGROUND_LIMITS_JSON`：

```json
{"defaultMonthlyTasks":1000,"bots":{"cli_example":200,"cli_paused":0}}
```

- `defaultMonthlyTasks`：每个机器人默认的月度自动根任务准入次数；不填表示没有默认上限。
- `bots`：按机器人 appId 覆盖默认值；`0` 表示拒绝新的自动根任务。
- 启用后覆盖后台判定、回复、记忆，以及主动介入和定时根任务。实际费用事前未知，所以所有这些任务都计次，不只针对事后已经 `unpriced` 的记录。
- 显式人发起的任务、Web 任务和已接纳根任务的子步骤维持原行为。该上限不能约束一个根任务内部的调用次数、持续时长、token 或费用。
- 按服务时区的自然月计数，与现有美元月度上限一致。计数存储在 SQLite，重启不清零；同一任务的重复准入、重放和跨月重放不重复扣次。
- 在准入时原子占一次名额；若后续准备失败或取消，名额也保留。这样重复重试不会重新扣次，也不会因并发超额放行。配置关闭期间不计次，重新开启不会抹去同月此前已计次数。
- `automaticRefusal(appId)` 仅供昂贵上下文检索前只读检查；实际 Runtime `admitTask` 仍原子检查并认领，避免并发绕过。

Web 展示当前默认值、单机器人上限和已准入次数；配置通过服务部署环境管理，旧的美元上限接口和配置保持兼容。本改动未修改任何线上配置，未启用新的线上限额，也未验证真实账单下降。
