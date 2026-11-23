# Alfred 设计主线

**整体风格**（颜色、层次、文字、布局、交互、动效、形象、文案）汇总在 [style.md](style.md)。新页面先看它。

**已定的是形象，不是整套工作台皮肤。** 把工作台原型做进 App 的方案草案：[workspace-architecture.md](workspace-architecture.md)（等确认）。 日常对话和开发会话怎么分开：[dev-mode.md](dev-mode.md)（2026-11-18 已批准；D1 对话组件、D2 项目和只读开发会话已做完），[原型](../../prototype/dev.html)。 一件事由谁、在哪、什么时候告诉你：[attention.md](attention.md)（2026-11-19 已批准；A1 决定用的表、A2 主节点分派推送并记事件、A3 每个出口上报它看到的、A4 窗口和形象只呈现派给自己的、A5 回来时等着的通知并进欢迎语，已做完）。 Alfred 自己的笔记（一个 Markdown 文件夹 `Alfred Notes`，Obsidian 只是可选的旁路）：[notes.md](notes.md)（2026-11-20 已批准；[原型](../../prototype/notes.html)；代码没开始）。 你的注意力放在哪（新的默认页「今天」是 Alfred 写给你的便条；通知页只放 Alfred 自己的事在等你；问名字挪到首次引导）：[today-and-inbox.md](today-and-inbox.md)（2026-11-20 方向已逐条对齐；「今天」、通知卡片和首次引导的实现进度见文内）。 多个邮箱（先把多个 Gmail 做完整，再加发件地址，再接 IMAP 和 Outlook）：[mail-accounts.md](mail-accounts.md)（2026-11-21 草案，待看；代码没开始）。 标志为超立方体线框；没有脸或眼睛。切换状态时，同一组线连续重组成另一种几何体。依据：[形象决策记录 §4.4](../research/alfred-entity.md)。

[查看可交互的十种状态](../../prototype/tesseract.html) · [浏览器截图](tesseract.png) · [放进工作台原型的样子](../../prototype/workspace.html)

形象的代码只有一份：`packages/ui/src/entity/tesseract.js`（导出为 `@alfred/ui/figure`）。原型里的 `prototype/figure.js` 是指向它的链接，所以原型和 App 跑的是同一套动画。

| 已实现的视图或入口 | 现在用来做什么 |
| --- | --- |
| 主窗口：对话列表和当前对话 | 切换话题、查看任务步骤和回执、回答授权请求 |
| 待办视图 | 从侧栏打开，或在相关对话中展示；与工具操作读写同一份待办 |
| Mac 常驻形象、菜单栏与通知 | 不打开主窗口也能看到进展；点击通知回到对应对话 |

以上是现有功能，并不表示它们的最终布局已签定。

**超立方体已经替换了 App 里的旧形象（Sky）：**
- **Mac 常驻形象**：一块小圆角底板上的超立方体。它会跟着状态变：你回来时打招呼，有事等你时变成琥珀四面体，办事时本体慢慢双旋，其余时间是平静的本体。
- **菜单栏图标**：18pt 单色模板图，画的是「方中方」。

`prototype/workspace.html` 已移回原型目录，原来的占位球换成了超立方体，出现在 Alfred 面板头部、收起后的浮动按钮、手机底栏和日程页的建议卡片里。

**配色已用到 App**（2026-11-18）：主窗口和常驻形象都改用「纸」主题，浅色或深色跟随系统。
- 用的是 `tokens.css` 里暖度按层级递减后的那一版。
- 颜色文件只有一份：`packages/ui/src/tokens.css`。原型里的 `prototype/tokens.css` 是指向它的链接。
- **工作台的壳已经做进 App**（W1，见[落地方案](workspace-architecture.md)）：
  - 侧栏可以收成图标栏；
  - 页面整页切换；
  - 右侧是 Alfred 面板，可以收起、展开；
  - 有 ⌘K 和手机底栏。

  之后又做了 W2（领域和待办页）、W3（提议和通知页）、W4（每页的一句话、建议问法、「在 X 页问的」）、W5（自动任务和早报）。日程、邮件等页按方案后面几刀加。
- **App 有中文和英文**（2026-11-18）：语言存在主节点，所有设备跟着它。

[历史样稿](../../archive/design/prototype/)保留供回查：`style-report.html` 是未定的配色；Sky、点阵球、领结等不是当前形象。研究文档里的旧 `prototype/` 引用可在该归档按原名查找。
