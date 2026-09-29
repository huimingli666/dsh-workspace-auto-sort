# dsh-workspace-auto-sort

为 DSH（DeepSeek Harness）Web / 桌面端新增**工作区自动排序**：会话收到新的用户消息时，
自动把侧边栏的各个工作区按「子会话最后一条用户消息时间」降序持久化重排——刚被使用的
工作区上浮到最前，且顺序在重启后保留。

DSH 原生的「排序方式：手动 / 最近更新」只作用于**工作区组内会话**；工作区分组本身的顺序
是 registry 的持久化有序列表，只能手动拖拽调整。本插件补上缺失的"按活动自动排列工作区"。

## 功能

- 监听宿主 `session/event`，按 `activity` 口径刷新「会话 → 最后活动时间」
  （默认 `'prompt'`：只认用户自己发的消息，与 GUI「刚刚 / N 分钟」标签同口径）；
- 排除 `origin === 'subagent'` 的隐藏子代理会话（与 GUI 可见口径一致，后台代理的写入
  不会扰动可见排序）；
- 活动事件经防抖窗口（默认 750ms）合并后触发一次重排计算；
- 通过官方 `workspaceRegistry.insertBefore(id, beforeId)` 应用重排——与**手动拖拽同一条
  持久化通道**，每步都落盘并自动触发 `host/workspace-changed` 广播，GUI 立即刷新，
  无需任何浏览器端注入（本插件没有浏览器半面）。

## 排序规则

1. **参与范围**：默认 `scope: 'all'`——侧边栏里看到的所有工作区一起按 recency 排序
   （嵌套显示只是 GUI 的可选视图选项，路径嵌套的工作区同样参与）。可配置
   `scope: 'outermost'` 只排没有已注册路径祖先的顶层工作区：此时嵌套子工作区**从不**
   出现在任何移动里（既不作为移动源也不作为锚点），其在父目录内的相对顺序保持不变；
2. **rank**：每个工作区取其挂账会话的最新活动时间；未知活动逐级兜底
   （活动时间 → 磁盘会话头 `createdAt` → 0），启动时从 `sessionPersistence.list()`
   播种兜底表（服务未就绪时延迟 15s 重试一次）；
3. **活动口径**：默认 `activity: 'prompt'`——只有**用户自己发的消息**刷新 recency，
   与 GUI 里「刚刚 / N 分钟」标签完全同口径，长跑的后台任务/工具活动不会霸占第一名；
   可配置 `activity: 'any'` 恢复"任一提交事件"口径（运行中会话会把所属工作区持续顶在最前）；
4. **稳定排序**：rank 相同保持现有相对顺序；空工作区（无挂账会话）稳定沉底；
5. **最少移动**：在参与子序列上模拟固定前缀推进，生成 ≤ m-1 条 `insertBefore` 移动；
   已有序时为零移动、零写入。

## 安全模型 / 容错（fail-degrade）

- 启动时**不**主动重排——只响应真实活动变化，重启不会突然跳序；
- 会话监听以 `{ global: true }` 注册：不受 cordis scope 过滤影响，agent 作用域内的
  会话事件一样计入活动（随后按 origin 排除隐藏的 subagent 会话）；
- `workspaceRegistry` 不存在（异常 profile）→ 记一次警告后休眠，不拖垮宿主；
- 移动失败（如工作区被并发删除）→ 记警告中止本轮，下次活动从最新快照重新规划；
- 单向数据流：插件不写任何会话数据，重排只触发 workspace 广播，不会反向产生会话事件，
  无反馈回路；
- 配置非法（`debounceMs` 非非负整数）在加载时直接抛错（fail loud）。

## 诊断与手动触发（loopback-only）

诊断路由与宿主其它插件走同一套信任篱笆（loopback socket + loopback Host + 同源标记），
仅接受本机回环请求：

```bash
# 流水线状态：监听计数、各工作区 rank、最近一轮计划/错误
#（每轮重排同时落盘到 ~/.dsh/logs/dsh-workspace-auto-sort.log，含 rank 快照与移动）
# <端口> 换成你的 dsh web 实例实际监听端口
curl http://127.0.0.1:<端口>/api/dsh-workspace-auto-sort/status

# 立即强制执行一轮重排（不等会话活动），返回应用的移动
curl -X POST http://127.0.0.1:<端口>/api/dsh-workspace-auto-sort/reorder
```

`status` 响应不携带任何会话内容，只有 id、计数、时间戳与工作区元数据。

## 安装与激活

先把仓库克隆到本地任意目录（以下用 `<克隆目录>` 指代）：

```bash
git clone https://github.com/huimingli666/dsh-workspace-auto-sort.git
cd dsh-workspace-auto-sort
```

### dsh web（CLI profile，`dsh plugin` 可直接管理）

```bash
dsh plugin --profile web add link:"$PWD"

# 验证已装载
dsh --profile web --dump-config | grep workspace-auto-sort

# 重启 dsh web 生效，浏览器刷新页面
```

### DSH desktop 桌面端（`desktop` profile 由 Electron 应用独占管理，手动复刻 link 安装）

`dsh plugin --profile desktop add` 会被拒绝（`profile "desktop" is managed exclusively
by the Electron application`），按既有 link 插件的装法手动做三步：

```bash
# 1. 在 desktop profile 的 node_modules 下创建指向克隆目录的符号链接
mkdir -p ~/.dsh/profiles/desktop/node_modules/@dsh-plugins
ln -s <克隆目录>/dsh-workspace-auto-sort \
      ~/.dsh/profiles/desktop/node_modules/@dsh-plugins/dsh-workspace-auto-sort

# 2. 编辑 ~/.dsh/profiles/desktop/package.json，dependencies 增加：
#    "@dsh-plugins/dsh-workspace-auto-sort": "link:<克隆目录>/dsh-workspace-auto-sort"

# 3. 同文件 dsh.profile.bundles 数组末尾追加 "@dsh-plugins/dsh-workspace-auto-sort"

# 重启桌面端生效
```

激活后：在任意工作区里跑一个会话 → 该工作区（的最外层分组）自动上浮；重启 dsh 后顺序保留；
手动拖拽的顺序会在下一次会话活动时被重新排序（这正是"自动排列"语义），关闭插件即恢复纯手动。

## 配置

组合入口可覆盖的合成条目配置（`defaultConfig`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时不挂监听、不读持久化、不重排 |
| `debounceMs` | `750` | 活动事件合并窗口（非负整数） |
| `activity` | `'prompt'` | recency 口径：`'prompt'` 只认用户自己发的消息（与 GUI 标签一致）；`'any'` 认所有提交事件 |
| `scope` | `'all'` | 参与排序的范围：`'all'` 全部工作区；`'outermost'` 仅路径树最外层（嵌套项钉住不动） |
| `logFile` | `''` | 重排轮日志路径；`''` = `~/.dsh/logs/dsh-workspace-auto-sort.log`；`'off'` 关闭 |
| `announceToAgent` | `false` | 是否向模型通告本插件（纯 UI 行为，默认不占上下文） |

## 目录布局

```
package.json       宿主单面插件包（无 ./client 导出）
cordis.patch.yml   web profile 插入行
src/index.js       宿主接线（监听、防抖、播种、串行重排链、fail-degrade）
src/sort.js        纯逻辑：路径归一/祖先判定/rank/目标顺序/移动序列（可单测）
test/              node:test 单测（纯逻辑全分支 + 假 ctx 接线冒烟）
```

## 测试

```bash
node --test test/*.test.js    # 32 个用例：排序逻辑 + 接线冒烟
```

## 限制

- 手动拖拽与自动排序互斥：活动一到，拖拽结果会被重排（`enabled: false` 可关闭）；
- 冷会话（宿主进程内从未运行过）的排序精度取决于磁盘会话头的 `createdAt`；
  其真实"最后活动时间"要等它下次运行产生事件后才会被感知；
- 「最后运行时间」口径是**任一提交事件**（比 GUI「最近更新」的"最后一条用户消息"口径更广：
  工具结果、后台 job 写入都会刷新时间）；
- 版本兼容：插件不锁宿主版本，但在 dsh 0.1.x 上开发与测试；依赖宿主具备
  `workspaceRegistry.insertBefore`（DOM 式插入语义，移动规划算法建立在其上）、
  `sessionPersistence.list()`、`session/event` 的 `{ global: true }` 监听、
  `webServer.register`（`kind: 'exact'` 路由）与 package.json 的 `dsh.bundle.patch`
  装载机制（官方 web profile 默认具备）。更早版本未验证；缺失关键服务时插件
  降级休眠而非报错。Node 运行时要求见 `engines`（`^22.0.0 || >=24.0.0`）。
