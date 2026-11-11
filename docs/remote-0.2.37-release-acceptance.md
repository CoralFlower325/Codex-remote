# Remote 0.2.37 发布与部署验收

日期：2026-11-11。组件：Remote **0.2.37** / manager **0.2.9**。

## PR #30 审查与修复

- 审查初始提交 `3a69bb7` 的流式刷新、Markdown 增量切块、时间线检查点链、
  虚拟锚点与 active trace 窗口化。
- 发现 `historySettleRef` 只在滚动 idle 回调中失效。若历史提交后的同步恢复
  没有产生 scroll 事件，后续触摸可能继续走 virtual-core 的同步尺寸补偿，
  绕过本 PR 的手势期冻结。
- 在 `4f126cc` 修复：触摸接管显式优先于历史 settle；导航、回底、线程切换和
  静默结算都会清理该窗口；新增纯函数回归覆盖。
- PR #30 CI `42959538026` 在 Windows、macOS、Ubuntu 与浏览器验收全部通过后，
  合并为 `4a2fee5b3614df33da39ad3ac6d7afe0d40c62b8`。

## 源码与发布

- 版本准备 PR #31 的 CI `42961472952` 全部通过，合并提交为
  `78cbc862b257d20dd6747576317195c13a789820`。
- 正式标签 `v0.2.37` 指向该合并提交，为非草稿、非预发布版本。最终 main CI
  `42962195229` 通过三平台验证和合成浏览器验收。
- Runtime Packages `42962870805` 完成 Windows x64 与 macOS Apple Silicon
  签名运行包构建、解包校验和附件上传。Desktop Manager `42962870818`
  的 plan 通过，管理器版本未变化，package job 按门禁跳过。
- 本地全量测试为 143 个测试文件、1142 通过、2 跳过；类型检查和生产构建
  通过，前端构建标识为 `assets/index-CqXL-FeZ.js`。
- Release 四个运行包/清单通过固定公钥验签，签名提交与标签目标一致。
  Windows x64 运行包为 `11989028` 字节，SHA-256
  `deb967f3ff669302e2a696d5c2c6932be060010b12f9f0be58f37ed0a8d16f01`；
  macOS Apple Silicon 运行包为 `10061355` 字节，SHA-256
  `43bcd7a035c23cfcff866198c2502d60c39aae679dcb75f989d6ff82988ae21a`。

## 性能与浏览器验收

- 流式刷新按阅读状态分为 60ms 贴底、300ms 历史阅读、250ms 后台和
  100ms 受限网络档位。
- 同口径桌面 CPU 节流探针中，6 倍节流长任务的刷新从 19 次/1073ms 降至
  10–11 次/610ms；帧间隔超过 25ms 的占比从 13.5–15.5% 降至 4.8–5.6%。
- Markdown 尾部单步解析由 5.06ms 降至 0.196ms；时间线增量链在巨型轮次由
  3.10ms 降至 1.75ms，在 5,000 条多轮窗口由 7.66ms 降至 3.18ms。
- 浏览器五组验收全部通过：八视口历史锚点与虚拟化、输入栏布局、
  终端/多根目录/预览、Web 更新恢复及 HTML 预览安全。
- 八组桌面与手机视口最大挂载用户行 18，历史锚点漂移 `0px`。

## 分发与边缘

- 下载 Worker 当前版本为 `86911e8f-1ad4-4d73-9d40-dbb051f73ecf`，已刷新为
  `v0.2.37` 四附件快照；`/releases/latest` 返回 `v0.2.37`。
- 四个运行包/清单的项目分发 HEAD 均为 `200`，公网大小与 Release 元数据
  逐项一致。
- `codexwin` 静态边缘已同步 0.2.37 前端，当前 Worker 版本为
  `6f438c70-83b8-46b1-9a81-59fe5f38af9c`。

## 本机安装

- `F:\AAAAcodexremote\codex-remote-main` 已从 0.2.36 通过签名预构建运行包
  事务升级到 0.2.37，安装模式为 `runtime`，旧服务正常恢复为运行状态。
- 事务备份为
  `output\manager-backup-f646027c-e75e-4d90-819c-a8a485ad5dca`。更新保留了
  本机定制的 `docs/maintainer-handoff.md` 和 `docs/release-organization.md`；
  新版副本保存在事务备份的 `incoming` 目录。
- 本地与公网 `/version.json` 均为 0.2.37，构建标识
  `assets/index-CqXL-FeZ.js`；两端 `/health` 均为 `ready / desktop`，密码已配置。
- `CodexRemote` 与 `CodexRemoteTunnel` 计划任务保持运行。端口 4545 只有一个
  Remote 后端监听，未启动第二个 App Server，未停止 Desktop，也没有弹出
  命令行窗口。
- 安装管理器保持 0.2.9，无变更；管理器自更新、macOS 应用代码签名与公证继续
  暂停。

## 边界

- 性能数据来自桌面 CPU 节流模拟，不等于物理 iPhone 真机。
- 物理 iPhone Safari/主屏、已登录 macOS Desktop 集成、登录持久化、惯性打断
  和真实网络切换仍需真机验收。
- 本轮没有恢复管理器 AU 自更新，也没有改变 macOS 应用签名和公证断点。
