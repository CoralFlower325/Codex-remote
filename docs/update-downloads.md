# 更新下载与分发

从 Remote 0.2.10 与正式管理器 0.2.1 起，更新优先通过项目自有的
`https://downloads.73916482.xyz` 读取公开版本信息及下载官方附件，
失败后尝试官方 GitHub。分发由项目的 Cloudflare Worker 提供，不要求更新主机配置
Cloudflare 凭据，也不代理聊天、认证、终端或其他私有内容。

## 安装管理器 0.2.3

| 系统 | 项目分发 | 官方备用 |
| --- | --- | --- |
| macOS Apple Silicon | [DMG](https://downloads.73916482.xyz/releases/download/v0.2.17/Codex-Remote-Manager-0.2.3-mac-arm64.dmg) · [ZIP](https://downloads.73916482.xyz/releases/download/v0.2.17/Codex-Remote-Manager-0.2.3-mac-arm64.zip) | [DMG](https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.17/Codex-Remote-Manager-0.2.3-mac-arm64.dmg) · [ZIP](https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.17/Codex-Remote-Manager-0.2.3-mac-arm64.zip) |
| Windows x64 | [安装程序](https://downloads.73916482.xyz/releases/download/v0.2.17/Codex-Remote-Manager-0.2.3-win-x64.exe) | [安装程序](https://github.com/CoralFlower325/Codex-remote/releases/download/v0.2.17/Codex-Remote-Manager-0.2.3-win-x64.exe) |

1. 从菜单栏／托盘菜单退出旧管理器。退出管理器不停止 Remote。
2. 下载并安装 0.2.3，覆盖旧应用。macOS 将新应用替换到原应用位置。
3. 重新打开管理器，确认显示 0.2.3，选择原 Remote 安装目录。
4. 有中断事务时先恢复；否则重新检查并执行主机更新。保留事务记录和备份，
   不要为重试删除本机数据、文档或更新锁。

主机 Remote 的更新不会替换已安装管理器 `app.asar` 中的更新器。
旧管理器仅检查 Remote 新版本也不能获得新下载逻辑。
管理器与 Remote 独立计版。管理器自更新仍暂停在 `archive/manager-0.2.0AU`，
本次不恢复 AU 功能；签名、公证和真实 Mac 登录环境验收仍是独立断点。
未签名安装包可能需要按系统下载信誉或 Gatekeeper 流程确认。

Remote 0.2.18 未修改管理器，继续使用 v0.2.17 的 0.2.3 安装包。

English: install manager 0.2.3 manually over the old app, reopen it and select the same
Remote directory before retrying. Host updates cannot patch the old manager's
bundled updater. Manager self-update, signing and notarization remain paused.

## 下载协议与校验

- 最新正式版元数据：`https://downloads.73916482.xyz/releases/latest`。
  官方备用为 GitHub 仓库的 `releases/latest` API；每个来源限时 15 秒。
  2026-11-01 的公网检查确认 Cloudflare 出口的匿名 GitHub API 返回 HTTP 403、
  `RateLimitRemaining=0`。分发域名可达不代表该上游未限流；客户端官方备用也可能
  受所在出口限制。2026-11-02 在正式附件齐全后已刷新并部署 `v0.2.16` 公开快照，
  生成于 `2026-11-02T02:41:55.782Z`；公网实际返回 HTTP 200、版本 `v0.2.16`、
  四个运行附件及三个管理器 0.2.2 安装包。上游限流时使用已校验的公开快照，
  保留上游状态诊断。未显式配置 HTTP 代理的 Agent 探测
  不证明系统 TUN、VPN 或透明代理已关闭，也不代表用户 Mac 的网络验收。
- 附件地址保持 `/releases/download/v<Remote版本>/<附件名>`。运行包清单、归档和
  管理器安装包均使用公开 Release 附件；管理器自身版本可与标签中的 Remote 版本不同。
- 附件每次下载等待响应头最多 30 秒、连续无数据最多 60 秒、整个下载最多 600 秒。
  切换到备用来源后仍需重新完成该次下载，不能把不完整文件当成成功结果。
- 来源切换不降低校验。运行包清单和归档需要官方 Release 的大小与 SHA-256，
  解压前检查路径、链接、重复条目和大小，解压后逐文件校验，再检查原生终端。
  缺少校验值或清单／归档不成对时停止，不绕过保护继续安装。
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

2026-11-01 对 0.2.11 的分发验证中，四个运行附件均完成整文件大小和 SHA-256
校验，双平台清单源码为本标签提交 `bb9aa39f0b4bc462a64576f6bcead0f301263419`。
Apple Silicon 归档 6,821,263 字节耗时约 7 秒，Windows 归档 8,745,893 字节
耗时约 11 秒；两次连接均为 HTTP/2、SJC 节点，六项访问边界检查通过。
这是该次 Agent 请求的结果，不代表所有时段、地区或 Electron 更新下载的速度。

此前 0.2.10 的分发验证中，两个平台的 JSON 清单完成整文件大小、SHA-256、
版本和源码提交校验；Windows 运行归档通过 HTTP/2 完整下载及官方摘要校验，
8,739,271 字节耗时约 13 秒。Apple Silicon 运行归档通过七段 Range 重组，
6,813,152 字节的完整摘要与官方一致；这只验证服务附件内容，不代表客户端的
单次整文件下载已经通过。Mac 归档的 HTTP/1 与 HTTP/2 整文件探测均在 600 秒
超时，其中 HTTP/2 收到 5,467,724／6,813,152 字节。不同请求经过 LHR、SJC
节点，不能只依据协议归因速度差异；当前仍需实际设备网络下的整包下载验收。
三种管理器安装包均已核对 HEAD 大小和 16 字节 Range 总大小，Windows Range
首次连接失败后一次重试通过。Mac DMG 另以 HTTP/2 完成 121,337,983 字节的整包
下载及官方 SHA-256 校验，LHR 节点耗时约 132 秒；ZIP 和 EXE 的镜像检查仍限于
HEAD 和 Range，没有以局部读取代替整包摘要验证。

下载准备失败不会停止旧服务。安装／验证失败沿用事务回滚，恢复旧依赖及原运行状态。
这里的分发不替换已有的恢复协议，也不为主机提供远程服务修复权限。
详见[管理器](desktop-manager.zh-CN.md)与[网页后端更新](web-backend-update.md)。

## 维护分发服务

2026-11-02 后续批次已发布 Remote 0.2.17／管理器 0.2.3，并刷新七附件公开快照。
分发 Worker 版本为 `60686ca8-96e7-4326-9093-0f7e8680fdee`；
三个管理器安装包和两个运行归档经现有系统代理完整下载，大小及 SHA-256
与正式发布一致。直连 TLS 曾超时，不能将这次验证描述为免代理或关闭 TUN 的实测通过。

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
2026-11-02 已核对公网返回的 0.2.16 元数据，包含四个运行附件及三个管理器
0.2.2 安装包的公开大小与摘要。正式源码为标签提交
`61737a64b2c20bc450e91f500718006be31f3cbc`；三平台 CI、双平台运行包安装／回滚
及双平台管理器源码／打包 smoke 均通过。仅维护文档不改写已发布标签。
