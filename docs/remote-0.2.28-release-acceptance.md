# Remote 0.2.28 发布与部署验收

日期：2026-11-10。组件：Remote **0.2.28** / manager **0.2.6**。

## 发布身份

- GitHub Release：`v0.2.28`，正式、非预发布。
- 源码签发标签：`e9a3417c2d06306655437f823b7cb1b2cf087307`。
- 当前 `main` 后续合并的运行时查询修复为 `e22a923883f493bb72b09568eb345b0bbf5be8c7`。
- Release 共 7 个附件：Windows/macOS Remote 运行包各 1 个归档和 1 个清单，
  Windows x64、macOS arm64 DMG/ZIP 管理器安装包共 3 个。
- Runtime Packages `42663449220`、Desktop Manager `42663449323`、`main` CI
  `42668536324` 均通过。

## 下载分发

- `downloads.73916482.xyz/releases/latest` 在 GitHub `Accept` 请求下返回
  `v0.2.28`；部署后的 Worker 版本为
  `044b4962-becc-489b-a0a8-c70deab4277c`。
- 刷新后的公开快照时间为 `2026-11-10T04:28:09.221Z`。
- 七个分发附件的 HEAD 请求全部返回 `200`，`Content-Length` 与 Release 元数据一致。
- Windows 管理器安装包完整下载校验：
  `121709707` 字节，SHA-256
  `9e8a1d9ca6b13d60f66df8d415240ed582689a66c506f81e5ae72810e2bfc2ba`。

## 公网与安装

- `codexwin.73916482.xyz` 静态边缘 Worker 版本为
  `f7f5b88c-6874-45a8-b8b5-d0d84fea75ef`。
- 公网 `/version.json` 返回 `0.2.28`，构建标识为
  `assets/index-ColwNQ7W.js`；`/health` 返回 `ready / desktop`。
- 本机安装目录为 `F:\AAAAcodexremote\codex-remote-0.2.26`，目录名是历史标签，
  安装内容已由预构建运行包更新为 `0.2.28`。更新前的备份保存在该目录的
  `output/manager-backup-*`。
- 本机 `/version.json`、`/health` 与公网版本/健康一致。
- manager 0.2.6 安装在 `C:\Program Files\Codex Remote Manager`，已选中当前安装目录；
  `CodexRemote`、`CodexRemoteTunnel` 均为 Running，使用
  `C:\ProgramData\CodexRemoteNode\node.exe`。

## 保留边界

- iPhone Safari/主屏和已登录 macOS 桌面集成仍需真机验收。
- `codexmacos.73916482.xyz` 本轮未能完成版本/健康确认，不作为已部署依据。
- 管理器自更新、macOS 应用签名/公证仍处于暂停断点。
- 真机、外部代理切换和云端下载节点长期速度不由本轮合成测试替代。
