# 管理器自更新断点与恢复

本轮目标：Remote 保持 0.2.2，管理器独立升级为 0.2.3。
功能状态与实际验收分开记录；发布与本机安装结果以本页末尾的验收记录为准。

## 实现位置

| 模块 | 职责 |
| --- | --- |
| `desktop/manager-release.mjs` | 有界分页、独立管理器标签、平台附件、来源及摘要验证 |
| `desktop/manager-self-update.mjs` | 下载进度与取消、二次校验、程序与设置备份、持久化安装交接、重启确认 |
| `desktop/main.mjs` / `preload.cjs` | 可信本机 IPC、托盘入口、受控安装退出 |
| `desktop/renderer/ManagerUpdate.tsx` | 中文更新状态、摘要、真实下载百分比、确认安装与备份入口 |
| `.github/workflows/manager.yml` | Windows x64、Mac arm64 打包及更新清单上传 |
| `desktop/installer.nsh` | 直接启动已安装 EXE，保留 NSIS 标准用户权限启动流程 |

## 已知断点

首个 0.2.1 实机验收发现 ASAR 虚拟文件系统拦截程序备份，因而未完成安装；
该版本已标为预发布并保留标签。修正后通过 `original-fs` 复制与校验物理文件，
并将真实打包程序备份纳入 Windows/Mac 打包验收，不能只用普通 Node 的备份测试替代。

0.2.2 实机安装已替换程序，但安装器自动重开时无法解析开始菜单快捷方式。
0.2.3 改为直接启动已安装 EXE，不再依赖该快捷方式；旧发布及失败证据保留。

| 断点 | 当前处理 | 接续条件 |
| --- | --- | --- |
| 旧管理器无自更新代码 | 首次手动安装支持自更新的管理器 | 后续从 GUI 更新 |
| Mac 包无 Developer ID 签名、公证 | 可检查版本、下载安装包，阻止自动安装 | 配置签名与公证，使用同一身份签名的真实新旧包验证升级 |
| Windows 包未签名 | 校验 GitHub 摘要，使用 NSIS；系统信誉提示仍可能出现 | 配置正式 Windows 签名并验收 |
| 安装交接后进程已退出 | 下次启动按实际版本确认；不提前显示成功 | 新版确实启动，版本与目标一致 |
| 安装失败后的程序恢复 | 保留完整程序备份、设置和交接记录 | 手工重装旧版；自动回滚另行实现 |
| 网络下载中断 | 可以取消和重试，已有完整包交给更新库缓存校验 | 不承诺跨进程按字节续传 |
| 公网/Remote/隧道故障 | 本轮自更新不调用这些组件的启停 | 使用原有独立诊断流程 |
| 真实 Mac 桌面集成 | CI 仅证明构建和合成 Electron 行为 | 已登录 Apple Silicon 设备实测 |

## 恢复方法

管理器用户数据目录默认位于 Windows 的 `%APPDATA%/Codex Remote Manager`，
macOS 的 `~/Library/Application Support/Codex Remote Manager`，以 Electron 实际
`app.getPath('userData')` 为准。自定义启动参数可能改变目录。

1. 保留 `manager-self-update.json`、已下载安装包和 `manager-update-backups/<id>`。
2. 查记录里的目标版本，并在管理器中核实实际版本；未一致时不能当作更新成功。
3. 程序不能打开时，关闭残留管理器进程，通过原 Release 重新安装旧版。不要停止 Desktop
   或 Remote，也不要复制覆盖运行中的程序目录。
4. 备份的 `backup.json` 记录来源、版本和逐文件摘要，`application/` 保留程序，
   `settings.json` 保留安装前设置。只在需要时手工恢复设置，并先另存当前设置。
5. 记录损坏时先排查内容、权限和磁盘；不要用删除证据作为默认修复。

## 发布接续

管理器使用 `manager-v0.2.3` 标签，Release 中分别列出 Remote 0.2.2（无改动）
和管理器 0.2.3（本轮改动）。发布时必须使用 `--latest=false`，保留 Remote 的
`v0.2.2` 最新版入口。上传 Windows EXE、Mac arm64 DMG/ZIP 以及
`latest.yml`、`latest-mac.yml`。元数据和安装包均须有 GitHub SHA-256 摘要。

以后管理器发版时同时修改自身 package/lockfile 版本及打包 generic feed URL；
运行时会切换到所选的已验证精确标签地址。不改 Remote 版本、运行包或发布元数据。

## 本轮验收

2026-10-31，Windows 官方管理器 0.2.2 → 0.2.3 的真实安装与独立后验核对通过。
发布源码为 `c60deb7a187c01b1dd9d7871a9c71a03e3aa4554`；
精确源码三平台 CI `41191276998`、双平台管理器打包 `41191306506` 已通过。
五个正式附件的摘要及更新清单中的大小、SHA-512 已核对；实际使用的 Windows
安装包 SHA-256 与正式发布一致。此前的模拟状态、CI 和真实升级验收仍分别记录。

| 核对项 | 实际结果 |
| --- | --- |
| 安装交接 | 旧版退出后，由正式 NSIS 安装器自动重开主安装目录中的新版 EXE |
| 实际版本 | 已安装 ASAR 的 package.json 为 0.2.3；运行进程带 `--updated`，不带测试调试参数 |
| 完成记录 | 普通桌面用户数据目录中的记录为 `completed`；fromVersion 为 0.2.2，toVersion 与 observedVersion 均为 0.2.3 |
| 程序备份 | 保留旧版 0.2.2，80 项文件/链接均按备份清单逐项校验通过 |
| 设置与私有配置 | 管理器设置及受保护的配置、认证、会话和推送文件摘要与普通桌面升级前基线一致 |
| 运行服务 | Remote 与 Desktop 原监听进程均未替换；本机健康为 `ready / desktop` |

原验收脚本在安装退出时收到 `Render frame was disposed before the request completed`，
提前结束后续检查；本轮修正该退出判断，并对已自动重开的正式程序进行独立只读核对，
没有重装、重启 Remote/Desktop 或重启隧道。不能由这一条预期退出错误推断安装失败。

私有验收结果保留在忽略目录
`output/manager-self-update-acceptance/standard-final-verification.json` 和 `results.json`，
正式包及打包冒烟证据在 `output/release-manager-0.2.3/verification.json`。
这些本机记录含路径和进程信息，不提交公开仓库。此次仅补齐验收和文档，不递增版本。
本结论限于 Windows 本机本次升级，不代表 Mac 实机或所有 Windows 安装环境已通过。

Windows 验收必须保持启动环境一致。由 Windows Store 封装宿主启动的终端进程，
其 AppData 文件及安装注册表可能被虚拟化；同一文字路径不一定代表同一物理文件。
安装器经 Explorer 重开的是普通桌面进程。不能把封装宿主内写入的记录与普通桌面的
记录混为一份，否则会误报确认记录缺失，或根据另一份安装注册表选错目录。
应核实记录文件的物理路径、旧版实际版本及安装目录，再走正常桌面启动流程验收。

## macOS 签名接入

当前 Mac 包仍未完成 Developer ID 签名与公证，继续提供手动下载安装。
以下是接入步骤，尚未执行或计为验收通过；只维护 Apple Silicon arm64。

1. 以个人或组织身份加入 Apple Developer Program。官方年费为 99 美元，
   地区价格以实际注册页为准；本项目采用 Mac App Store 以外的 Developer ID 分发。
2. 在 Mac 生成证书请求，由账号持有人创建 `Developer ID Application` 证书，
   导入生成请求的 Mac 钥匙串，并将证书与对应私钥一起导出为带密码的 `.p12`。
   当前 DMG/ZIP 分发不需要为 PKG 单独申请 `Developer ID Installer`。
3. 为 Apple 账号启用双重认证，创建本项目专用的 App 专用密码，用于提交公证。
   不使用日常 Apple 账号密码。持续集成也可改用适当权限的 App Store Connect API key，
   但它不替代程序签名证书。
4. 将以下项目存入 GitHub Actions Secrets，由 macOS 签名任务注入。
   不写入仓库、文档示例、日志或聊天；证书文件与导出密码分开保存。

| Secret / 注入变量 | 内容 |
| --- | --- |
| `CSC_LINK` | `.p12` 的单行 Base64 |
| `CSC_KEY_PASSWORD` | `.p12` 导出密码 |
| `APPLE_ID` | 用于提交公证的 Apple 账号 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 本项目的 App 专用密码 |
| `APPLE_TEAM_ID` | 开发者团队标识 |

之后仍需修改 `.github/workflows/manager.yml` 和打包配置：将 Mac 签名任务与
Windows 未签名任务分开设置环境，移除 Mac 的禁用身份自动发现设置；为当前锁定的
electron-builder 26 配置强制签名、Hardened Runtime、所需最小 entitlements 和
`mac.notarize`。正式任务必须在签名、公证或票据校验失败时停止上传，不能静默降级为未签名包。
不照抄 electron-builder 27 的 `mac.sign` 配置到当前 26 版本。

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/Codex Remote Manager.app"
codesign -dv --verbose=4 "/Applications/Codex Remote Manager.app"
spctl --assess --verbose --type exec "/Applications/Codex Remote Manager.app"
xcrun stapler validate "/Applications/Codex Remote Manager.app"
```

检查实际 TeamIdentifier、Gatekeeper 的 `Notarized Developer ID` 结果和装订票据；
安装包与 ZIP 中的程序都应是已签名、公证后的最终产物，随后才生成和校验更新清单。
保持原 appId、包名及团队身份。旧未签名安装需先手动安装首个签名版到“应用程序”，
再用同一身份签名的更高版本验证检查、下载、替换、自动重开、完成记录和配置保留。
签名只是前提，两份真实签名版本的升级验收通过后，才可宣布 Mac 自更新完成。

官方参考：

- [Apple Developer Program 注册与费用](https://developer.apple.com/programs/enroll/)
- [创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [导出签名证书](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html)
- [Apple App 专用密码](https://support.apple.com/en-us/102654)
- [electron-builder 26 签名配置](https://www.electron.build/v26/docs/features/code-signing/)
- [electron-builder 26 公证配置](https://www.electron.build/v26/docs/features/code-signing/notarization/)

## 其他项目接续点

这些是现有功能的实现或验收边界，本轮不扩展功能范围：

| 接续点 | 当前边界 |
| --- | --- |
| 多电脑入口 | 管理器能发现多个本机目录；这不等于统一管理多台电脑或自动路由到不同主机 |
| 独立静态托管 | 更新本机服务不自动部署外部静态边缘资源，仍需同步对应版本的公开资源 |
| macOS 外部隧道 | 保持独立管理，GUI 不接管其 LaunchAgent；公网可达不等于隧道归属已确认 |
| Desktop 调试端口 | 普通启动不保证 9229 开放，仍需正确启动参数；不能通过启动竞争后端修复 |
| 原生目录分页 | 模型与项目列表目前只读首个请求页，不能宣称完整目录 |
| 原生历史信息 | 历史中未保留的瞬时重试状态、已丢失原图及重启前未观察到的提问无法凭空恢复 |
| 真实设备验收 | 登录后的 Mac Desktop、登录项、Gatekeeper，以及 iPhone 网络、键盘和推送显示仍需实机验证 |

国内服务器入口继续保留备案接续点，实际启用需核实备案批准并由操作者推进；
日常开发仍沿用现有 Cloudflare 入口。本轮未变更路由或国内网关快照。
