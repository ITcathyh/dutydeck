# 离线执行账本命令

本文档说明 Dutydeck 离线执行账本状态查询与升级 CLI 命令。

## 命令总览

| 命令 | 模式 | 说明 |
| --- | --- | --- |
| `dutydeck database execution-status --database <path>` | 同步只读 | 查询数据库的执行 schema 与权威状态，无副作用 |
| `dutydeck database upgrade-execution --database <path>` | 排他维护 | 将历史 legacy 数据库离线升级为 `ledger_v1` 执行账本 |
| `dutydeck database retire-legacy --database <path> ...` | 排他维护 | 精确核验旧执行资源后，将对应旧会话归档为只读历史 |

三项命令均要求显式指定 `--database <path>`，不默认选取运行中或历史守护进程数据库。输出格式均为单行结构化 JSON，错误以非零退出码退出并在 stderr 输出结构化错误信息。

---

## 1. 状态查询：`execution-status`

### 用法

```bash
dutydeck database execution-status --database <path>
```

### 行为特性

- **同步只读**：以只读模式（`readonly + fileMustExist`）打开数据库，不加 `immutable`，保证能读取到未 checkpoint 的最新 WAL 提交记录。
- **无副作用**：同一只读快照内完成检查，不建库、不建目录、不执行迁移、不注册写入 access。
- **并发安全**：在有活跃 Runtime 运行期间仍可正常执行查询，无需关闭 Runtime。
- **状态区分**：
  - `missing`：目标文件在文件系统中不存在。
  - `uninitialized`：数据库存在但无任何业务用户 schema（仅含保留对象或控制表）。
  - `legacy`：包含历史 Dutydeck 业务表或早期迁移版本，尚未升级为执行账本。
  - `ledger_v1`：包含最小受支持的核心执行账本表结构与关键列（非全库健康检查），且权威标记为 `ledger_v1`。
  - `unsupported`：未知或不兼容的数据库结构（如版本过高或无关表）。
- **错误严格抛出**：不可读文件、非 SQLite 文件或损坏的 authority 记录直接报错，不伪装为 `missing`。

### 输出示例

```json
{
  "ok": true,
  "database": "/path/to/dutydeck.db",
  "status": "legacy",
  "authority": "legacy",
  "schemaVersion": 18,
  "counts": {
    "tasks": 12,
    "attempts": 0,
    "resources": 0,
    "registeredAccess": 0
  }
}
```

---

## 2. 离线升级：`upgrade-execution`

### 用法

```bash
dutydeck database upgrade-execution --database <path>
```

### 行为特性

- **排他隔离**：获取独占维护门禁，若数据库当前存在活跃 Runtime 或其他访问登记，升级命令立即拒绝退出，且绝不主动杀停 Runtime。
- **原子快照**：`before`、`after` 及 `blockers` 均在同一次排他维护事务内读取，完全隔离外部并发写入；连接关闭后不再重新查询。
- **Before 定义**：`before` 明确定义为 schema 准备完成（如基础迁移就绪）后、执行权威账本转换之前的数据库事实快照；`registeredAccess` 反映维护门禁内的真实登记数（含本次维护连接）。
- **路径校验**：目标路径必须真实存在且为普通文件，若路径不存在则明确拒绝，防止意外建立空库。
- **复用权威算法**：直接调用仓储内建的 `execution.upgradeLegacy()`，不使用裸 SQL 改动 authority 或迁移数据。
- **队列与数据保真**：保留既有任务排队次序，将旧执行历史和外部资源标记为受控 `unknown` 状态。
- **幂等可重跑**：对已升级为 `ledger_v1` 的数据库再次执行保持幂等成功。
- **旧会话摘要分栏**：`legacy.unresolvedSessions` 不包含已受控退休的 Session；`legacy.retiredSessions` 单列已退休数，`legacy.evidenceIncomplete` 仍保留原 legacy `unknown` 资源证据不完整的总数。
- **连接安全释放**：成功与失败路径均关闭本次仓储；事务完成后释放维护门禁。

### 输出示例

```json
{
  "ok": true,
  "database": "/path/to/dutydeck.db",
  "authority": "ledger_v1",
  "before": {
    "status": "legacy",
    "authority": "legacy",
    "counts": {
      "tasks": 12,
      "attempts": 0,
      "resources": 0,
      "registeredAccess": 1
    }
  },
  "after": {
    "status": "ledger_v1",
    "authority": "ledger_v1",
    "counts": {
      "tasks": 12,
      "attempts": 8,
      "resources": 2,
      "registeredAccess": 1
    }
  },
  "blockers": []
}
```

---

## 3. 核验并归档旧会话：`retire-legacy`

先停止旧服务、排除全部旧 writer 并备份数据库，再执行 `upgrade-execution`，最后提供旧部署的明确本机范围运行本命令：

```bash
dutydeck database retire-legacy \
  --database <path> \
  --hostname <旧服务所在主机名> \
  --uid <旧服务用户UID> \
  --tmux-socket <旧服务使用的精确tmux socket> \
  --acpx-directory <迁移后保存旧acpx记录的目录>
```

`--hostname` 和 `--uid` 必填，并且必须与当前维护进程一致。PTY 会话还要求 `--tmux-socket`；ACP 会话要求 `--acpx-directory`。路径不会从默认环境或个人目录猜测。该命令不停止 daemon，也不扫描或批量清理名称相似的 tmux 会话。

PTY 核验先用确定性 Session 名做精确 `has-session`，再读取稳定 tmux Session ID 和 `@dutydeck_owner_id`。只有 owner 精确等于 `dutydeck:<session-id>` 才会停止该目标；命令会记录 pane 及子进程的内核身份，等待它们退出，再确认目标消失。权限、连接、socket、owner 或进程身份无法确认时，该 Session 保持 blocked，其他 Session 继续核验。

ACP 核验只定位 `<acpx-directory>/sessions/<session-id>.json`，读取固定元数据字段并校验 schema、record id、旧 cwd 和记录 PID。`closed`、last-exit 字段或 Task 终态都不作为退出证明；记录 PID 仍存活、缺失或元数据损坏时保持 blocked，命令不会向裸 PID 发信号。

数据库写入发生在短事务中，并再次核对 Session/run、全量旧执行摘要、Session 非执行中、全部 Task/Attempt 终态和维护门禁。成功后仅把旧 Session 设为 `stopped`、保留已有 `archivedAt`（未归档则写入核验时间）并追加说明：历史 Task、Attempt、事件、输出、workspace、原生上下文文件及 legacy `unknown` 资源事实都保留。相同回执重放不会重复更新。Web 继续显示旧结果；飞书同话题的下一条任务会创建新 Session，并明确提示原上下文未自动恢复。

命令输出逐 Session 的 `retired`、`replayed` 或 `blocked` 状态及汇总。未核实条目不会阻断其他已核实条目的退休。

## 退出码与错误契约

- `0`：命令成功执行，结果打印在 stdout（单行合法 JSON）。
- `1`：参数缺失（未传 `--database` 输出 `DATABASE_OPTION_REQUIRED` 单行 JSON）、文件不存在（`DATABASE_NOT_FOUND`）、非法文件（`DATABASE_UNSAFE_FILE`）、schema 不支持（`DATABASE_UNSUPPORTED`）或存在活跃 Runtime 阻塞（`DATABASE_RUNTIME_STILL_ATTACHED` / `DATABASE_UPGRADE_BUSY`），错误信息均统一以单行结构化 JSON 打印在 stderr，不打印多行帮助或堆栈。
