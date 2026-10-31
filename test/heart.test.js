import test from 'node:test'
import assert from 'node:assert/strict'

import { blankState, openWorkAdd } from '../lib/core/state.js'
import { buildCard, parseDecision, nextWakeAt, heartSystem, HEART_DEFAULT_MINUTES } from '../lib/core/heart.js'
import { grantAddTaken, askPush } from '../lib/core/grants.js'

const DAY = new Date(2026, 9, 31, 15, 20, 0).getTime()
const NIGHT = new Date(2026, 9, 31, 2, 10, 0).getTime()

function sampleState(now = DAY) {
  const s = blankState(now)
  s.mood = 42
  s.spirit = 41
  s.activity = { kind: 'study', note: '在看 v4 契约', since: now }
  s.timeline = [
    { at: now - 3600000, kind: 'task-done', reason: '把 gate 改完了', delta: 3 },
    { at: now - 1200000, kind: 'user-message', reason: '主人说了一句「慢点来」', delta: 2 },
  ]
  openWorkAdd(s, { text: '把导出模板收尾', urgency: 0.9 }, now)
  s.agenda = [{ id: 'a1', text: '提醒主人喝水', kind: 'remind', dueAt: now + 1800000, window: null, urgency: 0.7 }]
  return s
}

const info = {
  now: DAY,
  mainGapMinutes: 37,
  lastUserText: '这条先别急，慢慢改就行，改完再给我看',
  thoughts: ['她好像有点累', '导出那块还没动'],
  plans: ['明天把 v4 的宿主接上'],
}

test('卡片只有事实：不出现允许、阈值、门槛这类话', () => {
  const card = buildCard(sampleState(), info, {})
  assert.ok(!/允许|需要许可/.test(card), card)
  assert.ok(!/阈值|门槛|最少隔|必须要/.test(card), card)
  assert.ok(!/你可以|你被允许/.test(card), card)
})

test('卡片按顺序给出时段、主人、在做的事、心情、活、时间线', () => {
  const card = buildCard(sampleState(), info, {})
  assert.match(card, /【现在】.*下午/)
  assert.match(card, /37 分钟前/)
  assert.match(card, /慢慢改就行/)
  assert.match(card, /在学东西/)
  assert.match(card, /【状态】心情 42\/100/)
  assert.match(card, /兴致 41\/100/)
  assert.ok(!/精力/.test(card), '卡片里不该再说精力')
  assert.match(card, /把导出模板收尾/)
  assert.match(card, /提醒主人喝水/)
  assert.match(card, /把 gate 改完了/)
  assert.match(card, /导出那块还没动/)
  assert.match(card, /明天把 v4 的宿主接上/)
  assert.ok(!card.includes("没人接"), "卡片不该再提被忽略")
  assert.ok(card.endsWith('这一会儿要不要做点什么，你自己定；不做也正常。'))
})

test('夜里说主人在睡，凌晨也算夜里', () => {
  const card = buildCard(sampleState(NIGHT), { now: NIGHT, mainGapMinutes: 12 }, {})
  assert.match(card, /凌晨/)
  assert.match(card, /主人多半在睡/)
})

test('没有时间就不假装知道现在几点', () => {
  const card = buildCard({ mood: 70, spirit: 55 }, {}, {})
  assert.match(card, /时间不明/)
  assert.ok(!card.includes('1970'))
})

test('【今天】只读宿主给的事实，空数组时整块不出现', () => {
  const withFacts = buildCard(sampleState(), { ...info, facts: ['主人在改界面', '测试跑到 143 条'] }, {})
  assert.match(withFacts, /【今天】/)
  assert.match(withFacts, /主人在改界面/)
  assert.match(withFacts, /测试跑到 143 条/)

  const without = buildCard(sampleState(), info, {})
  assert.ok(!without.includes('【今天】'))
})

test('卡片不写体感词，只给读数和位置', () => {
  const card = buildCard(sampleState(), info, {})
  assert.match(card, /【位置】/)
  assert.match(card, /心情 42\/100/)
  assert.ok(!/一般|有点蔫|挺好|很难受/.test(card), `不该出现形容词：${card}`)
})

test('三种输入都能解析：纯 JSON / 代码块 / 文字里夹一段', () => {
  const body = '{"do":"speak","act":null,"text":"主人，喝口水吧","reason":"看他忙太久了","note":"","nextMinutes":25}'
  const plain = parseDecision(body)
  assert.equal(plain.do, 'speak')
  assert.equal(plain.text, '主人，喝口水吧')
  assert.equal(plain.nextMinutes, 25)

  const fenced = parseDecision('```json\n' + body + '\n```')
  assert.equal(fenced.do, 'speak')

  const prose = parseDecision('我看了一圈，觉得还是说一句好。\n' + body + '\n大概就这样。')
  assert.equal(prose.do, 'speak')
  assert.equal(prose.reason, '看他忙太久了')
})

test('do 写错的时候映射到 speak，act 写错就整条不认', () => {
  assert.equal(parseDecision('{"do":"talk","text":"在吗"}').do, 'speak')
  assert.equal(parseDecision('{"do":"说话","text":"在吗"}').do, 'speak')
  assert.equal(parseDecision('{"do":"act","act":"watch","reason":"随便"}'), null)
})

test('do 为 nothing 是成功的解析，不是失败', () => {
  const d = parseDecision('{"do":"nothing","reason":"这会儿不想说话","nextMinutes":30}')
  assert.ok(d)
  assert.equal(d.do, 'nothing')
  assert.equal(d.text, '')
  assert.equal(d.nextMinutes, 30)
})

test('乱码和没有 JSON 返回 null', () => {
  assert.equal(parseDecision(''), null)
  assert.equal(parseDecision('就是一些没头没尾的话'), null)
  assert.equal(parseDecision('{"do":"speak",'), null)
  assert.equal(parseDecision('{"do":"什么都不是"}'), null)
  assert.equal(parseDecision('{不是 json}'), null)
})

test('nextMinutes 缺省或写坏就用默认，text 超过 400 字截断', () => {
  const d = parseDecision('{"do":"speak","text":"' + '啊'.repeat(500) + '","nextMinutes":"一会儿"}')
  assert.equal(d.nextMinutes, HEART_DEFAULT_MINUTES)
  assert.equal(d.text.length, 401) // 400 字 + 省略号
})

test('nextWakeAt 夹在上下限之间', () => {
  const cfg = { heartDefaultMinutes: 20, heartMinMinutes: 1, heartMaxMinutes: 60 }
  assert.equal(nextWakeAt({ nextMinutes: 0.2 }, DAY, cfg), DAY + 60000)
  assert.equal(nextWakeAt({ nextMinutes: 999 }, DAY, cfg), DAY + 3600000)
  assert.equal(nextWakeAt({}, DAY, cfg), DAY + 20 * 60000)
  assert.equal(nextWakeAt({ nextMinutes: 7 }, DAY, cfg), DAY + 7 * 60000)
})

test('系统提示第一人称，只输出一段 JSON', () => {
  const sys = heartSystem({ selfName: '小鱼' })
  assert.match(sys, /^你是小鱼/)
  assert.match(sys, /可以什么都不做/)
  assert.match(sys, /只回一段 JSON/)
  assert.match(sys, /\{"do":"nothing\|speak\|act\|ask\|use"/)
})

test('卡片里有门路，有待答请求时多一行原话', () => {
  const state = sampleState()
  grantAddTaken(state, {
    id: 'bili',
    label: 'B站',
    account: '主人自己的账号',
    private: true,
    limits: ['不评论'],
    verbs: [
      { verb: 'look', label: '看看', how: '只读：搜视频', needAsk: false, granted: true },
      { verb: 'collect', label: '收藏', needAsk: true },
    ],
  }, DAY)
  askPush(state, { use: 'bili', verb: 'collect', text: '主人，人家想把那个视频收起来，可以吗？' }, DAY, {})

  const card = buildCard(state, info, {})
  assert.match(card, /【门路：B站 —— 看看（只读：搜视频）、收藏（要先问主人）】/)
  assert.match(card, /还有一件事在等你答应：主人，人家想把那个视频收起来/)
})

test('do:ask 能解析，use/verb 缺一个就整条不认', () => {
  const d = parseDecision('{"do":"ask","use":"bili","verb":"collect","why":"想收藏几个视频"}')
  assert.ok(d)
  assert.equal(d.do, 'ask')
  assert.equal(d.use, 'bili')
  assert.equal(d.verb, 'collect')
  assert.equal(d.act, null)
  // 没写原话就留空，由宿主按门路的中文名拼一句（core 拼出来是 bili 的 collect，太生硬）
  assert.equal(d.text, '')

  assert.equal(parseDecision('{"do":"ask","use":"bili"}'), null)
  assert.equal(parseDecision('{"do":"ask","verb":"collect"}'), null)
})


test('卡片给往来摘要：主人说的和人家说的都在', () => {
  const s = blankState(1000)
  s.recentTalk = [
    { at: 1000, who: 'owner', text: '今晚早点睡' },
    { at: 1001, who: 'fish', text: '人家知道了喵' },
  ]
  const card = buildCard(s, { now: 1002 })
  assert.match(card, /【刚才在聊什么】/)
  assert.match(card, /主人：今晚早点睡/)
  assert.match(card, /人家：人家知道了喵/)
})

test('没有往来时退回说过的话，都没有就说还没聊过', () => {
  const s = blankState(1000)
  const card = buildCard(s, { now: 1002 })
  assert.match(card, /还没聊过/)
})
