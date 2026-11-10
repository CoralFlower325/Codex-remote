# Remote 0.2.31 发布与部署验收

日期：2026-11-10。组件：Remote **0.2.31** / manager **0.2.9**。

## 升级兼容修复

- 0.2.29 到 0.2.30 的本机实测中，旧 `remote-control-windows.ps1` 只识别
  `node.exe`，管理器无法确认版本化 Node 服务已经停止。事务在替换文件前
  安全回滚，Remote 保持 0.2.29 且健康。
- manager 0.2.9 在安装目录停止路径未达到 stopped 状态时，调用随包
  `stop-windows.ps1`。该助手核对任务工作目录，只处理所选根目录的
  Remote/Tunnel、版本化 Node、cloudflared、网络 watcher 和隐藏包装器，
  不停止 Codex Desktop。
- 停止后继续使用原事务：备份、输入复核、替换、启动验证和失败恢复均未放宽。

## 源码验收

- `npm run typecheck`、`npm test`（138 个文件，1070 通过、2 跳过）、
  `npm run build` 和管理器 smoke 通过。
- manager stop helper 的 PowerShell 语法、根目录范围、任务禁用/停止和
  `node%.exe` 所有权识别加入源码检查。
- 0.2.30 的添加菜单、`/plan`、`/goal`、通用文件/文件夹、八视口布局和
  44px 移动端触控目标保持不变。

## 发布与分发

- GitHub Release `v0.2.31` 为正式、非预发布，源码提交
  `c01cc69eba6d003ce9d449448dd114c5ea392cde`，包含七个附件。
- main CI `42780100444`、Runtime Packages `42781200883` 和 Desktop Manager
  `42781201109` 全部通过。双平台运行包清单均带 Ed25519 签名，版本 0.2.31，
  签名源码提交与标签一致。
- Windows manager 0.2.9 安装包为 `121711356` 字节，SHA-256
  `925758d7c00fb8404cb544a94b933c14a1075265656099e6353ed146e117f10f`。
- 分发 Worker 已刷新七附件快照，版本
  `1f6cb2ab-46f9-4028-88d2-3604c4ae7de2`；`/releases/latest` 返回
  `v0.2.31`，七个附件 HEAD 均为 `200` 且大小匹配。
- `codexwin` 静态边缘版本
  `0fca1603-565d-4a45-a233-1e971391ab50`，公网与本机构建标识均为
  `assets/index-DP0yhQII.js`。

## 本机安装

- manager 0.2.9 已静默安装到 `C:\Program Files\Codex Remote Manager`，
  停止助手随包存在于 `app.asar.unpacked`。
- Remote 从 0.2.30 通过预构建运行包升级到 0.2.31，耗时 2 分 55 秒；
  管理器显示“更新完成”和 `Remote v0.2.31`。
- 本机与公网 `/health` 均为 `ready / desktop`，密码已配置；隐藏任务继续运行
  `node-22.19.0-127.exe`，没有启动第二个 App Server，也没有弹出命令行窗口。

## 边界

- 0.2.29 到 0.2.30 的旧停服问题已在本机真实复现并安全回滚；0.2.31 的停止
  兜底通过源码、PowerShell、管理器 smoke 和双平台 CI 验收。
- iPhone Safari/主屏和已登录 macOS 仍属于真机验收，不以模拟视口代替。
- 管理器自更新、macOS 应用签名与公证继续暂停。
