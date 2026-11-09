# 原生待发与引导条验收

日期：2026-11-09。功能版本：Remote **0.2.27**，管理器 **0.2.6**。

## 交互契约

- 主输入始终只有一个主操作：运行中空输入显示停止，有文字、附件或技能时显示发送。
- 运行中点击发送先调用原生 `thread/queue/add`，不直接调用 `turn/steer`。
- 待发消息在 RPC 完成前立即显示在输入框上方；原生队列返回相同
  `clientUserMessageId` 后替换本地行，不产生重复或闪动。
- 待发条提供原生“引导”、删除和更多菜单；菜单包含编辑、在侧边聊天中打开和关闭排队。
- 点击“引导”使用原生 `turn/steer` 和当前 `expectedTurnId`，成功后再删除待发项。
- 关闭排队只影响当前活动轮次，后续发送直接引导；活动轮次结束后恢复默认排队。
- 会话历史入口紧靠主发送按钮左侧，不再夹在模型控件旁。

## 自动验收

- `npm run typecheck` 通过。
- `npm test` 通过：138 个文件、1058 项通过，2 项平台测试跳过。
- `npm run build` 通过。
- `check-composer-layout.mjs` 覆盖八个视口，确认单主线、只有一个主按钮、
  历史入口紧邻主按钮、无横向溢出和控件重叠。
- `check-skill-timing.mjs` 覆盖八个视口，延迟原生队列回执 450ms，确认待发行仍会
  立即出现；原生回执后菜单可编辑，随后用 `turn/steer` 完成引导。

截图位于忽略目录 `output/playwright/composer-028/` 和
`output/playwright/skill-timing-027/`。真实 iPhone Safari 与物理网络仍需单独验收。
