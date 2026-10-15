# team-faq 插件

团队答疑示例插件。群里有人问到指定服务或流程时，按 runbook 判断要不要接，接了按 runbook 回答。插件带一个场景包 `team-faq` 和一个读 runbook 的 provider `runbook`：

- 场景包（`scenarios/team-faq.json`）：真人消息里命中群里配置的关键字（`topics`）时，把这条消息交给参与判定模型；判定指引和回答要求写在包里。
- provider（`provider.mjs`）：读群参数 `docs` 列出的 Markdown，按二级标题（`## `）切段，用消息里命中的关键字给每段打分，取分高的若干段，总长不超过包声明的 `maxChars`（6000 字）。读不到或被拒的文件写进 `missing`，由 Dutydeck 记入判定记录。

## 安装

```sh
dutydeck plugin install ./plugins/team-faq     # 插件带 providers，安装时需要确认
dutydeck plugin config team-faq docs_dir --value /path/to/runbooks
dutydeck restart
```

`docs_dir` 是 runbook 所在目录。provider 只读这个目录内的文件：

- `docs` 里只能写相对 `docs_dir` 的路径，且必须是 `.md` / `.markdown` 文件；
- 带 `..`、绝对路径、解析后落在 `docs_dir` 之外的路径（包括指向目录外的符号链接）一律拒绝，写进 `missing`；
- 单个文件超过 1 MB 时不读。

## 群里开启

先填参数再开启：在 Web 群设置的「团队答疑」里填，或用命令行：

```sh
dutydeck settings group set <chatId> 'scenarios={"team-faq":{"enabled":true,"params":{"topics":["订单服务"],"docs":["orders/oncall.md"]}}}'
```

在群里说「开启团队答疑」也能开启，确认卡上没有填写项，参数沿用已有的值；没填过时 `topics` 为空，不会触发。参数：

| 参数 | 含义 |
|---|---|
| `topics` | 关键字（服务名、流程名），最多 50 个。消息命中任一关键字才会触发 |
| `docs` | runbook 文件，相对 `docs_dir` 的路径，最多 20 个，例如 `orders/oncall.md` |

关闭说「关闭答疑」。

## 打分与摘录

- 只用消息里命中的关键字（不区分大小写）打分：关键字出现在段落标题里按 3 分，正文里每个关键字最多计 5 次，每次 1 分。得分为 0 的段不进入摘录。
- 摘录按分数从高到低放入，同分按 `docs` 里的文件顺序和段落顺序；每段最多 4000 字，超出的部分截断并以「…」结尾，后面的段继续放；总长（标题加正文）到 `maxChars` 时，卡住的那一段截断后结束。同一个文件用不同写法列两次（如 `a.md` 和 `./a.md`）只取第一次。
- 每段的 `id` 是 `<文件相对路径>#<段序号>`，同一文件同一段每次相同；标题是 `<文件相对路径> · <二级标题>`。
- 第一个二级标题之前的内容算作前言段，用文件名作标题。

## 当前限制

- 只在群的参与强度为 `按需` 或 `积极` 时生效；@ 机器人、回复机器人的消息不走这个包。
- runbook 读取超时（3 秒）或出错，或者一段都没读到而有文件读不到时，这条消息按没开这个包判定，`/status` 记为「取材料失败」。
- 摘录只按关键字打分，不做语义检索；runbook 里的段落标题和关键字写法要对得上。
- runbook 内容会交给模型并可能出现在群回复里，不要把含密钥的文件列进 `docs`。
