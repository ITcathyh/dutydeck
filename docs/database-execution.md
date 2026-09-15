# 离线执行账本命令

本文档说明 Dutydeck 离线执行账本状态查询与升级 CLI 命令。

## 命令总览

| 命令 | 模式 | 说明 |
| --- | --- | --- |
| `dutydeck database execution-status --database <path>` | 同步只读 | 查询数据库的执行 schema 与权威状态，无副作用 |
| `dutydeck database upgrade-execution --database <path>` | 排他维护 | 将历史 legacy 数据库离线升级为 `ledger_v1` 执行账本 |

两项命令均要求显式指定 `--database <path>`，不默认选取运行中或历史守护进程数据库。输出格式均为单行结构化 JSON，错误以非零退出码退出并在 stderr 输出结构化错误信息。

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

## 退出码与错误契约

- `0`：命令成功执行，结果打印在 stdout（单行合法 JSON）。
- `1`：参数缺失（未传 `--database` 输出 `DATABASE_OPTION_REQUIRED` 单行 JSON）、文件不存在（`DATABASE_NOT_FOUND`）、非法文件（`DATABASE_UNSAFE_FILE`）、schema 不支持（`DATABASE_UNSUPPORTED`）或存在活跃 Runtime 阻塞（`DATABASE_RUNTIME_STILL_ATTACHED` / `DATABASE_UPGRADE_BUSY`），错误信息均统一以单行结构化 JSON 打印在 stderr，不打印多行帮助或堆栈。
