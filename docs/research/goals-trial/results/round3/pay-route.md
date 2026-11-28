# 路线：自己做出一个能收款的小产品，放到网上让人付费用

## 别人一般是怎么走到的

我读到的资料里，走法大致分三种。区别在"先做什么"：先做软件、先上架现成平台，还是先收钱再做。

### 做一个小软件，自己接支付
**这条路是什么样** 找一个很窄的问题，做出只解决这一件事的小网站或小工具，让人注册并付月费。资料里的节奏是：先选题，再用一个落地页验证，再做，再发布，再转成付费。[1][2] 收款一般接 Stripe 这类支付公司。你的网站要在收到"付款成功"的通知后才开通权限。[1][3]
好比开一家只做一道菜的小馆子：菜单极短，但灶台、收银和上菜都要自己搭。

**代价** 要自己写或让 AI 写代码，还要自己维护。来源 [2] 说，活跃客户到三十个左右，维护就会开始吃掉开发时间。固定的几十美分手续费、税务和退款，也要按第一部分的世界观自己对付。

**靠什么** 四周计划 https://wannaship.fyi/blog/how-to-build-micro-saas/ [1]；单人从想法到首位客户 https://sek.re/en/blog/solo-micro-saas-from-idea-to-first-paying-customer/ [2]；Stripe 订单履行文档 https://docs.stripe.com/checkout/fulfillment [3]。

**大约多久** 猜测：到第一笔付款约 3 到 8 周。来源 [2] 自己给的是这个范围，[1] 的计划是 4 周。两篇都是作者的经验之谈，没有统计。

### 把东西放到现成的售卖平台上
**这条路是什么样** 做一个小而具体的数字商品，比如模板、电子书、素材包或带授权码的小程序。然后放到 Gumroad、Lemon Squeezy、Polar 之类的平台。平台提供商品页、收款和文件发放。[4][5] 其中几家自己充当代收商，税由它们处理。[5]
好比把作品放进一家有现成柜台的集市，不用自己租铺子。

**代价** 每一笔都要被抽成，例如 Gumroad 直接销售是 10%+0.5 美元，另加银行卡处理费。[4] 平台不会替你带来买家，来源 [4] 明说了这一点。你能做的商品形态也被平台的格式限制，比如文件、授权码、会员。

**靠什么** Gumroad 六步指南 https://productivityvision.com/how-to-sell-on-gumroad/ [4]；独立开发者数字商品指南与平台费用对比 https://zeroraised.com/blog/how-to-sell-digital-products-online [5]。

**大约多久** 猜测：几天到两三周。来源 [4] 说一个下午就能上架，但没说多久能卖出去。

### 先收钱、后做东西
**这条路是什么样** 先写好大纲、价格和交付日期，放一个能付款的页面，看陌生人愿不愿意付钱。有人付了，再做完整的东西。[5][1] 来源 [2] 也说，首位付费客户要在写代码之前找到。
好比饭馆先贴出"下月开张，订座交定金"，有人交了钱再装修。

**代价** 没人付钱时，你会白忙一场页面，但省下了整个产品的时间。有人付了钱，你就欠对方一个交付。来源 [5] 提醒，预售拖成无限期延迟，会失去你想要的那批受众。

**靠什么** 同样是 [5] https://zeroraised.com/blog/how-to-sell-digital-products-online（预售、带价格的候补名单）；[2] https://sek.re/en/blog/solo-micro-saas-from-idea-to-first-paying-customer/（72 小时验证）。

**大约多久** 猜测：几天验证，做出来再花几周。来源 [2] 的 72 小时验证是一家之言。

## 眼前这一段（以第一种走法为例）

只排最前面的一小段，也就是到"有人愿意付钱"为止。

### 第 1 步：找一个窄问题，和几个有这个问题的人聊
**做什么** 用一句话写出"某类人因为某个具体问题在浪费时间或钱"。然后去他们聚集的论坛、社群，找 5 到 10 个人，问他们现在怎么解决、最烦哪里、愿意为解决付多少钱。不是推销，只是了解。
**为什么走这一步** 两篇来源都把这一步放在写代码之前，因为后面要做的东西由它决定。[1][2]
**用什么走** 来源 [1] 的"第 0 周"和"第 1 周"：三个筛选问题和三个访谈问题 https://wannaship.fyi/blog/how-to-build-micro-saas/ 。来源 [2] 的"72 小时验证"：怎么描述问题、去哪找人 https://sek.re/en/blog/solo-micro-saas-from-idea-to-first-paying-customer/ 。

### 第 2 步：做一个带价格的单页，放给陌生人看
**做什么** 做一页：标题、问题、方案、价格、一个按钮。用 Carrd、Notion 页面或简单网页都行，发到你聊过人的那些地方。
**为什么走这一步** 来源 [1] 和 [5] 都认为，陌生人留邮箱或预付，比朋友说"挺好"更接近真实需求。
**用什么走** [1] 的"48 小时验证"，含强弱信号怎么看 https://wannaship.fyi/blog/how-to-build-micro-saas/ 。[5] 的"带价格的候补名单" https://zeroraised.com/blog/how-to-sell-digital-products-online 。

### 第 3 步：只做一个功能，让它能上线
**做什么** 把产品缩到只做一件事。登录用现成的服务，部署到一个真实网址上。
**为什么走这一步** 第 2 步有了回应，这一步才有方向。两篇来源都建议把登录、邮件这类杂活交给现成服务。[1][2]
**用什么走** [1] 的"7 天搭建清单"，含按天安排和工具表 https://wannaship.fyi/blog/how-to-build-micro-saas/ 。[2] 的技术栈一节 https://sek.re/en/blog/solo-micro-saas-from-idea-to-first-paying-customer/ 。

### 第 4 步：接上 Stripe，让付款真的能开通权限
**做什么** 在 Stripe 里设一个商品和价格，用它的结账页收款。再写一小段代码，让网站在收到"付款成功"的通知（webhook）后才开通。用测试卡号走一遍。
**为什么走这一步** 在第 3 步之后，有东西可卖了。官方文档说，不能只靠付款后的跳转页来触发开通，因为买家可能付了钱却没打开那一页。[3]
**用什么走** Stripe 订单履行文档，含可改的示例代码和本地测试办法 https://docs.stripe.com/checkout/fulfillment [3]。Stripe 的结账与 webhook 快速入门页（我只看了摘要）https://docs.stripe.com/payments/accept-a-payment [6]，https://docs.stripe.com/webhooks/quickstart [7]。

### 第 5 步：发给第一批人，开口报价
**做什么** 把链接发给第 1、2 步里联系过的人，附上价格。再私信几位最近抱怨过这个问题的人，请他们试用。
**为什么走这一步** 到这里，才能知道有没有人真的付钱。
**用什么走** [1] 的第 3 周：发布清单和私信写法 https://wannaship.fyi/blog/how-to-build-micro-saas/ 。[2] 的"第一位付费客户"一节 https://sek.re/en/blog/solo-micro-saas-from-idea-to-first-paying-customer/ 。两篇对定价说法不同：[1] 给的是 B2B 月费 15 到 49 美元，面向个人消费者 5 到 15 美元；[2] 说 B2B 至少 29 欧元一个月。

## 后面的段
- 留住前 10 个用户、只做他们最常提的那一个功能：到那时再展开。[1]
- 选支付公司，以及税、代收商怎么选：到需要真收钱时再展开，世界观里已有概述。
- 上线后的维护：监控、客服、手册：到客户多起来时再展开。[2]

## 没找到的、不确定的
- 三种走法的来源多是个人或公司博客，其中 [1] 卖创意清单，[5] 自己运营发布站点，两家都有利益关系。我没找到有数据支持的成功率统计，所以"多久"都只是猜测。
- 第三种走法，我没找到专门描述它的完整教程，它是从 [1][2][5] 里的验证做法拼出来的。
- Stripe 的文档在你所在的国家能不能直接开户收款，我没查。Gumroad 提到支持的国家要看它自己的帮助页。[4]
- 第 1 步里"怎么找到并信任"的方法，只有 [1][2] 两篇，我没读到第三篇独立来源。
- 来源 [5] 只读了前约两万字，税务部分之后的内容没读到。
- Stripe 文档页的部分示例代码和 webhook 快速入门，我没逐行看。

## 出处
1. How to Build a Micro-SaaS in 2-4 Weeks (Step-by-Step) | WannaShip.fyi — https://wannaship.fyi/blog/how-to-build-micro-saas/ （读过）
2. Solo micro-SaaS: from idea to first euro without a team — SEK — https://sek.re/en/blog/solo-micro-saas-from-idea-to-first-paying-customer/ （读过）
3. Fulfill orders | Stripe Documentation — https://docs.stripe.com/checkout/fulfillment （读过）
4. How to Sell on Gumroad: 6 Simple Steps to Your First 10 Sales — https://productivityvision.com/how-to-sell-on-gumroad/ （读过）
5. How to Sell Digital Products Online: The Indie Maker Guide — ZeroRaised — https://zeroraised.com/blog/how-to-sell-digital-products-online （读过）
6. Accept a payment | Stripe Documentation — https://docs.stripe.com/payments/accept-a-payment （只看了摘要）
7. Webhooks quickstart | Stripe Documentation — https://docs.stripe.com/webhooks/quickstart （只看了摘要）