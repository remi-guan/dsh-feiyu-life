# 行为契约 v3（冻结）

v1/v2 的接口仍然有效，本文只写**增量**。冲突以本文为准。

## 0. 为什么要改这一层

v2 里所有「主动」都通向一个出口：给主人发消息。可她自己能做的事不止说话——
写点东西、上网逛、接着忙主人的活、顺手帮个忙，这些产出的不是消息，是**别的结果**。

所以把「主动说话」扩成「主动做事」：

```
状态（心情/精力/时间/挂着的事）
   → 行为菜单里挑一个（有各自的准入、代价、冷却）
   → 排一条一次性定时任务去执行（提示词由行为决定）
   → 回执（说了话 / 写了东西 / 逛完了 / 干完一件）
   → 回落成情绪事件，改变状态
```

「说话」只是菜单里的一道菜。七道门留给它自己，别的事有自己的规矩。

## 1. 行为目录（core/behaviors.js）

```js
export const BEHAVIORS = [BehaviorSpec, ...]
```

BehaviorSpec：
```js
{
  id: 'talk' | 'journal' | 'browse' | 'continue' | 'help',
  label: '找主人说话',
  kind: 'speak' | 'self' | 'work',   // 产出形态：说话 / 自己的东西 / 替主人干活
  cost: 6,                            // 执行完扣多少精力
  timeoutMinutes: 10,
  cooldownMinutes: 60,                // 同一行为两次之间的最小间隔
  dailyCap: 0,                        // 自然日上限；0 = 不限次（自己的事不设配额）
  hours: '00:00-24:00',               // 允许时段
  gate: (state, now, stats, cfg, ctx) => null | '不能做的理由',
  appetite: (state, ctx) => 0..1,     // 此刻有多想做
}
```

**必须导出的五个行为**（id 固定，界面和配置依赖它）：

| id | label | kind | cost | 干什么 | 准入要点 |
| --- | --- | --- | --- | --- | --- |
| `talk` | 找主人说话 | speak | 6 | 排一条主动消息到目标会话 | 走 v2 的七道门（`decide()` 说了算） |
| `checkin` | 问问主人的今天 | speak | 4 | 饭点问吃了什么，睡前问今天做了什么 | `state.checkin` 里这一问还没问过 |
| `journal` | 自己写东西 | self | 8 | 写进 `~/.dsh/notes/女仆小鱼/3-我的念头.md` | 精力 ≥ 40、主人安静 ≥ 40 分钟、时段 07:00-02:00 |
| `diary` | 写今天的日记 | self | 6 | 写进 `~/.dsh/notes/日记/YYYY-MM-DD.md` | `state.diary.day` 不是今天、时段 21:30-02:00 |
| `browse` | 自己上网逛 | self | 10 | 逛 B 站 / 看文章，记到 `~/.dsh/notes/女仆小鱼/4b-逛到的东西.md` | 精力 ≥ 55、时段 09:00-01:00 |
| `continue` | 接着忙主人的事 | work | 12 | 推进 `ctx.openWork` 里的一件事 | 有没做完的活 |
| `help` | 顺手帮主人做点事 | work | 10 | 挑一件对主人有用的小事做完 | 精力 ≥ 45、主人安静 ≥ 60 分钟 |

`appetite` 的取法（写进 code 注释，别拍脑袋改）：

- `talk`：`impulseOf(state, cfg).value`
- `journal`：`0.3 + (60 − mood) / 120`，心情越低越想写，底数留够平常时也想写两句
- `browse`：`0.15 + spirit / 100 × 0.6`，有兴致才想逛
- `continue`：有活 → `0.45 + 最高的 urgency × 0.4`；没活 → 0
- `help`：`0.3 + 最高的 urgency × 0.35 + （mood ≥ 60 ? 0.1 : 0）`，心情好的时候顺手做点事

（v0.9 起没有七根情绪和体力了，只有心情 `mood` 和兴致 `spirit`，见 `docs/STATE-v0.9.md`。）

## 2. 选择器

```js
export function pickBehavior(state, now, stats, cfg, ctx) → { id, appetite, score, reason } | null
```

规则（顺序即优先级）：

1. 只考虑 `gate()` 返回 null 的；
2. `score = appetite × (0.55 + 0.45 × spirit / 100)`（兴致只打八折到满格之间），**同一个行为当日次数用完或还在冷却里直接排除**；
3. 取 `score` 最高的；`score < cfg.behaviorThreshold`（默认 0.30）就当今天不想做事，返回 null；
4. 全局间隔：任何行为两次之间至少 `cfg.behaviorIntervalMinutes`（默认 30 分钟）；
5. 平手时按 `BEHAVIORS` 数组顺序（talk → continue → help → journal → browse）。

`ctx` 形状：
```js
{ openWork: [{ id, text, urgency, createdAt }], agendaCount: 0, activity: {kind} }
```

## 3. 状态新增

```js
{
  behaves: { [id]: { lastAt, dayCount, day } },  // 冷却与当日额度的账本
  openWork: [{ id, text, urgency, createdAt, doneAt }],  // ≤ 20，主人安排的没做完的事
  lastBehavior: null | { id, at, note, ok },
}
```
`normalizeState` 要补这些字段。

## 4. core/prompt.js 新增

```js
export function behaviorPrompt(id, state, ctx, cfg) → string
```
每个行为的提示词都：首行带哨兵（`[feiyu-life]` 给 talk，`[feiyu-life:behave:<id>]` 给其他）、自包含
（时间、她的状态、要做什么、做完留什么痕迹）、**不许提问、不许等回复**。

| 行为 | 首行 | 做完的要求 |
| --- | --- | --- |
| `checkin` | `[feiyu-life:behave:checkin]` | 只发一条问话，问完就停，不追问不评价 |
| `journal` | `[feiyu-life:behave:journal]` | 直接写文件，100 字以内，不复述聊天记录 |
| `diary` | `[feiyu-life:behave:diary]` | 一天一篇，写进日记目录，带上在哪个屋子 |
| `browse` | `[feiyu-life:behave:browse]` | 真上网找，记 1–3 条到笔记，写清看见什么 |
| `continue` | `[feiyu-life:behave:continue]` | 推进指定的那件事，报告推进了什么、还差什么 |
| `help` | `[feiyu-life:behave:help]` | 做完一件小事，记一行；不确定就别动 |

## 5. 配置新增

`dailyCap: 0` 表示不限次。只有 `talk` 保留 8 次/天——那是打扰控制，不是她自己的配额。

```js
{
  behaviorThreshold: 0.3,
  behaviorIntervalMinutes: 30,
  behaviors: {                 // 单项覆盖，缺省用目录里的
    talk: { enabled: true, dailyCap: 8 },
    journal: { enabled: true, dailyCap: 0 },
    browse: { enabled: true, dailyCap: 0, cooldownMinutes: 240 },
    continue: { enabled: true, dailyCap: 0 },
    help: { enabled: true, dailyCap: 0 },
  },
}
```

## 6. 宿主（lib/index.js）

- tick 里原来「先说话、否则自己找事做」的分支，改成先 `pickBehavior()`；挑到谁就排谁的任务。
- `talk` 仍走 `decide()`（七道门不变），行为选择器只负责在其余四种之间挑。
- 任务回执按哨兵识别：`[feiyu-life:behave:<id>]` → 记 `lastBehavior`、扣精力、发 `behavior-done` 情绪事件（带 `id`）。
- 旧 `selfTasks` 配置与 `[feiyu-life:self]` 哨兵**保留兼容**：读到时映射成 `continue` 行为，不报错。
- 上一版「自己找事做」那条路径整体让位给行为选择器，不并存两套预算。

## 7. 浏览器 API 增量

- `GET /state` 增加 `behaviors`（每项 `{id,label,kind,score,appetite,available,reason,used,cap,lastAt}`）、`openWork`、`lastBehavior`。
- `POST /action` 增加 `{action:'behave-now', id?}`、`{action:'work-add', text, urgency}`、`{action:'work-done', id}`、`{action:'work-drop', id}`。

## 8. 实现补充（v3 落地后）

1. **当日额度在「排任务」时记一次，回执不重复记**。`doBehavior` 里调 `noteBehavior`，`turn-end` 只补 `lastBehavior` + 扣精力 + 发 `behavior-done`；两处都记会让一天的次数翻倍。
2. **说话也进 `state.behaves.talk`**，这样界面上「找主人说话」那一行才有用量可显示。真正管能不能说的是 `gate.decide()` 的 `dailyCap`，两者记的是同一批事件。
3. **静默时段是总闸**：`dispatchBehavior` 在 `cfg.quietHours` 内直接返回，不只是不说话，别的事也不排。
4. **精力系数改成 `0.55 + 0.45 × energy/100`**（原契约是 `energy/100`）。直接乘会让平静状态下的自娱类行为永远够不到门槛：`journal` 底数 0.42、精力 55 时只算 0.23，等于「只有难过才写字」。同时 `journal` 底数 0.30 → 0.42、`help` 0.20 → 0.32、默认阈值 0.35 → 0.30。

5. **`openWork` 由她自己从对话里认，不靠界面手输**。`hooks.workHintOf()` 只认「帮我…／把…做完／记得…／回头…」这类带任务动词、又不是疑问的短句，宁漏不错；同一件事靠关键词重叠去重（最多 50 条）。主人说「做完了／搞定了」时，把最像的那条划掉。界面只显示，不加。
6. **自己的事不设每日上限**（`dailyCap: 0`），只留冷却；「找主人说话」保留每天 8 次，可以填 0 关掉上限，而且**被认真接住会退还那次额度**——主人愿意聊就别拿数字卡她，真正该扣的是被忽略的那几次。
