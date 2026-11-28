# 路线：学会线性代数，到能看懂机器学习论文里的推导

## 别人一般是怎么走到的

我找到三种走法，区别在于"先学什么、用什么方式学"。三种都有公开材料可查，不分高低。

### 先看图像，再读机器学习专用的书
**这条路是什么样** 先用动画把"矩阵是对空间的一次变形"这幅画面建立起来，再直接进入专为机器学习写的数学书，边读边补算。书里的线性代数只是其中一部分，后面紧接着是矩阵分解、向量微积分、概率和优化 [3]。这像去陌生城市前先看航拍，再拿一张只标主干道的地图。
**代价** 动画不要求你动笔，看懂了不等于会算。专用书写得短，不少细节要自己另找材料补 [3]。
**靠什么** 3Blue1Brown《Essence of linear algebra》，共 16 个视频，从向量讲到特征值 [1]（https://www.3blue1brown.com/lessons/eola-preview/ ，章节表见 https://essence-of-linear-algebra.vercel.app/ ）。《Mathematics for Machine Learning》，PDF 免费，配有 Jupyter 练习 [3]（https://mml-book.github.io/ ）。
**大约多久** 猜测：每周几小时的话，两到四个月读到书的第一部分结束。

### 照着一门大学课，从头学扎实
**这条路是什么样** 跟着一门完整的大学线性代数课走，看讲课视频、读指定教材、做习题。MIT 18.06 的目标是"会用矩阵，也懂矩阵"，内容包括消元、四个基本子空间、最小二乘、特征值、对称与正定矩阵，最后连到 SVD [2]。这像在驾校按全套教程学开车，路上遇到什么都不慌。
**代价** 这门课按大学生的节奏设计，每周要上 3 次课，还要做作业和考试 [2]。其中有些内容，如行列式的完整公式，机器学习论文里不常用。它本身也不讲矩阵求导。
**靠什么** MIT OCW 18.06 的视频、习题与解答 [2]（https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/ ）。教材是 Strang 的《Introduction to Linear Algebra》[2]。
**大约多久** 猜测：每周约 5 到 8 小时，要四到六个月。

### 从应用和计算入手，边做边学
**这条路是什么样** 选一本从数据和应用出发的教材，向量、矩阵、最小二乘这些概念一出现就配上代码。VMLS 只用一个理论概念（线性无关）和一种计算工具（QR 分解），大多数应用靠最小二乘完成 [4]。这像先学做家常菜，用得多了自然懂原理。
**代价** 它讲的数学比一般教材少，特征值与 SVD 这类论文常用内容，要另外补 [4]。本页没有核对它的目录。
**靠什么** Boyd 和 Vandenberghe 的《Introduction to Applied Linear Algebra》，书、讲义、讲课视频和 Julia、Python 配套代码都在网上 [4]（https://web.stanford.edu/~boyd/vmls/ ）。
**大约多久** 猜测：三到五个月，每周几小时。

## 眼前这一段（以第一种走法为例）

### 第 1 步：用动画建立"矩阵是变形"的画面
**做什么** 按顺序看《Essence of linear algebra》第 1 到 4 章。这几章讲向量、基、线性变换，以及矩阵乘法为什么是"先后做两次变形" [1]。
**为什么走这一步** 论文里的每行公式都由向量和矩阵构成。先有画面，后面读符号时才知道它在说什么。
**用什么走**
- 第 1 到 4 章，每章约 10 分钟：https://essence-of-linear-algebra.vercel.app/ 。
- 第 3 章的文字版：https://www.3blue1brown.com/lessons/linear-transformations/ 。

### 第 2 步：看完特征值与基变换那几章
**做什么** 接着看第 7、9、13、14 章，分别是逆矩阵与零空间、点积、基变换、特征向量 [1]。第 5、6、8、10 至 12、15 章可以先放着，之后需要时再回头。
**为什么走这一步** 这几章对应论文里最常出现的几样东西：秩与零空间、内积、特征分解。
**用什么走**
- 同一份章节表：https://essence-of-linear-algebra.vercel.app/ 。

### 第 3 步：开始读书的第一部分
**做什么** 打开《Mathematics for Machine Learning》，读"Linear Algebra"和"Analytic Geometry"两章。遇到看不懂的地方，回头找对应的视频章节。
**为什么走这一步** 动画没有符号，书里的符号和论文里的一样。这一步是第一次把画面和写法对上 [3]。
**用什么走**
- 书的 PDF 与习题：https://mml-book.github.io/ 。
- 网页上"Additional exercises (with solutions)"一栏，是带答案的额外习题 [3]。

### 第 4 步：读矩阵分解一章
**做什么** 读书里的"Matrix Decompositions"一章，里面有特征分解和 SVD [3]。如果想要代码，可以试 PCA 的 Jupyter 练习，它用到了这些内容 [3]。
**为什么走这一步** 论文里的"把矩阵拆开"几乎都在这一章。读完它，线性代数这一块的主体就齐了。
**用什么走**
- 同一本书的第 4 章，和 PCA 的 Jupyter 练习：https://mml-book.github.io/ 。

## 后面的段
- 向量微积分与矩阵求导：书的"Vector Calculus"一章，以及 MIT 的矩阵微积分课 [3]。
- 概率与连续优化：书的后两章 [3]。
- 在回归、PCA 等经典模型中走一遍完整推导：书的第二部分 [3]。
- 换到真正的论文，从推导较短的开始。

## 没找到的、不确定的
- 没找到有人对比这三种走法、并说明哪种更快的研究。三段时间都是我的猜测。
- 三种走法有重叠，比如第一种的书也可以换成别的。我没有找到某种走法的实际完成率。
- 3Blue1Brown 的页面我只读到了标题和章节表，视频内容和时长来自搜索摘要，没有看过视频。
- 我读的是 VMLS 的主页，没有打开全书，所以目录没有核对。
- MIT 18.06 的页面我读到了课程目标和教材，没有读到视频清单。

## 出处
1. Essence of linear algebra preview | 3Blue1Brown — https://www.3blue1brown.com/lessons/eola-preview/ (读过)；章节表：3Blue1Brown - Essence of Linear Algebra Full Course — https://essence-of-linear-algebra.vercel.app/ (读过)
2. Syllabus | Linear Algebra | MIT OpenCourseWare — https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/pages/syllabus/ (读过)
3. Mathematics for Machine Learning（配套网页）— https://mml-book.github.io/ (读过)
4. Introduction to Applied Linear Algebra – Vectors, Matrices, and Least Squares — https://web.stanford.edu/~boyd/vmls/ (读过)；"只用一个理论概念"一句来自 PDF 搜索摘要：http://vmls-book.stanford.edu/vmls.pdf (只看了摘要)