# Dockmux 1.0 包边界审计

> 审计日期：2026-08-30。本文记录静态生产依赖证据与 1.0 收口结果。

## 结论

| 包 | 生产状态 | 依赖证据 | 1.0 处置 |
|---|---|---|---|
| `@dockmux/terminal-renderer` | 已接入 | `@dockmux/pty-driver` 在 manifest 中声明依赖，`driver.ts` 直接导入 `TerminalSnapshot`。server 依赖 PTY driver。 | 保留；属于 PTY 运行与 Web 终端链路。 |
| `@dockmux/workflow` | 未接入发布运行时 | 没有任何应用或其他生产包在 manifest 中依赖它，也没有包外生产源码导入它。 | 已从 1.0 工作区移除；未来以真实用户路径重新设计，不保留孤立子集。 |
| `@dockmux/skills` | 未接入发布运行时 | 没有应用或生产包 manifest 依赖；包外只存在测试 alias 和注释引用。 | 已从 1.0 工作区移除；不会写入用户全局 skill 目录。 |
| `@dockmux/renderer` | 未接入发布运行时 | 没有应用或生产包 manifest 依赖；Web 生产源码未导入它。 | 已移除冗余包边界；Web 直接维护当前任务视图。 |

## 判断方法

本次同时检查了：

1. 根目录与所有 workspace `package.json` 的依赖声明；
2. 包外对 `@dockmux/workflow`、`@dockmux/skills`、`@dockmux/renderer`、`@dockmux/terminal-renderer` 的源码导入；
3. server 发布包的直接依赖；
4. Vitest alias 与文档/注释引用，避免把测试解析配置误判为生产接入。

根脚本 `build:packages` 会编译所有 `packages/**`，因此“全仓 build 通过”只能证明这些包能编译，不能证明它们位于用户路径。唯一发布包 `dockmux` 的 server manifest 直接依赖 `cli-adapters`、`pty-driver` 和 `relay`；`terminal-renderer` 再由 `pty-driver` 间接进入运行链路。其余三个候选包没有这条依赖链。

## 收口依据

三个被移除的包均为 `private` workspace，包外没有 manifest 依赖或生产源码导入；删除同时移除了 Vitest 的无效 alias。`terminal-renderer` 保持原状，并继续由 `pty-driver` 的真实生产链路覆盖。最终独立评审与全仓构建会验证没有牺牲现有用户路径。
