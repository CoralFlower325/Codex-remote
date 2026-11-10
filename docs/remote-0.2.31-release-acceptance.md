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

- `npm run typecheck`、`npm test`、`npm run build` 和管理器 smoke 需在发布前
  重新通过。
- manager stop helper 的 PowerShell 语法、根目录范围、任务禁用/停止和
  `node%.exe` 所有权识别加入源码检查。
- 0.2.30 的添加菜单、`/plan`、`/goal`、通用文件/文件夹、八视口布局和
  44px 移动端触控目标保持不变。

## 发布后检查

- 正式标签、七个 Release 附件、签名清单、下载分发快照和 `codexwin` 静态边缘
  待发布后逐项校验。
- 本机先从 0.2.30 升级到 0.2.31，再另外验证 manager 0.2.9 的旧停服兜底
  不影响正常运行。
- iPhone Safari/主屏和已登录 macOS 仍属于真机验收。
