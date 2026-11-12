# Remote 0.2.39 发布与部署验收

日期：2026-11-12。组件：Remote **0.2.39** / manager **0.2.9**。

## PR #37 审查、修复与合并

- PR #37 最终 head 为 `6007599a46db2bd7eda21b71565f3c1444d5d87f`；
  复核确认历史缓存、后台预热、三页上滑预取、服务端 timings 覆盖及此前四项
  并发失效修复路径一致。
- 新增的确定性前插路径测试通过 5 轮；本机全量测试为
  `1179 passed / 2 skipped`，typecheck 与生产构建通过。
- Browser Acceptance 实际执行 `check-audit-ui`、`check-composer-layout`、
  `check-review-followup`、`check-preview-security`，最终 run
  `43166500897` 完整通过；此前一次 runner 抖动未计入通过。
- PR #37 合并提交为 `5d21a713fa8fe4b90447691965cb7842a5ccec99`。

发布准备阶段发现 Git index 中唯一一个 TypeScript 文件
`src/client/timeline-prepend.test.ts` 使用 CRLF，导致签名运行包的源码摘要
校验与 CRLF 规范化规则不一致。修复只改变换行和发布契约：

- 将该文件规范为 LF，新增 `*.ts`／`*.tsx` 的 LF 属性。
- `release-contract` 现将 TypeScript index 中的 CRLF 作为发布失败项。
- 修复提交为 `d872415b9d225e6254b2d54f6dff4cbed4d46866`，PR #39 合并提交为
  `80c82d576c47aadae08461310f4f212772c756ba`；本机验证 580 个 runtime source
  hash 全部与 HEAD 一致。

## 发布与 CI

- 正式标签 `v0.2.39` 指向 `80c82d576c47aadae08461310f4f212772c756ba`，
  Release 为非草稿、非预发布版本。
- main CI `43175971262` 通过 Windows、macOS、Ubuntu 和实际 Browser
  Acceptance；Desktop Manager `43176056991` 的 plan 通过，管理器未改版，
  package job 按门禁跳过。
- Runtime Packages `43176056957` 完成 Windows x64 与 macOS Apple Silicon
  签名运行包构建、解包、源码摘要与附件上传。macOS 首轮在解包后的 PTY
  检查处偶发失败，重跑失败 job `131043453041` 后完整成功；Windows job
  `131043455163` 完整成功，最终运行包 run 为 success。
- 四个正式附件均完成签名清单校验；Windows x64 归档为 `12036013` 字节，
  SHA-256 `a2ce524a48aef3b5cb5215009d3a9b894e30106203322b220883470a2e3ec7ab`；
  macOS Apple Silicon 归档为 `10107359` 字节，SHA-256
  `51ed0e76b1ec6734db352a58a38ae6d014bf6ca6bf787bc5cbf4db1492942d0f`。

## 历史加载实现

- 已完成历史页按 thread 与游标缓存，上限为 600 条目、48 MiB、16 个线程、
  30 分钟 TTL；回滚、压缩、归档、删除等改写事件使整线程失效。
- 打开会话后低优先级预热；前台读取优先。静止或不足一屏预取一页，上滑意图
  活跃时最多准备三页，预备页不投机插入，手势与惯性结束后保留原锚点逐页提交。
- timings 追赶由主机覆盖并随历史页返回，客户端只保留有界兜底；正常路径每页
  一次请求。
- 压缩并发、walking 淘汰、48 MiB 总预算和方向化预取 key 均有回归覆盖；
  历史缓存/prefetch 目标测试连续三轮 `27/27`。

## 分发与静态边缘

- 下载 Worker 已刷新为 `v0.2.39` 四附件快照，当前版本
  `101cd7f1-a113-4562-953d-e8a2b980a5dd`；`/releases/latest` 返回
  `v0.2.39`。
- 项目分发的四个附件 HEAD 均为 `200`，官方 GitHub 备用地址也均为 `200`；
  附件摘要与 Release 元数据一致。
- `codex-remote-static` 已部署同步 0.2.39 前端，Worker 版本为
  `46629ef4-cde1-41dc-83d6-9a9b76b53b0c`。

## 本机安装

- `F:\AAAAcodexremote\codex-remote-main` 已从 0.2.38 通过管理器相同的
  签名预构建运行包事务升级到 0.2.39，模式为 `runtime`，旧服务正常恢复为运行状态。
- 事务备份为
  `output\manager-backup-4314a272-0056-4951-a6af-276d98ea3fdf`；没有未完成的
  update journal。
- 本地与公网 `/version.json` 均为 `0.2.39`，构建标识均为
  `assets/index-CBVSN1lU.js`；本地与公网 `/health` 均为
  `ok / codex ready / transport desktop`，密码已配置。
- 端口 4545 只有一个 Remote 后端监听；服务与隧道由隐藏计划任务运行
  `node-22.19.0-127.exe`，未启动第二个 App Server，Desktop 保持运行，
  未弹出命令行窗口。
- 管理器保持 0.2.9，无变更；管理器自更新、macOS 应用代码签名与公证继续暂停。

## 边界

- 物理 iPhone Safari／主屏、真实 Wi-Fi/5G 切换和已登录 macOS Desktop
  仍需真机验收；本轮 Browser Acceptance 是合成浏览器与实际脚本断言，不替代
  物理设备记录。
- 历史缓存是进程内缓存，不持久化；冷启动后的第一轮预热收益需以实际设备网络
  和会话为准。
