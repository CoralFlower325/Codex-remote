<div align="center">

# Codex Remote

**在浏览器里，继续你的 Codex Desktop 工作。**

通过手机或另一台电脑继续会话、审阅变更，并回答原生提问。

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/CoralFlower325/Codex-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/CoralFlower325/Codex-remote/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/CoralFlower325/Codex-remote?color=24292f)](https://github.com/CoralFlower325/Codex-remote/releases) ![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-43853d) [![MIT](https://img.shields.io/badge/license-MIT-0969da)](LICENSE)

[快速开始](#快速开始) · [使用指南](docs/guide.zh-CN.md) · [文档索引](docs/README.md) · [版本记录](https://github.com/CoralFlower325/Codex-remote/releases)

</div>

![Codex Remote 桌面工作区，包含对话及 PR、输出和来源摘要](docs/images/workspace.png)

<p align="center"><sub>实际前端，虚构演示数据。桌面截图为 1440 × 900，手机为 390 × 844 CSS 像素。</sub></p>

## 同一个工作区，适应不同屏幕

Remote 连接 **Codex Desktop 自己的 App Server**，让浏览器与桌面共享会话和实时活动。手机使用独立的响应式布局，桌面面板可调整宽度，长历史按需加载，两端都保留适合自己的操作空间。

| 继续工作 | 检查结果 | 掌握操作 |
| --- | --- | --- |
| 共享会话、项目、原生模型、推理强度与技能 | 折叠执行记录、统一或并排 diff、文件及网页预览 | 会话级权限、受支持的审批和原生提问表单 |
| 主会话队列、引导、临时侧聊与子智能体查看 | 回合导航，以及汇集 PR、输出和来源的摘要面板 | 断线恢复不重放结果不确定的操作，按需开启 Web Push 和检查更新 |

<details>
<summary><strong>手机工作区与代码审阅</strong></summary>

<p align="center">
  <img src="docs/images/phone.png" alt="带紧凑输入框的手机工作区" width="240">
  <img src="docs/images/review.png" alt="包含行号和统一 diff 的文件变更审阅" width="300">
</p>

手机附件和回合索引控件采用 36px，桌面保留自己的控件尺寸。视口规则和设备验收边界见[布局指南](docs/guide.zh-CN.md#响应式布局)。

</details>

## 快速开始

需要 **Windows 10/11 或 macOS**、**Node.js 22.19+（含 npm）**，以及已安装并登录的 Codex Desktop。

### 1. 开启桌面同步

先保存工作并完全退出一次 Codex Desktop，再通过调试参数启动，将调试端口绑定到本机回环地址。

<details open>
<summary><strong>Windows · PowerShell</strong></summary>

Windows 商店安装版：

```powershell
$package = Get-AppxPackage -Name "*Codex*" | Select-Object -First 1
& (Join-Path $package.InstallLocation "app\Codex.exe") --remote-debugging-port=9229 --remote-debugging-address=127.0.0.1
```

其他安装方式请向实际的 `Codex.exe` 传入相同参数；安装包路径可能有所不同。

</details>

<details>
<summary><strong>macOS · 终端</strong></summary>

```bash
open -a Codex --args --remote-debugging-port=9229 --remote-debugging-address=127.0.0.1
```

</details>

**9229 端口必须保持私有**。[安装指南](docs/guide.zh-CN.md#2-开启桌面同步)提供调试页面的检查方法。

普通启动 Codex 不保证开启此端点，需使用上述参数启动，或使用已经配置这些参数的启动器。

### 2. 安装并启动

```bash
git clone https://github.com/CoralFlower325/Codex-remote.git
cd Codex-remote
```

根据主机系统执行安装命令，再启动 Remote：

| Windows | macOS |
| --- | --- |
| `npm run setup:windows` | `npm run setup:macos` |
| `npm start` | `npm start` |

安装会按锁文件安装依赖、构建应用，并要求设置访问密码。首次密码初始化仅接受主机上的请求。

打开 **http://127.0.0.1:4545** 并登录。共享桌面实时事件时，`/health` 应显示 `codex: ready` 和 `transport: desktop`。若为 `standalone`，则使用独立 App Server，不能共享桌面实时事件。

### 3. 从另一台设备访问

通过 **HTTPS 隧道或反向代理**公开受保护的网页入口。Windows Cloudflare 助手可配置固定域名；macOS 隧道有独立的安装要求。

[公网访问配置](docs/guide.zh-CN.md#公网访问) · [Windows 开关](docs/guide.zh-CN.md#windows-开启与关闭) · [macOS 开关](docs/guide.zh-CN.md#macos-开启与关闭)

安装完成后，主机上的 `Start Remote.cmd` / `Stop Remote.cmd` 或 `.command` 文件管理后台运行，Windows 无需常驻终端。关闭 Remote 会保留 Codex Desktop；Windows 开关也管理已配置的 Tunnel 任务，macOS 的独立隧道需单独管理。

可选的[本机管理器](docs/desktop-manager.zh-CN.md)自动探测安装目录，提供启停、诊断修复、密码和设备管理与确认后的版本更新，
Windows 常驻右下通知区域，macOS 常驻顶部菜单栏。
更新显示中文步骤、百分比和耗时；标准安装优先使用校验后的预构建运行包，
源码定制安装保留隔离构建。管理器重启后可恢复中断的安装。
选择现有安装目录，关闭窗口后继续常驻。Release 提供未签名安装包；
macOS GUI 的实机验收仍待完成。

正式管理器保持 **0.2.0**，通过安装包升级，不含管理器自更新。
带自更新的 **0.2.0AU** 开发线独立保留，暂停正式发布；
签名、公证及恢复开发的条件见[断点记录](docs/manager-self-update-checkpoints.md)。

## 为持续工作的会话准备

Codex 原生运行错误会保留在对应轮次，展示已有的 HTTP 状态码和原生重试状态。
详见[运行时错误说明](docs/native-runtime-errors.md)。

- **阅读长会话**：历史有界分页，保留阅读位置，展开执行记录时才加载详细正文。
- **停止后编辑消息**：修改最新被停止轮次的原始消息，确认后保留附件和技能重新发送；替换对话记录，保留已执行的文件修改。
- **处理原生提问**：主会话和临时侧聊均需明确提交答案；待答标识反映已发现的问题，不是对未读历史的完整检索。
- **随手查看上下文**：待发送图片在输入框上方预览，切换会话保留各自草稿的图片与技能；在对话旁查看文件、PR 附件、输出与来源，摘要覆盖取决于原生资源元数据。
- **决定何时更新**：已是最新版时保留页面；真正更新前展示摘要并等待确认。主会话文字草稿保留，临时侧聊、待发图片和技能选择清除。
- **远程更新后端**：设置中检查当前连接的 Windows x64 或 Apple Silicon Remote，新版只显示版本号和更新按钮；映射更新进度，成功后自动刷新配套网页。详见[网页后端更新](docs/web-backend-update.md)。
- **接收设备通知**：按需开启任务结束、提问和审批 Web Push，载荷含标题及有限长度的答复或提问预览，可能显示在锁屏上。
- **打开主机终端**：Remote 独立管理的交互式 shell 以宿主用户身份运行，与 Desktop 终端分开，不受模型权限配置限制。

[完整使用指南](docs/guide.zh-CN.md) · [设备通知](docs/guide.zh-CN.md#设备通知) · [更新与恢复](docs/manual-version-update.md) · [摘要面板](docs/native-summary-panel.md)

## 支持范围与边界

| 范围 | 验证状态 |
| --- | --- |
| Windows | 已登录 Desktop 的实机验收 |
| macOS | 构建、测试、shell 语法与 LaunchAgent CI；登录后集成、登录自启及旧隧道仍待实机验收 |
| 手机浏览器 | Chromium / Windows WebKit 响应式检查；真实 iPhone Safari、主屏幕应用、键盘及 Wi-Fi/5G 验收待完成 |
| Linux | CI 构建与测试；桌面集成未验证 |

界面目前为**简体中文**。Desktop 内部接口可能随版本变化。部分审批表单、真实原生答案提交、实际听写和系统通知显示仍需专项实机验收。模型与项目目录目前只读取首次请求页，模型默认值可能与全局覆盖配置不同。

Remote 面向**可信操作者控制自己的电脑**。使用强密码与 HTTPS，保持 `.env`、`data/`、凭据、日志和调试端口私有。公共应用缓存不包含会话与 API；独立的已认证设备快照有容量和时效限制。公开主机入口前请阅读[安全说明](SECURITY.md)和[完整限制](docs/guide.zh-CN.md#已知限制)。

## 文档与参与贡献

| 需要了解 | 从这里开始 |
| --- | --- |
| 安装、配置和日常操作 | [中文指南](docs/guide.zh-CN.md) / [English guide](docs/guide.md) |
| 托管、手机网络与恢复 | [运行维护章节](docs/guide.zh-CN.md#加载与手机网络) |
| 验收证据与实现说明 | [文档索引](docs/README.md) |
| 开发与 Pull Request | [贡献指南](CONTRIBUTING.md) |
| 当前工作与发布流程 | [维护交接](docs/maintainer-handoff.md) |
| 版本历史 | [GitHub Releases](https://github.com/CoralFlower325/Codex-remote/releases) |

每个验证完成的功能批次发布对应版本的 GitHub Release，文档更新保持应用版本不变。

## 致谢与许可证

[MIT](LICENSE)。基于 [Bones-star588/codex-remote](https://github.com/Bones-star588/codex-remote)，工作区与审阅界面参考 [Bones-star588/codex-webui](https://github.com/Bones-star588/codex-webui)，版权 2026 lezi-fun。Windows 移植及本发行版由 [CoralFlower325](https://github.com/CoralFlower325) 维护。

使用 React、TypeScript、Vite、Express、WebSocket 和 Lucide。完整声明见[第三方声明](THIRD_PARTY_NOTICES.md)。

本项目由社区独立维护，与 OpenAI 无隶属或背书关系。Codex 及相关品牌属于 OpenAI；软件许可证不授予商标使用权。
