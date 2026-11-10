# Remote 0.2.29 发布与部署验收

日期：2026-11-10。组件：Remote **0.2.29** / manager **0.2.7**。

## 发布身份

- GitHub Release：`v0.2.29`，正式、非预发布。
- 源码标签：`4e32e5c7710230fc62a09d2f38cc8ca0a54c2074`。
- 本版是 0.2.28 的 Windows 运行态补丁，不改变聊天和界面功能。
- `main` CI `42759828842`、Runtime Packages `42759896664`、
  Desktop Manager `42759896184` 全部通过。
- Release 包含 7 个附件：双平台 Remote 运行包/清单和 manager 0.2.7
  Windows/macOS 安装包。

## 修复内容

- Windows 计划任务使用隐藏的 `wscript` 包装器启动 `ProgramData` 下的受管
  Node 22.19.x，避免直接启动 Node 后收到 `0xC000013A` 并退出。
- manager 0.2.7 的 Start/Stop/repair 会识别并迁移 0.2.28 的直接 Node 任务。
- 管理器更新锁查询进程身份时增加短暂重试，避免瞬时 Windows 进程查询失败
  被误判为更新占用。
- 正常操作由管理器控制隐藏计划任务，不打开命令行窗口。

## 分发与安装

- 下载 Worker 最新部署版本：
  `cd20471a-3e91-4f64-8ec0-af57bc07a63d`。
- 公开 `/releases/latest` 在 GitHub `Accept` 请求下返回 `v0.2.29`，共 7 个附件。
- manager 0.2.7 Windows 安装包为 `121709945` 字节，SHA-256
  `15849a70a9415a1bf143e05c383ea3a71f9de8c3c5c10df10e2f02faf6eb35e1`。
- manager 0.2.7 已静默安装，现有设置与 Remote 根目录保留。
- 本机 Remote 通过预构建运行包升级到 0.2.29，更新前版本保留在
  `output/manager-backup-*`。

## 运行态

- `codexwin` 静态边缘 Worker：`e27d31f2-cecf-4825-a852-e9ab9c2a9180`。
- 公网与本机 `/version.json` 均为 `0.2.29`，构建标识
  `assets/index-D1_M0Otf.js`。
- 公网与本机 `/health` 均为 `ready / desktop`。
- `CodexRemote`、`CodexRemoteTunnel` 均保持 Running，动作使用
  `wscript.exe -> ProgramData Node`，没有可见控制台。

## 保留边界

- iPhone Safari/主屏和已登录 macOS 桌面集成仍需真机验收。
- `codexmacos.73916482.xyz` 本轮未完成版本/健康确认。
- manager 自更新、macOS 签名/公证仍在暂停断点。
