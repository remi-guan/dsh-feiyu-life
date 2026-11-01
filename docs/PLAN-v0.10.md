# v0.10 计划：把 SurfCore 的二代逻辑搬进 feiyu-life

主人 2026-11-01 的交代：「QQ 不要了。其他的地方都抄过来，用他们的逻辑替换掉我们的，界面也改成我们的。」

**实施状态（2026-11-01 傍晚）**：护栏、收尾、记忆、没说完、分条、面板都已接线，194 条测试全过。按主人后来的要求改过一轮：记忆只存 markdown、不做老状态兼容、护栏砍到三条。等回话再重启 DSH 生效。

**范围边界**：不接 SnowLuma、不碰真号、不移植 QQ 工具面（`src/mcp-snowluma-safe.js` 那 38 个工具）。
嘴巴仍是我们自己的 `notify-qq.py`（官方机器人），只把「怎么说话」按他们的写法改。
`B站`、`桌宠`、`群聊/拍一拍/引用/语音` 全部不要。

**目标一句话**：让她从「每分钟问自己想不想说话」变成「有事才醒，醒了看得到未读、上次说到哪、这次最多发几条」。

## 零、审查后的修订（2026-11-01，实施前）

计划写完先让人独立审了一遍，推翻了三处前提，下面是按审查改过的口径——**以这一节为准，下面各节保留原文当思考过程**。

1. **「要不要唤醒」的权力不在我们手上。** DSH 里主人一说话，宿主自己就开一轮，插件只能旁观（`lib/host/hooks.js:163` 的 `agent/inbox/inserted`）。所以 `state.inbox`、合并窗、优先级队列对「主人发消息」这条路是空转，硬做还会多出一个和 tick 抢着排任务的调度器。**结论**：`wake.js` 留作库存（下次真做 QQ 直连才用得上），这一版**不接**；唤醒仍只有一条链路——`nextWakeAt` 到点 → `heartStep`。
2. **护栏只能管她自己起的回合。** 主人那条路不拦也不该拦，只记账。所以护栏只剩「一天几次／隔多久／花多少」三条。
3. **¥8 日预算没有现成的成本源。** 我们用 `assistant/message` 的 `event.data.usage` 按配置单价估（`costPerMTokens`），只当刹车，不当账单。
4. **单轮步数、一次发几条这类护栏删掉了**：插件只有观察权，取消接口在宿主，留着计数只会让人误以为有防护。
5. **不新增工具**：`feiyu_close_conversation` 会出现在主人自己的工具列表里，且 `@deepseek-ai/dsh-tools` 的解析没验证过——收尾改成回合末按 `assessExchange` 的判定自动记一条，零 API 风险。
6. **分条不改公共脚本**：`~/.dsh/notify-qq.py` 只吃 argv[1]，另一条通道也在用；改成在 `reportTail` 里教她一条一条调，最多三条。
7. **记忆不另起一套真相**：只搬「五档清晰度 + 一天最多降一档 + 主人相关下限 55」，卡里只放收尾摘要这类她真说过的话，笔记和会话仍然是原来的家。

## 一、唤醒：时钟驱动 → 事件驱动

新文件 `lib/core/wake.js`（移植 `src/bridge.js:10001` 的 `defaultWakeConfigV2`、`:13942` 的
`WAKE_PRIORITY`、`:13280` 的 `evaluateWakeTriggerV2`、`:10099` 的 `computeWakeSafetyV2`、
`:10114` 的 `ensureWakeableV2`）。

- `state.wake`：`mode`(active/sleep)、`sleepUntil`、`infinite`、`triggers`、
  `batchWindowMs`(8000)、`lastWakeAt`、`wakeCount`、`noActionCount`、`confirmedAt`。
- 事件源：`session/event` 的 `user/message`（主人从 QQ 发来的）→ 进未读池
  `state.inbox`（`seq` 自增、正文截 200、带 `from`/`at`）。`readThroughSeq` 只推进已经展示过的连续 seq。
- 触发：私聊恒触发（priority 100）；其余按 `triggers` 的 `name/keyword/question/anyMessage/probability` 打分。
- 合并窗：`batchWindowMs` 内只醒一次，取最高优先级；忙（`stats.inTurn`）时写 `pendingWakeReasons`
  （上限 20），回合末 `replayPendingWakeReasons`，消息类要求 `inbox` 里那条还在。
- 三路调度：触发 / 睡醒定时器（单次最多 100009ms 再续，防 setTimeout 溢出）/ 主动机会
  （30–90 分钟随机、idle 15 分钟、prob 0.4、23:00–08:00 ×0.3）。
- 防永眠三层：无触发条件不许 `infinite`、`ensureWakeable`、回合末提醒两次后重置默认。
- 旧 `heartStep` + `nextWakeAt` 保留在 `legacy` 模式（配置 `wake.mode='legacy'` 可回滚），
  默认走新链路。

## 二、闸门与预算（护栏先上，别把钱包烧穿）

新文件 `lib/core/guard.js`（移植 `src/token-guard.js`、`src/turn-guard.js`，
简化 `src/token-budget.js`）。

- 唤醒上限：每日 20 次、最小间隔 120 秒、日预算（默认 ¥8，按 `assistant/message` 的 usage 记账）。
  超限不丢，延后 60 秒重试。
- 每分钟 1 次、每小时 12 次。
- 单轮 40 步、同工具同错误 3 次即停（用 `tool/call`、`tool/result` 事件计数）。
- 全部超限都写进 `state.wake.blocked`，界面上能看见「为什么没醒」。

## 三、收尾与「没说完」

新文件 `lib/core/closure.js`（移植 `src/conversation-closure.js`）和 `lib/core/unfinished.js`
（移植 `src/v2-wait.js`）。

- `classifyMessage`：ending / question / request / ack / substantive 五类，带 `settled`。
- `assessClosure`：给出「我最后一句像收尾 / 对方在提问 / 我还有想说的」三句建议；`closeGate`
  在对方有未答提问时拒绝收尾。
- 收尾冷却 20 分钟，只压主动机会和概率唤醒，主人叫醒不受影响。
- 不注册工具：回合末宿主按同一套判定自动写 `state.closure`（摘要 + 下次怎么接），
  醒来时把 `summary`/`nextOpening` 放进唤醒提示词。
- `looksUnfinished`：尾巴是「但是/然后/所以说/…」或逗号句号没收住，就注入
  「对方可能没说完」，提示先等一等。

## 四、说话：整段一条 → 分条

- `~/.dsh/notify-qq.py` 支持多条：参数是 JSON 数组，或正文按空行分条；
  每条 1–3 秒随机间隔、最多 8 条、单条 500 字；返回每条的发送结果。
- `lib/core/prompt.js` 的 `reportTail()` 改成分条写法：「先发第一句，隔一两秒再补第二句」，
  并带上「这次最多 N 条」的上限。

## 五、记忆：没有遗忘 → 会忘

新文件 `lib/core/memory.js`（移植 `src/memory-card.js` 的卡片模型 + `plugins/surfcore/lib/memory-card.js`
的对账节奏）。

- `~/.dsh/feiyu-life/memory-card.md` 是唯一真相：一行一条，行尾 `[清晰度 日期 重要度 提起次数 标签]`，主人可以手改，读不懂的行原样留着。要 json 就跑 `node scripts/memory-to-json.mjs`。
- 清晰度五档 `vivid/clear/fuzzy/trace/forgotten`；7 天内至少「清楚」；一天最多降一档、升一档；
  跟主人有关的保留度下限 55。
- 每 10 分钟对账一次（把当天日记、笔记里新出现的事实并进来）；渲染进 prompt 有 2200 字预算。

## 六、界面：改成我们自己的卡

`assets/widget.js`，沿用现在的深色卡片，新增四块（不照抄他们的 GUI）：

- 醒着的状态：模式、下次醒来、当前生效的触发条件、最近一次为什么没醒。
- 未读与上次发言：未读 N 条、最近一条来自谁、我上次说话多久前。
- 上次收尾：summary 一行、nextOpening 一行。
- 今日护栏：唤醒次数/上限、已花预算、被拦次数。

状态灯沿用三态（新/推进/卡住），加「醒着/睡着」一个点。

## 七、测试与收尾

- 新测试：触发优先级与合并窗、未读水位、防永眠、护栏上限、收尾闸门、没说完判定、
  记忆衰减、分条发送。
- `CHANGELOG.md` v0.10.0、`package.json` 同步；工作日志记一页。
- 兼容：老 `state.json` 缺字段一律由 `normalizeState` 补默认；`wake.mode='legacy'` 可回滚。

## 风险（自己过一遍）

1. **成本**：事件驱动之后每次唤醒都是完整回合，护栏必须和唤醒同一天上线，否则钱包先炸。
   → 先上 `guard.js`，再接事件源。
2. **事件源真假**：`user/message` 是否包含主人从 QQ 发来的消息，还没实测。
   → 先加一条诊断日志，跑一天看 `inbox` 有没有长大。
3. **老数据**：现在的 `state.json` 有 51KB、字段杂，迁移要幂等。
   → `normalizeState` 里补 `wake/closure/memory/inbox` 默认值，缺就当空。
4. **回滚**：新链路一出问题要能一键退。
   → `wake.mode='legacy'` 保留旧 `heartStep`，配置改一个字段就回去。
5. **「界面也改成我们的」**：理解为不抄他们的 GUI，用我们自己的挂饰卡。
   → 如果主人本意是「照他们界面重做」，这一步要返工，所以先按我们的卡做，做完给主人看。
