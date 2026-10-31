# 管理器自更新断点与恢复

本轮目标：Remote 保持 0.2.2，管理器独立升级为 0.2.2。
功能状态与实际验收分开记录；发布与本机安装结果以本页末尾的验收记录为准。

## 实现位置

| 模块 | 职责 |
| --- | --- |
| `desktop/manager-release.mjs` | 有界分页、独立管理器标签、平台附件、来源及摘要验证 |
| `desktop/manager-self-update.mjs` | 下载进度与取消、二次校验、程序与设置备份、持久化安装交接、重启确认 |
| `desktop/main.mjs` / `preload.cjs` | 可信本机 IPC、托盘入口、受控安装退出 |
| `desktop/renderer/ManagerUpdate.tsx` | 中文更新状态、摘要、真实下载百分比、确认安装与备份入口 |
| `.github/workflows/manager.yml` | Windows x64、Mac arm64 打包及更新清单上传 |

## 已知断点

首个 0.2.1 实机验收发现 ASAR 虚拟文件系统拦截程序备份，因而未完成安装；
该版本已标为预发布并保留标签。修正后通过 `original-fs` 复制与校验物理文件，
并将真实打包程序备份纳入 Windows/Mac 打包验收，不能只用普通 Node 的备份测试替代。

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

管理器使用 `manager-v0.2.2` 标签，Release 中分别列出 Remote 0.2.2（无改动）
和管理器 0.2.2（本轮改动）。发布时必须使用 `--latest=false`，保留 Remote 的
`v0.2.2` 最新版入口。上传 Windows EXE、Mac arm64 DMG/ZIP 以及
`latest.yml`、`latest-mac.yml`。元数据和安装包均须有 GitHub SHA-256 摘要。

以后管理器发版时同时修改自身 package/lockfile 版本及打包 generic feed URL；
运行时会切换到所选的已验证精确标签地址。不改 Remote 版本、运行包或发布元数据。

## 本轮验收

待最终精确源码 CI、发布附件校验和 Windows 安装交接验收后补齐。
目前不可将实现完成等同于跨平台自更新已经实机通过。
