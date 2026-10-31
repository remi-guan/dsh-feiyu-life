import test from 'node:test'
import assert from 'node:assert/strict'

import { blankState, normalizeState, noteBehavior, openWorkAdd, openWorkDone, openWorkList, dayKey } from '../lib/core/state.js'
import { BEHAVIORS, pickBehavior } from '../lib/core/behaviors.js'
import { behaviorPrompt } from '../lib/core/prompt.js'

/** 一个安静的白天：10:00，主人两小时没说话，兴致够用 */
const DAY = new Date(2026, 9, 31, 10, 0, 0).getTime()

function quietState(now = DAY, over = {}) {
  const s = blankState(now)
  s.spirit = 60
  s.mood = 70
  s.updatedAt = now
  Object.assign(s, over)
  return s
}

/** 只留下一个行为：别的都关掉，免得被更高的分抢走 */
function only(id) {
  const cfg = { behaviors: {} }
  for (const b of BEHAVIORS) cfg.behaviors[b.id] = { enabled: b.id === id }
  return cfg
}

/** 心情偏低的时候才想写日记：契约里 journal 的想头 = 0.3 + (60 - mood)/120 */
function gloomyState(now = DAY, over = {}) {
  const s = quietState(now, over)
  s.mood = 30
  return s
}

const quietStats = (now = DAY) => ({ lastUserAt: now - 120 * 60000, lastSpokeAt: 0, spokeToday: 0 })

test('BEHAVIORS 的 id 固定且顺序就是平手优先级', () => {
  assert.deepEqual(BEHAVIORS.map((b) => b.id), ['talk', 'continue', 'help', 'journal', 'browse'])
})

test('gate 不过的行为不会被挑中：凌晨不写日记', () => {
  const night = new Date(2026, 9, 31, 3, 0, 0).getTime()
  const state = quietState(night)
  const picked = pickBehavior(state, night, quietStats(night), only('journal'))
  assert.equal(picked, null)
  assert.equal(pickBehavior(gloomyState(DAY), DAY, quietStats(DAY), only('journal'))?.id, 'journal')
})

test('gate 不过的行为不会被挑中：兴致不够逛不动', () => {
  const state = quietState(DAY, { spirit: 50 })
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), only('browse')), null)
})

test('冷却中的行为被排除', () => {
  const state = gloomyState(DAY)
  state.behaves.journal = { lastAt: DAY - 60 * 60000, dayCount: 1, day: dayKey(DAY) }
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), only('journal')), null)

  state.behaves.journal = { lastAt: DAY - 4 * 3600000, dayCount: 1, day: dayKey(DAY) }
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), only('journal'))?.id, 'journal')
})

test('设了额度就按额度算，跨日不算；额度 0 表示不限次', () => {
  const state = gloomyState(DAY)
  const capped = only('journal')
  capped.behaviors.journal = { enabled: true, dailyCap: 2 }
  state.behaves.journal = { lastAt: DAY - 4 * 3600000, dayCount: 2, day: dayKey(DAY) }
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), capped), null)

  // 昨天的账不该背到今天
  state.behaves.journal = { lastAt: DAY - 4 * 3600000, dayCount: 2, day: '2026-10-30' }
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), capped)?.id, 'journal')

  // 自己的事默认不限次：今天已经写了 9 次，还是能写
  const uncapped = only('journal')
  uncapped.behaviors.journal = { enabled: true, dailyCap: 0 }
  state.behaves.journal = { lastAt: DAY - 4 * 3600000, dayCount: 9, day: dayKey(DAY) }
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), uncapped)?.id, 'journal')
})

test('全局间隔：任何一种行为刚做过，就都先停一会', () => {
  const state = gloomyState(DAY)
  state.behaves.journal = { lastAt: DAY - 4 * 3600000, dayCount: 1, day: dayKey(DAY) }
  state.behaves.browse = { lastAt: DAY - 10 * 60000, dayCount: 1, day: dayKey(DAY) }
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), only('journal')), null)

  state.behaves.browse.lastAt = DAY - 40 * 60000
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), only('journal'))?.id, 'journal')
})

test('低于阈值返回 null', () => {
  const cfg = only('journal')
  cfg.behaviorThreshold = 0.9
  const state = quietState(DAY, { spirit: 41 })
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), cfg), null)
})

test('同一件急活面前，continue 的想头比 help 高', () => {
  const state = quietState(DAY, { spirit: 100, mood: 50 })
  // help = 0.3 + 0.425*0.35 + 0 = 0.44875；continue = 0.45 + 0.425*0.4 = 0.62
  openWorkAdd(state, { text: '把导出模板收尾', urgency: 0.425 }, DAY)
  const cfg = only('continue')
  cfg.behaviors.help = { enabled: true }
  const picked = pickBehavior(state, DAY, quietStats(DAY), cfg)
  assert.equal(picked?.id, 'continue')
  assert.equal(picked.appetite, 0.62)
})

test('没有没做完的活时 continue 拿不到', () => {
  const state = quietState(DAY, { spirit: 90 })
  assert.equal(pickBehavior(state, DAY, quietStats(DAY), only('continue')), null)
})

test('挑中时返回可读的 reason', () => {
  const state = gloomyState(DAY)
  const picked = pickBehavior(state, DAY, quietStats(DAY), only('journal'))
  assert.equal(picked.id, 'journal')
  assert.equal(typeof picked.reason, 'string')
  assert.ok(picked.reason.length > 0)
})

test('缺省参数兜得住：cfg 空、behaves 没有、openWork 不是数组', () => {
  const state = quietState(DAY)
  delete state.behaves
  state.openWork = 'oops'
  assert.doesNotThrow(() => pickBehavior(state, DAY, {}, undefined, {}))
  assert.doesNotThrow(() => pickBehavior(state, DAY, {}, undefined, { openWork: 'oops' }))
})

test('normalizeState 迁移旧 state 不炸，v3 字段补齐', () => {
  const old = { mood: 52, energy: 40, dims: { happy: 3, calm: 5 }, feels: [] }
  const s = normalizeState(old, DAY)
  assert.deepEqual(s.behaves, {})
  assert.deepEqual(s.openWork, [])
  assert.equal(s.lastBehavior, null)
  assert.equal(s.mood, 52)
})

test('noteBehavior 记次数，跨日重置', () => {
  const state = blankState(DAY)
  assert.equal(noteBehavior(state, 'journal', DAY), 1)
  assert.equal(noteBehavior(state, 'journal', DAY + 60000), 2)
  assert.equal(state.behaves.journal.dayCount, 2)

  const tomorrow = new Date(2026, 10, 1, 10, 0, 0).getTime()
  assert.equal(noteBehavior(state, 'journal', tomorrow), 1)
  assert.equal(state.behaves.journal.day, dayKey(tomorrow))
})

test('openWork 增删查：完成的不再出现在清单里', () => {
  const state = blankState(DAY)
  openWorkAdd(state, { text: '整理文档', urgency: 0.2 }, DAY)
  openWorkAdd(state, { text: '修导出', urgency: 0.9 }, DAY + 1)
  assert.deepEqual(openWorkList(state).map((it) => it.text), ['修导出', '整理文档'])

  const top = openWorkList(state)[0]
  openWorkDone(state, top.id, DAY + 2)
  assert.equal(openWorkList(state).length, 1)
  assert.equal(openWorkList(state)[0].text, '整理文档')
})

test('openWork 超过 20 条时丢掉最不急的', () => {
  const state = blankState(DAY)
  for (let i = 0; i < 22; i++) openWorkAdd(state, { text: `活 ${i}`, urgency: i === 0 ? 0.01 : 0.5 }, DAY + i)
  assert.equal(state.openWork.length, 20)
  assert.ok(!state.openWork.some((it) => it.text === '活 0'))
})

test('behaviorPrompt 的哨兵与结束条件', () => {
  const state = quietState(DAY)
  openWorkAdd(state, { text: '把导出模板收尾', urgency: 0.8 }, DAY)

  const talk = behaviorPrompt('talk', state, { now: DAY }, {})
  assert.equal(talk.split('\n')[0], '[feiyu-life]')

  for (const id of ['journal', 'browse', 'continue', 'help']) {
    const text = behaviorPrompt(id, state, { now: DAY }, {})
    assert.equal(text.split('\n')[0], `[feiyu-life:behave:${id}]`)
    assert.ok(text.includes('做完就停'))
    assert.ok(text.includes('不提问') || text.includes('不许提问') || text.includes('没有人能回答'))
  }

  assert.ok(behaviorPrompt('continue', state, { now: DAY }, {}).includes('把导出模板收尾'))
  assert.ok(behaviorPrompt('journal', state, { now: DAY }, {}).includes('3-我的念头.md'))
  assert.ok(behaviorPrompt('browse', state, { now: DAY }, {}).includes('4b-逛到的东西.md'))
})

test('每条行为最后都要给主人发一句（走 QQ 时）', () => {
  const state = quietState(DAY)
  for (const id of ['journal', 'browse', 'continue', 'help']) {
    const qq = behaviorPrompt(id, state, { now: DAY }, { talkChannel: 'qq' })
    assert.ok(qq.includes('notify-qq.py'), `${id} 要交代发 QQ`)
    assert.ok(qq.includes('跑一次或几次'), `${id} 允许分几条发`)
    assert.ok(!/只发一句/.test(qq), '不再强求只发一句')
    const inSession = behaviorPrompt(id, state, { now: DAY }, { talkChannel: 'session' })
    assert.ok(!inSession.includes('notify-qq.py'), `${id} 发到会话时不该跑 QQ 脚本`)
  }
})
