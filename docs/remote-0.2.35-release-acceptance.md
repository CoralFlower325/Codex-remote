# Remote 0.2.35 发布与部署验收

日期：2026-11-11。组件：Remote **0.2.35** / manager **0.2.9**。

## 会话时间线虚拟化

- 时间线改为按 section 使用 `@tanstack/react-virtual`，只挂载视口及约 1.5
  视口预取范围内的行；短页面使用合成尾部空间，避免总高度小于浏览器可滚动
  范围时截断向上补页。
- 历史保留窗口从 800 条提高到 5,000 条，窗口、控制器和裁剪逻辑共用同一
  上限；在已加载范围内回到最新端不会重复读取历史页。
- 向上补页先按虚拟索引找回保留行，再按真实 `.timeline-row` 的 DOM 位置和
  流内偏移恢复。八组桌面、平板和手机视口验收的锚点漂移均为 `0px`，最大
  同时挂载用户行数为 18。
- 同一 section 内的活动展开、图片落位等高度变化使用行内补偿，不推动正在
  阅读的块。用户向下滚动或主动拖拽时取消自动恢复；`?virt=0` 保留全量渲染
  应急回退。
- Windows 测试并发限制为 4 个 worker，测试和清理钩子上限提高到 20 秒。
  这修复了合并后 Windows CI 在 139 个测试文件并发运行时，文件系统更新事务
  超过 Vitest 默认 5 秒上限的平台性误报。

## 源码与发布

- 正式标签 `v0.2.35` 指向最终合并提交
  `597579945ad3f10ce31b56a3ac2c48d5675e1cf2`，为非草稿、非预发布版本。
- PR #26 CI `42931328266`、0.2.35 门禁修复 PR #27 CI `42933122851` 和最终
  main CI `42933985604` 均通过 macOS、Windows、Ubuntu 验证及合成浏览器验收。
- Runtime Packages `42934907008` 在 Windows x64 与 macOS Apple Silicon 完成
  签名运行包构建、解包校验和正式附件上传。Desktop Manager `42934907041`
  的 plan 通过，管理器版本未变化，package job 按门禁跳过。
- 本地类型检查、完整测试和生产构建通过：139 个测试文件、1103 通过、2 跳过；
  前端构建标识为 `assets/index-9Agbdvm-.js`。
- Release 包含四个运行包/清单附件。Windows x64 运行包为 `11959519` 字节，
  SHA-256 `797ad79cc5fc59a4d68768ecdf683e9822b070f9604adbab18b79d17eaa9a102`；
  macOS Apple Silicon 运行包为 `10029609` 字节，SHA-256
  `df2210b80cf91d278bb9a60991fa4cc285cb952972f6d4ea2060563f1787e360`。

## 分发与边缘

- 下载 Worker 当前版本为 `584cad2d-fcd6-4d4b-b11c-68b19212818d`，已刷新为
  `v0.2.35` 四附件快照；`/releases/latest` 返回 `v0.2.35`。
- 四个运行包/清单的项目分发 HEAD 均为 `200`，公网大小与 Release 元数据
  逐项一致。
- `codexwin` 静态边缘已同步 0.2.35 前端，当前 Worker 版本为
  `77e027c7-48c7-48e6-a475-38a063371ed9`。

## 本机安装

- `F:\AAAAcodexremote\codex-remote-main` 已从 0.2.34 通过签名预构建运行包
  事务升级到 0.2.35，安装模式为 `runtime`，旧服务正常恢复为运行状态。
- 事务备份为
  `output\manager-backup-01739dc9-0c86-4362-a8ac-c85fbcaff3fa`。更新保留了
  本机定制的 `AGENTS.md`、`docs/maintainer-handoff.md`、
  `docs/release-organization.md`、`docs/release-signing.md` 和
  `docs/update-downloads.md`，新版副本保存在事务备份的 `incoming` 目录。
- 本地与公网 `/version.json` 均为 0.2.35，构建标识
  `assets/index-9Agbdvm-.js`；两端 `/health` 均为 `ready / desktop`，密码已配置。
- `CodexRemote` 与 `CodexRemoteTunnel` 计划任务保持运行。端口 4545 只有一个
  Remote 后端监听，隧道监督器 ready，未启动第二个 App Server，未停止 Desktop，
  也没有弹出命令行窗口。
- 安装管理器保持 0.2.9，无变更；管理器自更新、macOS 应用代码签名与公证继续
  暂停。

## 边界

- 虚拟化和锚点稳定性来自合成 5,000 条历史、真实浏览器滚动与八组视口验收；
  物理 iPhone Safari/主屏在 Wi-Fi 与 5G 下的连续手势仍需真机验收。
- 已登录 macOS Desktop 集成、登录持久化和隧道仍需真机验收。
- 本轮没有恢复管理器 AU 自更新，也没有改变 macOS 应用签名和公证断点。
