# 文档预览与可靠性验收

本批 Remote 0.2.8 将成果验收落实到现有文件检查器；管理器保持 0.2.0，无变更。
Office 预览依赖主机单独安装 LibreOffice。支持格式和操作边界以
[中文指南](guide.zh-CN.md#文件与网页预览)、
[English guide](guide.md#file-and-web-previews)为准。

## 可重复检查

```bash
npm run typecheck
npm test
npm run build
python -m pip install python-docx openpyxl python-pptx
node scripts/check-document-preview.mjs
node scripts/check-composer-layout.mjs
```

浏览器脚本使用可选 desktop 开发依赖中的 Playwright 与已安装 Chrome，
独立启动合成 HTTP/WebSocket 后台，不连接 Desktop、不发送真实模型请求或通知。
文档脚本创建合成 Word、Excel、PowerPoint，真实调用主机 LibreOffice，核对 PDF、
原文件摘要、禁止自动读取的 Writer 外链，并在标准八视口检查两页 Word 的翻页、
缩放、复制、原文件下载、转换错误与刷新恢复、PDF 画布和工具栏边界。
结果和截图保存在忽略的 `output/playwright/documents-028/`。
布局脚本输出 `output/playwright/composer-028/`，包含活动主聊与侧聊的
停止/发送双按钮、文字/图片/技能草稿和停止不误发检查。

单元测试覆盖转换串行、重复读取合并、队列上限、文件大小、超时子进程清理、
认证和原下载、HTML junction/symlink 越界、异常消息、登录预算、
损坏推送/附件索引保留，以及推送写入失败后的降级与恢复。

## 验收限制

Windows 的真实转换结果不能证明所有 Office 格式、复杂排版、宏文件或恶意文件安全。
宏和外链设置不提供网络或文件系统沙箱。旧格式和 ODF 仍需按实际产物抽查。
macOS 转换、真实 iPhone Safari/主屏幕、手机网络和系统听写需单独实机验收。
转换器缺失时的单元夹具与界面错误注入不等同于在每个平台卸载 LibreOffice 测试。
关闭页面会停止浏览器加载，但不会取消已经排队的主机转换。
