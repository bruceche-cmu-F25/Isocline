# 路线：学会线性代数，到能看懂机器学习论文里的推导

## 别人一般是怎么走到的

我找到了三种做法，区别在于"先学什么、用什么当主线"。

### 先学完整的线性代数课，再接机器学习
**这条路是什么样** 先把一门完整的线性代数课从头看到尾，例如 MIT 的 18.06。这门课从解方程组讲起，一路讲到列空间、零空间、独立、基和维数、四个基本子空间 [1]。学完之后再接一门面向机器学习的后续课，例如 MIT 的 18.065。它的简介说，这门课是复习线性代数，再讲它在概率统计和优化里的用法，最后完整解释深度学习 [2]。
**代价** 战线最长。前半段的很多内容（比如手算消元）不一定会出现在论文里，要很久才能碰到机器学习。
**靠什么**
- MIT 18.06 讲座目录：https://web.mit.edu/18.06/www/lectureproject/lecture.html?18.06
- MIT 18.065 课程页：https://ocw.mit.edu/courses/18-065-matrix-methods-in-data-analysis-signal-processing-and-machine-learning-spring-2018/
- Strang 的主页，列有两门课的视频和教材：https://math.mit.edu/~gs/

**大约多久** 猜测：业余时间约半年到一年。

### 用"机器学习的数学"一本书，边学边对着用
**这条路是什么样** 这本书的作者说，它不讲高深的机器学习，只给出读其他机器学习书所需的数学 [3]。第一部分是数学基础：线性代数、解析几何、矩阵分解、向量微积分、概率、优化。第二部分是用这些数学做的例子：线性回归、PCA 等 [3]。这条路是顺着书走，并配上网上的 Jupyter 练习本。
**代价** 书写得短，很多地方一带而过 [3]。卡住时往往要自己去找别的材料补。
**靠什么**
- 书的主页，PDF 可免费下载，并附练习本：https://mml-book.github.io/
- 书的 PDF：https://mml-book.github.io/book/mml-book.pdf

**大约多久** 猜测：约三到六个月。

### 先看图像直观，再补做题
**这条路是什么样** 先看 3Blue1Brown 的线性代数系列视频，目的是把"矩阵是对空间的变形"这个画面建立起来。他的站点把线性代数列为单独的一类 [4]。有人推荐的组合是 3Blue1Brown 加 MIT 18.06 和 18.065，另外还有 Coursera 上的几门机器学习数学课 [5]。画面有了之后，再用上面两种走法里的材料去做题和推导。
**代价** 光看视频容易"觉得懂了"，其实动不了笔。如果不另外找材料做推导，它不能单独走到读论文。
**靠什么**
- 3Blue1Brown 线性代数：https://www.3blue1brown.com/topics/linear-algebra
- 一份课程与书的汇总：https://samaustinai.com/best-linear-algebra-courses-books-machine-learning

**大约多久** 猜测：视频部分约一到两周，之后接上另一条路。

## 眼前这一段（以第一种走法为例）

只排最前面的一段。

### 第 1 步：先看懂方程组的"画面"
**做什么** 看 18.06 的第一讲。讲的是一组方程怎么看成几条线或几个面相交，也可以看成几个向量怎么拼出目标 [1]。看完用自己的话复述一遍。
**为什么走这一步** 后面所有"矩阵乘向量"都是这个画面的延伸。
**用什么走**
- 18.06 讲座目录，第 1 讲 The Geometry of Linear Equations：https://web.mit.edu/18.06/www/lectureproject/lecture.html?18.06

### 第 2 步：消元、乘法与逆
**做什么** 接着看第 2、3 讲：消元、矩阵乘法和逆矩阵 [1]。试着自己动手解几个小方程组。
**为什么走这一步** 这是你的世界观里"向量与矩阵、乘法、逆"那一块。论文里最常见的动作就是对这些乘法换顺序、合并。
**用什么走**
- 同一份讲座目录：https://web.mit.edu/18.06/www/lectureproject/lecture.html?18.06

### 第 3 步：转置与空间
**做什么** 看第 5、6 讲：转置、列空间和零空间 [1]。
**为什么走这一步** 列空间是"矩阵能产生哪些结果"，这是后面讲秩和基的起点。
**用什么走**
- 同一份讲座目录：https://web.mit.edu/18.06/www/lectureproject/lecture.html?18.06

### 第 4 步：独立、基与维数
**做什么** 看第 9、10 讲：独立、基、维数，以及四个基本子空间 [1]。
**为什么走这一步** 到这里，第一段的"基本语言"和"空间的结构"就走完了，之后才是分解。
**用什么走**
- 同一份讲座目录：https://web.mit.edu/18.06/www/lectureproject/lecture.html?18.06

## 后面的段
- 第二段：正交、投影、特征值与特征向量。
- 第三段：SVD 与 PCA。
- 第四段：矩阵与向量的求导（梯度、雅可比）。
- 第五段：换成论文，对着推导读。

## 没找到的、不确定的
- 18.06 的讲座目录我只看到搜索摘要，列出的是前 11 讲左右，所以第 1 到 10 讲的内容是摘要里有的。后面的讲次没有看到。
- 3Blue1Brown 的页面我读到了，但页面只有分类名，没有视频清单和时长。
- 三种走法的时长都是我的猜测，没有找到来源给出的数字。
- 没有找到"学到哪一步就能读论文"的统一说法。
- 没有找到专门讲"怎样读论文里推导"的材料，也没有测试过 18.06 的前几讲是否符合你的基础。

## 出处
1. 18.06: Linear Algebra Lectures by Gilbert Strang, MIT（搜索摘要）— https://web.mit.edu/18.06/www/lectureproject/lecture.html?18.06
2. Matrix Methods in Data Analysis, Signal Processing, and Machine Learning, MIT OCW（搜索摘要）— https://ocw.mit.edu/courses/18-065-matrix-methods-in-data-analysis-signal-processing-and-machine-learning-spring-2018/
3. Mathematics for Machine Learning（书的主页）— https://mml-book.github.io/
4. 3Blue1Brown, Linear Algebra — https://www.3blue1brown.com/topics/linear-algebra
5. Best Linear Algebra Courses and Books for Machine Learning（搜索摘要）— https://samaustinai.com/best-linear-algebra-courses-books-machine-learning