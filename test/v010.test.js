/**
 * v0.10 四个新模块的单元测试。
 *
 * 都是纯函数，所以用假时间戳直接摆事实，不起任何会话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  looksLikeUnfinished, unfinishedLine,
} from '../lib/core/unfinished.js'
import {
  buildReplyBrief, countBurst,
} from '../lib/core/brief.js'
import {
  assessExchange, closeGate, closureSuppressesWake, makeClosureRecord, normalizeClosureConfig, reopenClosure,
} from '../lib/core/closure.js'
import {
  DEFAULT_WAKE_GUARD, evaluateWakeBudget, estimateCost, guardSummary, noteSpend,
} from '../lib/core/guard.js'
import {
  CLARITY_ORDER, addMemory, applyDailyDecay, normalizeMemoryConfig,
  parseMemoryMarkdown, renderMemoryMarkdown, renderMemoryPrompt, targetClarity,
} from '../lib/core/memory.js'

const DAY = Date.parse('2026-11-01T15:00:00+08:00')
const HOUR = 3600_000

// ── 没说完 ────────────────────────────────────────────────────────────────

test('话说到一半能认出来，说完了不认', () => {
  assert.ok(looksLikeUnfinished('我跟你讲，'))
  assert.ok(looksLikeUnfinished('然后'))
  assert.ok(looksLikeUnfinished('其实吧'))
  assert.ok(!looksLikeUnfinished('我今天把报告交了。'))
  assert.ok(!looksLikeUnfinished('好的'))
  assert.ok(unfinishedLine('但是，').includes('没说完'))
  assert.ok(unfinishedLine('其实吧').includes('等一会儿'))
})

// ── 收尾 ──────────────────────────────────────────────────────────────────

test('收尾只看两件事：我最后一句像不像告别，他是不是还在问', () => {
  const close = assessExchange({ outgoing: '那人家先去忙了，晚点再说。', incoming: '好', now: DAY })
  assert.equal(close.verdict, 'close')

  const asked = assessExchange({ outgoing: '那人家先去忙了。', incoming: '你等下有空吗？', now: DAY })
  assert.notEqual(asked.verdict, 'close', '他还在问，就不该收尾')

  const open = assessExchange({ outgoing: '这个我算了一下是 3.2 秒。', incoming: '嗯', now: DAY })
  assert.notEqual(open.verdict, 'close')
})

test('收尾只压住「自己想去搭话」，压不住主人来消息', () => {
  const a = assessExchange({ outgoing: '那就这样啦，晚安。', incoming: '晚安', now: DAY })
  const record = makeClosureRecord({ key: 'owner', assessment: a, body: { summary: '聊完了' }, now: DAY })
  assert.ok(closureSuppressesWake(record, 'proactiveCheck', DAY + 60_000))
  assert.ok(!closureSuppressesWake(record, 'private', DAY + 60_000))
  const after = DAY + normalizeClosureConfig({}).cooldownMs + 60_000
  assert.ok(!closureSuppressesWake(record, 'proactiveCheck', after), '冷却过了就不压了')
  const reopened = reopenClosure(record, { reason: 'new-message', now: DAY + HOUR })
  assert.ok(reopened.reopenedAt > 0)
  assert.ok(!closureSuppressesWake(reopened, 'proactiveCheck', DAY + HOUR))
})

// ── 护栏 ──────────────────────────────────────────────────────────────────

test('护栏只拦三件事：一天几次、两次之间隔多久、今天花了多少', () => {
  const guard = { ...DEFAULT_WAKE_GUARD, maxWakesPerDay: 2, minWakeGapMs: 300_000 }
  const times = [DAY - 60_000, DAY - 30_000]
  assert.equal(evaluateWakeBudget({ wakeTimes: times, now: DAY, guard }).reason, 'day')

  const gap = evaluateWakeBudget({ wakeTimes: [DAY - 60_000], now: DAY, guard })
  assert.equal(gap.reason, 'gap')

  const cost = evaluateWakeBudget({
    wakeTimes: [], now: DAY, guard: { ...guard, maxDailyCostCNY: 1 }, cost: 1.5,
  })
  assert.equal(cost.reason, 'cost')

  const ok = evaluateWakeBudget({ wakeTimes: [], now: DAY, guard })
  assert.equal(ok.blocked, false, '没超就放行')
})

test('花费从 token 估，同一天累加，隔天清零', () => {
  const guard = { ...DEFAULT_WAKE_GUARD, costPerMTokens: 10 }
  const one = estimateCost({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, guard)
  assert.ok(Math.abs(one - 10) < 0.001)
  const state = { spend: { day: 0, yuan: 0 } }
  noteSpend(state, 0.5, DAY)
  noteSpend(state, 0.25, DAY + 60_000)
  assert.equal(state.spend.yuan, 0.75)
  noteSpend(state, 1, DAY + 26 * HOUR)
  assert.equal(state.spend.yuan, 1, '换天了就重新算')
  assert.equal(guardSummary(state, guard, DAY + 26 * HOUR).spent, 1)
})

// ── 记忆 ──────────────────────────────────────────────────────────────────

test('刚记下的事很清楚，很久没提就一路掉到忘了', () => {
  const { records } = addMemory([], { text: '主人喜欢把闹钟设在七点四十', importance: 70 }, {}, DAY)
  assert.equal(records.length, 1)
  assert.equal(targetClarity(records[0], {}, DAY), 'vivid')

  assert.equal(targetClarity(records[0], {}, DAY + 60 * 24 * HOUR), 'clear', '两个月不提还留着，但不再是新鲜事')
  assert.equal(targetClarity(records[0], {}, DAY + 150 * 24 * HOUR), 'trace', '半年不提只剩影子')
  assert.equal(targetClarity(records[0], {}, DAY + 200 * 24 * HOUR), 'forgotten')
})

test('跟主人有关又够重要的事，不会被彻底忘掉', () => {
  const { records } = addMemory([], {
    text: '主人答应下周一起看那部片子', importance: 80, tags: ['owner'],
  }, {}, DAY)
  assert.notEqual(targetClarity(records[0], {}, DAY + 300 * 24 * HOUR), 'forgotten')
})

test('一天只降一档，被提起又变清楚', () => {
  const { records } = addMemory([], { text: '他说想学吉他', importance: 50 }, {}, DAY)
  const cfg = normalizeMemoryConfig({})
  const first = applyDailyDecay(records, cfg, DAY + 20 * 24 * HOUR, { force: true })
  const startIndex = CLARITY_ORDER.indexOf('vivid')
  const afterIndex = CLARITY_ORDER.indexOf(first.records[0].clarity)
  assert.equal(startIndex - afterIndex, 1, '一次只降一档')

  const again = addMemory(first.records, { text: '他说想学吉他', importance: 50 }, cfg, DAY + 21 * 24 * HOUR)
  assert.equal(again.recalled, true)
  assert.equal(again.records[0].recallCount, 1)
  assert.equal(again.records[0].clarity, 'clear', '被提起就回到至少「记得」')
})

test('同一天不重复整理，渲染有字数预算', () => {
  let cur = []
  for (let i = 0; i < 30; i += 1) {
    cur = addMemory(cur, { text: `第 ${i} 件小事：${'很长的一句话'.repeat(6)}`, importance: 40 }, {}, DAY).records
  }
  const cfg = normalizeMemoryConfig({ promptBudgetChars: 600 })
  const out = renderMemoryPrompt(cur, cfg, DAY)
  assert.ok(out.includes('你记得的事'))
  assert.ok(out.length <= 640, `预算超了：${out.length}`)

  const cfg2 = normalizeMemoryConfig({})
  const once = applyDailyDecay(cur, cfg2, DAY + 24 * HOUR, { lastDecayDay: '2026-11-01' })
  assert.equal(once.changed, true)
  const twice = applyDailyDecay(once.records, cfg2, DAY + 24 * HOUR, { lastDecayDay: once.day })
  assert.equal(twice.changed, false, '今天已经整理过了就不再动')
})

// ── 记忆的 markdown 就是唯一真相 ──────────────────────────────────────────

test('写成 md 再读回来，内容和清晰度都不丢', () => {
  const { records } = addMemory([], { text: '主人怕吵，耳机音量总是调到六成', importance: 62, tags: ['owner'] }, {}, DAY)
  const md = renderMemoryMarkdown(records, DAY)
  assert.ok(md.includes('小鱼记得的事'))
  assert.ok(md.includes('主人怕吵'))

  const back = parseMemoryMarkdown(md, DAY + HOUR)
  assert.equal(back.broken, 0)
  assert.equal(back.records.length, 1)
  assert.equal(back.records[0].text, '主人怕吵，耳机音量总是调到六成')
  assert.equal(back.records[0].clarity, 'vivid')
  assert.equal(back.records[0].importance, 62)
  assert.deepEqual(back.records[0].tags, ['owner'])
})

test('手写的行也认，读不懂的行原样留着不吞', () => {
  const md = [
    '# 小鱼记得的事',
    '- 主人最近在改 feiyu-life 的唤醒 [clear 2026-10-30 70 3 owner,code]',
    '- 这一行是主人随手写的没有元信息',
    '随便一句不是列表的说明文字',
    '- 上周答应帮他跑一次测试 [fuzzy 2026-10-20 55 1]',
  ].join('\n')
  const { records, broken } = parseMemoryMarkdown(md, DAY)
  assert.equal(records.length, 3)
  assert.equal(broken, 1)
  assert.equal(records[0].clarity, 'clear')
  assert.equal(records[0].recallCount, 3)
  assert.deepEqual(records[0].tags, ['owner', 'code'])
  assert.equal(records[1].clarity, 'fixme')
  assert.ok(records[1].text.includes('随手写的'))
  assert.equal(records[2].clarity, 'fuzzy')
})

test('记忆超量时只丢自己记的，主人手写读不懂的行不丢', () => {
  const cfg = normalizeMemoryConfig({ maxRecords: 20 })
  const md = Array.from({ length: 25 }, (_, i) => `- 第 ${i} 条旧事 [vivid 2026-10-01 40 0]`).join('\n')
    + '\n- 这句话主人手写的，格式不对\n'
  const { records } = parseMemoryMarkdown(md, DAY)
  const fixme = records.filter((r) => r.clarity === 'fixme')
  assert.equal(fixme.length, 1)
  const res = addMemory(records, { text: '新记一笔', importance: 40 }, cfg, DAY)
  assert.ok(res.records.some((r) => r.clarity === 'fixme'), '手写读不懂的行被丢掉了')
  assert.ok(res.records.length <= 21, `没有按上限裁，实际 ${res.records.length} 条`)
})

test('记忆一行一条：正文里的换行写进去要压平，不能读成两条', () => {
  const md = '## 记得\n\n- 第一行\n第二行还在这一条里 [clear 2026-10-30 60 0]\n'
  const { records, broken } = parseMemoryMarkdown(md, DAY)
  assert.equal(broken, 1, '手写的跨行被当成读不懂，这是预期：一行一条才是格式')
  const res = addMemory([], { text: '多行\n的记忆', importance: 40 }, {}, DAY)
  const rendered = renderMemoryMarkdown(res.records, DAY)
  assert.ok(!/多行\n/.test(rendered), '换行没压平，写出来会变成两条')
  const back = parseMemoryMarkdown(rendered, DAY)
  assert.equal(back.records.length, 1)
  assert.equal(back.records[0].text, '多行 的记忆')
})

test('收尾硬闸：他还在问，我那句只是收场，就不许记收尾', () => {
  const asked = assessExchange({
    outgoing: '那人家先睡了，晚安。', incoming: '你明天有空帮我看下那个报错吗？', now: DAY,
  })
  assert.equal(asked.signals.awaitingTheirAnswer, true)
  assert.equal(closeGate(asked, {}).blocked, true)
  const answered = assessExchange({
    outgoing: '我看了一下，是端口被占了，改 5174 就行。', incoming: '你明天有空帮我看下那个报错吗？', now: DAY,
  })
  assert.equal(answered.signals.awaitingTheirAnswer, false)
})

test('记忆写盘在原文上原位改：主人写的散文和读不懂的行都留着', () => {
  const original = [
    '# 小鱼记得的事', '', '> 更新于 2026/10/30 10:00:00，共 1 条', '',
    '- 主人答应下周看片子 [clear 2026-10-28 80 2 owner]', '',
    '这是我手写的一行说明，别删。', '- 手写的半截', '',
  ].join('\n')
  const { records } = parseMemoryMarkdown(original, DAY)
  const res = addMemory(records, { text: '新的一件事', importance: 60 }, {}, DAY)
  const out = renderMemoryMarkdown(res.records, DAY, original)
  assert.ok(out.includes('这是我手写的一行说明，别删。'), '散文被洗掉了')
  assert.ok(out.includes('- 手写的半截'), '读不懂的行被改写了')
  assert.ok(out.includes('- 新的一件事 [vivid'))
  assert.ok(out.includes('共 3 条'))
})

test('回话状况单：连发时收成一条，没连发时按上限说', () => {
  const now = Date.UTC(2026, 10, 1, 9, 0, 0)
  const talk = Array.from({ length: 5 }, (_, i) => ({ at: now - i * 60_000, who: 'owner', text: `第${i}条` }))
  const burst = buildReplyBrief({
    owner: '主人', now, talk, lastUserText: '在吗', lastUserAt: now, lastSpeakAt: now - 40 * 60_000,
    config: { burstWindowMinutes: 10, burstCount: 4, maxMessages: 3, burstMaxMessages: 1 },
  })
  assert.ok(burst.includes('连发了 5 条'))
  assert.ok(burst.includes('最多发 1 条'))
  const calm = buildReplyBrief({
    owner: '主人', now, talk: [{ at: now - 3600_000, who: 'owner', text: '嗯' }],
    lastUserText: '帮我看看这个', lastUserAt: now,
    config: { burstWindowMinutes: 10, burstCount: 4, maxMessages: 3, burstMaxMessages: 1 },
  })
  assert.ok(calm.includes('最多发 3 条'))
  assert.ok(!calm.includes('连发'))
})

test('回话状况单：隔很久才开口、挂着活、记得的事都要带上', () => {
  const now = Date.UTC(2026, 10, 1, 9, 0, 0)
  const text = buildReplyBrief({
    owner: '主人',
    now,
    talk: [],
    lastUserText: '早',
    lastUserAt: now - 5 * 3600_000,
    lastSpeakAt: now - 2 * 3600_000,
    memory: '【你记得的】主人怕吵。',
    closure: '【收尾】上一段收在「明天再看」。',
    openWorkCount: 2,
    config: {},
  })
  assert.ok(text.includes('5 小时前'))
  assert.ok(text.includes('你上次开口是2 小时前'))
  assert.ok(text.includes('主人怕吵'))
  assert.ok(text.includes('挂着 2 件'))
})

test('回话状况单：关掉就一个字都不挂', () => {
  assert.equal(buildReplyBrief({ owner: '主人', now: 1, lastUserText: '在吗', config: { enabled: false } }), '')
})

test('countBurst 只数窗口内的他，不数她自己', () => {
  const now = 10_000_000
  const talk = [
    { at: now - 60_000, who: 'owner' },
    { at: now - 120_000, who: 'fish' },
    { at: now - 3600_000, who: 'owner' },
  ]
  assert.equal(countBurst(talk, 'owner', now, 10 * 60_000), 1)
  assert.equal(countBurst(talk, 'fish', now, 10 * 60_000), 1)
  assert.equal(countBurst(null, 'owner', now, 60_000), 0)
})
