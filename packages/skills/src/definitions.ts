import type { SkillDef } from './types.js';

/**
 * dockmux 内置 skill 集。
 *
 * 选型原则（与 botmux 的差异，改动前必读）
 * =========================================
 * botmux 的内置 skill 大多是**某个 botmux 子命令的说明书**（`botmux send`、
 * `botmux schedule`、`botmux ask`、`botmux workflow` …）。dockmux 没有这些命令，
 * 照搬过来就是教 CLI 调用不存在的东西——比缺失更糟。
 *
 * 所以这里只收两类内容：
 *  1. **无条件为真的运行环境事实**——不依赖任何 dockmux 子命令，纯粹告诉 CLI
 *     「你在哪、输出去哪、什么会让你卡死」。
 *  2. **会被 CLI 误判的 dockmux 侧行为**——比如安全 Hook 的拒绝，如果不解释，
 *     Agent 的本能是重试或绕过。
 *
 * 明确**不**收录的：`dockmux group *` 群协作命令族。它不是缺能力，而是
 * **已经由运行时注入覆盖**——`apps/server/src/lark/agent-tools.ts` 的
 * `larkGroupToolsPrompt()` 经 `sessionPrompt` 钩子拼在**每一轮** prompt 前，
 * 且其中的命令前缀是 `agentDockGroupToolsCommand()` 算出来的**绝对路径**
 * （`'<node>' '<abs>/dist/cli.js'`），并明确要求「不要改用 PATH 中的其他
 * dockmux」。静态 SKILL.md 拿不到那个运行期路径，只能写裸 `dockmux`——那正好是
 * 运行时禁止的形态，可能命中 PATH 里的另一个安装。重复覆盖也白烧 token。
 * 这与 botmux 的 `FULLY_ROUTING_COVERED_SKILLS`（路由块已覆盖的 skill 不再进
 * 目录）是同一个判断。
 */

const bridgeSession = `---
name: dockmux-bridge-session
description: 说明你当前运行在 dockmux 桥接会话里——没有人守在终端前，你的输出会被解析成消息转发给 IM/Web 用户。任何时候你准备执行交互式命令、启动前台长驻进程、等待人工确认、或想知道"我说的话用户到底看不看得到"时，都适用本说明。
---

# 你运行在 dockmux 桥接会话里

dockmux 把你（一个编程 CLI）当作被桥接的 agent 拉起来，架在 IM（飞书）和 Web
工作台之间。**没有人坐在这个终端前面。** 你以为的"跟人对话"，实际是：

    你的终端输出 → dockmux 解析成事件 → 渲染成 IM 卡片 / Web 时间线 → 人看到

理解这条链路会改变你的几个默认行为。

## 你的输出如何到达用户

- **正常输出即可送达。** 你打印的文本会被解析成 \`text\` 事件转发出去，不需要
  任何特殊命令去"发送"。**不存在专门的回传子命令**——不要去找、不要臆造，
  也不要因为没找到就认为自己的话没发出去。
- **解析不了的照样送达。** 无法归类的终端输出会走 \`raw_terminal\` 兜底通道，
  不会丢，但在用户那边呈现为一段原始终端文本，可读性差。**结论性内容要写成
  正常的正文段落**，不要只留在进度条、spinner、彩色 TUI 面板里。
- **一轮一个终点。** dockmux 靠检测终端回到空闲提示符来判定"这一轮结束了"。
  在此之前用户看到的是"运行中"。

## 什么会让你卡死（最重要的一节）

无人值守意味着**任何等待人类输入的东西都不会等到**，它会一直挂着直到超时：

- 交互式确认（\`y/N\`、\`Continue? [Y/n]\`、密码提示、\`git rebase -i\`）
- 需要按键退出的分页器（\`git log\` 默认走 \`less\`、\`man\`、\`top\`）
  → 用 \`--no-pager\` / \`| cat\` / \`PAGER=cat\`
- 前台长驻进程（\`npm run dev\`、\`tail -f\`、\`watch\`、不带超时的服务器）
  → 需要它跑着就放后台并重定向日志，然后**主动返回**，不要占着这一轮

拿不准某条命令会不会等输入时，优先选它的非交互形态（\`--yes\`、\`--no-input\`、
\`--non-interactive\`），或者加超时。

## 需要人做决定时

你**不能**发起阻塞式提问——没有可用的提问通道，也没有人实时回答。正确做法是
**把这一轮结束掉，并在输出里讲清楚**：

1. 你已经做完什么、当前状态在哪
2. 具体卡在哪个决策点，以及你需要的是什么（授权 / 凭证 / 二选一 / 需求澄清）
3. 每个选项你的推荐和理由

用户会在下一轮回复你。**不要**为了"等回答"而空转、轮询或反复重试。

## 谁能看到什么

- IM 用户看到的是**渲染后的消息**，看不到你的终端画面。
- Web 工作台的用户**可能正开着实时终端视图**看你的原始终端流（含 ANSI）。
  所以"反正没人看终端"不成立——别在终端里打印不该被看到的东西。
- 无论哪种，**凭证、token、密钥不要打印**。

## 环境细节

- 工作目录是本会话绑定的目录，不要假定它等于仓库根或你的 home。
- 桥接进程自身的 \`ANTHROPIC_*\` / \`CLAUDE_*\` 环境变量**已被剥离**——那是
  dockmux daemon 的运行身份，不是你的。你应当用自己的配置（如 \`~/.claude/\`）。
- 工作目录下的 \`.dockmux/\` 是 dockmux 的内部状态目录（会话策略、ACP 状态）。
  **只读都不必，更不要写。**
- 用户在 IM 里发的图片/文件，dockmux 会先下载到本地临时目录，并在 prompt 里
  直接告诉你路径。用普通的本地文件读取工具去看即可。
`;

const riskGuard = `---
name: dockmux-risk-guard
description: 解释 dockmux 的高危操作拦截——当你的工具调用被拒绝且理由形如"当前飞书发送人无权执行高危操作"或"高危操作已被 Dockmux 拦截"时读本说明。它是策略性拒绝，不是可重试的故障，更不该绕过。
---

# dockmux 高危操作拦截

dockmux 可以在工作区里装一道**工具调用前置门禁**（PreToolUse Hook，覆盖
Claude Code / Codex / Trae / Cursor / Pi；ACP 形态则在权限请求处内建同样的检查）。
它按管理员配置的正则匹配你的工具名和参数，命中就**拒绝这次调用**。

## 你会看到什么

拒绝会以工具调用失败的形式回到你这里，理由文本形如：

- \`当前飞书发送人无权执行高危操作\`（默认文案，管理员可自定义）
- \`高危操作已被 Dockmux 拦截：<工具标题>\`（ACP 形态）
- \`正则匹配超过 1000ms，已终止并拒绝操作\` / \`正则匹配失败：…\`

最后一类是**匹配本身出错时的 fail-closed**：判不出安全就按不安全处理。

## 正确反应

**停下来，把情况报告给用户。** 具体地说：

1. 说明你想执行什么操作、为什么需要它
2. 原样转述拒绝理由
3. 说明这需要有权限的人来放行，或者请用户确认换一条更保守的路径

## 明确禁止的反应

这是一道**安全控制**，不是需要你巧妙绕开的障碍。以下行为一律不允许，即使你
判断该操作本身是安全的、或者用户之前表达过想做：

- **原样重试。** 策略是稳定的，重试只会重复失败。
- **改写命令去躲正则。** 换等价写法、拆成多步、变量拼接、base64、换一个能达到
  同样效果的工具——**任何以规避匹配为目的的改写都是违规的**，哪怕改写后的命令
  确实没被拦。
- **换条路做同一件事。** 拦的是**这个操作**，不是这一种写法。
- **自行修改策略。** 工作区里的 \`.dockmux/\` 状态、Hook 配置文件（
  \`.claude/settings.json\`、\`.codex/hooks.json\`、\`.cursor/hooks.json\`、
  \`.trae/hooks.json\`、\`.pi/extensions/\`）都不要动。

被拦住不是你的失败，如实报告就是正确的收尾。绕过去才是。

## 顺带一提

没被拦不等于被批准——门禁只覆盖管理员配置的模式。不可逆操作（删数据、改线上
配置、强推分支、动生产环境）在动手前仍然应当先跟用户确认。
`;

/**
 * 内置 skill 集。顺序即投递顺序，也是 catalog 的展示顺序。
 *
 * 目前只有环境说明类——dockmux 尚未向被桥接 CLI 暴露通用的命令接口，
 * 硬凑命令型 skill 只会教出调不通的调用。缺口清单见包 README / M3 规划。
 */
export const DOCKMUX_BUILTIN_SKILLS: readonly SkillDef[] = Object.freeze([
  Object.freeze({ name: 'dockmux-bridge-session', content: bridgeSession }),
  Object.freeze({ name: 'dockmux-risk-guard', content: riskGuard }),
]) as readonly SkillDef[];

/** 按名字取内置 skill；未知名字返回 undefined。 */
export function builtinSkill(name: string): SkillDef | undefined {
  return DOCKMUX_BUILTIN_SKILLS.find(skill => skill.name === name);
}

/** 内置 skill 的目录名列表。 */
export function builtinSkillNames(): string[] {
  return DOCKMUX_BUILTIN_SKILLS.map(skill => skill.name);
}
