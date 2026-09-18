# 历史数据只读迁移 CLI（legacy-import-cli）

Dutydeck 提供只读迁移导入 CLI，用于发现、评估及归档历史运行数据。

当前迁移工具仅支持 Botmux 历史数据格式的解析、脱敏评估与加密归档。该工具以安全受限模式运行（`allowed_mode: read_only_plan / private_archive_only`，`production_cutover: NO_GO`），不会自动接管外部正在运行的源进程，也不会直接向 Dutydeck 生产数据库写入数据。

---

## 1. 命令概览

推荐使用 `dutydeck migrate` 子命令；历史命令 `dutydeck botmux` 保持兼容别名支持。

| 命令 | 行为说明 |
|---|---|
| `dutydeck migrate discover` | 发现并分类源工件（Bot 登记、凭据元数据、会话记录等），输出阻断项与脱敏分析，不修改源数据和目标数据库，可按需写出脱敏报告 |
| `dutydeck migrate plan` | 生成脱敏的迁移计划清单（包含 blockers、forbidden_capabilities 与 eligibility），不向 Dutydeck 数据库写入数据 |
| `dutydeck migrate archive` | 将符合条件的工件复制并加密保存到全新的私有归档目录中（基于 scrypt 派生密钥与 AES-256-GCM 加密） |

兼容别名：
```bash
# 以下两组命令行为完全一致：
dutydeck migrate discover --source-home /path/to/source
dutydeck botmux discover --source-home /path/to/source
```

---

## 2. 通用源数据选项

以下选项适用于 `discover`、`plan` 和 `archive` 子命令：

| 选项 | 说明 |
|---|---|
| `--source-home <directory>` | 历史来源根目录（默认按来源约定探测 `~/.botmux`） |
| `--bots-config <file>` | 明确指定的机器人配置文件绝对/相对路径 |
| `--data-dir <directory>` | 明确指定的历史数据目录路径 |
| `--json` | 输出紧凑机器可读 JSON（敏感机密保持脱敏） |

---

## 3. 子命令详解

### 3.1 discover（只读探测）

发现指定来源目录下的 Bot 注册表、会话与运行时数据，输出只读发现报告及资格评估。

```bash
dutydeck migrate discover [options]
```

- `--output <file>`: 将脱敏后的报告写入一个全新的私有文件（权限为 `0600`）。若文件已存在则报错退出，避免覆盖。

示例：
```bash
dutydeck migrate discover --source-home ~/.botmux --json
dutydeck migrate discover --source-home ~/.botmux --output /tmp/discovery-report.json
```

### 3.2 plan（生成脱敏计划）

在不修改源数据和目标数据库的前提下，生成脱敏的迁移计划 manifest。

```bash
dutydeck migrate plan [options]
```

- `--output <file>`: 将脱敏 manifest 写入指定的全新私有文件。

示例：
```bash
dutydeck migrate plan --source-home ~/.botmux --output /tmp/redacted-plan.json
```

### 3.3 archive（创建私有加密归档）

将符合条件的来源工件打包并使用高强度对称密钥加密保存到独立的私有归档目录。

```bash
dutydeck migrate archive --output <directory> [options]
```

- `--output <directory>`: **（必填）** 全新的私有归档目录路径。目录必须尚不存在。
- `--passphrase-fd <fd>`: 从指定的文件描述符读取加密口令（0 或大于 2 的整数）。**口令绝不接受通过命令行参数或环境变量直接传递**。
  - 在交互式终端（TTY）中，若未指定 `--passphrase-fd`，CLI 会通过隐藏回显提示输入并确认口令（需满足 16-1024 字节 UTF-8 限制）。
  - 在非交互式脚本或 CI 中，必须显式传入 `--passphrase-fd`。

示例：
```bash
# 交互式归档（终端提示输入口令）
dutydeck migrate archive --source-home ~/.botmux --output /tmp/private-archive

# 通过文件描述符传递口令
dutydeck migrate archive --source-home ~/.botmux --output /tmp/private-archive --passphrase-fd 3 3< /path/to/passphrase
```

---

## 4. 安全约束与范围说明

1. **只读保护与源隔离**：迁移工具对来源数据只读，不修改源文件。
2. **格式支持范围**：当前仅适配 Botmux 历史数据格式。如检测到不支持的结构或无法识别的配置项，会在 plan 中标记为 blockers 或 forbidden_capabilities。
3. **无生产写入（NO_GO）**：当前计划与归档流程不执行向 Dutydeck 真实生产库的写入或自动切换。真实切流与激活需由后续经过显式授权的生产流程接管。
