# Remote 0.2.38 发布与部署验收

日期：2026-11-11。组件：Remote **0.2.38** / manager **0.2.9**。

## PR #33 审查与修复

- 审查初始提交 `20cde20`，确认折叠中段 section 的虚拟高度、历史前插全量重建
  和空闲期几何修正构成插话位置卡顿与闪屏的主要链路。
- 发现 per-turn layout cache 在历史前插后继续复用旧全局 `sectionIndex`。
  无回复失败轮的切片判断会把用户消息自身当成后续 section，导致原生错误消失。
- `86c5b3e` 在缓存命中时按 section 身份校准当前下标，移位的行重铸包装对象并
  写回缓存；新增失败轮前插与全行下标回指回归。
- PR #33 的 Windows、macOS、Ubuntu 和合成浏览器验收全部通过后，合并为
  `a87757ed9466a4981c0902a3d868b7c741f9f1b4`。

## 源码与发布

- 版本准备 PR #34 的 CI `43015412835` 全部通过，合并提交为
  `817e20e8abeb404ae8569acf82d4286a075b4bfb`。
- 正式标签 `v0.2.38` 指向该合并提交，为非草稿、非预发布版本。最终 main CI
  `43016354483` 通过三平台验证和合成浏览器验收。
- Runtime Packages `43016530341` 完成 Windows x64 与 macOS Apple Silicon
  签名运行包构建、解包校验和附件上传。macOS 首轮在旧 0.2.37 running 基线的
  PTY 握手处出现已知间歇失败；0.2.38 新包与 stopped 场景已通过，失败作业
  重跑后完整通过，未修改源码或标签。
- Desktop Manager `43016530255` 的 plan 通过；管理器版本未变化，package job
  按门禁跳过。
- 本地全量测试为 145 个测试文件、1159 通过、2 跳过；类型检查和生产构建
  通过，前端构建标识为 `assets/index-06-44Qre.js`。
- Release 四个运行包/清单通过固定公钥验签，签名提交与标签目标一致。
  Windows x64 运行包为 `12010192` 字节，SHA-256
  `94e6664294a6fb1c686cb75bc99a2aca72a679e3fdbc1b2fb467dbc9eec49cfb`；
  macOS Apple Silicon 运行包为 `10082637` 字节，SHA-256
  `d5df7fc8d36e7571ebb63b03bd31088c0da1f1096c7d5f567b93802687fd44ad`。

## 历史布局验收

- 已完成且折叠的轮次只投影有真实内容的 section；插话用户消息保留，过程切片
  不再创建虚拟行。展开或 active 轮次仍保留 section 粒度。
- 历史前插只重扫新页和边界轮，其余轮保留 section、key、测量与 React 身份；
  低置信边界自动回退完整构建。
- 合成节流探针覆盖插话首次提交、连续上滑和巨型轮展开；steer/plain 各提交
  空白为 0%，顶跳为 0，展开/折叠/再展开漂移均为 0px。
- 流式 idle 长任务与贴底 CLS `0.143` 保持 0.2.37 基线；静态
  `pctOver25` 为 2.1%。

## 分发与边缘

- 下载 Worker 当前版本为 `26b5f04d-f2b0-435c-8436-adb0fcad7469`，已刷新为
  `v0.2.38` 四附件快照；`/releases/latest` 返回 `v0.2.38`。
- 四个运行包/清单在显式 `-NoProxy` 条件下 HEAD 均为 `200`，公网大小与
  Release 元数据逐项一致。
- `codexwin` 静态边缘已同步 0.2.38 前端，当前 Worker 版本为
  `469cfe1d-8cf4-4e99-a96b-e88607d4a26d`。本地、分发静态构建和公网前端构建
  标识均为 `assets/index-06-44Qre.js`，文件 SHA-256 为
  `810ba1cf1aa55cba73a692e0e55dada13dbec08ceab4e672d6b9c42d98677ebf`。

## 本机安装

- `F:\AAAAcodexremote\codex-remote-main` 已从 0.2.37 通过签名预构建运行包
  事务升级到 0.2.38，安装模式为 `runtime`，旧服务正常恢复为运行状态。
- 事务备份为
  `output\manager-backup-e31bf832-17b2-422c-8418-e5d090b60594`。更新保留了
  本机定制的 `docs/maintainer-handoff.md`；新版副本位于事务备份的 `incoming`。
- 本地与公网 `/version.json` 均为 0.2.38，侧栏显示 0.2.38；两端 `/health`
  均为 `ready / desktop`，密码已配置。
- `CodexRemote` 与 `CodexRemoteTunnel` 计划任务保持运行。端口 4545 只有一个
  Remote 后端监听，未启动第二个 App Server，未停止 Desktop，也没有弹出
  命令行窗口。
- 安装管理器保持 0.2.9，无变更；管理器自更新、macOS 应用代码签名与公证继续
  暂停。

## 边界

- 性能数据来自桌面 CPU 节流模拟，不等于物理 iPhone 真机。
- 物理 iPhone Safari/主屏、长时间连续上滑、惯性打断和真实网络切换仍需真机
  验收。
- 本轮没有恢复管理器 AU 自更新，也没有改变 macOS 应用签名和公证断点。
