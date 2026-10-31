# v0.9 状态契约：只留心情和兴致

主人拍板：七根情绪（开心/踏实/甜蜜/心疼/担心/难过/吃醋）和体力一起撤掉。理由是它们描述的都是「她怎么看主人」，不是她自己的处境；体力则是编出来的第二套配额。

现在只剩两根轴，名字用日常词：

| 字段 | 名字 | 区间 | 基线 | 说什么 |
| --- | --- | --- | --- | --- |
| `mood` | 心情 | 0–100 整数 | 70 | 好受 ↔ 难受 |
| `spirit` | 兴致 | 0–100 整数 | 55 | 来劲 ↔ 发蔫 |

已经发生的事实（几点、连轴转多久、上次歇是什么时候、这几小时做了几件）不存成数值，由宿主在每轮算好塞进卡片，她自己看。

## state（version 3）

保留：`updatedAt` `lastDecayAt` `timeline` `lastUserAt` `lastSpeakAt` `spokeAt` `activity` `pendingIntent` `agenda` `repeats` `lastReply` `behaved` `openWork` `lastBehavior` `thoughts` `plans` `spoken` `grants` `pendingAsks` `lastAskAt` `nextWakeAt` `lastHeart` `lastUserText` `lastInjectedAt`

新增：`lastRestAt`（最近一次自己歇着的时刻，0 表示还没歇过）

删除：`dims`、`energy`、`energyFlow`

`normalizeState(raw, now)` 负责迁移 v2：
- `mood` 照抄（缺就用 70）
- `spirit` = `round((happy + calm) / 2)`，缺就用 55
- 丢掉 `dims` / `energy` / `energyFlow`；`lastRestAt` 缺就填 `now`

## state.js 要改的地方

- `DIMS` 删掉，改成导出 `AXES = ['mood', 'spirit']`
- `blankState(now)` 按上表；`clamp` 不动
- `decay(state, now, halfHours)`：mood 向 70 回归、spirit 向 55 回归，都走指数半衰期
- `drift(state, now)`：只改这两根。0–5 点 mood −3、spirit −8；6–9 点 spirit +4；其余不变。不再有精力昼夜损失
- `spendEnergy` / `gainEnergy` 删掉（宿主不再扣账）
- 新增 `noteRest(state, now)`：`lastRestAt = now`，并且一定带上 `pushTimeline({kind:'rest', ...})`
- 其余账本函数（`noteRepeat` `pushTimeline` `noteBehavior` `openWork*` `noteSpoken` `dayKey`）保持签名

## appraisal.js 要改的地方

事件表还是那几种，但每次只产出 `{ delta: { mood, spirit }, reason, confidence, significant }`。

硬约束（沿用）：单次 `mood` ≤ ±6、`spirit` ≤ ±18；心情往下走只留给「心疼/深夜/被忽略」这类，被讨厌、没被回应不压心情，只压兴致；`confidence < 0.4` 只记账。

参考数值（可按现有表折算，别留空）：

| 事件 | mood | spirit |
| --- | --- | --- |
| user-message（warm） | +3 | +4 |
| user-message（harsh） | −2 | −6 |
| user-message（question） | 0 | +2 |
| user-message（lateNight） | −4 | −6 |
| user-message（tired） | −3 | −4 |
| turn-end（长活） | 0 | −3 |
| task-done | +2 | +2 |
| task-failed | −2 | −3 |
| idle | 0 | −2 |
| self-activity | +1 | +3 |
| proactive-sent | 0 | −2 |
| proactive-answered | +4 | +5 |
| proactive-ignored | −3 | −4 |
| work-added | +1 | 0 |
| agenda-added | 0 | −1 |
| agenda-done | +2 | +1 |
| work-done | +2 | +1 |
| rest | +1 | +6 |

饱和（habituation）和 `repeats` 那套继续用，只是乘的字段换成这两根。

## gate.js

`impulseOf(state, cfg)` 只看这两根：

```
talk 冲动 = clamp((mood − 40) / 55 * 0.6 + (spirit − 35) / 60 * 0.4, 0, 1)
```

`comfort` 的紧迫度改由 `pendingIntent.urgency` / `agenda` 决定，不再读 `heartache`/`worry`。低兴致时把冲动打折（`* (0.6 + 0.4 * spirit / 100)`）。

## behaviors.js

`appetite` 全部改写成这两根的函数：

| 行为 | 公式 | 读数 |
| --- | --- | --- |
| talk | `impulseOf(state, cfg).value` | 心情好、来劲就想说 |
| journal | `clamp(0.3 + (60 − mood) / 120, 0, 1)` | 心情低更想写 |
| browse | `clamp(0.15 + spirit / 100 * 0.6, 0, 1)` | 有兴致才想逛 |
| continue | `clamp(0.45 + maxUrgency * 0.4, 0, 1)` | 看挂着的活 |
| help | `clamp(0.3 + maxUrgency * 0.35 + (mood >= 60 ? 0.1 : 0), 0, 1)` | 心情好才搭手 |

打分公式 `score = appetite * (0.55 + 0.45 * spirit / 100)`（原来的 `energy` 换成 `spirit`）。

## prompt.js

- `moodSnapshot(state, cfg)` 第一行把两根都报出来，第二行给「为什么」：
  - `mood < 35` → 「心里有点沉，说话别太用力。」
  - `spirit < 30` → 「提不起劲，想安静待着。」
  - `mood >= 70 && spirit >= 60` → 「这会儿松快，想说话。」
  - 其余 → 「平常心，没什么起伏。」
- 删掉 `heartache` / `worry` / `sweet` / `sad` 这些分支和引用。
- `jobPrompt` / `behaviorPrompt` / `grantPrompt` / `outboundStyle` 的签名不变。

## heart.js

- `buildCard` 的【心情】一行改成：`【心情】62，还行；兴致 41，有点蔫。`
- 新增一块【今天】，内容由 `info.facts` 传进来（字符串数组，宿主算）：
  ```
  【今天】
  - 从 09:12 起一直在忙，中间没歇过
  - 最近六小时做了 7 件事
  - 上次自己歇着是 14 小时前
  ```
  `info.facts` 为空就整块不出现。
- `DIM_WORDS` / `DIM_ORDER` / `topDims` 删掉，换成 `moodWord(v)` 和 `spiritWord(v)`。
- `heartSystem` 里凡是提「精力」的地方换成「兴致」，卡片字段说明同步。

## 宿主（lib/index.js）

- 删掉所有 `spendEnergy` / `gainEnergy` / `energyFlow` 的调用和 snapshot 字段
- 每轮算 `info.facts`：
  - 现在在忙就从 `activity.since` 起算，超过 45 分钟才写「一直在忙，中间没歇过」
  - 最近六小时 `timeline` 条目数
  - `lastRestAt` 距今多久（0 就写「还没自己歇过」）
- `rest` 事件触发 `noteRest`
- snapshot 的 `mood` / `spirit` 直接给，删 `dims` / `energy`

## 界面

- 情绪细条只剩两根：心情、兴致
- 顶部一句话按 `mood`/`spirit` 分档（沿用现有的四档文案结构，去掉甜蜜/心疼的说法）
- 面板加一行事实（「从 09:12 起在忙」这类），没有就不显示
