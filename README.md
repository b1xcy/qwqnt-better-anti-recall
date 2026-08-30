# qwqnt-better-anti-recall

基于 QwQNT 框架的 **QQNT 简易防撤回**。  
本插件迁移自 [LiteLoaderQQNT-Anti-Recall](https://github.com/xh321/LiteLoaderQQNT-Anti-Recall)

## 功能简介

- 防止 QQNT 聊天消息被撤回（文本 / 部分富文本、图片、视频、文件消息等）
- 可选开启**视频自动预下载**：新视频到达即自动下载到本地，撤回前没点开过的视频撤回后也能完整播放
- 可选是否对「自己撤回的消息」生效
- 对被撤回的图片尝试补全、重定向到可访问链接
- 可选将被撤回的图片复制到插件数据目录的 `images/` 子目录中
- 撤回记录持久化到分片 JSON（明文，按 1 MB 自动切片，便于查看与备份）
- 独立的查看器窗口，按会话浏览所有撤回记录，支持双击看大图 / 播放视频
- 提供设置页面，可配置：
  - 是否持久化保存撤回消息
  - 撤回消息高亮样式（阴影 / 主题色 / 提示文本）
  - 是否启用定期清理、最大缓存条数、单次清理数量
  - 从 NapCat / SnowLuma 获取 RKey（用于修复图片链接失效）

### 关于视频

视频的封面会在收到消息时自动落盘，所以撤回后封面照常显示、查看器里也能看到。

视频本体默认只在你点开看过之后才会下载到本地。为此本插件提供**自动预下载**：
开启后，新收到的视频会在到达几秒后自动触发下载，撤回发生前文件已经完整落盘，
因此撤回后也能照常播放。

- 开关与大小阈值可在设置页配置，阈值默认 50MB，填 `0` 表示不限制大小
- 内核撤回时不会删除已下载的媒体文件，本地文件就是可靠的恢复来源
- 若视频在撤回前从未下载过（例如关闭了预下载、或视频超过阈值），撤回后将
  无法再向服务器索取，只能显示封面

## 前置插件

要正常使用本插件，你**必须**先安装并启用以下前置插件：

- [`qwqnt-ipc-interceptor`](https://github.com/qwqnt-community/qwqnt-ipc-interceptor)
- [`qwqnt-hako`](https://github.com/qwqnt-community/qwqnt-hako)

## 安装与使用

> 本节假设你已经正确安装了 QwQNT 框架，并了解如何安装 QwQNT 插件。

1. 下载构建好的 `qwqnt-better-anti-recall.zip` 插件包。
2. 按 QwQNT 要求，将压缩包解压并放入插件目录。
3. 确保以下插件在 QwQNT 中已启用：
   - `qwqnt-ipc-interceptor`
   - `qwqnt-hako`
   - `qwqnt-better-anti-recall`
4. 重新运行QwQNT框架。

**注意：qwqnt-hako请不要和qwqnt-renderer-events、qwqnt-plugin-settings这两个插件一起安装。**

### 设置页面说明

在 QwQNT 插件管理 / 设置页面中找到 **「防撤回（Anti-Recall）」**，进入设置页后可以配置：

- **是否将撤回消息存入数据库**
  - 关闭：只在内存中短期缓存，重启 QQNT 后撤回记录不再保留。
  - 开启：持久化到 `<data>/qwqnt-better-anti-recall/recalled/`，明文 JSON 按 1 MB
    自动分片。旧版的单文件 `qq-recalled-db.json` 会在首次启动时自动迁移。
- **是否将撤回图片保存到数据目录**
  - 开启后，图片会额外复制到 `<data>/qwqnt-better-anti-recall/images/`，文件名中包含消息 ID 及简化后的原始文件名。
- **是否反撤回自己的消息**
  - 开启后，自己撤回的消息也会被保留；从下一条新消息开始生效。
- **启用定期清理**
  - 控制内存中的消息缓存大小，可配置：
    - 内存中最多缓存消息条数
    - 每次清理时删除的消息数量
- **自动预下载新视频**
  - 开启后，新收到的视频在到达几秒后自动下载到本地，撤回前无需点开
  - 预下载大小阈值：默认 50MB，填 `0` 表示不限制大小
  - 注意：会消耗额外流量与磁盘空间
- **RKey 获取来源**
  - 从 NapCat 获取：通过 NapCat WebUI 的 nc_get_rkey 接口获取 RKey
  - 从 SnowLuma 获取：通过 SnowLuma 的 /api/debug/invoke（get_rkey_server）获取
    RKey；支持配置地址、登录密码与指定账号 UIN，可一键测试连接
  - 两者都启用时按 NapCat → SnowLuma 的顺序尝试
- **样式配置**
  - 撤回高亮主题色（会同时影响阴影和「已撤回」提示文本颜色）
  - 是否显示阴影效果
  - 是否在消息下方显示「已撤回」提示条

## 从源码构建

> 如果你只想体验插件，可以直接使用现成的 zip 包；本节面向希望自行修改 / 构建的开发者。

### 环境要求

- Node.js（建议 20+）
- [pnpm](https://pnpm.io/)（本项目的 `packageManager` 已指定为 `pnpm@10.x`）

### 安装依赖

```bash
pnpm install
```

### 构建插件

```bash
pnpm build
```

## 开源协议

本项目使用 **MIT License** 开源。  
你可以在遵守 MIT 协议的前提下自由地使用、修改和分发本项目的代码。
