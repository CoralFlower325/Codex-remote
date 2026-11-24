# Remote 0.2.44 发布与部署验收

日期：2026-11-24。组件：Remote **0.2.44** / manager **0.2.10**。

## 连接不稳定根因

- 浏览器在一次临时故障后切换到 HTTP/SSE 回退通道，并把该选择写入标签页
  `sessionStorage`。回退通道随后失败时，旧逻辑只会继续重连同一通道，即使
  WebSocket 已经恢复也不会切回，导致一次短暂故障被放大成持续不稳定。
- WebSocket 同步成功后没有清除旧的 HTTP 偏好，后续新连接可能继续使用回退通道。
- cloudflared 的所有指标边缘短暂归零时，监管器只等待 4 秒就终止并重建整条隧道；
  Cloudflare 自身通常仍在重连，过早重启会主动扩大断线窗口。
- Desktop 调试 WebSocket 偶发以 `1006` 短时断开。旧逻辑立即广播离线，再在恢复时
  广播 `remote/connected`，所有已连接页面因此同时重读目录、元数据和历史，进一步
  放大原生桥压力并形成反复恢复的反馈环。
- 约 2.9 MB 的 `thread/read` 原生响应以单个 CDP binding 帧传输后，Desktop 调试
  WebSocket 立即以 `1006` 关闭；断开前待处理请求正是这次历史读取。大响应不是
  HTTP/SSE 问题，也不是 Desktop 进程退出。

## 修复

- HTTP/SSE 回退连接失败时，立即尝试 WebSocket；两个通道都失败时进入有上限的
  退避轮换，不再永久粘在失败通道。
- WebSocket 完成同步后清除 `sessionStorage` 中的 HTTP 回退偏好。
- Desktop 调试桥短时断开后先在后台重连；1.5 秒内恢复时保持工作区和服务状态稳定，
  不触发全量目录/历史刷新。持续不可用才广播离线，并在真正恢复后执行一次完整恢复。
- 页面侧把大响应拆成 64 KiB 字符块传输，主机侧按传输 ID 有界重组；单响应上限
  100 MiB、所有未完成响应合计上限 128 MiB。重复传输会被去重，冲突块、超限或
  超过 60 秒的残片会被拒绝或清理。
- cloudflared 全部边缘持续不可用 20 秒后，才在出口可达且二次检查仍未恢复时
  重建隧道；仍保留启动宽限、网络变化唤醒和 15 秒重启冷却。

## 源码验证

- PR #47 CI `45245832567` 与 PR #48 CI `45251143064` 的 macOS、Windows、
  Ubuntu 和浏览器合成验收全部通过。Ubuntu 作业运行 `149` 个测试文件，
  `1201 passed / 5 skipped`。
- `npm run typecheck`、生产构建和 release contract 检查通过。构建产品版本为
  `0.2.44`，入口构建标识为 `assets/index-98koT1Ur.js`。
- 现场日志确认约 `2.9 MB` 的 `thread/read` 响应后，旧 Desktop 调试连接立即以
  `1006` 关闭；分块版本上线后连续 90 秒为 `0` 次断开、`0` 次上下文清空和
  `0` 次无效帧，`/health` 始终保持 ready / desktop。
- 公网浏览器会话主动从已记住的 HTTP/SSE 回退切到离线，再恢复网络：重新建立
  `wss`，旧回退标记被清除，60 秒观察期间没有连接横幅。
- 本机直接执行全量测试时出现既有 macOS PTY 临时目录 `ENOTEMPTY` 清理失败，
  CI 同名 macOS 作业通过；该终端问题不属于本批网络改动。

## 发布与部署

- PR #47、#48、#49 均已合并，每个 PR 的 macOS、Windows、Ubuntu 与浏览器
  合成检查全部通过。main CI `45254299198`、Runtime Packages `45254355807` 和
  Desktop Manager `45254355802` 通过；管理器未改版，package job 按门禁跳过。
- GitHub Release `v0.2.44` 已发布为非草稿、非预发布 latest，双平台签名运行包
  清单与归档共四附件齐全。下载 Worker 版本
  `a2b973b4-cca7-4d2b-a931-692057eb273c`（部署
  `cc462718-30ba-4c14-b570-d43e8a81e3fa`）已刷新快照，`/releases/latest`
  返回 `v0.2.44`；四附件完整下载的大小与摘要均和 Release 元数据一致。
- Windows 本机通过正式网页更新事务从 0.2.43 升级到 0.2.44。更新任务
  `2d384c21-691e-4351-b973-e483ed16988e` 完成，保留备份
  `output/manager-backup-e16e1ffb-3f70-465e-8e4c-33a4bca34351`；Remote PID
  `42420` 监听 `127.0.0.1:4545`，`/health` 为 ready / desktop，配套后端入口
  为 `assets/index-98koT1Ur.js`。`CodexRemote`、`CodexRemoteTunnel` 和
  `CodexRemoteDomesticTunnel` 三项任务均为 Running，Desktop 未重启。
- 国内 Caddy 的 `current` 指向 `releases/0.2.44`，共 `118` 个文件，旧
  `0.2.43` 目录保留。Windows 国内入口
  `codexwin.mmmmmzzzzzyyyyy.online` 与 Cloudflare 入口
  `codexwin.73916482.xyz` 的 `/version.json` 均返回 0.2.44 /
  `assets/index-98koT1Ur.js`，`/health` 均为 ready / desktop。
- 未登录 `/api/bootstrap` 返回 `workspace: null`。`/data/`、`/.env` 与
  `/.git/config` 没有返回文件或目录内容；其中一个入口返回 404，另一个回退到
  不含环境变量或凭据标记的 SPA 外壳。公开页面不含会话、附件、认证或私有配置
  数据。

## 边界

- 管理器 0.2.10 无变更，安装包继续从 `v0.2.41` 提供。
- 其他平台的公网入口属于独立部署状态，不作为本 Windows 入口验收依据。
- 浏览器合成测试不能替代物理 iPhone Safari、主屏和移动网络切换验收。
- 现有诊断日志在明确授权前保留。
