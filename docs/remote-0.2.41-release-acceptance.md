# Remote 0.2.41 发布与部署验收

日期：2026-11-19。组件：Remote **0.2.41** / manager **0.2.10**。

## 非 Cloudflare 公网入口与管理器

- 管理器逐项读取 `PUBLIC_ORIGIN` 与 `PUBLIC_ORIGINS`，分别检查 `/health`；
  主入口失败不会再掩盖备用入口状态。
- 静态页面可打开但健康接口返回 502 时，管理器明确提示检查反向隧道或上游
  API 转发，不再归入密码、DNS 或一般网络失败。
- Windows 新增显式 SSH 反向隧道模式。只有
  `SSH_TUNNEL_MANAGED=1` 且主机、用户、私钥路径和端口有效时才接管；
  没有标记的配置保持外部管理。
- “修复”先核验现有任务确实属于当前主机、用户、私钥与端口，再把匹配的旧
  单次 SSH 任务迁移为私有 `data` 下的稳定隐藏监管任务。SSH 任意退出后两秒重试。
- 管理器只保存私钥路径，不读取或返回私钥内容。开始、关闭、重启、服务修复、
  本机更新和停止兜底均同步处理受管 SSH 任务。

## 国内入口恢复与故障演练

- 故障时 DNS、TLS 和静态版本页正常，`/health` 与 `/api/*` 返回 502；本机
  Remote 健康且 Desktop 传输正常。
- 根因是 Windows 到杭州入口的反向 SSH 任务已以退出码 `0` 结束，Task Scheduler
  的失败重启策略不会处理成功退出，任务因此停留在 `Ready` 而不再重连。
- 迁移后计划任务、监管进程与 SSH 子进程均为运行状态，主入口
  `https://codexwin.mmmmmzzzzzyyyyy.online/health` 返回 `200` 和 ready / desktop。
- 受控演练只终止 SSH 子进程，未停止 Remote 或 Desktop。监管器在 15 秒窗口内
  将 PID 从 `54020` 替换为 `44788`，随后主入口再次返回 ready / desktop。
- 主入口与 `https://codexwin.73916482.xyz` 两个入口的管理器探测均可达。

## 构建与安装

- 全量测试：`1192 passed / 2 skipped`，149 个测试文件通过。
- `npm run typecheck`、Remote 生产构建和管理器构建通过。
- 源码 Electron 验收与打包 Electron 验收均通过，覆盖 400/480/780 宽度、
  自动发现、托盘状态、认证、更新恢复、诊断布局与外部隧道修复控件。
- Windows manager 安装包
  `Codex-Remote-Manager-0.2.10-win-x64.exe` 为 `121718525` 字节，
  SHA-256 `4c3a10f1b9def047db6b44014f51ac44dd3d543d1c0b97ca16398339508dee40`。
- 安装器静默退出码为 `0`；Windows 卸载记录和可执行文件产品版本均为
  `0.2.10`。安装后管理器正常启动，Remote、Cloudflare 与 SSH 三项任务保持运行。

## 发布状态

- PR #45 合并提交和 `v0.2.41` 标签源为
  `0110ce7862a4411e00efd21d7b4c550f1d3d2338`。PR CI `44459398248` 的
  Ubuntu、Windows、macOS 和浏览器合成验收全部通过。
- Runtime Packages `44460543487` 与 Desktop Manager `44460543509` 通过。
  macOS 运行包首次在终端 smoke 阶段失败，原作业重跑后通过；两份签名清单均验证到
  同一发布提交。
- Release 已发布为非草稿、非预发布 latest，共 7 个附件。下载 Worker
  `7906d5e0-004d-4050-984f-88b66c0716ce` 已刷新快照，`/releases/latest`
  返回 `v0.2.41`，七个附件的项目分发 HEAD 均为 `200`。
- 本机 Remote 已从 0.2.40 通过签名预构建运行包升级到 0.2.41，事务备份为
  `output\manager-backup-62033631-e5b0-4a17-a98e-be4d8e4752be`。
- 国内 Caddy 已原子切换到 `releases/0.2.41`，旧 0.2.40 目录保留。主入口和
  Cloudflare 入口的 `/version.json` 均为 0.2.41，构建标识
  `assets/index-C8YizH9h.js`，`/health` 为 ready / desktop。

## 边界

- SSH 自动管理当前只支持 Windows；macOS 仍按外部隧道管理。
- 真实 iPhone Safari/主屏、移动运营商网络切换、已登录 macOS Desktop、
  macOS GUI、应用签名与公证仍需独立真机验收。
- 首次安装包仍未签名，Windows 下载信誉提示可能因机器而异。
