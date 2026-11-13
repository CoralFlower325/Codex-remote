# Remote 0.2.40 发布与部署验收

日期：2026-11-13。组件：Remote **0.2.40** / manager **0.2.9**。

## 非 Cloudflare 适配

- `PUBLIC_ORIGINS` 支持规范公网入口之外的多个备用入口；`PUBLIC_ORIGIN`
  仍为规范入口，`ALLOWED_ORIGINS` 保留为额外信任列表。
- HTTP(S) Origin 在启动配置阶段规范化并去重；带凭据、路径、查询或片段的
  来源会阻止启动，浏览器提交未信任来源时返回明确的 403。
- 设置页连接菜单列出当前入口之外的规范入口与备用入口，Cloudflare 和国内
  HTTPS 反向代理可同时存在。
- `deploy/caddy/Caddyfile.example` 提供静态资源、API、WebSocket 与健康检查
  分离转发的 Caddy 配置；`npm run precompress:client` 生成 Brotli 附属文件。

## 构建与本地门禁

- 本机全量测试：`1186 passed / 2 skipped`，typecheck 与生产构建通过。
- 新增 Origin 策略和 Brotli 发布脚本定向测试 `7 passed`。
- 本机 `npm run check:browser` 完整通过，覆盖 8 个桌面/平板/手机视口、
  历史边界、输入区、更新恢复与预览安全。
- 构建版本为 `0.2.40`，入口构建标识为 `assets/index-nEP_tXGA.js`。

## 发布与部署

- PR #42 合并提交为 `3391901a4a5f187a5112e44273f4a07bef161d1c`。首次运行包
  发布发现三个文本文件的 Git blob 为 CRLF，签名摘要门禁在正式发布前阻断；
  PR #43 只规范 `.env.example`、`package.json` 和 `package-lock.json` 为 LF。
- PR #43 与最终 tag source 指向
  `d939828213e99483b3a27494065d6c0a3f722e0b`。main CI `43432391478`、
  Runtime Packages `43432431776` 和 Desktop Manager `43432428144` 通过；
  管理器 package job 按计划跳过。
- `v0.2.40` 为非草稿、非预发布 latest。Windows x64 归档 `12047334` 字节，
  SHA-256 `957b76deb2aefd58049c990dcb0afdb4c6fee0779c565e13b37a17fd8ac4ccc4`；
  macOS Apple Silicon 归档 `10122021` 字节，SHA-256
  `1493efec0d060e2f6eafa1c2e9eb3ac9450227c903e3fa060d344df7a078dfae`。
- 下载 Worker `096ad31f-4119-4c44-a3dd-7d1994e963ce` 的快照返回 v0.2.40；
  `codex-remote-static` 版本为
  `b7348e2d-e563-4c8e-8883-a11872311b9c`。
- 本机通过签名运行包升级到 0.2.40，事务备份为
  `output\manager-backup-14202311-57d9-477b-9251-65d25f6b4226`，没有未完成
  update journal。
- 本地、`codexwin.mmmmmzzzzzyyyyy.online` 与 `codexwin.73916482.xyz`
  均返回版本 0.2.40、构建 `assets/index-nEP_tXGA.js` 和 ready / desktop
  health。国内入口使用 Brotli，Cloudflare 边缘以 gzip/br 回退。

## 边界

- 真实 iPhone Safari/主屏、真实运营商网络切换与已登录 macOS Desktop 仍需
  独立真机验收；当前性能数据是合成网络和 CPU 限速。
- 管理器保持 0.2.9，管理器自更新、macOS 应用代码签名与公证继续暂停。
