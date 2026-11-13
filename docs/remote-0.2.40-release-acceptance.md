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

待 CI、Release、分发、Windows 安装、国内静态资源和双入口核查完成后补录。

## 边界

- 真实 iPhone Safari/主屏、真实运营商网络切换与已登录 macOS Desktop 仍需
  独立真机验收；当前性能数据是合成网络和 CPU 限速。
- 管理器保持 0.2.9，管理器自更新、macOS 应用代码签名与公证继续暂停。
