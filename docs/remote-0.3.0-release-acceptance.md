# Remote 0.3.0 发布与部署验收

日期：2026-11-25。组件：Remote **0.3.0** / manager **0.3.0**。

## 本批范围

- Windows 移除浏览器调试端口、CDP 探测和 Codex++ 依赖。
- 私有 CLI 适配层将 Desktop stdio 与 Remote 连接到同一个官方 App Server。
- App Server 仅监听本机回环地址，使用临时端口与 capability token。
- 自动任务由 Remote 持久化认领并调用官方线程、恢复和回合接口。
- Manager 同步升级到 0.3.0，诊断改为共享 App Server 端点状态。

## 源码验收

- `npm run typecheck` 通过。
- `npm test`：148 个测试文件，1178 个测试通过，2 个按既有条件跳过。
- `npm run build` 与 `npm run manager:build` 通过。
- Manager 源码 smoke 通过，覆盖 400/480/780 宽度、密码与设备管理、
  健康诊断、启动等待、恢复锁、托盘与网络失败提示。
- Manager 0.3.0 Windows x64 安装包构建和 packaged smoke 通过。

## App Server 适配验收

`npm run check:desktop-shim` 使用隔离的临时 `CODEX_HOME`：

- Desktop 适配层启动 WebSocket App Server 并写入私有描述文件。
- 两个独立 CLI 客户端复用同一 App Server。
- 两个客户端均完成 `initialize` 和 `initialized`。
- 第一个客户端创建临时线程，第二个客户端收到 `thread/started` 广播。
- 没有 capability token 的连接被拒绝。
- 描述目录与令牌文件 ACL 仅保留当前用户、SYSTEM 与 Administrators。
- 验收结束后没有生产 App Server、Desktop 会话或临时线程残留。

## 验证边界

Windows 共享适配层已有本机真实传输验收。由于 macOS 与 Linux 需要各自的
GUI 环境注入和生命周期接入，0.3.0 不宣称这两个平台已完成共享 App Server 验收。
真实 iPhone Safari、Home Screen、系统通知显示及长期网络切换仍需单独验收。

发布附件、下载分发、本机安装和两个 Windows 公网入口必须在修复源码提交后
分别记录；源码测试通过不自动代表这些外部状态完成。
