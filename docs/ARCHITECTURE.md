# 架构说明

本文记录 `xianyu-local-agent` 的分层结构、数据流、接口协议、本地存储与 PWA 缓存策略，以及两个小游戏的实现要点。内容依据仓库当前代码（`index.html`、`js/app.js`、`sw.js`）整理；`server/` 的实现以 `server/server.py` 为准。

> 实验性项目，架构以「能跑、够简单」为第一目标，不追求工程规范。

## 1. 总体分层

```
┌──────────────────────────────────────────────┐
│  浏览器（同一台机器）                          │
│                                              │
│  index.html ── css/style.css                 │
│       │                                      │
│       └── js/app.js  （单文件，按 IIFE 分区）  │
│              │  fetch /api/health            │
│              │  fetch /api/system            │
│              │  POST /api/chat  (SSE)        │
│              ▼                               │
│  Service Worker (sw.js)                      │
│    · 缓存外壳：/、index.html、图标、manifest    │
│    · /api/* 直接放行，不缓存                   │
└──────────────┬───────────────────────────────┘
               │ HTTP（本机回环，默认 127.0.0.1:8000）
┌──────────────▼───────────────────────────────┐
│  server/server.py                             │
│    · 标准库 http.server                       │
│    · 静态文件路由（页面壳）                     │
│    · /api/health、/api/system、/api/chat       │
│    · /api/chat 以 SSE 逐 token 推回            │
│              │                               │
│              ▼                               │
│  llama-cpp-python + models/*.gguf            │
│  （Qwen2.5-1.5B-Instruct Q4_K_M ≈ 1.1 GB）    │
└──────────────────────────────────────────────┘
```

分层职责：

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 外壳 / 视图 | `index.html` | 聊天列表、输入区、设置抽屉、五子棋与 2048 全屏面板 |
| 表现 | `css/style.css` | 全部样式、面板与动画 |
| 逻辑 | `js/app.js` | 渲染、SSE 消费、复读检测、存储、两个游戏的规则与 AI |
| 离线外壳 | `sw.js` | 预热缓存、导航网络优先、静态资源缓存优先 |
| 清单 | `manifest.webmanifest` | PWA 名称、图标、`display: standalone` |
| 推理服务 | `server/server.py` | 提供页面与 `/api`，封装 llama.cpp 推理 |
| 模型 | `models/*.gguf` | 不进仓库，由 `server/download-model.sh` 下载 |

没有前端框架、没有打包器：`index.html` 直接 `<script src="js/app.js">`，改完刷新即生效。

## 2. 前端模块分区（`js/app.js`）

单文件约 1200 行，靠注释分成几块：

1. **常量与人设**：`LS`（存储键）、`PERSONAS`（人设 prompt、开场/收尾语、特征词）、`wrapPersona()`
2. **工具函数**：`estimateTokens()`、`trimMessages()`、`abortAfter(ms)`、`$()` 选择器
3. **存储**：`load()`、`save()`、`usageKB()`、`clearChat()`、`clearAllLocal()`
4. **渲染**：`render()`、`bubbleFor()`、`splitThink()`（解析 `<think>…</think>` 折叠展示）、`patchLast()`
5. **健康检查**：`health()`，启动即查、之后每 8 秒一次，4 秒超时
6. **复读检测**：`isLooping()`、`loopCut()`
7. **发送**：`send()`、`setSendState()`
8. **五子棋**：`(function(){ … })()` 自执行，暴露 `window.__gmHandleHelp`
9. **2048**：`(function(){ … })()` 自执行，含滑动、键盘、悔棋、排行榜

## 3. 一次聊天的数据流

```
用户输入
  │  Enter 或点发送
  ├─ 五子棋面板打开时：先交给 window.__gmHandleHelp(text)
  │    命中「帮我/建议/下哪…」→ 本地规则给出落子建议或代下，结束
  ├─ messages.push(user)、messages.push({assistant, streaming:true})、save()
  ├─ POST /api/chat { system, messages:[仅当前这一句], temperature, max_tokens }
  │    · 单轮模式：只发当前这一句，避免长上下文压垮 1.5B 模型
  │    · temperature = 滑杆值 + 随机 0~0.35，上限 1.1
  │    · max_tokens = 滑杆值裁剪到 [64, 1024]
  ▼
SSE 读取（fetch + ReadableStream + TextDecoder）
  ├─ 按 \n\n 切分事件，取以 data: 开头的行
  ├─ data: [DONE] → 跳过（结束）
  ├─ JSON.parse → j.t 追加进当前气泡，逐字上屏
  ├─ 累计超过 1000 字（MAX_REPLY_CHARS）→ 截断并提示、abort
  └─ isLooping(acc) 命中 → loopCut() 截断并提示、abort
  ▼
结束清理
  ├─ streaming=false
  ├─ 正常结束时 wrapPersona()：回复较短或已带人设特征词就原样，否则补一句开场/收尾
  ├─ 出错时插入一条 role=error 的气泡（提示本地服务 127.0.0.1:8000 没响应）
  └─ render() + save()
```

补充：

- 发送键在流式过程中变成「■」，点一下即 `controller.abort()`。
- `contextTokens` 默认 **2048**，由 `/api/system` 返回的 `n_ctx`（兼容 `context` / `contextSize`）校正，小于 512 时忽略。
- 历史记录全部保存在本地，但默认**不发给模型**（单轮模式）。代码里保留了 `trimMessages()` / `compactForSend()` 这类上下文裁剪工具，改成多轮时可以用上。

## 4. SSE 协议

`POST /api/chat`，请求：

```json
{
  "system": "系统提示词 / 人设",
  "messages": [{ "role": "user", "content": "…" }],
  "temperature": 0.6,
  "max_tokens": 768
}
```

响应头需为 `text/event-stream`，每个事件一行：

```
data: {"t":"增量文本"}

data: {"t":"再来一段"}

data: [DONE]
```

约定：

- 只认 `{"t": "..."}` 字段，前端没用 `event:`、`id:`、`retry:`。
- 结束标记是字面量 `data: [DONE]`，前端看到就 `continue`，真正退出靠流关闭（`reader.read()` 返回 `done`）。
- 失败时返回非 2xx + JSON `{"error": "..."}`，前端直接把 `error` 展示给用户。
- 其他两个接口：

| 接口 | 响应 |
| --- | --- |
| `GET /api/health` | `{"ok": true}` 表示模型已加载；前端只看 `ok` |
| `GET /api/system` | 至少包含上下文长度字段 `n_ctx`（或 `context` / `contextSize`） |

## 5. 本地存储（localStorage）

| Key | 内容 | 写入时机 |
| --- | --- | --- |
| `bft.msgs` | 对话数组 JSON，元素形如 `{role, content, streaming?}`，`role` 可为 `user` / `assistant` / `error` | 每次发送、结束、清空 |
| `bft.sys` | 当前系统提示词（人设） | 保存设置、切人设 |
| `bft.temp` | 温度滑杆值（字符串，默认 `0.6`） | 保存设置 |
| `bft.max` | 单次最大输出 token（字符串，默认 `768`） | 保存设置 |
| `bft.persona` | 当前人设 id（目前只有 `baifantuan`） | 切人设、保存设置 |
| `g2.rank` | 2048 分数数组 JSON，降序，最多保留 5 条；第 1 名即「最高分」 | 2048 结束/关闭时 |

清理行为：

- **清空对话**（设置 → 清空对话）：清空 `messages` 并写回 `bft.msgs`，`g2.rank` 保留。
- **清空全部数据**（设置 → 清空全部数据）：删除所有 `bft.*`，参数恢复默认，但 `g2.rank` 同样不在 `bft.` 前缀内，因此不会被这段逻辑清掉（这是当前实现的已知小瑕疵：排行榜需要单独特判清理）。
- 存储用量按 `bft.` 前缀估算（KB / 约 5120 KB），超过 4 MB 提示「快满了」。写入抛异常（多半是 5 MB 配额）时会弹窗提醒。

## 6. PWA / Service Worker 缓存策略

`sw.js` 版本常量 `VERSION = 'xianyu-v1'`，`install` 时 `addAll` 预热外壳：`/`、`/index.html`、`/avatar.png?v=3`、`/manifest.webmanifest`、`/icon-192.png`、`/icon-512.png`、`/icon-maskable-512.png`、`/apple-touch-icon.png`。任何一项失败会被吞掉（`.catch(() => {})`），并 `skipWaiting()`。`activate` 时删掉非当前版本缓存并 `clients.claim()`。

请求分流（只处理同源 GET）：

| 请求类型 | 策略 |
| --- | --- |
| `/api/*` | **直接放行，永不缓存**（聊天与健康检查必须实时） |
| 页面导航（`mode === 'navigate'`） | **网络优先**：成功则顺手把响应写进 `/index.html` 缓存；失败回退缓存，再回退 `/index.html` |
| 其他静态资源 | **缓存优先**：命中即返回，未命中再请求网络，200 且 `type === 'basic'` 时写入缓存 |

更新外壳时改 `VERSION` 即可让旧缓存整体淘汰。开发时如果页面被缓存住，在 DevTools → Application → Service Workers 里更新或注销。

## 7. 五子棋实现要点

- 棋盘 **15×15**，canvas 逻辑坐标 600×600，`PAD = 46`，`CELL = (SIZE - 2*PAD) / (N - 1)`（约 36.3 px）；点击时用 `getBoundingClientRect()` 把 CSS 像素换算回这套逻辑坐标，落点允许 ±0.55 格误差，避免误触。
- 你执黑先手（`1`），本地规则 AI 执白（`2`）。**AI 不是大模型**，不调用 `/api`。
- 走子评分 `lineScore(x, y, p)`：四个方向（横、竖、两条斜）各自统计连子数 `n`，累加 `n²`。`bestMove(p)` 在空点上取 `atk`（己方）与 `def`（对方）加权最大者：
  - AI 落子：`atk * 1.15 + def`
  - 给玩家支招：`atk * 1.05 + def * 1.2`（更偏防守）
- `winAt()` 沿横、竖、两条斜线共 4 个方向（各向两侧延伸）统计连子，≥5 即胜。
- AI 回合有 `650 + random*500` ms 的思考停顿，避免「瞬间落子」的违和感。
- 会说话：`say()` 默认只有 28% 概率接话；台词按 `streak()`（最长连子数）、`stones()`（棋子总数）从池子里挑，另有通用台词池。
- 与聊天框打通：聊天发送前先调用 `window.__gmHandleHelp(text)`；棋盘打开且文本命中 `/帮我|下哪|建议|提示|下一步|怎么办/` 时，给出坐标建议（如 `H8`）；命中 `/帮我下|替我下|你下吧/` 则直接替玩家落子。
- 关闭再点「棋」会重开一局（`reset()`）。

## 8. 2048 实现要点

- 逻辑盘面 4×4；渲染不用 canvas，而是绝对定位的 DOM tile（`.g2t`）+ `transform: translate()`，便于做滑动与合并弹跳动画。
- 方向编码：`0` 上、`1` 右、`2` 下、`3` 左。输入方式：方向键、在棋盘上滑动手势（位移阈值 24 px）、底部输入框发指令。
- 合并规则即标准 2048：同一行/列向目标方向压缩，相邻等值合并一次，`score += 合并后的值`；新块 90% 出 2、10% 出 4；无法移动且无空位则 Game Over 并写入排行榜。
- 悔棋：每局 3 次。`saveState()` 在每次移动前压入快照（`grid` + `score`），最多保留 30 步；原地没动（不合法方向）会立即 `history.pop()`，不浪费悔棋次数。`restoreState()` 重建 tile。
- 排行榜：`g2.rank`，降序取前 5；面板里「最高」显示第 1 名。关闭面板时若尚未记录则把本局分数记入一次。
- AI 陪玩（同样不调模型）：
  - `react()`：按最大数、空格数、分数说一句局面点评。
  - `help(text)`：用 `simScore(dir)` 对四个方向做一局模拟打分（合并收益、空格数、最大数、角落权重），给出「往上/右/下/左滑」的建议；文本里含「直接 / 帮我下 / 替本鱼」时直接替你滑。
  - 输入「重新 / 再来」即开新局。
- `layout()` 按容器宽度重算 tile 尺寸与字号，`resize` 时重排。

## 9. 安全与隐私

- 所有数据留在本机：前端只请求同源 `/api`，没有第三方脚本、统计或字体 CDN。
- 推理服务默认只在本机运行（`http://127.0.0.1:8000`）。若要暴露到局域网，请自行确认 `server/server.py` 的绑定地址与鉴权；当前实现面向单机自用，**没有**任何认证、限流或输入审查。
- 模型输出未经审核，可能出错或说不合适的话，请自行判断。

## 10. 可扩展点

- 多轮对话：`send()` 里把 `messages` 从单条改为经 `trimMessages()` 裁剪后的历史即可。
- 更多人设：往 `PERSONAS` 加条目，并在 `index.html` 的 `.persona-row` 加对应按钮（`data-persona`）。
- 换模型：改 `server` 侧的模型路径与 `n_ctx`，前端会自动通过 `/api/system` 适配上下文长度。
- 更多小游戏：沿用现有 IIFE 分区，暴露一个「先于聊天拦截输入」的钩子（参考 `window.__gmHandleHelp`）。
