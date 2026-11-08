# Windows Desktop 调试端口自动发现

日期：2026-11-08。功能版本：Remote **0.2.24**，管理器 **0.2.4，无变更**。

## 问题

`--remote-debugging-port` 是 Codex/ChatGPT 启动参数，不是固定产品端口。
Codex++ 等启动器会在重新启动时选择不同端口，实测从 6333 变为 4952。
此前 Remote 只探测 `.env` 候选和 9229，必须手工跟随端口变化，Desktop
重启后容易进入 `transport: desktop`、`codex: offline`。

## 实现

- Windows 连接失败时，读取当前 `ChatGPT.exe` / `Codex.exe` 最高层进程的
  `--remote-debugging-port`，只保留可信安装路径下的进程。
- 显式拒绝 `0`、越界端口、渲染器子进程以及 `0.0.0.0` 等非回环调试地址。
- 自动发现的端口仍必须通过现有 `/json/list` 校验，找到
  `app://-/index.html` 主页面。
- CDP WebSocket 必须使用 `ws://127.0.0.1:<同一端口>/devtools/page/...`，
  防止页面返回其他主机或其他端口。
- 自动发现失败、超时或 PowerShell 输出异常时返回空候选；现有显式候选和
  9229 回退继续运行。Remote 不启动独立 App Server。
- PowerShell 使用系统固定路径、无窗口、3 秒超时和 256 KiB 输出上限。

## 验证

- 单元测试覆盖可信 WindowsApps 路径、动态端口、重复端口、最新进程优先、
  回环地址、非回环地址、渲染器子进程、异名进程、非法端口、损坏输出及
  非 Windows 不执行进程查询。
- DesktopBridge 测试覆盖固定端口失败后从自动发现端口连接，以及原有重连、
  审批、错误传播和不确定写入不重放行为。
- 本机只读实机验证：固定端口 `[1]` 失败后自动选择当前 Codex++ 进程的
  `4952`，找到 `app://-/index.html` 并成功建立 CDP 桥；随后关闭测试桥，
  未发送模型轮次、审批、归档或通知。

真机边界：仅验证 Windows 当前用户和本机安装；macOS 不做进程参数自动发现。
启动器未来若改用 `--remote-debugging-pipe` 或端口 `0`，本实现不会猜测端口，
Remote 会保持离线。Codex++ 的端口选择行为属于外部程序，不作为稳定契约。
