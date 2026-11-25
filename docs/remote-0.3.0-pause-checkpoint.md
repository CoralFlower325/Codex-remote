# Remote 0.3.0 断点

日期：2026-11-25。

## 已完成

- Remote 与 manager 源码版本均为 **0.3.0**。
- Windows 已移除 Codex++、浏览器调试端口与 CDP 依赖。
- Windows CLI 适配层使用一个共享 App Server，Remote 作为第二个官方客户端连接。
- App Server 只监听本机回环地址，使用临时端口和 capability token。
- 描述目录与令牌文件 ACL 仅保留当前用户、SYSTEM 与 Administrators。
- 自动任务改为 Remote 持久化认领，执行前恢复已有心跳线程，离线使用有界退避。
- `npm run typecheck`、全量测试、Remote 构建与 manager 构建通过。
- Manager 源码 smoke、Windows x64 安装包和 packaged smoke 通过。
- `npm run check:desktop-shim` 验证两个客户端复用、事件广播、无令牌拒绝和临时会话隔离。
- 已生成签名 Windows x64 运行包与 manager 0.3.0 安装包。

## 尚未执行

- 未推送源码或创建 Git 标签。
- 未创建 GitHub Release，未上传运行包和 manager 安装包。
- 未刷新下载 Worker 或静态边缘资源。
- 未升级本机 Remote，未安装 manager 0.3.0。
- 未完全退出并重新打开 Desktop。
- 未切换两个 Windows 公网入口。
- macOS 域名和其他平台部署未处理。

## 下次恢复顺序

1. 确认当前分支干净，并确认 `package.json`、lockfile 和 `desktop/package.json` 均为 0.3.0。
2. 重新运行 `npm run typecheck`、`npm test`、`npm run build`、`npm run manager:build`。
3. 在 Windows 运行 `npm run check:desktop-shim`。
4. 复核 `output/runtime` 中的运行包及其签名与当前 HEAD 一致。
5. 推送源码，创建 `v0.3.0` Release，附带签名运行包与 manager 0.3.0 安装包。
6. 刷新下载快照，备份本机安装目录，再升级 Remote 和 manager。
7. 完全退出并正常重开一次 Codex Desktop，确认本地 `/health` 为 ready / desktop。
8. 只同步两个 Windows 公网入口并验证匿名脱敏、登录和实时连接。

## 当前安装状态

本机安装与公网仍保持上一版 0.2.44；Manager 0.3.0 安装包尚未覆盖当前安装。
源码打包完成不等于已发布、已安装或已上线。
