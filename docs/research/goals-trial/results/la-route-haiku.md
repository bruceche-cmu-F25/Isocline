# 路线：学会线性代数，到能看懂机器学习论文里的推导

## 别人一般是怎么走到的

我找到两种走法有真实资料支撑，第三种只有一篇博客的大纲，列在最后。这两种的区别在于先学什么、用什么方式学，不在于细节多少。

### 先看图建立直觉，再回到算法
**这条路是什么样** 先看一组以画图为主的视频，让向量、矩阵、变换在脑子里有形状，再去学计算和证明。3Blue1Brown 的系列是这类路线最常被提到的入口，它用可视化讲核心概念，不靠大量推导。[3]

**代价** 视频主要给直觉，不会让你熟练做题。看完之后，你仍然需要自己动手算，否则看懂的感觉容易变成错觉。这条路在视频之后还得另找练习材料。

**靠什么** 3Blue1Brown《Essence of linear algebra》播放列表，16 个视频，视觉优先的入门课程。[3] 按播放列表统计，全部时长约 3 小时 1 分钟。[4] 地址：https://www.youtube.com/playlist?list=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab

**大约多久** 猜测：看视频本身几天，加上之后的练习，一两个月。

### 直接按教材章节读，边读边做题
**这条路是什么样** 选一本为机器学习准备的数学教材，从线性代数那一章开始，按章节读、做习题。这本书的目的很明确：提供读其他机器学习书所需的数学技能，而不是讲高级算法。[2] 它的第一部分“数学基础”里，第二章就是线性代数。[2]

**代价** 教材比视频密，前期会更慢，也更依赖习题和耐心。它的章节顺序是按机器学习需要来排的，但你要自己判断哪些地方可以快读。

**靠什么** 《Mathematics for Machine Learning》（Deisenroth、Faisal、Ong），官网提供免费 PDF，并附带习题答案的获取途径和配套的 Jupyter 教程。[2] 地址：https://mml-book.github.io/

**大约多久** 猜测：按每晚一两小时，线性代数部分需要两到四个月。

### 按每天固定时长的 12 周时间表
**这条路是什么样** 一位博主给出一个 12 周的时间表，每天 45 到 60 分钟，按主题推进：先向量和矩阵运算，再线性方程组、线性无关与基，再到线性变换、行列式、特征值，最后内积、正交与最小二乘。[1] 这条路线的特点是用时间表管住节奏，不指定具体教材。

**代价** 它只给了主题顺序，没有指定书或视频，你需要自己选资源。它的推荐是通用线性代数教材，并没有专门针对机器学习论文的部分。[1] 作者在文中也建议只用一本主教材，避免资料过多。[1]

**靠什么** Free Mathematics Books 博客的自学路线文章。[1] 地址：https://freemathematicsbooks.substack.com/p/how-to-self-study-linear-algebra

**大约多久** 文章自己给的是 12 周。[1]

## 眼前这一段（以第一种走法为例）

### 第 1 步：先看向量和线性组合
**做什么** 看 3Blue1Brown 播放列表的前两集，把向量理解成空间里的箭头，再看线性组合和张成。看的时候在纸上自己画几个二维例子，不要只看。
**为什么走这一步** 向量是后面所有东西的基础，论文里的数据、参数都是向量。这一步不需要任何数学前置，正适合现在开始。
**用什么走**
- 3Blue1Brown《Essence of linear algebra》前两集：用画面讲向量与线性组合，适合建立第一印象。[3] https://www.youtube.com/playlist?list=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab

### 第 2 步：看矩阵作为变换
**做什么** 继续看播放列表中讲线性变换的几集，理解一个矩阵如何把整个平面“拉伸、旋转、压缩”。看完后，试着用纸笔算一个具体矩阵作用在一个点上的结果。
**为什么走这一步** 神经网络每一层的主要计算就是乘矩阵，理解变换，才知道层在做什么。这一步是从“看懂图”走向“看懂式子”的桥。
**用什么走**
- 3Blue1Brown 播放列表中关于线性变换的集：用动画展示矩阵如何改变空间。[3]

### 第 3 步：对照教材的线性代数章节
**做什么** 打开《Mathematics for Machine Learning》的线性代数章节，只读其中与前两步相同的定义和例子，把视频里的直觉对应到书中的符号上。
**为什么走这一步** 论文里用的是书面符号，视频里没有这些写法。现在对照，符号就不会在后面变成障碍。
**用什么走**
- 《Mathematics for Machine Learning》第二章线性代数：提供机器学习语境下的正式定义与符号。[2] https://mml-book.github.io/

### 第 4 步：做一组纸笔习题
**做什么** 从教材的习题里挑几道关于线性相关和矩阵乘法的题，不看答案先自己算，算完再核对。
**为什么走这一步** 视频和阅读都会产生看懂的错觉，只有亲手算出结果，理解才会留下。这个习惯在两种走法里都是共同的。[1]
**用什么走**
- 《Mathematics for Machine Learning》的习题：配套有习题答案的获取途径，可在卡住时核对。[2]

## 后面的段
- 特征值、特征向量与对角化：论文中降维和稳定性推导的核心，等你走到这里再展开。
- 内积、投影与最小二乘：连接线性代数与数据拟合，等前面的变换和矩阵掌握后再看。
- 奇异值分解与矩阵求导：论文里最常见的两类工具，等基础稳定后再逐步补上。

## 没找到的、不确定的
- 我没有找到一份专门为“读懂机器学习论文”设计的标准路线，上面的几条都是通用线性代数学习路径，或是为机器学习准备的教材。
- 我没有读到 MIT 线性代数课程的完整大纲，所以没有把大学课程作为一条独立的走法列出。
- 各资料对“必须掌握的范围”说法不一，例如矩阵求导放在哪一部分，安排各不相同。
- 我查到的“大约多久”大多是博客或猜测，不是经过验证的数据。

## 出处
1. How to Self-Study Linear Algebra in 2026: The Definitive Roadmap & Free Resources — Free Mathematics Books — https://freemathematicsbooks.substack.com/p/how-to-self-study-linear-algebra
2. Mathematics for Machine Learning（companion webpage） — https://mml-book.github.io/
3. Essence of linear algebra — 3Blue1Brown（YouTube 播放列表） — https://www.youtube.com/playlist?list=PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab
4. Essence of linear algebra — 3h 1m total, 16 videos — https://playlistduration.com/playlist/PLZHQObOWTQDPD3MizzM2xVFitgF8hE_ab