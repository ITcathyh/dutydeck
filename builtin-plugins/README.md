# 内置插件

每个子目录是一个随 Dutydeck 发布的插件，格式和外部插件相同（`.dutydeck-plugin/plugin.json`），目录名必须等于清单里的 `name`。

- 构建时复制到 `apps/server/dist/builtin-plugins`；各插件的 `test/` 目录和 `*.test.ts` 不复制。
- daemon 先加载这里的插件，再加载已安装的外部插件。内置插件免信任确认，作用域是 global，不能卸载；外部插件不能和它们同名。
- 测试放在 `<插件>/test/*.test.ts`，由仓库根的 vitest 收集。
