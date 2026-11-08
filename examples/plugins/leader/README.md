# leader-guide 示例插件

一份通用的「Leader 指引」，配合机器人的 Leader 模式使用。Leader 每次运行（拆解任务、代判 Worker 的提问和工具授权、验收）都会按它办事：开工先看什么、哪些事 Leader 自己定、哪些事上报给发起人、验收问哪几件事、上报怎么写。

它只是一个技能，不带命令、Hook 或 provider，安装不需要信任确认。

## 里面有什么

| 文件 | 作用 |
|---|---|
| `skills/leader/SKILL.md` | 指引正文：开工、什么你定什么上报、判断原则、验收、上报格式 |
| `references/decide-or-escalate.md` | 「你定 / 上报」的详细清单和授权怎么认；清单 `skillResources` 声明，每次 Leader 运行都会原文带上 |
| `references/acceptance.md` | 验收几问和打回怎么写；同样每次都带上 |
| `references/escalation-examples.md` | 上报示例；没有声明，Leader 需要时自己去读（需要 Leader Agent 能读技能目录） |

授权账本（发起人本人说过的话）和决定记录（Leader 替发起人定过的事）由 Dutydeck 在每次运行里提供，指引里不需要也不应该让 Leader 自己建文件维护。

## 安装并绑到机器人

```sh
dutydeck plugin install ./examples/plugins/leader --scope bot:<appId> --yes
dutydeck restart
dutydeck settings bot set <appId> leaderSkill=leader-guide/leader
```

- `--scope bot:<appId>` 让技能只对这个机器人生效；要所有机器人都能用，去掉它（默认 `global`）。
- `leaderSkill` 的值是 `插件名/技能目录名`。也可以在 Web「机器人管理」的「执行方式」里选 Leader 模式后，从「Leader 指引」候选里选。
- 别忘了同一个机器人还要配好 Leader 模式本身：`executionMode=layered`、`leaderAgentId`、`workerAgentIds`，并开启群工具，见[飞书指南](../../../docs/zh/lark.md)。
- 想清除指引、改回内置规则：`dutydeck settings bot set <appId> leaderSkill=`。

## 改写成你自己的规则

1. 复制这个目录，在 `.dutydeck-plugin/plugin.json` 里改 `name`（kebab-case）。`leaderSkill` 随之变成 `<新名字>/leader`。
2. 改 `references/decide-or-escalate.md`：把你们团队「谁能定什么」的真实边界写进去，尤其是底部的「长期授权」。长期授权是 Leader 除了发起人原话之外唯一认的授权，写得越具体越好（动作、环境、有效范围）。
3. 改 `references/acceptance.md`：换成你们的验收标准。
4. 想让 Leader 每次都带上的文件，放进 `skillResources`（单个最多 64 KiB，同一技能合计受宿主上限约束）；只在偶尔需要时才读的文件不声明，在 `SKILL.md` 里写明路径即可。
5. 本示例用中文写成，上报表头固定为「问题 / 建议 / 不回复时」；改成别的语言时，保持这三栏的含义不变。
6. 不要把凭据、内部地址或个人信息写进指引：指引文本会进入 Leader 的提示词。

## 不用插件也行

指引就是一个普通技能（`SKILL.md` 加引用文件）。放到项目的 `.claude/skills/<名字>/`、`.agents/skills/` 或用户目录对应位置，`leaderSkill` 填技能名即可；也可以直接填 `SKILL.md`（或其所在目录）的绝对路径，这时不要求它在技能目录里；技能目录会跳过指向目录外的软链接，放在别处的指引就用这种写法。绝对路径来源不内联 `skillResources`，同目录的引用文件由 Leader 按路径自己读。技能名重名或找不到时，这次 Leader 运行会失败并在话题里说明，不会悄悄改用内置规则。

## 打包分发

```sh
cd examples/plugins/leader && npm pack --ignore-scripts
dutydeck plugin install npm:/绝对路径/dutydeck-plugin-leader-guide-example-0.1.0.tgz --scope bot:<appId> --yes
```
