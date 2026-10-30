export interface ReleaseNote { version: string; changes: string[] }

// Public release metadata only; never include host paths or conversation data.
export const releaseNotes: ReleaseNote[] = [
  { version: '0.1.8', changes: [
    '新增原生会话摘要面板，集中查看拉取请求、输出内容、侧边聊天、子智能体和来源。',
    '版本检查在已是最新版时保留当前页面；有新版时先展示更新摘要。',
    '保留手机 36px 输入区控件和桌面原有尺寸。'
  ] },
  { version: '0.1.7', changes: [
    '优化手机回合列表弹窗和键盘焦点，保留桌面入口样式。',
    '改进侧栏运行图标的 WebKit 动画兼容性。'
  ] },
  { version: '0.1.6', changes: ['简化侧栏标题和帮助入口，保留设置菜单及双端控件尺寸。'] },
  { version: '0.1.5', changes: ['新增手动版本更新入口和独立更新页面，改善手机侧栏手势。'] }
];
