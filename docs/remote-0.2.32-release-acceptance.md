# Remote 0.2.32 发布与部署验收

日期：2026-11-10。组件：Remote **0.2.32** / manager **0.2.9**。

## 历史加载修复

- 用户开始上滑阅读历史或历史分页开始时，之前的尾页静默刷新立即失效。
- `thread/resume`、`turn/completed` 和前台恢复只在未进入历史阅读时启动尾页核对。
- 晚到的最新页响应不能覆盖当前历史窗口，避免旧窗口与最新页拼接后闪屏或跳位。
- 回归覆盖历史页先提交、最新页延迟返回，以及上滑期间收到完成事件两种顺序。

## 源码验收

- `npm run typecheck`、`npm test`（138 个文件，1072 通过、2 跳过）和
  `npm run build` 通过。
- `check-audit-ui` 八个视口通过，长历史上滑最坏阅读锚点漂移为 `0px`；
  `npm run check:browser` 完整浏览器组通过。
- 运行包下载后使用 Node 22.19 验签、解包并验证 0.2.31 与 0.2.7 的
  stopped、running、rollback 更新场景。

## 发布与分发

- GitHub Release `v0.2.32` 为正式、非预发布，源码提交
  `7009ceefbcaf932836d826cddec32a9e8bfb8e70`，包含四个 Remote 运行包/清单。
- main CI `42799699651`、Runtime Packages `42799810058` 通过；Desktop Manager
  `42799807769` 的 plan 通过，管理器未改版，package job 按版本门禁跳过。
- Runtime Windows 首次云端工作流因既有更新器测试超时失败，原地重跑通过；
  本机完整测试和运行包验收未出现该失败。
- 下载 Worker 版本 `67ca358a-f525-40f3-abcf-2fae99040636`，
  `/releases/latest` 返回 `v0.2.32`，四个附件公网 HEAD 均为 `200` 且大小匹配。
- `codexwin` 静态边缘版本 `9a804efc-a90b-4ca7-8564-2c4c9afa7fcf`，
  本地与公网 `/version.json` 均为 `0.2.32`，构建标识
  `assets/index-Cu1mBGiP.js`。

## 本机安装

- 管理器 0.2.9 使用自身更新事务将本机已选安装目录从 0.2.31 升级到 0.2.32；
  事务备份由管理器保留，未写入公开仓库。
- 隐藏计划任务继续运行 `node-22.19.0-127.exe` 和受管 cloudflared；
  没有启动第二个 App Server，没有弹出命令行窗口，Desktop 保持运行。
- 本机 `/health` 为 `ready / desktop`，本地与公网同步入口均可达。

## 边界

- 物理 iPhone Safari/主屏在 Wi-Fi 与 5G 下的长历史上滑仍需真机验收。
- 已登录 macOS 集成、管理器自更新和 macOS 应用签名/公证继续暂停。
