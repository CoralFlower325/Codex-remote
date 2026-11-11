# Remote 0.2.36 发布与部署验收

日期：2026-11-11。组件：Remote **0.2.36** / manager **0.2.9**。

## Windows 终端 Job 清理竞态

- Windows 终端 Job helper 可能先于终端 worker 退出。旧清理路径仍会向已经
  关闭的 stdin 写入 `STOP`，产生未处理的 `EPIPE`，足以污染正常关闭流程。
- 停止 helper 前现在检查 stdin 是否已销毁或结束，并持续吸收迟到流错误。
  新增 Windows 回归覆盖：helper 先退出后再次停止不得抛出。
- Windows 测试文件改为顺序执行，避免并发 PTY、PowerShell Job 与更新事务
  争用进程、管道和文件系统。完整 Windows 测试在正式门禁中稳定通过。
- 0.2.35 的 section 时间线虚拟化、5,000 条历史窗口、稳定补页锚点与行内
  高度补偿继续保留。

## 源码与发布

- 正式标签 `v0.2.36` 指向合并提交
  `66b393dab8e3feefd22948a8604eb276ef58a2a7`，为非草稿、非预发布版本。
- PR #28 CI `42938121220` 和最终 main CI `42938969194` 均通过 Windows、
  macOS、Ubuntu 与合成浏览器验收。
- 本地完整测试为 139 个测试文件、1104 通过、2 跳过；类型检查和生产构建
  通过，前端构建标识为 `assets/index-DYP7FSvW.js`。
- Runtime Packages `42939852642` 在 Windows x64 与 macOS Apple Silicon 完成
  签名运行包构建、解包校验和正式附件上传。Desktop Manager `42939852816`
  的 plan 通过，管理器版本未变化，package job 按门禁跳过。
- Release 四个运行包/清单均通过固定公钥验签，签名提交与标签目标一致。
  Windows x64 运行包为 `11962225` 字节，SHA-256
  `a242a844ad63d8cf415bd93e4d522e413424cf5ac3b5de11f07915918d491257`；
  macOS Apple Silicon 运行包为 `10031111` 字节，SHA-256
  `8ee13d4bea32ba657fbe6f5838c9b2066ed5413737cf566cd8ff2dfcd22815b1`。

## 分发与边缘

- 下载 Worker 当前版本为 `b7e5377f-2717-4cf2-b9a5-48c5d7a65663`，已刷新为
  `v0.2.36` 四附件快照；`/releases/latest` 返回 `v0.2.36`。
- 四个运行包/清单的项目分发 HEAD 均为 `200`，公网大小与 Release 元数据
  逐项一致。
- `codexwin` 静态边缘已同步 0.2.36 前端，当前 Worker 版本为
  `b2e42fba-b8c0-40b4-8d0b-cf87b9239c12`。

## 本机安装

- `F:\AAAAcodexremote\codex-remote-main` 已从 0.2.35 通过签名预构建运行包
  事务升级到 0.2.36，安装模式为 `runtime`，旧服务正常恢复为运行状态。
- 事务备份为
  `output\manager-backup-5026e3d4-2fb3-428b-8b9a-866f4e979108`。更新保留了
  本机定制的 `AGENTS.md`、`docs/maintainer-handoff.md`、
  `docs/release-signing.md` 和 `docs/update-downloads.md`；新版副本保存在
  事务备份的 `incoming` 目录。
- 本地与公网 `/version.json` 均为 0.2.36，构建标识
  `assets/index-DYP7FSvW.js`；两端 `/health` 均为 `ready / desktop`，密码已配置。
- `CodexRemote` 与 `CodexRemoteTunnel` 计划任务保持运行。端口 4545 只有一个
  Remote 后端监听，隧道 readiness 为 `200`，未启动第二个 App Server，未停止
  Desktop，也没有弹出命令行窗口。
- 安装管理器保持 0.2.9，无变更；管理器自更新、macOS 应用代码签名与公证继续
  暂停。

## 边界

- 本版修复来自真实 Windows CI 的 `EPIPE` 生命周期失败，并由隔离 Job helper
  回归和完整顺序测试验证。
- 物理 iPhone Safari/主屏、已登录 macOS Desktop 集成、登录持久化和真实网络
  切换仍需真机验收。
- 本轮没有恢复管理器 AU 自更新，也没有改变 macOS 应用签名和公证断点。
