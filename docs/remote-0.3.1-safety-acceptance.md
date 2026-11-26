# Remote 0.3.1 安全撤回与部署验收

日期：2026-11-26。组件：Remote **0.3.1** / manager **0.3.1**。

## 根因与边界

0.3.0 在 Windows 安装时把用户级 `CODEX_CLI_PATH` 指向 Remote 的 CLI shim，
同时把 shim 目录加入用户 `PATH`。Codex Desktop 的普通启动也因此经过 shim，
但其 `policy-read` 握手未被完整实现，最终表现为策略读取失败和“无法加载组织设置”。

官方 Codex 源码中的 Windows Desktop App Server 路径不会自动接入本地
App Server daemon。因此不能通过全局 CLI、`PATH`、启动器或环境变量劫持来
强行复用 Desktop 进程；不再启动替代 App Server，也不修改 Desktop 配置。

## 撤回修复

- 删除 0.3.0 的全局 CLI 适配层和服务启动时写入用户环境的逻辑。
- 清除用户级 `CODEX_CLI_PATH`，并移除用户 `PATH` 中的 shim 目录。
- 恢复已验证的 Desktop 现有连接路径；Windows 当前由 Codex++ 管理 Desktop，
  Remote 只连接该现有实例，不修改其启动方式。
- 0.3.0 的 GitHub Release 已标记为预发布并加入“请勿安装”警告；下载分发
  的 latest 已回落到 0.2.44，避免自动更新再次安装危险版本。

## 本机与入口

- Windows 本机 Remote 报告 0.3.1，健康状态为 ready / desktop。
- Windows 本机管理器已覆盖安装为 0.3.1，打包版 smoke 通过。
- 两个 Windows 公网入口的版本均为 0.3.1，健康状态均为 ready / desktop。
- 国内 Caddy 已原子切换 `current` 到 0.3.1，0.2.44 目录保留用于回滚。
- 升级前安装目录备份保存在 `output/manager-backup-manual-20261126-132602`。

## 验证

- `npm run typecheck` 通过。
- `npm test`：149 个测试文件通过，1204 个测试通过，2 个跳过。
- `npm run build` 与 `npm run manager:build` 通过。
- 打包版管理器自动发现、健康状态、托盘状态、三组视口、诊断恢复、
  更新确认、认证管理和版本更新界面 smoke 全部通过。
- 修复后的一小时桌面日志中没有再次出现 `policy-read`、`reason=protocol`、
  `Untrusted request origin` 或组织设置加载失败。

## 平台边界

Windows 已完成本机安装和两个公网入口的现场验收。macOS 与 Linux 的源码、测试、
构建和 runtime 打包由同一 0.3.1 源版本发布；Apple Silicon 管理器与运行包由
对应 CI runner 生成。macOS 登录状态、LaunchAgent、真机网络和 GUI 仍需在
Apple Silicon 设备上单独验收，不能用 Windows 部署结果替代。
