# 安装说明（发给同学）

这是一个 DeepSeek Harness 插件：在插件详情页里检查 npm 上有没有新版本，有的话一键更新。

## 需要什么

- DeepSeek Harness（桌面版或 Web 版都行）
- 已经在用的一个 profile（默认就是你的 `desktop`）

插件本身没有任何依赖，也不会改你的模型、密钥或其它配置。

## 装

### 方式一：从 GitHub 直接装（最省事）

打开 DeepSeek Harness，左侧点 **插件** → 右上角 **+ 添加插件** → 填：

```
https://github.com/YiZhiQvQ/dsh-plugin-auto-update
```

或者命令行：

```sh
dsh plugin --profile desktop install https://github.com/YiZhiQvQ/dsh-plugin-auto-update
```

这种方式不需要先下载任何文件，以后想更新也可以重新装一次。

### 方式二：装我发的压缩包

1. 把 `dsh-plugin-auto-update-0.1.0.tgz` 放到一个**以后不会移动**的位置，比如 `D:\dsh-plugins\`
   （移动或删掉这个文件后，插件会加载失败，需要重新装一次）
2. 打开 DeepSeek Harness，左侧点 **插件**
3. 右上角 **+ 添加插件**
4. 在输入框里填这个文件的**完整路径**，例如：
   ```
   D:\dsh-plugins\dsh-plugin-auto-update-0.1.0.tgz
   ```
5. 确认安装

也可以命令行：

```sh
dsh plugin --profile desktop install "D:\dsh-plugins\dsh-plugin-auto-update-0.1.0.tgz"
```

## 怎么用

打开 **插件 → 已安装插件**，点任意一个从 npm 装的插件进它的详情页：

- 右上角多一个 **检查更新** 按钮
- 有新版本时，标题旁出现绿色的 **有新版本 x.y.z**，按钮变成 **更新到 x.y.z**
- 点更新会先弹确认，确认后自动卸载旧版、装新版、重新加载

页面下方的区块会写清楚：已安装哪个版本、npm 上最新是哪个、从哪个仓库查的。如果那个插件是本地链接或从 Git 装的，它会直接说明「不会去问 npm」，不会给你一个按了没用的按钮。

## 会不会乱动我的东西

- 只检查**你自己装的、从 npm 来的**插件；Harness 自带的插件、本地链接的插件都不碰
- 检查只是读 npm 的公开版本信息，不发送任何本地数据
- 只有你点「更新」并确认之后才会真的动文件
- 新版本如果要求更高的 DSH 版本，它会提示而不是硬装

## 卸载

插件页面里点进去，右上角 **卸载** 即可。

## 打包信息

- 包名：`dsh-plugin-auto-update`
- 版本：`0.1.0`
- 文件数：10
- 大小：约 20 KB
- 许可：MIT
