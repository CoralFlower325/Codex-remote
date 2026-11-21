# Remote 0.2.42 发布与部署验收

日期：2026-11-21。组件：Remote **0.2.42** / manager **0.2.10**。

## 会话计时修复

- 线程状态短时回到 idle 时，客户端先核对原生轮次时间；对应轮次仍为
  `inProgress` 时不再清空活动轮次。
- 同一会话的静默刷新保留已确认的活动轮次，不再等待后续历史响应才恢复计时。
- 原生轮次完成、中断或失败后仍会停止；最终答复开始流式输出时继续按 Desktop
  的原生 `startedAtMs` 锚点冻结工作用时。
- 新增状态事件、静默刷新和多种计时状态的回归覆盖。管理器 0.2.10 无变更。

## 源码验证

- 全量测试：`1196 passed / 2 skipped`，149 个测试文件通过。
- `npm run typecheck` 与 Remote 生产构建通过。
- 构建产品版本为 `0.2.42`，入口构建标识为
  `assets/index-Nk9GOGX-.js`。
- 本地 composer 合成浏览器验收覆盖八组桌面与手机视口；最终 main CI
  `44853893449` 的 Ubuntu、Windows、macOS 与浏览器作业全部通过。

## 发布与安装

- 最终源码提交和 `v0.2.42` 标签目标均为
  `b1a49bbccca0d5140ec9766631f5a84c86a1289d`。Release 已发布为
  非草稿、非预发布 latest，包含 Windows x64 与 macOS Apple Silicon 两份运行包
  及各自签名清单。
- Runtime Packages `44854588388` 的双平台打包、解包和终端验证通过；两份正式
  清单使用固定公钥独立验签，签名提交与标签目标一致。Desktop Manager
  `44854588412` 的 plan 通过，管理器未改版，打包按版本门禁跳过。
- 下载 Worker 版本 `e826ac9f-0550-4a12-95a2-6ff032bcf9dc` 已刷新四附件快照，
  `/releases/latest` 返回 `v0.2.42`；四个附件的项目分发 HEAD 均为 `200`，大小
  与 Release 元数据一致。管理器 `0.2.10` 安装包继续从 `v0.2.41` 提供。
- 本机 Remote 已从 `0.2.41` 通过签名预构建运行包事务升级到 `0.2.42`。更新任务
  `c98da869-34f5-480a-8ff1-9162c80d42e7` 状态为 `completed`，备份保留在
  `output\manager-backup-84933633-c777-4f84-93c7-daf8a02928cc`。
- 本机 `/health` 为 ready / desktop，`/version.json` 为 `0.2.42` /
  `assets/index-Nk9GOGX-.js`；端口 `4545` 只有当前后端一个监听者。
  `CodexRemote`、`CodexRemoteTunnel` 与 `CodexRemoteDomesticTunnel` 均保持运行，
  Desktop 未重启。

## 公网入口

- 国内 Caddy 已生成最终 Brotli 附属文件，并把
  `/opt/codex-remote-gateway/current` 原子切换到 `releases/0.2.42`；
  `releases/0.2.41` 保留用于回滚，最终目录包含 118 个文件。
- `https://codexwin.mmmmmzzzzzyyyyy.online/version.json` 与
  `https://codexwin.73916482.xyz/version.json` 均返回 `0.2.42` 和同一入口构建
  标识；两个入口的 `/health` 均返回 ready / desktop。
- 两个域名均写入 `PUBLIC_ORIGINS` 与 `ALLOWED_ORIGINS`。分别从两个实际公网
  Origin 提交无效测试凭据时，登录接口均返回 `401` 的凭据错误，没有返回 `403`
  的未信任来源错误；测试没有读取或输出真实密码。
- `codex-remote-static` 已发布 `0.2.42` 静态边缘，Worker 版本为
  `2d4ef8c7-7456-4cb2-97a6-8485bdc852bb`，部署为
  `567a2ed7-646d-42d3-b77b-d4fe03215c20`。首页与版本化资源由边缘返回，资源响应
  带 `x-codex-static: edge`；`/api`、WebSocket 与 `/health` 仍由原后端处理。

## 边界

- 本轮不重新打包或安装管理器 0.2.10。
- 失败和已替代的本机更新记录继续保留；在明确授权前不清理这些诊断证据。
- 物理 iPhone Safari/主屏、移动运营商网络切换和已登录 macOS Desktop 仍需独立
  真机验收。
