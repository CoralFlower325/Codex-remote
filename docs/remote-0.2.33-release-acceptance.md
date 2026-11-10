# Remote 0.2.33 发布与部署验收

日期：2026-11-10。组件：Remote **0.2.33** / manager **0.2.9**。

## 历史加载修复

- 向下补页只在阅读位置真正接近当前窗口末端、且没有上滑意图时触发；
  滚轮和键盘操作先确认方向，再重新判断补页条件。
- 活动折叠后窗口可能短于旧的“两屏”阈值。新门禁不再让该条件在窗口顶部
  恒成立，避免向下补页反复把阅读位置拉回最新端。
- 被窗口较新边界截断的轮次不再用中间回复片段锚定工作时长；最终答案尚未
  加载时，时分隔线回退到原生轮次时长。

## 源码与发布

- 正式标签 `v0.2.33` 指向合并提交
  `b2e3d9ecc2ee6afbb6fcef87ff74de9334dc9e10`，为非草稿、非预发布版本。
- main CI `42808058587`、Runtime Packages `42808168637` 和 Desktop Manager
  `42808168788` 全部通过。管理器版本未变化，仍为 0.2.9。
- Release 包含 Windows x64 与 macOS Apple Silicon 两份运行包及对应签名清单。
  Windows x64 运行包为 `10274077` 字节，SHA-256
  `980ba78fd170e37a8ab27d3ea38999e792a10f5ec5b3e64bbb677e3aa5ea8b5b`。
- 本机针对改动文件运行 45 项回归测试，`npm run build` 通过；构建标识为
  `assets/index-DraSBu-b.js`。

## 分发与边缘

- 发布后发现下载 Worker 的已校验快照仍返回 `v0.2.32`。刷新公开快照并重新部署
  下载 Worker 后，`/releases/latest` 已返回 `v0.2.33`，管理器版本检查可发现更新。
- 下载 Worker 当前版本为 `a5a09717-3d5d-4bb8-8d78-aa86f6b465ec`。四个运行包/清单
  的项目分发 HEAD 均为 `200`，大小与 Release 元数据一致。
- `codexwin` 静态边缘已同步 0.2.33 前端，当前 Worker 版本为
  `d291018d-8fb0-47a2-b2c9-91c92631ee1e`。

## 本机安装

- 已选安装目录的实际 `package.json` 版本从 0.2.32 通过预构建运行包升级到
  0.2.33；目录名仍沿用历史名称，不能据目录名判断版本。
- 本地与公网 `/version.json` 均为 0.2.33，构建标识
  `assets/index-DraSBu-b.js`；两端 `/health` 均为 `ready / desktop`。
- `CodexRemote` 与 `CodexRemoteTunnel` 计划任务保持运行。端口 4545 只有一个
  Remote 后端监听，未启动第二个 App Server，未停止 Desktop，也没有弹出命令行窗口。

## 边界

- 长历史修复已通过源码回归和宿主浏览器/合成历史检查；物理 iPhone Safari/主屏
  在 Wi-Fi 与 5G 下的实际手势和前台恢复仍需真机验收。
- 已登录 macOS Desktop 集成、登录持久化和隧道仍需真机验收。
- 管理器自更新、macOS 应用代码签名与公证继续暂停。
