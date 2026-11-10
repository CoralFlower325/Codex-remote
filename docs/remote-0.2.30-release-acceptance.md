# Remote 0.2.30 发布与部署验收

日期：2026-11-10。组件：Remote **0.2.30** / manager **0.2.8**。

## 源码与界面验收

- `npm run typecheck`、`npm test`（138 个文件，1067 通过、2 跳过）和
  `npm run build` 通过。
- `scripts/check-composer-layout.mjs` 覆盖桌面、平板、402×874、874×402、
  390×844 与 320×568 等八组视口，验证 `+` 添加菜单、`/plan`、`/goal`、
  插件列表、内部滚动、44px 触控目标、单行工具栏和单主操作。
- 添加菜单包含文件与文件夹、目标、计划模式、绘图及当前目录插件；文件夹选择
  一次最多加入 20 个受支持文件。
- `/goal <目标内容>` 提交原生 thread goal mutation；任务运行中选择 `/plan`
  会保留命令并在当前轮次结束后应用。
- `npm run check:windows-worker` 的安装与回滚验收通过。

## 管理器验收

- manager 0.2.8 的源码构建与 Electron smoke 通过。
- Windows 服务控制、状态、修复和网页更新所有权检查统一识别
  `node-22.19.0-127.exe` 等受管运行时文件名，不再只接受 `node.exe`。
- Windows 状态读取先采用安装目录脚本报告的已运行/冲突结果；若它报告停止，
  再用管理器随包的新只读探针交叉核对。这样既兼容合成/外部服务，也避免旧脚本
  把健康的版本化 Node 进程覆盖成“端口被占用”。
- manager 0.2.8 已静默安装在 `C:\Program Files\Codex Remote Manager`；安装后的
  只读探针针对当前 Remote 0.2.29 返回：

```json
{"running":true,"enabled":true,"tunnelManaged":true,"conflict":false,"installed":true}
```

- 管理器界面实测显示 **运行正常**，Remote v0.2.29，本地服务、Desktop 同步、
  隧道和公网入口均正常，不再显示“端口被占用”。

## 发布与部署

- GitHub Release `v0.2.30` 为正式、非预发布；Runtime Packages
  `42774792639` 和 Desktop Manager `42774792343` 通过，七个附件齐全。
- 双平台运行包清单带 Ed25519 签名，签名源码提交为
  `c47dfc5597078fb7fb6a1d94b1089d11b5865ef6`。
- 下载分发 Worker `500568e1-eedd-41cc-ab4c-edb466a8ce32` 曾刷新并验证
  七附件；`codexwin` 静态边缘 `2dd807d2-abf0-4ecf-9ca7-884087ba8d47`
  部署成功，本机与公网构建标识均为 `assets/index-DwIpt2Ym.js`。
- 本机通过 manager 0.2.8 更新到 Remote 0.2.30，隐藏任务和 `ready / desktop`
  健康检查通过。

## 取代关系

- 0.2.30 在真实 0.2.29 升级过程中暴露了旧控制脚本无法可靠停止版本化 Node
  的兼容问题。事务安全回滚后，本机把控制脚本热替换为 0.2.30 版本并重试成功。
- 该问题由 Remote 0.2.31 / manager 0.2.9 提供通用停止兜底，0.2.30 不再是最新
  正式版。

iPhone Safari/主屏和已登录 macOS 仍属于真机验收，不以八组模拟视口代替。
