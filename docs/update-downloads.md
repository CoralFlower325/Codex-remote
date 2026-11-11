# 更新下载与分发

从 Remote 0.2.10 与正式管理器 0.2.1 起，更新优先通过项目自有的
`https://downloads.73916482.xyz` 读取公开版本信息及下载官方附件，
失败后尝试官方 GitHub。分发由项目的 Cloudflare Worker 提供，不要求更新主机配置
Cloudflare 凭据，也不代理聊天、认证、终端或其他私有内容。

## 安装管理器 0.2.9

| 系统 | 项目分发 | 官方备用 |
| --- | --- | --- |
| macOS Apple Silicon | [DMG](https://downloads.73916482.xyz/releases/download/v0.2.31/Codex-Remote-Manager-0.2.9-mac-arm64.dmg) · [ZIP](https://downloads.73916482.xyz/releases/download/v0.2.31/Codex-Remote-Manager-0.2.9-mac-arm64.zip) | [DMG](https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.31/Codex-Remote-Manager-0.2.9-mac-arm64.dmg) · [ZIP](https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.31/Codex-Remote-Manager-0.2.9-mac-arm64.zip) |
| Windows x64 | [安装程序](https://downloads.73916482.xyz/releases/download/v0.2.31/Codex-Remote-Manager-0.2.9-win-x64.exe) | [安装程序](https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.31/Codex-Remote-Manager-0.2.9-win-x64.exe) |

1. 从菜单栏／托盘菜单退出旧管理器。退出管理器不停止 Remote。
2. 下载并安装 0.2.9，覆盖旧应用。macOS 将新应用替换到原应用位置。
3. 重新打开管理器，确认显示 0.2.9，选择原 Remote 安装目录。
4. 有中断事务时先恢复；否则重新检查并执行主机更新。保留事务记录和备份，
   不要为重试删除本机数据、文档或更新锁。

主机 Remote 的更新不会替换已安装管理器 `app.asar` 中的更新器。
旧管理器仅检查 Remote 新版本也不能获得新下载逻辑。
管理器与 Remote 独立计版。管理器自更新仍暂停在 `archive/manager-0.2.0AU`，
本次不恢复 AU 功能；签名、公证和真实 Mac 登录环境验收仍是独立断点。
未签名安装包可能需要按系统下载信誉或 Gatekeeper 流程确认。

Remote 0.2.36 修复 Windows 终端 Job helper 退出后的 `EPIPE` 清理竞态，并保留
0.2.35 的 section 时间线虚拟化、5,000 条历史窗口与稳定补页锚点；运行包位于
`v0.2.36`。管理器 0.2.9 未变更，安装包继续位于
`v0.2.31`。
运行包 Ed25519 清单签名已启用，与仍暂停的 AU 和 macOS 应用签名分别管理。

English: install manager 0.2.9 manually over the old app, reopen it and select the same
Remote directory before retrying. Host updates cannot patch the old manager's
bundled updater. Manager self-update, signing and notarization remain paused.

## 下载协议与校验

- 最新正式版元数据：`https://downloads.73916482.xyz/releases/latest`。
  官方备用为 GitHub 仓库的 `releases/latest` API；每个来源限时 15 秒。
  分发域名可达不代表其匿名 GitHub 上游未限流；客户端官方备用也可能受出口限制。
  上游限流时使用已校验的公开快照，保留上游状态诊断。
  当前快照及公网验证见下方维护记录；不能把旧快照当作最新发布。
  未显式配置 HTTP 代理的 Agent 探测
  不证明系统 TUN、VPN 或透明代理已关闭，也不代表用户 Mac 的网络验收。
- 附件地址保持 `/releases/download/v<Remote版本>/<附件名>`。运行包清单、归档和
  管理器安装包均使用公开 Release 附件；管理器自身版本可与标签中的 Remote 版本不同。
- 附件每次下载等待响应头最多 30 秒、连续无数据最多 60 秒、整个下载最多 600 秒。
  切换到备用来源后仍需重新完成该次下载，不能把不完整文件当成成功结果。
- 来源切换不降低校验。运行包清单和归档需要官方 Release 的大小与 SHA-256，
  解压前检查路径、链接、重复条目和大小，解压后逐文件校验，再检查原生终端。
  Remote 0.2.25 / manager 0.2.4 还要求固定公钥验证 Ed25519 清单签名；
  源码回退也要求与签名提交完全一致。缺少签名、校验值或清单／归档不成对时停止，
  不绕过保护继续安装。
- 使用管理器或网页入口前需具备包含新逻辑的版本。旧程序不会因分发服务上线自动升级。

分发面向公开发布内容；访问日志可能包含公开附件路径。不会传递浏览器 Cookie、
Authorization 或任意客户端请求头，不接收私有安装配置。它不负责向主机分发密码、
Cloudflare 令牌或任何运行数据。

## 网络与安装边界

Remote 0.2.16 与管理器 0.2.2 不再将已等于目标版本的文件误判为定制，
避免无故退回 Git/npm 构建。真正的私有源码及配置仍阻止运行包直接覆盖。
网页更新的代理连接明确失败时，公开 GET/HEAD 可在原超时预算内尝试一次直连；
取消、到期及非只读请求不参与回退。不会更改系统代理设置，也不保证 TUN 关闭后的
任意地区网络可达，仍需在用户实际网络上验收。

当分发可达、平台运行包完整且已安装版本有兼容基线时，标准安装无需直连 GitHub，
也不执行 Git 克隆、npm 安装、本机测试或构建。仍需本机 Node.js 22.19+。
`.DS_Store`、AppleDouble `._*` 和 `__MACOSX` 不视为源码定制；
其他真实输入保留，源码回退提示最多列出有限相对路径，不公开文件内容。
`.env.example` 的本机副本保留，运行时 `.env` 和私有数据受保护。

源码定制、缺少基线或没有当前架构的运行包时，更新仍走隔离源码构建，需要 Git/npm
各自的网络与依赖源。管理器的系统代理不等于 Git/npm 的代理配置。
分发或 Cloudflare 无法访问时，官方备用也可能需要代理。因此不能承诺所有安装与网络
都免 TUN，也不能把部署成功或本机探测写成用户 Mac 网络的现场验收。

下载准备失败不会停止旧服务。安装／验证失败沿用事务回滚，恢复旧依赖及原运行状态。
这里的分发不替换已有的恢复协议，也不为主机提供远程服务修复权限。
详见[管理器](desktop-manager.zh-CN.md)与[网页后端更新](web-backend-update.md)。

## 维护分发服务

2026-11-11 已完成 Remote **0.2.36** 的分发与 `codexwin` 部署收尾。正式标签为
`v0.2.36`，发布提交 `66b393dab8e3feefd22948a8604eb276ef58a2a7`。main CI
`42938969194`、Runtime Packages `42939852642` 和 Desktop Manager
`42939852816` 通过；管理器未改版，package job 按门禁跳过。

下载 Worker 版本 `b7e5377f-2717-4cf2-b9a5-48c5d7a65663` 已刷新四附件快照，
`/releases/latest` 返回 `v0.2.36`。四个运行包/清单的项目分发 HEAD 均为 `200`，
大小与 Release 元数据一致；Windows x64 运行包为 `11962225` 字节，SHA-256
`a242a844ad63d8cf415bd93e4d522e413424cf5ac3b5de11f07915918d491257`。

本机 Remote 已从 0.2.35 通过预构建运行包升级到 0.2.36，事务备份为
`output\manager-backup-5026e3d4-2fb3-428b-8b9a-866f4e979108`；本地与
`codexwin` 的 `/version.json` 均为 0.2.36，构建标识
`assets/index-DYP7FSvW.js`，`/health` 为 ready / desktop。静态边缘 Worker 版本为
`b2e42fba-b8c0-40b4-8d0b-cf87b9239c12`。服务与隧道继续由隐藏计划任务运行
`node-22.19.0-127.exe`，未弹出命令行窗口，Desktop 保持运行。

2026-11-11 已完成 Remote **0.2.35** 的分发与 `codexwin` 部署收尾。正式标签为
`v0.2.35`，发布提交 `597579945ad3f10ce31b56a3ac2c48d5675e1cf2`。main CI
`42933985604`、Runtime Packages `42934907008` 和 Desktop Manager
`42934907041` 通过；管理器未改版，package job 按门禁跳过。

下载 Worker 版本 `584cad2d-fcd6-4d4b-b11c-68b19212818d` 已刷新四附件快照，
`/releases/latest` 返回 `v0.2.35`。四个运行包/清单的项目分发 HEAD 均为 `200`，
大小与 Release 元数据一致；Windows x64 运行包为 `11959519` 字节，SHA-256
`797ad79cc5fc59a4d68768ecdf683e9822b070f9604adbab18b79d17eaa9a102`。

本机 Remote 已从 0.2.34 通过预构建运行包升级到 0.2.35，事务备份为
`output\manager-backup-01739dc9-0c86-4362-a8ac-c85fbcaff3fa`；本地与
`codexwin` 的 `/version.json` 均为 0.2.35，构建标识
`assets/index-9Agbdvm-.js`，`/health` 为 ready / desktop。静态边缘 Worker 版本为
`77e027c7-48c7-48e6-a475-38a063371ed9`。服务与隧道继续由隐藏计划任务运行
`node-22.19.0-127.exe`，未弹出命令行窗口，Desktop 保持运行。

2026-11-10 已完成 Remote **0.2.34** 的分发与 `codexwin` 部署收尾。正式标签为
`v0.2.34`，发布提交 `736067de4194871cda7dd33b19c5e6de04648678`。main CI
`42832498455`、Runtime Packages `42834522094` 和 Desktop Manager
`42834521951` 通过；管理器未改版，package job 按门禁跳过。

下载 Worker 版本 `bfadec63-945f-4f36-9dae-8a2f31ab6545` 已刷新四附件快照，
`/releases/latest` 返回 `v0.2.34`。四个运行包/清单的项目分发 HEAD 均为 `200`，
大小与 Release 元数据一致；Windows x64 运行包为 `10279325` 字节，SHA-256
`46d9e25652479410cdafec021b892813c8a309224384b451634fd26af4a80c3b`。

本机 Remote 已从 0.2.33 通过预构建运行包升级到 0.2.34，事务备份由管理器
保留；本地与 `codexwin` 的 `/version.json` 均为 `0.2.34`，构建标识
`assets/index-C3CJbpCT.js`，`/health` 为 ready / desktop。静态边缘 Worker 版本为
`e0f64688-1fee-4ae7-85b4-f786971673cd`。服务与隧道继续由隐藏计划任务运行
`node-22.19.0-127.exe`，未弹出命令行窗口，Desktop 保持运行。

2026-11-10 已完成 Remote **0.2.33** 的分发与 `codexwin` 部署收尾。正式标签为
`v0.2.33`，发布提交 `b2e3d9ecc2ee6afbb6fcef87ff74de9334dc9e10`。main CI
`42808058587`、Runtime Packages `42808168637` 和 Desktop Manager
`42808168788` 全部通过；管理器未改版。

发布后首先发现下载 Worker 的已校验快照仍返回 `v0.2.32`，管理器会因此漏报
新版本。刷新快照并部署下载 Worker 后，`/releases/latest` 返回 `v0.2.33`；
Worker 版本为 `a5a09717-3d5d-4bb8-8d78-aa86f6b465ec`。四个运行包/清单的
项目分发 HEAD 均为 `200`，大小与 Release 元数据一致。

本机 Remote 已从 0.2.32 通过预构建运行包升级到 0.2.33，事务备份由管理器
保留；本地与 `codexwin` 的 `/version.json` 均为 `0.2.33`，构建标识
`assets/index-DraSBu-b.js`，`/health` 为 ready / desktop。静态边缘 Worker 版本为
`d291018d-8fb0-47a2-b2c9-91c92631ee1e`。服务与隧道继续由隐藏计划任务运行
`node-22.19.0-127.exe`，未弹出命令行窗口，Desktop 保持运行。

2026-11-10 已完成 Remote **0.2.32** 的分发与 `codexwin` 部署收尾。正式标签为
`v0.2.32`，发布提交 `7009ceefbcaf932836d826cddec32a9e8bfb8e70`。main CI
`42799699651` 和 Runtime Packages `42799810058` 通过；Desktop Manager
`42799807769` 的 plan 通过，管理器未改版，package job 按版本门禁跳过。

下载 Worker 版本 `67ca358a-f525-40f3-abcf-2fae99040636` 已刷新四附件快照，
`/releases/latest` 返回 `v0.2.32`。四个运行包/清单公网 HEAD 均为 `200`，大小与
Release 元数据一致；Windows x64 运行包为 `10271009` 字节，SHA-256
`ab5cbb9aaf69f2c9a9122a6a31acbee5acb166ca64d534b260585da0031fee80`。

本机 Remote 已从 0.2.31 通过管理器更新事务升级到 0.2.32，事务备份由管理器
保留；本地与 `codexwin` 的 `/version.json` 均为 `0.2.32`，构建标识
`assets/index-Cu1mBGiP.js`，`/health` 为 ready / desktop。静态边缘 Worker 版本为
`9a804efc-a90b-4ca7-8564-2c4c9afa7fcf`。服务与隧道继续由隐藏 `wscript`
包装器运行 `ProgramData` 下 `node-22.19.0-127.exe`，未弹出命令行窗口，Desktop
保持运行。

2026-11-10 已完成 Remote **0.2.31** / manager **0.2.9** 的分发与
`codexwin` 部署收尾。正式标签为 `v0.2.31`，发布提交
`c01cc69eba6d003ce9d449448dd114c5ea392cde`。
Runtime Packages `42781200883`、Desktop Manager `42781201109` 和
`main` CI `42780100444` 全部通过。

下载 Worker `1f6cb2ab-46f9-4028-88d2-3604c4ae7de2` 已刷新七附件快照，
`/releases/latest` 返回 `v0.2.31`。七个附件的公网 HEAD 请求全部为 `200`，
大小与 Release 元数据一致；Windows manager 0.2.9 安装包为 `121711356` 字节，
SHA-256 `925758d7c00fb8404cb544a94b933c14a1075265656099e6353ed146e117f10f`。

本机 manager 已静默升级到 0.2.9，Remote 从 0.2.30 升级到 0.2.31；本地与
`codexwin` 的 `/version.json` 均为 `0.2.31`，构建标识
`assets/index-DP0yhQII.js`，`/health` 为 ready / desktop。静态边缘 Worker
版本为 `0fca1603-565d-4a45-a233-1e971391ab50`。服务与隧道继续由隐藏
`wscript` 包装器运行 `ProgramData` 下 `node-22.19.0-127.exe`，未弹出命令行窗口。

0.2.30 曾在真实 0.2.29 升级中暴露旧停服脚本不识别版本化 Node 的兼容问题；
事务安全回滚后，0.2.31 通过 manager 0.2.9 的随包停止助手修复升级路径。
0.2.30 仍保留为历史正式版本，但不再是最新版本。

2026-11-10 已完成 Remote **0.2.29** / manager **0.2.7** 的分发与
`codexwin` 部署收尾。正式标签为 `v0.2.29`，发布提交
`4e32e5c7710230fc62a09d2f38cc8ca0a54c2074`。
Runtime Packages `42759896664`、Desktop Manager `42759896184` 和
`main` CI `42759828842` 全部通过。

下载 Worker `cd20471a-3e91-4f64-8ec0-af57bc07a63d` 已刷新七附件快照，
`/releases/latest` 对 GitHub `Accept` 请求返回 `v0.2.29`。七个附件的
公网 HEAD 请求全部返回 `200`，大小与 Release 元数据一致；Windows manager
0.2.7 安装包完整下载为 `121709945` 字节，SHA-256
`15849a70a9415a1bf143e05c383ea3a71f9de8c3c5c10df10e2f02faf6eb35e1`。

本机 manager 已静默升级到 0.2.7，Remote 通过预构建运行包升级到 0.2.29；
本地与 `codexwin` 的 `/version.json` 均为 `0.2.29`，构建标识
`assets/index-D1_M0Otf.js`，`/health` 为 ready / desktop。静态边缘 Worker
版本为 `e27d31f2-cecf-4825-a852-e9ab9c2a9180`。服务与隧道均由隐藏
`wscript` 包装器运行 `C:\ProgramData\CodexRemoteNode\node.exe`，
未弹出命令行窗口。

0.2.28 的发送/引导即时呈现、轮次状态单向推进和待处理区优先级继续保留。
下载分发、GitHub Release、静态边缘、本机安装与真机验收仍分别记录，
不能相互替代。`codexmacos` 站点本轮未完成版本/健康确认。
历史版本的下载速度、节点和失败调查保留在 Git 历史及对应版本证据中，
不作为当前网络或当前安装状态的保证。

Worker 仅支持 `GET`／`HEAD`，固定上游仓库为 `CoralFlower325/Codex-remote`：
只放行最新正式版元数据，以及 Windows x64／Apple Silicon 运行包和管理器附件名。
不是任意 URL 代理；不支持客户端指定目标、查询参数、其他仓库或私有 API。
官方附件重定向仅允许该仓库 ID 下的 GitHub release-assets HTTPS 路径，
不在日志中记录带签名参数的 CDN 地址。

公开元数据通过校验和大小限制后缓存 60 秒；缓存命中响应也保持
`Cache-Control: public, max-age=60`。Worker 额外检查内部存储时间，
忽略超过 60 秒、缺少时间或时间无效的旧缓存；内部时间戳不会返回客户端。
2026-11-01 公网先取得缓存命中，再间隔超过 116 秒确认重新取源，
避免平台缓存把较旧元数据继续保留数小时。
匿名上游限流或不可用时，可使用部署时携带的公开正式发布快照。附件直接流式转发，
响应为 `Cache-Control: no-store`，不落入公共应用缓存或 Worker 附件缓存。
允许校验后的单段 Range 请求；不传递客户端凭据。
部署账号使用维护者自己的 Cloudflare CLI 登录，更新客户端无需该权限。

仓库没有此 Worker 的 Wrangler 配置，使用 `cf`：

```powershell
node scripts/refresh-distribution-release.mjs
$env:REMOTE_DOWNLOAD_HOST = "downloads.73916482.xyz"
$env:REMOTE_DOWNLOAD_ZONE = "73916482.xyz"
node scripts/prepare-distribution.mjs
Push-Location distribution
cf deploy --prebuilt
Pop-Location
```

先在正式 Release 的附件上传齐全后运行刷新命令。刷新脚本固定读取本仓库的
`gh api` 最新正式发布，检查双平台共四个运行包附件及其大小和 SHA-256 字段，
写入忽略的 `distribution/.cloudflare/release-snapshot.json`。
这是维护者的发布操作，不把本机 `gh` 凭据放进快照或 Worker；
管理器版本变化时还需另行核对三个新安装包已正式上传；无变更时保留原 Release 的包。
准备脚本默认读取该快照，也可通过 `REMOTE_DOWNLOAD_METADATA` 指向已核对的
官方公开发布元数据文件；不能使用草稿、其他仓库数据或手工编造摘要。

准备脚本将公共 `worker.mjs` 和校验后的公开快照写入
`distribution/.cloudflare/output`，
生成 `codex-remote-downloads` Worker 的预构建配置和指定域名路由；
不要把 Remote 的 `.env`、`data/`、会话、认证或任何私有凭据加入产物。
修改放行路径时同步检查 `desktop/release-source.mjs`、Worker 和对应测试，
保持客户端校验与上游来源约束，禁止为方便下载放开任意目标地址。
发布维护还需核对 Release 版本、管理器版本、两个平台附件及摘要，
并分别验证分发路径与官方备用。真实设备、代理关闭后的用户网络与已登录 Mac
集成仍需单独记录，不以合成测试替代。

匿名 API 限流时，使用发布方已核对的公开 Release 元数据快照作为 Worker 后备，
不添加 GitHub token。快照仅进入忽略的构建输出，不包含私有配置或客户端凭据；
必须等正式附件及摘要全部齐全后刷新，再准备和部署分发产物。
每次发布都要重新执行上述刷新、准备和部署顺序；仅重新部署旧输出不能更新快照。
仅维护文档不改写已发布标签。
