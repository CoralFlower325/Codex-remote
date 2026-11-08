# 0.2.22 对抗审查修复对账

日期：2026-11-08。审查基线为 `97d7130`，修复正式发布为 Remote **0.2.23**、
管理器 **0.2.4**。下方本地结果保留开发阶段的验证范围；正式发布与安装见后续记录。

## 逐项结果

| 原编号 | 结论和本批处理 | 实现及验证入口 |
| --- | --- | --- |
| 1 | 缺少发布者签名属实。运行包清单改为 Ed25519 签名，固定公钥校验；源码回退也要求签名版本身份且 HEAD 与签名 commit 一致。摘要仍用于逐文件完整性验证。缺签名禁止更新，不允许转未签名路径。 | `desktop/release-signature.mjs`、`update-prepare.mjs`、`scripts/package-runtime.mjs`；签名、运行包和更新测试 |
| 2 | 原密码下限和跨 IP 预算不足属实。新密码限 12–256 字符并拒绝明显弱口令，保留既有哈希验证；登录增加滚动全局失败预算。 | `auth.ts`、`request-security.ts`；密码兼容、预算和本机恢复槽测试 |
| 3 | 畸形 CDP/relay 帧可抛异常属实。增加 JSON 与结构校验，异常连接安全拆除并重连。报告“服务无人拉起”不准确，已有平台服务监督；本批不靠监督掩盖协议异常。 | `desktop-bridge.ts` 及异常帧、断连测试 |
| 4 | 未知发送结果可被人工重复提交属实。浏览器持久化意图 ID，主聊发送/引导/排队共用输入身份；服务端先落盘并 fsync 再派发，确认结果可重取，未知结果禁止重放。侧聊保留原方法、目标轮次与消息 ID。首页建聊后首发失败将草稿保留在新会话。 | `action-intents.ts`、`side-chat-actions.ts`、`action-ledger.ts`、`peer-hub.ts`；ledger、协议接入、草稿和浏览器用例 |
| 5 | 客户端缺少 Desktop 连接指引属实。未就绪时显示检查入口、操作说明和文档链接，提供重新检查；不自动退出或重启 Desktop。 | `Workspace.tsx`；连接故障合成验收 |
| 6 | 默认替用户选第一项属实。问题初始未作答，显式作答后才能提交，失败保留选择。 | `QuestionDock.tsx`、`ApprovalDock.tsx`；表单与真实 React 浏览器验收 |
| 7 | 订阅失败缺少就地恢复入口属实。独立显示会话恢复失败及重试，保留正文和草稿；恢复成功只清对应错误。 | `useRemote.ts`、`Workspace.tsx`；恢复失败/重试/清错验收 |
| 8 | 底部待处理区域可挤没正文属实。限制底部区域高度并允许滚动；窄屏控件重排。 | `styles/audit-followup.css`；八组视口审批/问题/输入框验收 |
| 9 | 排队/引导难发现且重置偏好属实。输入区常驻模式切换并保存选择，排队为空时也可切换。 | `Composer.tsx`、`Workspace.tsx`；模式与窄屏验收 |
| 10 | 原生计划编辑丢失可识别控件属实。使用既有 RRULE 解析器还原可识别预设、时间和星期；只改提示词保留原始计划。 | `automation-schedule.ts`、`Automations.tsx`；规则与 17:45 编辑验收 |
| 11 | 单错误槽、重连清错属实。改为最多八条有界错误记录；未知写入提示保留到核对，连接横幅按原生风格保留。原生错误正文不伪造、不丢弃。 | `error-notices.ts`、`useRemote.ts`、`Workspace.tsx`；并发错误与重试清错用例 |
| 12 | 队列派发错误不可见、恢复触发不足属实。错误显式上报；桥恢复后重新读取原生队列，使用原生 submission ID 消费，不重建已发送输入。 | `queue-dispatcher.ts`；失败、恢复和原生 ID 测试 |
| 13 | 审批并发窗口属实。服务端同步 claim，同一请求共享在途结果；前端同步 ref 阻止同 tick 连点。 | `desktop-bridge.ts`、`ApprovalDock.tsx`；跨客户端并发与重复点击测试 |
| 14 | 流式逐条验会话产生同步 I/O 属实。出站广播复用最长一秒的成功鉴权结果；入站操作仍即时严格校验。 | `session-connections.ts`；缓存有效期、撤销与访问失败测试 |
| 15 | RPC 响应等待过长且未知写入无提示属实。默认响应等待缩短到 30 秒；读操作允许调用方指定界限，写操作超时按未知结果处理，不以探活成功推断动作未执行。 | `desktop-bridge.ts`、action ledger；响应超时与未知结果测试 |
| 16 | 逐条挂鉴权存在维护风险属实；“全是单元测试”不准确，原有路由 HTTP 测试。增加 API 默认拒绝边界，只有精确公开例外，新增路由默认受保护，并以真实 HTTP 请求验证。 | `api-boundary.ts`、`api-boundary.test.ts`、`index.ts` |
| 17 | 明文 LAN 与 Public 防火墙配置问题属实。增加 LAN TLS；无证书必须明确同意 HTTP。旧配置没有同意时只关闭 LAN 入口，保留主入口。防火墙收紧为 Private/Domain 和 LocalSubnet。 | `config.ts`、`index.ts`、`enable-lan.mjs`；配置与命令构造测试，不修改本机防火墙 |
| 18 | 原 grant 可读整个目录且允许网络外带属实。限制为所选 HTML 与安全静态资源；词法和 realpath 两次校验，拒绝隐藏/配置/私有数据路径及目录链接绕过。脚本执行前注入 CSP，禁连接、外部资源、frame、worker、表单；保留安全本地 CSS/JS。 | `preview-security.ts`、`file-preview.ts`、`preview-rendering.ts`；HTTP、目录链接和真实 iframe 外带阻断验收 |
| 19 | README 版本漂移属实；多目标发布本身需要各自核验。同步候选版本并新增 `check:release`，校验 package、lock、README、说明、信任根和签名工作流，输出源码收据。收据不冒充发布/分发/安装结果。 | `scripts/check-release-readiness.mjs`；CI 纳入检查 |
| 20 | 间歇 PTY 崩溃有历史证据，但无 dump 不能声称上游根因已修。将每个原生 PTY 放入独立子进程，崩溃只结束对应终端并可见报错，不自动重开或重放。增加 IPC 背压和进程退出验收。 | `terminal-process.ts`、`terminal-worker.ts`；进程崩溃、真实 Windows shell 与编译产物 smoke |
| 21 | 验收入口不统一属实；“manager smoke 未进 CI”不准确，原已有部分平台检查。新增 `check:browser`、`check:windows-worker`，CI 运行浏览器矩阵与 Windows 更新 worker，并保留失败产物。 | `scripts/run-acceptance.mjs`、`.github/workflows/ci.yml` |
| 22 | hook 集中和自制 hook harness 的局限属实。抽出意图、历史窗口控制和错误记录模块；保留原有快速回归，并新增真实 React 浏览器场景覆盖恢复、表单、历史、模式和草稿。未声称完成整个 hook 的架构拆分。 | `history-window*.ts`、`action-intents.ts`、`error-notices.ts`、`check-audit-ui.mjs` |
| 23 | 刷新静默丢附件/技能属实。主草稿以 tab 级 sessionStorage 保留已上传 PDF 引用、技能和容量内 data URL 图片；每份 2 MiB、总计 4 MiB、24 小时。无法恢复的内容明确提示，注销/过期清理私有上下文。 | `composer-drafts.ts`；容量、过期、恢复及首发失败验收 |
| 24 | 未知审批直接展示全量 JSON 不友好属实。默认显示 Desktop 处理说明，详情折叠并限制显示长度，提供复制；不虚构未知审批的允许/拒绝协议。只带手机时，此类原生审批仍需 Desktop 处理。 | `ApprovalDock.tsx`；未知审批组件测试 |
| 25 | 无限累积历史属实；强制使用估计高度虚拟化会破坏现有锚点约束。改为最多 800 个原生 item 的双向窗口，优先保持完整轮次，超大轮次使用精确 item anchor；提供返回最新。 | `history-window*.ts`、`thread-history.ts`、`ThreadTimeline.tsx`；跨轮/超大轮分页和读位验收 |
| 26 | 全局快捷键占用浏览器默认行为属实。应用快捷键改用 Alt 组合，并排除输入框、终端与对话框。 | `Workspace.tsx`；浏览器默认快捷键与输入控件验收 |
| 27 | 无差别 status 重置 epoch 属实；“客户端必定整会话全量重拉”表述过度。现在仅实际从 ready 断开时失效一次；桥断开期间可能漏掉原生事件，仍需核对快照，不能复用日志假装无缺口。 | `index.ts`；桥状态转换与事件恢复测试 |
| 28 | 终端资源无界和共享活动会话问题属实。最多 32 个会话、每工作区 8 个、64 个工作区；达到上限明确拒绝。客户端保留所选会话，首个附着查看器控制共享尺寸，不静默杀 shell。 | `terminal-manager.ts`、`terminal-socket.ts`、`TerminalPanel.tsx`；上限、多客户端和重连测试 |
| 29 | 日志无轮转属实。服务、托管隧道和 console 使用每文件 5 MiB、三份备份的轮转；macOS 同 PID 包装入口捕获 JS 输出，launchd 原始 fd 指向 `/dev/null`。日志 I/O 失败不杀服务，恢复后记录丢失写入次数。 | `rotating-log.mjs`、`background-service.mjs`、平台后台入口；轮转、启动失败和存储失败测试 |
| 30 | PID 重用和单份事务损坏风险属实。锁记录 OS 进程启动身份；无法确认时保守阻断。事务双份带校验和与序号，单份损坏可恢复，两份都坏时保留现场并阻止覆盖。 | `update-transaction.mjs`；PID 复用、镜像恢复和损坏保留测试 |
| 31a | 密码 CLI 明文回显属实。改为隐藏输入并确认，非 TTY 不回显。 | `cli/password-prompt.ts`、`set-password.ts`；输入和取消测试 |
| 31b | 版本不一致时缺少恢复入口属实。错误与设置提供独立 `/update.html` 恢复入口。 | `App.tsx`、`Workspace.tsx`；更新恢复浏览器验收 |
| 31c | 原默认 30 天纯 bearer 的暴露窗口属实。默认改为七天且闲置 24 小时过期，不做会打断正常移动网络切换的 IP 强绑定；保留即时撤销。 | `auth.ts`、`session-store.ts`；过期与撤销测试 |
| 31d | 全局并发可挤占本人登录属实。跨来源限制外另留直连本机恢复槽，代理来源不能占用；这不承诺抵抗网络 DDoS。 | `request-security.ts`；并发占用与恢复槽测试 |
| 31e | `/health` 公开有限状态属实，作为既有 manager/公网诊断契约保留，未判为高危越权。它不返回会话、路径、用户名、日志或凭据。 | `index.ts`、API 边界测试；不要删字段制造旧管理器诊断回归 |
| 31f | import 阶段同步探测存在阻塞风险，原报告也未实测。移除配置加载时的二进制版本执行探针，仅解析候选路径。 | `config.ts`；配置及构建检查 |

## 验证方式

最终批次执行 `npm run typecheck`、`npm test`、Remote 与 manager 构建，
以及 release metadata、真实编译 PTY worker、隔离更新 worker、浏览器和
HTML 预览安全验收。浏览器使用合成数据与隔离接口，不连接真实 Desktop、
不创建真实模型轮次、不发送通知。

八组视口来自 `scripts/acceptance-viewports.json`。长历史场景检查窗口大小、
双向恢复、返回最新和分页读位；具体机器可重复执行
`npm run check:browser`，结果保存在 ignored `output/`，不上传真实聊天。
CI 配置已补齐，但本地通过不等于 GitHub CI 已运行。

本地最终结果：

- 127 个测试文件通过，1016 项通过、2 项平台跳过；typecheck、Remote 构建、
  manager 构建通过。目录 fsync 最后补修后已重新执行全量测试与服务端编译。
- 八组真实 React 浏览器场景通过：最多 800 item，12 次更早分页、五次向后恢复，
  分页和手指按住时实时新增消息的阅读锚点偏移均为 0px。
- 输入框、原审查后续和更新/恢复各八组视口通过；Windows manager source smoke、
  独立更新 worker 的安装与回滚通过。
- HTML 预览安全浏览器验收通过，未发生外带请求；Windows 缺少普通文件 symlink
  创建权限，该条浏览器回归明确记为未实测，POSIX CI 要求实际执行。
  Windows 目录 junction 的私有路径阻断已由服务端测试覆盖。
- 隔离 Windows x64 签名运行包通过：15,753 文件、71,865,404 字节，
  测试密钥验签、篡改拒绝、逐文件解包校验及真实编译 PTY worker 均通过。
  临时仓库和资产已清理，未使用正式私钥；该包验证早于最后的目录 fsync 补修，
  补修由随后全量测试与服务端编译覆盖，没有冒充最终正式发布包。

## 正式发布与安装

用户授权后，PR #14 合入 `348e457899172a91d1c6936b045082096794e74f`，
标签 `v0.2.23` 与该提交一致，Release 已发布并设为最新。
主分支 CI `42482630537`、双平台运行包 CI `42482760659` 和双平台管理器
CI `42482760660` 全部通过，包含打包后运行包、真实 PTY 和管理器启动检查。
后续收尾 PR #15 的首次 Windows CI 有两项安装/恢复测试触发默认 5 秒时限，
耗时约 5.2 秒；这两项改用既有事务恢复测试的 25 秒预算，行为断言和生产代码不变。
下一次 Windows CI 的草稿容量压力用例超时；夹具改用小草稿触发 30 条上限，
三份大图片触发 4 MiB 上限，补充数量与图片淘汰提示断言，避免重复序列化 35 份大图片。

七份官方附件均核对大小与 SHA-256；两个正式 manifest 通过固定公钥 Ed25519 验签，
完整源码树匹配标签，Windows 3073 个文件、macOS 3066 个文件逐项解包校验通过。
下载 Worker 已刷新本版快照；七份完整分发下载、HEAD、Range 和七项路由边界通过。
初次分发探测有 502，后续通过，失败证据保留，不据此承诺长期网络稳定。

经授权更新 Windows Remote 及公网前端至 0.2.23，管理器实际安装为 0.2.4。
本机与公网版本、shell、SW 及九项资产摘要一致，ready / desktop；
登录后任务与有界历史读取通过，匿名私有接口返回 401。
管理器原设置和目录保留，当前版本检查不刷新，最小化/关闭驻留通过。
Remote 更新仅重启自身；Desktop、Tunnel、国内中继和私有数据保留。
详细安装备份与进程收据维护在私有部署记录；不在公开仓库上传。

## 保留边界与人工验收

- 正式签名 CI secret、运行包生成与验签已完成，详见
  [发布签名运维](release-signing.md)。管理器 AU 自更新与 macOS 代码签名/公证继续暂停。
- 原生 PTY access violation 的上游根因仍待诊断，本批交付进程隔离和可见失败；
  不用“重跑变绿”关闭历史根因。
- iPhone Safari/主屏应用、已登录 macOS Desktop、真实原生审批、长时间弱网、
  LibreOffice 持续转换仍须真机验收。既有 [真机清单](review-followup-acceptance.md)
  继续适用，并补验：问题默认未答、多个审批时输入框可达、刷新恢复附件、
  长历史上滑与新消息并发、终端切标签和 shell `cd`、更新恢复入口。
- HTML 预览不支持任意 JSON fetch、CDN 或联网 demo。它不是操作系统沙箱，
  Office 转换也只应处理可信文件。
- 正式发布和 Windows 安装已完成；未启动第二 App Server，也未发送真实模型轮次、
  审批、归档或设备通知来测试。
