# 模块宿主：模块自己的后台、模块之间的桥、状态怎么刷、路由怎么写

> 状态：v0.1 草稿（2026-11-26），**待 Bruce 看**。还没有代码。
> 起因：2026-11-26 对最近几个 PR（#14–#26）的架构检查，发现第 1 节这几处。
> 依据：`docs/ARCHITECTURE.md` §5.8（模块契约）、§9.1（不写死）；`packages/module-kit/src/index.ts`；`packages/server/src/{cli,home,http,passes,notes,note-compile,note-todos,todo-sources}.ts`。
>
> 标记：**【事实】** 读过代码；**【建议】** 本文的提案；**【待定】** 第 7 节。

## 0. 结论

1. 模块契约（`ZirmaModule`）现在只管「被叫到时做什么」：操作、工具、快照、同步、投递。模块**自己要一直做的事**（看文件夹、定时跑任务、跟着别的模块的事件动）没有地方放，于是都写进了 `packages/server`，并且靠 `id === "note"` 加 `as unknown as` 找到模块。
2. 【建议】契约加三样，都由主节点统一调度，模块只说「做什么」：
   - `start(host) → stop`：模块自己的后台（看文件夹）。
   - `reactions`：在某些事件之后做一件事（待办勾了，笔记里的方框跟着勾）。
   - `jobs[*].due(world, now)`：后台任务什么时候该跑；主节点每 30 秒问一遍，到了就按任务自己的能力档起一个 run。
3. 【建议】两个模块之间的事（笔记和待办、日历和待办）写成**桥**：一个小文件，声明它连哪两个模块，只用两边公开的函数，由主节点装上。server 不再认识任何具体模块。
4. 【建议】`/api/state` 只在模块的快照**真的变了**时才重算：每个模块记一个版本号，它自己的事件来了才加一。
5. 【建议】HTTP 路由改成一张表，每条写明谁能调（本机、配对设备、要开发权限）和请求体的 schema；检查由表统一做，不再每条路由手写。

做完以后，私有模块（§5.8 说的求职、外联……）能用和自带模块一模一样的方式接进来。

## 1. 现状

【事实】

| 地方 | 做的事 | 问题 |
|---|---|---|
| `server/src/note-compile.ts` | 每 30 秒看笔记的整理该不该跑，起 run | 只认 `note` 模块和它的 `jobs.compile`；`ZirmaModule.jobs` 的注释说「由宿主代码启动」，等于每个 job 都要在 server 里手写一个调度器 |
| `server/src/notes.ts` | 看笔记文件夹的变化、保存页面的专用地址 | 文件监听是笔记模块的事，写在 server 里 |
| `server/src/note-todos.ts` | 笔记和待办互相勾 | 两个模块之间的事，server 同时 import 两个模块 |
| `server/src/todo-sources.ts` | 日历事件变成待办 | 同上 |
| `server/src/cli.ts` | 列出五个模块；`onMoved` 回调把笔记改名告诉待办 | 模块列表和模块之间的接线都写死在启动文件里 |
| `server/src/http.ts` `state()` | 每次请求把**所有**模块的快照算一遍，再 `JSON.stringify` 加 sha1，只为了判断要不要发 | 设备每收到一个事件 120ms 后就来拉一次（`ui/src/useZirma.ts`）；写笔记时每 2 秒一个 `note.saved`，每台开着的设备都让日历、邮件、链接、笔记的快照全部重算 |
| `server/src/http.ts` `route()` | 约 300 行 if 加正则，58 处判断；23 处 `needDev` / `peer.local` 内联检查 | 新加一条路由时很容易漏掉权限检查；请求体手写校验，TypeBox 已经在依赖里 |

`packages/server/package.json` 依赖全部五个模块；`as unknown as` 在 module-kit 里有 14 处，server 里找模块的地方各有一处。

## 2. 模块自己的后台

【建议】`ZirmaModule` 加：

```ts
/** 主节点启动后调一次；返回的函数在关闭时调。只做模块自己的事：看它的文件夹、开它的定时器。 */
start?(host: ModuleHost): () => void;

/** 在这些事件之后（事务提交以后，不在事务里）做一件事。主节点合并同一刻的多个事件，一次调一回。 */
reactions?: ReadonlyArray<{ after: readonly string[]; run(world: World, kinds: ReadonlySet<string>): void }>;

interface ModuleJob {
  instructions: ...; tools: ...;
  /** 这个任务现在该不该跑；该跑就给出这一次的目标。主节点每 30 秒问一次，同一个任务同一时间只有一个 run。 */
  due?(world: World, now: number): { goal: string; title: string } | null;
  /** run 起了以后告诉模块，它记下自己的状态。 */
  started?(world: World, runId: string): void;
}

interface ModuleHost {
  world: World;
  log(message: string): void;
  /** 让主节点马上问一遍 jobs 的 due，不等 30 秒（用户在对话里说「开一页」）。 */
  wake(): void;
}
```

- 主节点统一负责：定时、「同一任务只有一个 run」（用 core 的 `isRunUnfinished`）、run 的对话标题和归档、出错写日志。
- `note-compile.ts` 里的判断（安静 5 分钟、每天一次、被叫到）挪进笔记模块的 `due`。
- `notes.ts` 里的文件监听挪进笔记模块的 `start`。
- 保存页面的专用地址（不走操作，免得自动保存把正文抄进事件日志）保留，但改成模块声明的 `routes`（第 5 节），不再是 server 里的特例。

## 3. 模块之间的桥

【建议】

```ts
// modules/bridges/note-todo.ts（或者放在 todo 模块里，见第 7 节）
export const noteTodoBridge = defineBridge({
  between: ["note", "todo"],
  reactions: [{ after: ["todo.completed", "todo.updated", "todo.added"], run(world) { ... } }],
  start(host) { ... },   // 启动时对一遍账
});
```

- 桥只调两边模块**导出的函数**，不读对方的表（这条和现在一样）。
- 主节点只装「两头都在」的桥：少一个模块，桥就不装，不报错。
- `cli.ts` 里的 `onMoved` 回调、`note-todos.ts`、`todo-sources.ts` 都变成桥。
- 有了桥，`createNotesModule` 返回的额外方法（`library`、`indexChanged`）只给桥和模块自己的路由用，server 不用再按 id 找模块、也不用强转。

## 4. 状态刷新

【建议】

- 每个模块声明 `snapshotAfter: readonly string[]`：哪些事件会改它的快照（默认：以它自己 id 开头的事件）。
- 主节点给每个模块记一个版本号，这些事件提交后加一。`/api/state?have=<模块:版本>` 里版本没变的模块**不重算**，直接跳过。
- 现在的 sha1 留作兜底：版本号变了但内容没变时，照样不发。
- 效果：写笔记时只有笔记的快照重算；日历、邮件、链接不动。

## 5. 路由表

【建议】

```ts
route({ method: "POST", path: "/api/runs", access: "device", body: SubmitRunSchema, dev: (body) => isSession(world, body.conversationId) }, handler);
```

- `access`：`local`（只有这台 Mac）、`device`（配对设备也行）；`dev` 说这一条要不要开发权限。
- 进 handler 之前统一做：权限、`readJson` 加大小上限、schema 校验，错误统一成 400 / 403。
- 模块也能用同一个 `route` 声明自己的地址（笔记的保存、附件）。
- 一次挪一组路由，每组挪完测试照样过；不一次重写。

## 6. 用户能自己建什么、改什么

这份是内部结构，用户看不到。和用户有关的只有一条：私有模块（自己写的）能用同样的契约接进来，包括后台任务和桥；契约以外不需要改 Zirma 的代码。

## 7. 待定

1. 桥放在哪：单独一个 `modules/bridges/`，还是放进「依赖的那一方」（笔记和待办的桥放进 todo）？【建议】先放进 todo 和笔记各自的目录里一个 `bridges.ts`，等桥多了再单独放。
2. `reactions` 出错时要不要重试？【建议】第一版只写日志；需要「一定送到」的（比如对外改动）照旧走对外队列。
3. 顺序：【建议】先做第 2、3 节（去掉 server 里的模块特例），再做第 4 节（性能），最后第 5 节（路由，量最大、风险最小，可以慢慢挪）。
