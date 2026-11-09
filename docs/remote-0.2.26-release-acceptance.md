# Remote 0.2.26 发布验收

Remote 0.2.26 / manager 0.2.4。管理器没有功能变更。

## 本版范围

- 模型和项目目录沿完整原生游标读取，拒绝不完整快照；reasoning 保留默认继承并按设置修订顺序合并。
- 插话立即显示本地“正在引导当前任务”状态，原生 user item 到达后去重；只读 Desktop 请求超时不再断开实时事件桥。
- Windows PTY 使用 Job Object，POSIX 使用进程组；运行包校验 Node 22.19.x ABI。
- Office 转换使用隔离低权限 worker；SSE/WS 有界背压，受管隧道使用动态指标端口。
- 客户端视图/动作契约、Home/Thread 拆屏和 RPC 请求生命周期独立；发布与 CI 使用共享契约。

## 验证

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run manager:build`
- `npm run check:browser`
- `npm run check:windows-worker`
- `npm run check:release`

## 边界

iPhone 真机、已登录 macOS Desktop、真实代理/网络切换和 Native PTY upstream
access violation 根因仍需单独实机或长期验收不能由合成测试代替。本记录不代表
本机部署、公网前端或管理器安装已经升级；这些状态分别记录。
