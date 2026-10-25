# dsh-plugin-update

[English](README.md) | 中文

一个 DeepSeek Harness 插件包：检查 npm 上有没有该 profile 里插件的新版本，一键完成更新——就在插件自己的详情页里。

## 它解决的问题

从 npm 装进 DSH profile 的插件，会一直停在当初 `pnpm` 解析出来的那个版本。Web UI 里没有任何地方会告诉你上游发了新版本：

- **插件**页面只给安装时自带的 Official 目录条目提供 *更新* 按钮；
- `list_bundles` 只报告已安装版本和保存的依赖说明，不会去问仓库；
- `install_bundle` 对已安装的包会直接拒绝（`already-installed`），所以更新本质上永远是 **先卸载、再安装**。

这一串操作手动做既繁琐又容易漏。这个插件替你做。

## 它提供什么

侧边栏不新增任何入口。它挂在插件页面的详情视图上，所以控件就长在页面本来就有的按钮旁边：

| 位置 | 内容 |
|---|---|
| 详情页头部 | **检查更新**，在插件自己的开关和「卸载」旁边 |
| 标题旁 | 有新版本时显示 **有新版本 4.10.0** |
| 页面内容下方 | 已安装 → 最新、回答的仓库；检查失败或新版本要求更高 DSH 时给出原因 |

它只出现在「从 npm 仓库装进该 profile」的插件包页面上。本地链接、Git 安装、以及安装时自带的插件包，页面会写明为什么不去问 npm，而不是给一个按了也没用的按钮。

它按与 profile 插件管理器完全相同的顺序询问同一批仓库，所以配了 `registry.npmmirror.com` 的 profile 是拿镜像对比，而不是拿 npmjs 对比。

单个插件的检查结果有五种状态：

- **可更新**：存在新版本，且 `engines.dsh`（没有则看 `@deepseek-ai/dsh` 的 peer 范围）允许当前运行的 DSH 版本。
- **不兼容**：有新版本，但它要求的 DSH 版本这个 profile 没有在跑。界面会显示要求来自哪里，不出现更新按钮。
- **已是最新**：装的就是最新版。
- **读取失败**：仓库读不到（离线、404、文档格式异常），并给出原因；**检查更新** 可以重试。
- **不支持**：依赖是本地链接、Git 地址、压缩包或别名。这些永远不动。

检查某个页面时只问那一个包：其它包的仓库文档走十分钟缓存。

## 更新是怎么执行的

Host 半部调用 profile 自己的 `pluginManager` 服务，和插件页面、`plugin_manager` 工具走的是同一套逻辑：

1. `removeBundle(name)` —— 取消选择该插件包、卸载它的所有行，并执行 `pnpm remove`。
2. `installBundle(spec, { enabled, registry })` —— 安装新版本并重新选择。`enabled` 会保留用户原本关闭的状态。
3. 如果第 2 步失败，会把原来的依赖说明再装回去，所以更新失败不会留下一个缺失的插件。

保存的依赖说明会沿用原来的范围符号：`^4.8.1` 变成 `^4.10.0`，而不是 `4.10.0`。原本锁死精确版本的 profile 继续锁死。

开启 HMR 时替换无需重启；对启动以来一直在运行的插件包会报告 `restart-required`，页面会提示重启。

这个插件拒绝更新自己：卸载它会连带撤掉正在响应请求的路由。

有两个副作用来自插件管理器本身，而不是这个插件，并且和官方 Update 的行为一致：

- 重新安装的插件包会排到 `dsh.profile.bundles` 的**末尾**。这个顺序就是配置优先级，所以如果某个 profile 里两个插件包覆盖了同一行配置，更新后的那个会变成最后生效。
- 卸载之后如果安装失败或被取消，这个包会处于未安装状态；正因如此，失败时会自动把原来的依赖说明装回去。

## 配置

不需要配置。要问哪些仓库，由插件管理器自己的 `registry` 和 `fallbackRegistries` 决定。

## HTTP 接口

Client 半部通过三条路由和 Host 通信，因为纯 JS 插件包无法生成 `@Remote` 命名空间：

```
GET  /plugin-update/state    -> { ok, report, checking }
POST /plugin-update/check    -> { ok, report }           请求体: { refresh?: boolean, names?: string[] }
POST /plugin-update/update   -> { ok, result, report }   请求体: { name }
```

写操作要求带上 `x-plugin-update: 1` 请求头：跨站表单设不了它，跨域 `fetch` 要带它必须通过 CORS 预检，而这两条精确路由从不响应预检。

## 安装

直接从 GitHub 装（推荐，不需要预先下载）：

```sh
dsh plugin --profile <profile> install https://github.com/YiZhiQvQ/dsh-plugin-update
```

本地检出用目录安装，编辑后立即生效：

```sh
dsh plugin --profile <profile> install /绝对路径/dsh-plugin-update
```

从别人发的压缩包安装：

```sh
dsh plugin --profile <profile> install /绝对路径/dsh-plugin-update-0.1.0.tgz
```

压缩包安装会把依赖记成绑定该文件路径的 `file:` 依赖，所以要把 `.tgz` 留在原地，移走后需要重装；装目录会记成 `link:` 依赖，直接跟随目录里的改动；从 GitHub 安装记的是 Git 地址，随时可以重新拉取。

## 测试

```sh
node --test test/helpers.test.js test/update.test.js
node test/dry-run.mjs
```

`update.test.js` 通过全局 `fetch` 提供固定的仓库文档，所以线上发了新版本也不会让断言变色。`dry-run.mjs` 把真实的 `apply` 挂到假 context 上，用真实 HTTP socket 提供路由，并打印它生成的报告；导入前设置 `globalThis.__DSH_BUNDLES__` 和 `globalThis.__DSH_REGISTRIES__` 即可喂入测试数据。
