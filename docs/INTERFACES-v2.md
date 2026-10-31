# dsh-feiyu-life 接口契约 v2（冻结）

v1（docs/INTERFACES.md）仍然有效，本文只写**增量**。冲突处以本文为准。
纯 ESM JS，不构建。改导出名/字段名之前先改本文。

## 1. State 新增字段

```js
{
  version: 2,
  // v1 已有：mood dims energy updatedAt lastDecayAt timeline lastUserAt lastSpeakAt spokeAt pendingIntent

  activity: { kind, note, since },        // kind: 'idle' | 'chat' | 'work' | 'rest' | 'sleep'
  agenda: [AgendaItem],                   // ≤ 20，见 §3
  repeats: { [key]: { count, lastAt } },  // 同类事反复发生用，见 §2.3
  lastReply: null | { at, gapMs, length, follows },  // follows: true 接住了 / false 敷衍 / null 判断不了
  energyFlow: { spent, gained, since },   // 只做界面展示与诊断
}
```

`blankState(now)` 必须带上这些字段；`normalizeState(raw, now)` 负责把 v1 旧文件补成 v2（缺字段补默认，不丢数据）。

## 2. core/state.js

原有导出不变，新增：

- `normalizeState(raw, now)` → 补齐 v2 字段的 state
- `spendEnergy(state, amount, reason)` → 直接改 state.energy 并累加 energyFlow.spent
- `gainEnergy(state, amount, reason)` → 同上，累加 gained
- `noteRepeat(state, key, now)` → 更新 repeats[key]，返回累计次数（同一 key 距上次 > 24h 则重新从 1 计）

## 3. core/agenda.js（新文件）

```js
export function agendaAdd(state, item, now)      // item: {text, kind, dueAt, window, urgency}
export function agendaSweep(state, now)          // 丢掉过期（dueAt 过后 24h）与已说的，返回剩余条数
export function agendaPick(state, now, cfg)      // 选一条现在能说的，返回 item 或 null
```

AgendaItem：
```js
{
  id, text,                     // text: 要说的事，一句话
  kind: 'remind' | 'followup' | 'report' | 'care',
  dueAt,                        // ms，最早什么时候该说
  window: { from, to } | null,  // 绝对 ms 时间戳的可行窗，null = 不限
  urgency: 0.0 – 1.0,
  createdAt,
  spokenAt: null,
}
```

`agendaPick` 规则：`dueAt <= now`，且 `window` 为空或者 `now` 落在 `[from, to]` 之间（绝对 ms，跨零点由生成方算好），按 `urgency` 降序、`dueAt` 升序取第一条。

## 4. core/appraisal.js

### 4.1 事件类型扩到 14 种

```
'user-message' 'turn-end' 'task-done' 'task-failed' 'idle' 'self-activity'
'proactive-sent' 'proactive-answered' 'proactive-ignored' 'self-prompt'
'agenda-added' 'agenda-done' 'work-done' 'rest'
```
（`work-done` = 她自己干活回来；`rest` = 休息。）

### 4.2 饱和与敏感化（同表两个方向）

同类事件先 `noteRepeat(state, repeatKey(event), now)` 拿 count，再乘系数：

- **正向事件**（让某根情绪涨的）：`mult = max(0.35, 1 / (1 + 0.3 * (count - 1)))`
- **负向事件**（让某根情绪跌的）：`mult = min(2.0, 1 + 0.25 * (count - 1))`

`repeatKey(event)`：优先 `event.kind + ':' + (event.tag || '')`，无 tag 用 kind。
判定正负：appraise 算完 raw delta 后看 `delta.mood + sum(delta.dims)` 的符号，再乘系数（一次算不出来就分两步：先算 raw，再缩放）。
缩放后重新套用 v1 的硬上限（mood ≤±6，dims ≤±18）。

### 4.3 精力成本

appraise 内部对这几类事件扣精力（`spendEnergy`）：

| 事件 | energy |
|---|---|
| user-message | -1.5 |
| self-activity | -3 |
| proactive-sent | -6 |
| work-done | -4 |
| rest | +8 |
| idle | +2 |

结果里带 `delta.energy` 反映净值。

### 4.4 夜间

`event.lateNight === true`（0–5 点）时，energy 额外 -2，并且 mood 不因「玩得开心」上涨（防止熬夜反而更开心，这是个不真实的回路）。

## 5. core/gate.js

`decide(state, now, stats, cfg)` 新增两道门，顺序插在原第 4 门（冷却）之后、每日上限之前：

1. **精力门**：`state.energy < cfg.energyFloor(默认 25)` 时，只有 `intent.kind === 'comfort' && urgency >= 0.85` 能过，否则 `{speak:false, reason:'没精力'}`。
2. **待办门**：`state.agenda` 里有 `agendaPick` 命中时，直接用这条（`intent = {kind:'agenda', text, urgency}`），**跳过冲动阈值门**——事情该说就说，不看心情够不够。冷门、静默时段、每日上限仍然管。

返回结构增加：
```js
{ speak, reason, intent: { kind, text?, urgency }, cooldownMinutes, energyFloorBlocked?: boolean }
```

`impulseOf` 里精力低于 40 时对 `impulse.value` 乘 `0.5 + 0.5 * energy / 40`。

## 6. core/prompt.js

- `moodSnapshot(state, cfg)` 保留，但**不再带细碎数字**，改成一句话体感（「这会儿有点乏」「尾巴很放松」「心里有点堵」），供每轮注入用。
- `jobPrompt(intent, state, cfg)`：`intent.kind === 'agenda'` 时用 `intent.text` 当重点，首行仍是 `[feiyu-life]`。
- 新增 `selfTaskPrompt(state, cfg)`：首行 `[feiyu-life:self]`，让她自己找事做。
- 新增 `replyFollows(state, cfg)`：判断上一条主动消息有没有被接住的提示串（给宿主用，纯文本规则，不调 LLM）。

## 7. 配置新增（~/.dsh/feiyu-life/config.json）

```js
{
  // v1 全部保留
  injectMode: 'on-change',        // 'on-change' | 'every-turn' | 'off'
  sessionMode: 'pinned',          // 'pinned' | 'recent'
  energyFloor: 25,
  selfTasks: {                    // 自己找事做
    enabled: true,
    intervalMinutes: 150,         // 至少隔这么久
    dailyCap: 4,
    activeHours: '09:00-23:00',
  },
  agenda: { enabled: true, maxItems: 20 },
}
```

## 8. 宿主（lib/index.js）新增行为

- **活动判定**：收到 user 事件 → `activity={kind:'chat'}`；turn-end 且持续 > 45 秒 → `{kind:'work'}`；20 分钟没动 → `{kind:'idle'}`；0–5 点主人没在说话且没任务 → `{kind:'sleep'}`。
- **反馈判定**：`state.pendingIntent` 存在时，主人下一条消息算作回应：`gapMs <= 180s` 且（`length >= 6` 或与 `pendingIntent.text` 有共同关键词）→ `follows = true`；否则 `follows = false`。结果写 `state.lastReply`，并发 `proactive-answered` 事件（带 `follows` 字段，appraisal 里 `false` 才加 ignoredStreak）。
- **多会话**：`sessionMode === 'recent'` 时目标会话 = 最近发过言的会话（内存 map sessionId → lastUserAt，持久化到 `~/.dsh/feiyu-life/sessions.json`，最多 20 条）。
- **注入模式**：`every-turn` 每轮注入体感句；`on-change` 沿用 v1 的「心情变了才注入」；`off` 不注入。
- **agenda 输入源**：`POST /action {action:'agenda-add', text, dueAt, window, urgency, kind}`；宿主也从主人消息里认「明天/后天/几点」这类词，自动加一条 `kind:'remind'`（拿不准就不加）。
- **自己找事做**：过了 `selfTasks.intervalMinutes`、在 activeHours 内、energy ≥ 55、今日次数没超 → 排一条 `[feiyu-life:self]` 任务；回来后 `work-done` 事件。

## 9. 浏览器 API 增量

- `GET /state` 的返回增加 `agenda`、`activity`、`energy`、`lastReply`、`selfTasks`（今日已用/上限）。
- `POST /action` 新增 `{action:'agenda-add'}`、`{action:'agenda-drop', id}`、`{action:'self-task-now'}`。

## 10. 实现时定下的补充（v2 落地后追加，视为有效）

1. **`appraise` 会就地更新 `state.repeats`**。这是 v1「纯函数不改入参」的唯一破例：签名只回 count，宿主拿不到新副本，不就地记的话重复计数永远是 1，饱和与敏感化整条逻辑空转。`mood` / `dims` / `energy` 仍然不在 core 里直接改，由宿主落地。
2. **精力门放行紧急待办**。`energy < energyFloor` 时，除了 `comfort` 且 urgency ≥ 0.85，`agenda` 且 urgency ≥ 0.7 也能过。理由：答应过要提醒的事不该因为她累了就失约，但一般事务照样歇着。
3. **`injectMood` 是总闸，`injectMode` 只管频率**。`injectMood === false` 时无论 `injectMode` 是什么都不注入。
4. **`appraise` 的 comfort 豁免取不打折的 `rawValue`**。`impulseOf` 在低精力时会给 `value` 打折，若豁免也用打折后的值，累到 30 时 comfort 永远到不了 0.85，那条豁免是死代码。
5. **`selfTasks` 的今日预算存在 `state.selfTasks = {day, count, lastAt}`**，不放进 core 的状态契约（core 不关心），由宿主维护；`/state` 里以 `{enabled, used, cap, lastAt}` 暴露。
6. **`agendaDrop` 是删除，不是标记**。界面点「扔掉」后那行立刻消失。
7. **recent 策略下挂载所有活着的会话**（`sessionMode === 'recent'`），否则听不到别的窗口里主人说话，目标永远停在最初那个。pinned 仍只挂目标会话。
