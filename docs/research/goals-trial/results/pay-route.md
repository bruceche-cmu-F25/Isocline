# 路线：自己做出一个能收款的小产品，放到网上让人付费用

## 别人一般是怎么走到的

我找到三种做法。它们的区别是先做哪一块：先收钱，先让人表态，还是先把完整产品做出来。

### 先收钱，后自动化
**这条路是什么样** 先不写任何收款程序。在收款服务里生成一条"付款链接"，当作购买按钮。有人付钱后，你手动把东西交给他。等确定有人愿意买，再把交付做成自动的 [1]。

**代价** 前期要手动交付，人一多就忙不过来。付款链接不管自动交付、订阅管理和账号对接 [1]。

**靠什么**
- Stripe for Indie Developers（一位独立开发者的经验总结）：https://dev.to/whoffagents/stripe-for-indie-developers-everything-i-learned-across-6-products-1050

**大约多久** 猜测：几天到两周，取决于产品本身有多小。

### 先验证有没有人要，再动手做
**这条路是什么样** 先做一个只有介绍和"留邮箱"按钮的单页，把它发给目标人群，看有多少人留下邮箱。有人感兴趣后才开始写产品。这份指南把整件事压在 30 天内，分为验证、定范围、开发、上线几周 [3]。

**代价** 前几周可能一行产品也没写。它假定你会写代码，用的是 Next.js、Supabase、Stripe、Vercel 这类工具。指南里的转化率目标和广告预算只是作者的经验数字，我没看到出处 [3]。

**靠什么**
- Build a SaaS in 30 Days: Lean Launch for Indie Hackers：https://calmops.com/indie-hackers/saas-in-30-days-lean-launch/

**大约多久** 指南自称 30 天。我猜一个人兼职做，会更长。

### 用现成平台，不自己写收款程序
**这条路是什么样** 用一个"代理商户"平台（由它充当卖家、处理税务）。你在上面建店、上传文件或设置订阅、填收款账户，平台自带店面网址和付款页。买家付款后能直接从邮件或账户里下载文件 [2]。

**代价** 平台要审核你的店铺，抽成也不由你定。我读到的 Lemon Squeezy 页面写着：它已停止接受新注册，并将在 2027 年 3 月 31 日关闭 [2]。所以这个例子本身已经走不通，同类平台（如 Gumroad、Paddle）我只看到搜索摘要，没有读过原文。

**靠什么**
- Lemon Squeezy 入门指南（可看建店流程长什么样）：https://docs.lemonsqueezy.com/guides/getting-started
- Gumroad 与 Lemon Squeezy 的对比文章（只读了摘要）：https://www.creatorstackclub.com/compare/gumroad-vs-lemon-squeezy

**大约多久** 猜测：产品已经有的话，几天。

## 眼前这一段（以第一种走法为例）

### 第 1 步：定下卖什么、卖多少
**做什么** 写下一句话：这个产品替谁解决什么小麻烦，买一次还是按月付。第一个产品选一次性付款。
**为什么走这一步** 付款链接要填产品名和价格。一次性付款的实现只有订阅的一半复杂 [1]。
**用什么走** 
- 上面那篇 Stripe 经验文，里面的"一次性付款与订阅"和"定价"两节：https://dev.to/whoffagents/stripe-for-indie-developers-everything-i-learned-across-6-products-1050

### 第 2 步：做出能交付的东西
**做什么** 做出最小的一版，比如一个文件，或一个能打开的网页工具。它只需做到能解决那一个麻烦。
**为什么走这一步** 手动交付时，你要有东西可交。
**用什么走** 
- 30 天指南里"只做主流程、先走顺利路径"一节，可借来划定范围：https://calmops.com/indie-hackers/saas-in-30-days-lean-launch/

### 第 3 步：建一条付款链接
**做什么** 注册收款服务，在后台建产品和价格，生成付款链接，用测试模式付一笔自己的钱。
**为什么走这一步** 这一步让"陌生人能付钱"第一次成真 [1]。
**用什么走** 
- Stripe 文档，订阅与结账入门：https://docs.stripe.com/billing/quickstart（只看过摘要）

### 第 4 步：放一个介绍页，把链接挂上去
**做什么** 做一个单页，写清产品解决什么问题、价格多少，放上购买按钮。
**为什么走这一步** 没有公开网址，别人看不到也付不了钱。
**用什么走** 
- 30 天指南第 1 周提到的单页工具（Carrd、Framer、Webflow）：https://calmops.com/indie-hackers/saas-in-30-days-lean-launch/

### 第 5 步：让第一个人付钱
**做什么** 把链接发给你想帮的那类人，收到付款后手动把东西交给对方。
**为什么走这一步** 这能验证有没有人愿意付钱，也是之后做自动化的依据 [1]。
**用什么走** 
- 30 天指南里找人的几个渠道（社区、社交平台）：https://calmops.com/indie-hackers/saas-in-30-days-lean-launch/

## 后面的段
- 付款后自动开通：接收付款通知（webhook），验证后自动开放产品。
- 订阅的续费、扣款失败与取消。
- 税务与"卖家"身份的选择。
- 把产品和账号系统做完整。

## 没找到的、不确定的
- 第一种和第二种走法主要依据个人经验文章，不是正式课程。我没找到可靠的时间数据，上面的时间都是猜的。
- 没查各平台的费率，也没查你所在地区能否开通收款，以及个人是否要注册公司。
- Stripe 快速入门页和 Gumroad 对比文我只看了摘要。

## 出处
1. Stripe for Indie Developers: Everything I Learned Across 6 Products — https://dev.to/whoffagents/stripe-for-indie-developers-everything-i-learned-across-6-products-1050
2. Guides: Getting Started | Lemon Squeezy — https://docs.lemonsqueezy.com/guides/getting-started
3. Build a SaaS in 30 Days: Lean Launch for Indie Hackers — https://calmops.com/indie-hackers/saas-in-30-days-lean-launch/
4. Build a prebuilt subscription page with Stripe Checkout（仅摘要）— https://docs.stripe.com/billing/quickstart
5. Gumroad vs Lemon Squeezy (2026)（仅摘要）— https://www.creatorstackclub.com/compare/gumroad-vs-lemon-squeezy