# Windows / macOS Desktop 调试端口自动发现

日期：2026-11-08。功能版本：Remote **0.2.24-rc**，管理器 **0.2.4，无变更**。

## 问题

`--remote-debugging-port` 是 Codex/ChatGPT 启动参数，不是固定产品端口。
Codex++ 等启动器会在重新启动时选择不同端口，实测从 6333 变为 4952。
此前 Remote 只探测 `.env` 候选和 9229，必须手工跟随端口变化，Desktop
重启后容易进入 `transport: desktop`、`codex: offline`。

## 实现

- Windows 使用固定 PowerShell 路径读取当前 `ChatGPT.exe` / `Codex.exe` 最高层
  进程的 `--remote-debugging-port`，只保留可信 WindowsApps 或安装目录下的进程。
- macOS 使用固定 `/bin/ps` 读取当前 `/Applications` 或 `~/Applications` 下
  `ChatGPT.app` / `Codex.app` 主程序的完整启动参数，按进程启动时间优先排序。
- 显式拒绝 `0`、越界端口、渲染器子进程以及 `0.0.0.0` 等非回环调试地址。
- 自动发现的端口仍必须通过现有 `/json/list` 校验，找到
  `app://-/index.html` 主页面。
- CDP WebSocket 必须使用 `ws://127.0.0.1:<同一端口>/devtools/page/...`，
  防止页面返回其他主机或其他端口。
- 自动发现失败、超时或进程输出异常时返回空候选；现有显式候选和
  9229 回退继续运行。Remote 不启动独立 App Server。
- Windows 查询无窗口运行；两个平台均使用 3 秒超时和 256 KiB 输出上限。

## 验证

- 单元测试覆盖 WindowsApps 与 macOS Applications 可信路径、带空格主目录、
  动态端口、重复端口、最新进程优先、回环地址、非回环地址、渲染器子进程、
  异名进程、非法端口、损坏输出及不支持平台不执行进程查询。
- DesktopBridge 测试覆盖固定端口失败后从自动发现端口连接，以及原有重连、
  审批、错误传播和不确定写入不重放行为。
- 本机只读实机验证：固定端口 `[1]` 失败后自动选择当前 Codex++ 进程的
  `4952`，找到 `app://-/index.html` 并成功建立 CDP 桥；随后关闭测试桥，
  未发送模型轮次、审批、归档或通知。
- 正式发布 tag `v0.2.24`、提交
  `94077f48aad6f35d4e1e97d3566dea920726b101`；main CI `42491241874`、
  双平台运行包 CI `42491290265` 通过。四份运行包附件通过固定公钥验签和
  逐文件解包校验，下载 Worker `52592367-a379-4a89-aa4f-0dcc4f09d758`
  的四份完整镜像摘要通过。
- Windows 本机安装后直接从日志确认桥选择了 4952；本机与公网均为 0.2.24、
  ready / desktop，九项关键静态资源摘要一致。Remote 升级只重启自身，
  Desktop、Tunnel 和国内中继 PID 保持不变。
- macOS 本机只读实机验证：从当前 `/Applications/ChatGPT.app` 顶层进程解析出
  `9229`，确认 `/json/list` 返回 `app://-/index.html`，页面 WebSocket 仍为
  `ws://127.0.0.1:9229/devtools/page/...`；未发送模型轮次、审批、归档或通知。

启动器未来若改用 `--remote-debugging-pipe` 或端口 `0`，本实现不会猜测端口，
Remote 会保持离线。Codex++ 的端口选择行为属于外部程序，不作为稳定契约。
