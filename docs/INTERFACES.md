# dsh-feiyu-life 内部接口契约（冻结版 v1）

所有代码是**纯 ESM JavaScript**（`.js`，JSDoc 类型），不经过构建，不需要 tsdown。
原因：插件由 DSH 在 boot 时直接 `import()`，任何构建产物过期都会让整个 host 起不来。

目录：

```
lib/index.js          宿主入口（apply）。只做接线，不含业务规则
lib/host/hooks.js     session 事件 → 情绪事件；provider 挂载
lib/host/bridge.js    创建一次性 timer job（主动消息的唯一出口）
lib/host/routes.js    /dsh-feiyu-life/* HTTP 路由
lib/core/state.js     状态模型 + 衰减 + 持久化格式（纯函数）
lib/core/appraisal.js 事件 → 情绪增量（确定性规则表）
lib/core/gate.js      冲动 + 打扰门
lib/core/prompt.js    快照文本 / job prompt 模板
client.js             浏览器半端：设置页
assets/widget.js      浏览器半端：右下角立绘 + 弹窗
assets/*.png          立绘与五档表情
test/*.test.js        node --test 单测（只测 core）
```

## 一、状态模型

```js
/** 七根情绪 + 基调 + 精力 */
const DIMS = ['happy', 'calm', 'sweet', 'heartache', 'worry', 'sad', 'jealous']

/** @typedef {{version:number, mood:number, dims:Record<string,number>,
 *   energy:number, updatedAt:number, lastDecayAt:number,
 *   timeline:TimelineEntry[],
 *   lastUserAt:number, lastSpeakAt:number, spokeAt:number[],
 *   activity:{kind:string,note:string,since:number},
 *   pendingIntent:Intent|null}} State */
```

- `mood` 0–100，基线 70，无下限（可掉到 0），靠衰减回稳。
- `dims` 每根 0–100。
- `energy` 0–100（精力），夜里掉、干活掉、睡/安静回升。
- `timeline` 只保留最近 200 条；`delta` 是**实际**的 mood 变化。
- 持久化：`~/.dsh/feiyu-life/state.json`，原子写（tmp + rename）。
- `updatedAt` **只在真的有情绪变化时**更新；tick 里的衰减/昼夜漂移会改数值但不改它，所以「一次变化只注入一次」比较的是它。另有一个契约外的 `lastInjectedAt`，用来记住已经挂过上下文的那次变化。

## 二、核心纯函数

### lib/core/state.js

```js
export const DIMS                       // string[]
export function blankState(now)        // → State
export function clamp(v, lo, hi)       // → number
export function decay(state, now, halfHours) // → State（不改入参）
export function drift(state, now)      // → State：昼夜节律（energy 与 calm 漂移）
export function pushTimeline(state, entry)   // → State
```

`decay`：所有值按 `halfHours` 半衰期向基线（mood 70 / dims 0 / energy 55）指数回归。
`drift`：按本地小时调 energy（0–6 点 −、7–9 点回升、午后 −、20–22 点 +）。

### lib/core/appraisal.js

```js
export const EVENT_KINDS  // ['user-message','turn-end','task-done','task-failed','idle','self-activity','proactive-sent','proactive-answered','proactive-ignored']
export function appraise(state, event, cfg)
// → { delta: {mood:number, dims:Record<string,number>, energy:number},
//     reason: string, confidence: number, significant: boolean }
```

**确定性规则表**，零 LLM 调用。规则以 `event.kind` + 特征字段打分：

- `user-message`：`gapMs`（距上一条间隔）、`length`、`question`（是否问句）、`toneHint`（'warm'|'neutral'|'harsh'，来自本地词表）、**`lateNight`（本地 0–5 点）**、**`tired`（主人明说累/困）**。后两个是「心疼」唯一允许压 mood 的入口，hooks 必须传；`lateNight` 看时钟，`tired` 只认明确说出来的词，不靠语气猜。
- `turn-end`：`failedTools`、`toolCount`、`durationMs`
- `task-done` / `task-failed`：`note`
- `idle`：`minutes`
- `self-activity`：`kind`（'study'|'chore'|'rest'|'play'）
- `proactive-sent` / `proactive-answered` / `proactive-ignored`

约束（设计文档里的三条，违反要在这里拦）：
1. mood 单次变化不超过 ±6，dims 不超过 ±18。
2. 用户没回应、或语气差 → 不许降低 mood（降 mood 只能因为「心疼/担心」，不能因为「被讨厌」）。
3. `confidence` 0–1；< 0.4 的事件只记账、不注入、不触发说话。

### lib/core/gate.js

```js
export function impulseOf(state, cfg)
// → { value:0..1, kind:'share'|'report'|'comfort'|'idle-chat'|'none', reason:string }

export function decide(state, now, stats, cfg)
// stats = { lastUserAt, lastSpokeAt, spokeToday, answeredLast, ignoredStreak, inTurn, secondsSinceTick }
// → { speak:boolean, reason:string, intent:Intent|null, cooldownMinutes:number }

/** @typedef {{kind:string, seed:string, mood:number, urgency:number, createdAt:number}} Intent */
```

`decide` 依次过门，任一门否决就 `speak:false`：

1. `cfg.enabled` 且 `cfg.mode !== 'off'`
2. 不在 `inTurn`（对话进行中不插话）
3. 静默时长 ≥ `cfg.minSilenceMinutes`
4. 距上次主动 ≥ `max(cfg.cooldownMinutes, cooldownMinutes * (1 + ignoredStreak))`
5. 今日主动次数 < `cfg.dailyCap`
6. 不在 `cfg.quietHours` 内（除非 `impulse.kind === 'comfort'` 且 `urgency ≥ 0.85`）
7. `impulse.value ≥ cfg.impulseThreshold`

### lib/core/prompt.js

```js
export function moodSnapshot(state, cfg) // → string：给 systemPrompt.context 的一段，空串表示不注入
export function jobPrompt(intent, state, cfg) // → string：一次性 timer job 的完整 prompt（自包含、不可提问）
export function nextHint(intent, state, cfg)  // → string：给界面显示"下次大概什么时候"
```

`jobPrompt` 必须包含：心情快照一行、想说的事的种子、口吻约束（一句话一意思、不汇报腔、不喊主人起床）、以及**结束条件**（说完就停，不复述）。

## 三、宿主 http 路由（浏览器半端消费）

全部前缀 `/dsh-feiyu-life`，JSON，`cache-control: no-store`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | `{ok, state, gate, next, config}` |
| GET/POST | `/config` | 读 / 改配置（POST 传 patch） |
| GET | `/sessions` | `{ok, sessions:[{id, title, updatedAt}]}` |
| POST | `/action` | `{action:'speak-now'|'reset'|'pause'|'resume'|'clear-timeline'}` |
| GET | `/jobs` | `{ok, jobs:[{id,title,scheduledAt,status}]}` 最近 20 条主动消息任务 |
| GET | `/feiyu.png` 等 | 立绘与表情 |

## 四、配置（`~/.dsh/feiyu-life/config.json`）

```js
{
  targetSession: '',        // 主动消息投递到的会话；空 = 用 DSH_SESSION_ID
  enabled: true,
  mode: 'normal',           // 'normal' | 'quiet'（只记账不说话）| 'off'
  minSilenceMinutes: 25,
  cooldownMinutes: 40,
  dailyCap: 8,
  quietHours: '02:00-08:00',
  impulseThreshold: 0.55,
  injectMood: true,
  judgeProvider: '',
  judgeModel: '',
  useLlmAppraisal: false,
  selfName: '小鱼',
  ownerName: '主人'
}
```

## 五、主动消息的唯一出口

`lib/host/bridge.js`：

```js
export async function spawnProactiveJob(origin, { prompt, title, sessionId, runAt })
```

- 用 `origin`（`ctx.webServer.getOrigin()`）POST `/api/dsh-timer-agent/jobs`
- body：`{title, prompt, runAt, target:{sessionId, workdir:''}}`（一次性任务，触发后自动归档）
- 失败返回 `{ok:false, error}`，**绝不抛**（打扰控制失败不能拖垮对话）
- 同时把 job 记进 `state.pendingIntent`，供界面显示
