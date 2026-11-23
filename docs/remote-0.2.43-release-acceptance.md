# Remote 0.2.43 发布与部署验收

日期：2026-11-23。组件：Remote **0.2.43** / manager **0.2.10**。

## Office 文件失败根因

- 运行目录中的事实证明同一份 18,084 字节 Word 文件在约 20 秒内连续三次写入
  主机附件存储；三次记录均完整，因此不是浏览器选择、网络上传或服务器拒收。
- 失败发生在 Office 隔离预览进程。该进程过滤环境变量时没有保留 Windows
  `ProgramFiles`、`ProgramFiles(x86)`、`ProgramW6432` 和显式
  `LIBREOFFICE_PATH`，导致主机已安装 LibreOffice 时仍误报“主机尚未安装”。
- 文档处于“正在上传”时不能写入浏览器附件草稿，但旧逻辑会立即把它视作可恢复
  遗漏并显示“部分附件未能保存”，造成用户误以为上传失败。

## “+”菜单滚动根因

- 外层 `.composer-popover` 和插件列表 `.composer-add-plugins` 同时启用纵向滚动；
  手机端又给插件列表增加独立最大高度，手势会在两个滚动容器之间抢占。
- 菜单打开后首个菜单项使用普通 `focus()`，浏览器可能为了露出焦点自动滚动页面。
- 移动端定位只监听窗口 `resize`，没有跟随 `visualViewport` 的键盘、地址栏和缩放
  变化，菜单可能在焦点切换后落到旧位置。

## 修复

- 隔离转换进程和 LibreOffice 子进程共用受限环境白名单，只额外放行 Office
  路径发现所需变量，不传递无关秘密。
- 上传中和上传失败的文档继续保留内联状态，但不会立即触发草稿恢复警告；上传
  成功后附件按原流程显示、持久化和提交。
- “+”菜单改为单一内部滚动面，外层固定标题不参与滚动；初始焦点使用
  `preventScroll`，位置更新按动画帧合并，并监听 `visualViewport` 的尺寸与滚动。

## 源码验证

- 全量测试：`1198 passed / 2 skipped`，149 个测试文件通过。
- `npm run typecheck`、Remote 生产构建和完整八视口浏览器验收通过。
- 构建产品版本为 `0.2.43`，入口构建标识为
  `assets/index-B1vKcnCJ.js`。
- 同一份用户 Word 测试文件已通过修复后的隔离进程实际转换为 154,477 字节 PDF。
- 合成 Office 上传在八组桌面、平板、手机和横屏视口均成功：上传中无错误恢复
  提示，完成后附件正常出现；菜单只有一个滚动容器，打开菜单不改变历史阅读位置。

## 发布与部署

- PR #46 已合并，正式标签与 Release `v0.2.43` 精确绑定到该发布源码；Release
  已发布为非草稿、非预发布 latest，Windows x64 与 Apple Silicon 的签名运行包
  清单、归档共四附件齐全。main CI `45138042290`、Runtime Packages
  `45139094926` 和 Desktop Manager `45139094906` 通过；PR CI `45136295090`
  首次浏览器作业在既有等待点超时，原作业重跑后通过。
- 下载 Worker 版本 `178906cd-dc09-414e-8b0f-81763a8e5a90`（部署
  `1de552f4-b60f-4962-997e-dc748800413a`）已刷新四附件快照，
  `/releases/latest` 返回 `v0.2.43`。四个附件的项目分发 HEAD 均为 `200`，
  完整下载的大小与 SHA-256 和 Release 元数据一致，未输出摘要值。
- 本机通过正式更新事务从 0.2.42 升级到 0.2.43，更新任务
  `1be9e524-3e20-49f9-b032-888fb3969118` 已完成；保留备份
  `output\manager-backup-b98fd5f8-bd7f-430d-956b-02cc84ef4788`。Remote PID
  `58388` 监听 `127.0.0.1:4545`，`/health` 为 ready / desktop，
  `/version.json` 为 0.2.43；`CodexRemote`、`CodexRemoteTunnel` 和
  `CodexRemoteDomesticTunnel` 三项任务均为 Running。Desktop 未重启。
- 国内 Caddy 的 `current` 已原子切换到 `releases/0.2.43`，共 118 个文件，
  `releases/0.2.42` 保留用于回滚。Cloudflare `codex-remote-static` Worker
  版本 `e3a6bab5-5907-495f-bb4d-ad23f0991710`（部署
  `4dfca6a8-ead2-4993-afa6-799776ede70c`）已上线 30 个新/变更静态文件；
  版本化 JavaScript 返回 `x-codex-static: edge` 和
  `Cache-Control: public, max-age=31536000, immutable`。
- 国内主入口 `codexwin.mmmmmzzzzzyyyyy.online` 与 Cloudflare 入口
  `codexwin.73916482.xyz` 的 `/version.json` 均返回 0.2.43 和
  `assets/index-B1vKcnCJ.js`，`/health` 均为 ready / desktop。

## 边界

- 管理器 0.2.10 无变更，安装包继续从 `v0.2.41` 提供。
- 物理 iPhone 键盘、Safari 主屏和移动网络切换仍需真机验收；浏览器合成视口
  不能替代真实输入法与系统文件选择器。
- 现有三次未保留的 Office 上传记录作为故障证据保留，在明确授权前不清理。
