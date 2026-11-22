# Alfred 网页与手机安全评估

2026-11-21。适用范围是个人主机 Mac、经 Tailscale Serve 连接的电脑浏览器、手机浏览器及安装到主屏幕的网页。远程客户端共用同一套鉴权规则，每台设备的开发权限由主机单独授予。手机更容易遗失，锁屏通知、手表和最近使用的应用还会在工作台之外显示信息。建议在主机启用网页锁，并给每台设备开启系统锁屏。

## 已实现的保护

- **私网接入与配对。** 主机把本机管理和远程请求分到两个回环端口，检查 Host 和浏览器 Origin。远程新设备需在私网内使用一次性配对码，10 分钟内有效。浏览器的配对 Cookie 最长保留 400 天。主机按令牌摘要和吊销状态识别设备，可单独终止授权。Tailscale 提供请求者身份且主机已知所有者时，Alfred 会拒绝不匹配的账号。身份缺失时仍依赖配对校验，部署应同时限制允许访问的私网成员。[主机入口](../../packages/server/src/http.ts) · [配对逻辑](../../packages/server/src/remote.ts) · [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- **闲置与失窃。** 网页锁默认关闭。主机所有者在「设置 → 设备」启用后设定密码，也可以在这里重设。主机保存加盐的 scrypt 摘要，按设备、全局次数及并发数限制密码试验。远端解锁还会得到独立的会话 Cookie。两种 Cookie 均设置 Secure、HttpOnly、SameSite=Strict。没有前台操作报告满 15 分钟，主机拒绝后续私有 API 请求并关闭事件流。轮询、后台推送和刷新不会延长解锁时间。修改密码或主节点重启也会结束原解锁会话。离开到超时之间，能操作这台设备的人仍能使用工作台。[主机会话](../../packages/server/src/web-lock.ts) · [浏览器门禁](../../packages/ui/src/WebLockGate.tsx) · [OWASP 会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- **通知与缓存。** 开启网页锁后，主机对新发出的网页推送只提供通用提醒，打开后仍受网页锁约束。先前已送达或进入投递队列的详细推送可能保留。带有明确开发会话关联的通知只发送给拥有开发权限的设备。远程 JSON、事件流、附件和模块资源响应使用 `no-store`，Service Worker 负责推送，不缓存工作数据。升级后需让旧标签页和主屏幕应用重新载入。旧页面仍可能显示先前收到的内容。[推送实现](../../packages/server/src/push.ts) · [Service Worker](../../packages/ui/public/sw.js)

## 用户现在可以做什么

| 情况 | 优先措施 |
| --- | --- |
| 主机或远程设备无人看管 | 主机 Mac 拥有重设网页密码的权力，优先设置离开自动锁屏、磁盘加密和独立系统账户。远程设备离手时立即锁屏。避免配对公用电脑，个人电脑使用专用浏览器配置，限制能读取网页的扩展。设备系统或扩展被控制时，已解锁页面上的内容和操作都可能暴露。 |
| 手机通知或多任务预览泄露 | iPhone 把通知预览设为解锁后显示，并检查 Apple Watch 的通知镜像。Android 隐藏锁屏敏感内容，必要时关闭锁屏通知。通用提醒仍透露收到消息的时间。清除过去的详细通知。网页进入后台时会遮盖界面，系统保存最近应用快照的时机由设备决定。[iPhone](https://support.apple.com/zh-cn/guide/iphone/-iph7c3d96bab/ios) · [Apple Watch](https://support.apple.com/zh-cn/108274) · [Android](https://support.google.com/android/answer/9079661) |
| 设备丢失、转让或人员退出 | 在主机「设置 → 设备」吊销对应浏览器，并在 Tailscale 移除相关设备或成员权限。若密码可能外泄，再重设网页密码。找回或转让设备时，清理 Alfred 站点数据、下载和通知。已经复制的文字、截图、系统备份和下载需要另行处理。 |
| 配对链接和草稿留下副本 | 仅在自己的设备间传递配对链接。怀疑误分享时，在主机换一个配对码。邮箱手写草稿的正文和收件人在 `localStorage`，开发会话输入与附件元数据可能在 `sessionStorage`。网页锁限制向主机取数，设备本地仍保有这些副本。清理站点数据前先保存需要的草稿。[邮箱](../../packages/ui/src/Mail.tsx) · [开发会话草稿](../../packages/ui/src/composerDraft.ts) · [OWASP 浏览器存储](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html) |

## 工程改进优先级

1. **优先隔离服务。** 部署负责人应为 Alfred 分配专用 HTTPS 主机名。同一主机名下的不同端口共享 Cookie 的发送范围，其他服务必须同样可信。私网管理员应核对访问规则、设备共享和身份缺失时的处理，保留独立的主机恢复入口。[RFC 6265 §8.5](https://datatracker.ietf.org/doc/html/rfc6265#section-8.5) · [Serve 身份头](https://tailscale.com/docs/features/tailscale-serve)
2. **收窄已解锁设备权限。** 产品和后端可增加按设备只读模式，为发邮件、批准外部写入、开发发布等操作要求近期重新验证。普通设备已有开发权限限制，但状态响应仍有开发会话标题及项目路径等元数据。应按设备实际需要裁剪。持续操作可延长会话，可再设置绝对到期时间。[状态与权限检查](../../packages/server/src/http.ts)
3. **减少敏感内容落盘。** 前端可提供临时会话及草稿保留选项，将保护模式中的敏感草稿迁到主机，在明确退出时提供安全清理。通知生产者应统一标注数据范围，覆盖没有显式开发会话关联的场景。

Chrome 桌面与触屏手机模拟分别完成配对、密码解锁、活动续期、闲置后刷新、主机改密以及关闭开关后的验证。测试使用临时数据库、HTTPS 和模拟的 Tailscale 转发，通过推进测试时钟检验 15 分钟到期。还验证了手机模拟会话离线时遮盖内容及联网后重新验证。真实设备的锁屏和后台快照、手表镜像、浏览器扩展与备份行为，需要在实际系统配置上分别验收。[服务端测试](../../packages/server/test/web-lock.test.ts) · [远程访问测试](../../packages/server/test/remote.test.ts)
