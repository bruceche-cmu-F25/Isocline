Two more reads for the internal path and step materials.

# 路线：一年内换一份后端工程师的工作

## 别人一般是怎么走到的

我找到三种走法，差别在于"靠什么让对方相信你"。

### 自己对照路线图学，做项目，然后投简历
**这条路是什么样** 先选一门语言（国内多是 Java，英文路线图还列了 Python、Go、Ruby、Node.js 等[3]），再按路线图一块一块补：语言、数据库、框架、工具[1][3]。然后做一两个自己讲得清的项目，最后再准备面试。这像自己照着菜谱学做菜，最后拿几道成品请人尝。

**代价** 没人给你反馈。资料很多，容易学成"四不像"[1]。自学要自己找人看代码、给意见，光看完教程不算有反馈[2]。

**靠什么**
- JavaGuide 的 Java 后端学习路线，里面说明了找小厂工作和进大厂各要学到哪里 [1]：https://javaguide.cn/roadmap/java-roadmap.html
- roadmap.sh 的后端路线图，语言不限，列出了数据库、API、Git 等 [3]：https://roadmap.sh/backend
- JavaGuide 的面试通关计划，从简历和项目开始准备 [6]：https://javaguide.cn/interview-preparation/backend-interview-plan.html

**大约多久** 猜测：几个月到一年，取决于你已经会多少、每天能拿出多少时间。资料本身只给了面试准备的长度，4 周或 8 周，而且默认你已学过主要知识[6]。

### 在现在的公司里，一点一点接后端的活
**这条路是什么样** 不先换公司，而是先在现有团队里换活干。一位前端工程师写了自己的经历：他先向主管说明意愿，再接小的后端任务，和后端同事结对，逐步接手接口、异步任务、线上问题排查，最后负责整块模块[4]。另一份指南讲的是正式的内部转岗：先和目标团队的负责人聊，再投内部简历，再过面试[5]。这像在餐厅里从洗碗转去帮厨，先站到灶台边，再谈换岗。

**代价** 要看现公司有没有后端的活和缺口，你不能自己决定。那位工程师就是等到产品做完第一版、后端缺人手才有机会[4]。内部转岗也有门槛：在现岗位待够一定时间、近期考核合格、目标团队有名额[5]。内部面试不是走形式，常常和外部面试差不多[5]。

**靠什么**
- 一位前端转后端的亲身记录（只是一个人的经历）[4]：https://dev.to/ninariccimarie/from-frontend-to-backend-how-i-transitioned-across-the-stack-in-a-real-product-team-3d8d
- 工程师内部转岗指南（讲的主要是大型科技公司）[5]：https://www.wrok.app/blog/engineer-internal-transfer-guide-2026

**大约多久** 猜测：半年到一年以上，进度由公司的机会决定。两份资料都没给具体时长。

### 报班或训练营，在固定节奏里学
**这条路是什么样** 找一个范围固定的集中课程，按它排好的内容学，一般还有项目和老师。这像报驾校：路线和进度别人替你排好了。

**代价** 要花钱，还可能要暂时不工作。一个短课程，如果需要很长一段没有收入的时间，也可能很贵[2]。就业率这类宣传数字，要问清算的是哪些人、怎么定义"就业"，没说清就不能当真[2]。

**靠什么** 我只找到一份可读的资料，它讲怎么比较这几种路，没有讲具体哪个课程好[2]：https://softwareengineercareers.com/career-paths/degree-bootcamp-self-taught/ 。具体课程的大纲我没有读到。

**大约多久** 猜测：几个月，各课程不同，我没有读到可靠数字。

## 眼前这一段（以第一种走法为例）

### 第 1 步：先把要准备的范围画出来
**做什么** 找几份你想投的后端岗位描述，把反复出现的技能记下来。再把你现在的简历拿出来，看上面已经写了什么。

**为什么走这一步** 要准备的范围主要来自两处：岗位明确要求什么，简历上写了什么[6]。先画范围，后面才不会什么都想学。

**用什么走**
- JavaGuide 面试通关计划的"第 0 阶段"，讲了这一步怎么做 [6]：https://javaguide.cn/interview-preparation/backend-interview-plan.html
- roadmap.sh 后端路线图，可以对照看你缺哪些块 [3]：https://roadmap.sh/backend

### 第 2 步：选定一门主语言，把基础过一遍
**做什么** 按岗位描述里最常出现的语言来选。Java 路线是语言基础、集合，再到并发；并发先学入门部分，等学深了再回头看[1]。路线图里的建议是：没学过编程的人，先看视频跟着做。

**为什么走这一步** 数据库、框架和项目都是建在语言上面的。这像先学会认字，再谈写文章。

**用什么走**
- JavaGuide 的 Java 路线，"Java 核心"部分列了视频和书 [1]：https://javaguide.cn/roadmap/java-roadmap.html
- roadmap.sh 的"如何成为后端开发者"一段，讲了非 Java 语言的起步顺序 [3]：https://roadmap.sh/backend

### 第 3 步：学数据库，写一个会读写数据的小接口
**做什么** 学关系型数据库的基本操作：建表、增删改查、多表查询。然后写一个简单的接口，让它真的读写数据库。MySQL 是国内主流[1]，英文路线图的例子用的是 PostgreSQL[3]。

**为什么走这一步** 后端的核心是"接请求、读写数据"。这一步做完，你手里第一次有了能跑的后端东西。

**用什么走**
- JavaGuide 路线里的 MySQL 部分，初期只需掌握常用命令、查询和索引 [1]：https://javaguide.cn/roadmap/java-roadmap.html
- roadmap.sh 的起步说明，提到先学关系型数据库的基本操作，再做简单的 REST 接口 [3]：https://roadmap.sh/backend

### 第 4 步：做一个自己讲得清的项目，放到 Git 上
**做什么** 做一个完整的小项目，用 Git 管理。可以是跟着课程做的，也可以是二次开发别人的开源项目。要记下业务背景、你负责哪几块、一次请求怎么流转[6]。

**为什么走这一步** 面试官通常从项目问起，再顺着往下追问[6]。项目讲不清，别的知识点就接不上你的经历。

**用什么走**
- 面试通关计划的"项目与简历深挖"，列出了每个项目该整理的内容 [6]：https://javaguide.cn/interview-preparation/backend-interview-plan.html
- 项目要找人看一看、跑一跑，才有反馈 [2]：https://softwareengineercareers.com/career-paths/degree-bootcamp-self-taught/

## 后面的段
- 补缓存和框架：Redis、Spring，视简历和岗位而定。
- 补系统设计与稳定性：消息队列、限流、故障处理。
- 补算法与计算机基础：有笔试的岗位要早一点开始。
- 整理简历，开始投递。
- 模拟面试，复盘每一场真实面试。

## 没找到的、不确定的
- 没找到专门写"已经在职、一年内换后端岗位"的完整路线，读到的多是零基础、校招或泛指南。
- 第二种走法，我只有一份个人经历和一份偏大型科技公司的转岗指南[4][5]，不一定适用于你的公司。
- 第三种走法，我只读到一份讲怎么比较的文章[2]。具体课程的大纲、价格、时长，都没有读到。
- 三种走法的时长都是猜测，没有找到哪份资料给出可靠的统计。
- 不知道你现在做什么工作、在国内还是海外，所以三种走法对你各自可不可行，我无法判断。
- 第一种走法的例子主要用 Java（JavaGuide），其他语言只有路线图的概述[3]。

## 出处
1. Java 后端学习路线（2026 最新版）| JavaGuide — https://javaguide.cn/roadmap/java-roadmap.html （读过，只读到前一部分）
2. Degree vs bootcamp vs self-taught: evidence and tradeoffs | Software Engineer Careers — https://softwareengineercareers.com/career-paths/degree-bootcamp-self-taught/ （读过）
3. Backend Developer Roadmap | roadmap.sh — https://roadmap.sh/backend （读过）
4. From Frontend to Backend: How I Transitioned Across the Stack in a Real Product Team | DEV Community — https://dev.to/ninariccimarie/from-frontend-to-backend-how-i-transitioned-across-the-stack-in-a-real-product-team-3d8d （读过）
5. The Engineer's Guide to Internal Transfers | Wrok Blog — https://www.wrok.app/blog/engineer-internal-transfer-guide-2026 （读过，只读到前一部分）
6. 2026 最新版 Java 后端面试通关计划 | JavaGuide — https://javaguide.cn/interview-preparation/backend-interview-plan.html （读过）