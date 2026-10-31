# Documentation / 文档

[Desktop Manager](desktop-manager.md) / [本机管理器](desktop-manager.zh-CN.md)

[English overview](../README.md) · [中文首页](../README.zh-CN.md)

[Desktop manager acceptance](desktop-manager-acceptance.md): Windows x64 and macOS Apple Silicon.

The overview introduces the product. The guides describe current supported
behavior and limits; dated acceptance and investigation records describe their
original verification scope. A deployment's private acceptance record remains
the authority for what is actually installed.

首页介绍产品；使用指南说明现役行为与限制。带日期、版本的验收及排查记录只代表当时的验证范围，实际安装状态以对应部署的私有验收记录为准。

## Use And Operate / 使用与运维

| Topic / 主题 | English | 简体中文 |
| --- | --- | --- |
| Full guide / 完整指南 | [User guide](guide.md) | [使用指南](guide.zh-CN.md) |
| Setup / 安装 | [Quick start](guide.md#quick-start) | [快速开始](guide.zh-CN.md#快速开始) |
| Configuration / 配置 | [Environment](guide.md#configuration) | [环境配置](guide.zh-CN.md#配置) |
| Hosting / 公网访问 | [HTTPS access](guide.md#public-access) | [HTTPS 访问](guide.zh-CN.md#公网访问) |
| Models and permissions / 模型与权限 | [Native state](guide.md#models-permissions-and-state) | [原生状态](guide.zh-CN.md#模型权限与状态) |
| Notifications / 设备通知 | [Web Push](guide.md#device-notifications) | [Web Push](guide.zh-CN.md#设备通知) |
| Networks and recovery / 网络与恢复 | [Loading and networks](guide.md#loading-and-mobile-networks) | [加载与手机网络](guide.zh-CN.md#加载与手机网络) |
| Troubleshooting / 排障 | [Troubleshooting](guide.md#troubleshooting) | [常见问题](guide.zh-CN.md#常见问题) |

## Maintain / 维护

- [Contributing / 贡献指南](../CONTRIBUTING.md)
- [Code organization / 代码分层与维护边界](code-organization.md)
- [Maintainer handoff and release procedure / 开发交接与发布流程](maintainer-handoff.md)
- [0.2.0AU 暂停开发与签名断点](manager-self-update-checkpoints.md)
- [Agent rules / 开发约束](../AGENTS.md)
- [Product principles / 产品原则](../PRODUCT.md)
- [Security / 安全](../SECURITY.md)
- [GitHub Releases / 版本记录](https://github.com/CoralFlower325/Codex-remote/releases)

## Design And Behavior / 设计与机制

- [Native summary panel / 原生会话摘要](native-summary-panel.md)
- [Native runtime errors / 原生运行错误](native-runtime-errors.md)
- [原生聊天顺序与晚到事件](native-history-order.md)
- [Manual updates and recovery / 手动更新与恢复](manual-version-update.md)
- [网页检查后端版本、远程更新与进度](web-backend-update.md)
- [Native questions and history payloads / 原生提问与历史传输](history-questions-investigation.md)
- [Question visibility / 提问显示](question-visibility-investigation.md)
- [Conversation dock navigation / 回合导航](dock-navigation-investigation.md)
- [Mobile sidebar gestures / 手机侧栏手势](mobile-sidebar-swipe.md)
- [Sidebar animation and dialog focus / 侧栏动画与弹窗焦点](sidebar-animation-dialog-investigation.md)

## Acceptance And Reviews / 验收与审查

These are historical evidence, not blanket claims of current device acceptance.
Physical iPhone and signed-in macOS acceptance remain pending.

以下记录保留原始验收范围，不代表已完成所有现役设备验收。真实 iPhone 与已登录 macOS 的验收仍待完成。

| Evidence / 记录 | Scope / 范围 |
| --- | --- |
| [代码整理](refactor-acceptance.md) | v0.1.16 基线、独立差分与桌面/手机界面对照 |
| [Startup](startup-acceptance.md) | Shell, authentication, tasks, chat and connection phases / 启动各阶段 |
| [History](history-loading-acceptance.md) | Paging, anchors and side chats / 历史分页、阅读锚点与侧聊 |
| [Previews](session-preview-acceptance.md) | Isolation, attachments and rendering limits / 预览隔离、附件与渲染限制 |
| [输入草稿与布局](composer-layout-acceptance.md) | 0.2.5 会话草稿、图片预览、末条间距与历史锚点回归 |
| [Subagents](subagent-acceptance.md) | Discovery, history and safe viewer close / 发现、历史与关闭行为 |
| [PR #3 · 0.1.5](pr-3-review.md) | Updates, phone controls and gestures / 更新、手机控件与手势 |
| [PR #4 · 0.1.6](pr-4-review.md) | Sidebar and desktop/mobile sizing / 侧栏与双端尺寸 |
| [PR #5 · 0.1.7](pr-5-review.md) | Phone outline and animation / 手机回合列表与动画 |
| [PR #6 · 0.1.9](pr-6-review.md) | Questions, pending badges and notifications / 提问、待答标识与通知 |

## README Layout References / 首页排版参考

Reviewed the official READMEs on **2026-10-30**:

| Project | Applied here / 采用方式 |
| --- | --- |
| [uv](https://github.com/astral-sh/uv) | A short product definition, focused highlights and clear installation paths / 简短定位、能力摘要和清楚的安装路径 |
| [Open WebUI](https://github.com/open-webui/open-webui) | Show the real product early and link to deeper documentation / 提前展示实际界面，引导至详细文档 |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | Screenshot-first introduction and separate update/hosting guidance / 截图优先，更新与托管独立成章 |

Only information structure was adapted. No third-party text, media, branding or
code was copied. The overview's desktop and phone screenshots were captured from
the 0.1.9 frontend using a synthetic, isolated fixture with no Desktop connection.
Older detail screenshots remain illustrations and do not document every latest control.
