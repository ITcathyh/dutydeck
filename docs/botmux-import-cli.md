# Botmux 只读迁移 CLI

当前 CLI 只提供 `dockmux botmux discover`、`dockmux botmux plan` 和 `dockmux botmux archive`。它们不会连接或写入 Dockmux 数据库，不会修改 Botmux 源，不会启动 listener/Schedule，也不会把 legacy session/workflow 恢复为运行态。

所有成功报告都保持 `production_cutover=NO_GO`、`eligibility.activation_ready=false`，并列出当前 blocker。默认输出是缩进 JSON；`--json` 只改为紧凑 JSON，不增加字段，也不会输出原始路径、App/Chat/用户身份或 secret。

## 合成数据用法

以下路径仅为合成示例：

```bash
dockmux botmux discover \
  --source-home ./synthetic-botmux \
  --data-dir ./synthetic-botmux/data

dockmux botmux plan \
  --source-home ./synthetic-botmux \
  --data-dir ./synthetic-botmux/data \
  --output ./redacted-plan.json
```

`--bots-config` 可指定精确 registry 文件。若省略显式 source 参数，Importer 沿用既有只读 source resolution；输出中只保留每次调用生成的 opaque refs。当前 CLI 不持久化 fingerprint key，因此不同调用的 opaque refs 不应被当作长期 ID；同一次 plan/archive 内的引用和 fingerprint 是一致的。

`discover --output` 和 `plan --output` 只创建新文件，权限为 `0600`。已有文件或软链目标会被拒绝，CLI 不覆盖它们。命令行回执只报告 `output_written=true`，不会回显输出路径。

## 私密 archive

交互式终端会隐式询问并确认口令：

```bash
dockmux botmux archive \
  --source-home ./synthetic-botmux \
  --data-dir ./synthetic-botmux/data \
  --output ./synthetic-private-archive
```

非 TTY 环境必须显式提供文件描述符。下面的口令只存在于 shell 变量和管道中，不进入 Dockmux argv、日志或环境变量：

```bash
read -r -s archive_passphrase
printf '%s\n' "$archive_passphrase" | dockmux botmux archive \
  --source-home ./synthetic-botmux \
  --data-dir ./synthetic-botmux/data \
  --output ./synthetic-private-archive \
  --passphrase-fd 0
unset archive_passphrase
```

非 TTY 未显式指定 `--passphrase-fd` 时命令硬失败。CLI 不接受 argv 口令选项，也不读取口令环境变量。口令要求 16–1024 UTF-8 bytes，通过带随机 salt 的 scrypt 派生 32-byte key；salt 和参数写入 archive manifest，口令和 key 不落盘。

Archive 目标必须是尚不存在的新目录。目录权限为 `0700`，其中所有文件为 `0600`。候选历史内容使用 AES-256-GCM 加密；registry secret、runtime credential、socket/lock/PID 等禁止项不会进入 archive。`archive-manifest.json` 和 `migration-plan.json` 只包含脱敏元数据，archive 也不会解除 Hammer、enabled Schedule、active topic 或未知配置 blocker。

当前没有 archive 解密/恢复命令。请妥善保管口令；在独立评审批准接管前，archive 仅用于私密保存和审计。

## 退出与故障安全

Importer 错误写入 stderr，格式为脱敏的 `{ok:false,error:{code,message}}`，退出码非零。路径不可读、source 软链、权限过宽、读取过程中变化、未知配置/资产、输出目标已存在或 archive 口令输入不安全时都不会降级为可接管状态。
