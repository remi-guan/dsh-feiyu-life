import test from 'node:test'
import assert from 'node:assert/strict'

import {
  blankState, dayKey, normalizeState, noteBehavior, openWorkAdd, openWorkDone, openWorkList, openWorkNote,
  openWorkMergeAll, openWorkSimilar, openWorkStuck,
} from '../lib/core/state.js'
import { BEHAVIORS, checkinPlan, pickBehavior, planDay } from '../lib/core/behaviors.js'
import { detectRoutine } from '../lib/core/routine.js'
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
  assert.deepEqual(BEHAVIORS.map((b) => b.id), ['talk', 'checkin', 'continue', 'help', 'journal', 'diary', 'browse'])
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
    assert.ok(qq.includes('有几件事就分开发几条'), `${id} 允许分几条发`)
    assert.ok(!/只发一句/.test(qq), '不再强求只发一句')
    const inSession = behaviorPrompt(id, state, { now: DAY }, { talkChannel: 'session' })
    assert.ok(!inSession.includes('notify-qq.py'), `${id} 发到会话时不该跑 QQ 脚本`)
  }
})

test('作息只认他自己说的话：去睡了算，还没睡不算，问句不算', () => {
  assert.equal(detectRoutine('我去睡了'), 'sleep')
  assert.equal(detectRoutine('晚安'), 'sleep')
  assert.equal(detectRoutine('我醒了'), 'wake')
  assert.equal(detectRoutine('起床了'), 'wake')
  assert.equal(detectRoutine('我还没睡'), '')
  assert.equal(detectRoutine('你睡了吗？'), '')
  assert.equal(detectRoutine('今天好累'), '')
})

test('问饭：午餐窗口里没问过就返回午饭，问过了就不再返回', () => {
  const noon = new Date(2026, 9, 31, 11, 45, 0).getTime()
  const state = quietState(noon)
  assert.deepEqual(checkinPlan(state, noon), { kind: 'meal', slot: 1, label: '午饭' })

  // 记上问过午饭，同一窗口不再问
  state.checkin = { ...state.checkin, day: planDay(noon), meals: [1] }
  assert.equal(checkinPlan(state, noon), null)
})

test('问「今天做了什么」在睡前窗口，凌晨一点还算是前一天的', () => {
  const night = new Date(2026, 9, 31, 22, 10, 0).getTime()
  assert.equal(checkinPlan(quietState(night), night)?.kind, 'day')

  // 01:20 属于逻辑上的 10-31，所以 22:10 问过的那天不会再问
  const late = new Date(2026, 10, 1, 1, 20, 0).getTime()
  const state = quietState(late)
  state.checkin = { ...state.checkin, day: '2026-10-31', dayDone: true, meals: [] }
  assert.equal(checkinPlan(state, late), null)
})

test('检查点只占一个位置：窗口里能选到，窗口外选不到', () => {
  const noon = new Date(2026, 9, 31, 11, 45, 0).getTime()
  assert.equal(pickBehavior(quietState(noon), noon, quietStats(noon), only('checkin'))?.id, 'checkin')
  // 下午三点，既不在饭点也不在睡前
  const afternoon = new Date(2026, 9, 31, 15, 0, 0).getTime()
  assert.equal(pickBehavior(quietState(afternoon), afternoon, quietStats(afternoon), only('checkin')), null)
})

test('日记：到点才写，一天只写一篇', () => {
  const night = new Date(2026, 9, 31, 22, 10, 0).getTime()
  assert.equal(pickBehavior(quietState(night), night, quietStats(night), only('diary'))?.id, 'diary')

  const morning = new Date(2026, 9, 31, 10, 0, 0).getTime()
  assert.equal(pickBehavior(quietState(morning), morning, quietStats(morning), only('diary')), null)

  const state = quietState(night)
  state.diary = { day: planDay(night), lastAt: night - 3600000 }
  assert.equal(pickBehavior(state, night, quietStats(night), only('diary')), null)
})

test('问饭和写日记的提示词各自带了要做的那件事', () => {
  const noon = new Date(2026, 9, 31, 11, 45, 0).getTime()
  const ask = behaviorPrompt('checkin', quietState(noon), { now: noon }, {})
  assert.match(ask, /吃了什么/)

  const night = new Date(2026, 9, 31, 22, 10, 0).getTime()
  const diary = behaviorPrompt('diary', quietState(night), { now: night }, {})
  assert.match(diary, /日记\/2026-10-31\.md/)
})

test('同一件事换个说法只记一条，不长的复读行', () => {
  const state = blankState(DAY)
  openWorkAdd(state, { text: '把 B站和小红书的操作步骤补进 lcu 排障文档', urgency: 0.4 }, DAY)
  openWorkAdd(state, { text: '把 B站/小红书这一轮的真实操作步骤补进 lcu 排障文档，每步写清用了哪个 verb', urgency: 0.5 }, DAY + 1000)
  openWorkAdd(state, { text: '把 B站/小红书六步操作清单也补进那份 lcu 排障文档', urgency: 0.4 }, DAY + 2000)
  assert.equal(openWorkList(state).length, 1, '三条说的是同一件事，应该并成一条')
  const only = openWorkList(state)[0]
  assert.equal(only.merged, 2, '合并次数要记下来')
  assert.equal(only.urgency, 0.5, '合并后取更急的那个')
  assert.match(only.text, /B站和小红书/, '说法留着最早那版')
})

test('不相干的活不许并到一起', () => {
  const state = blankState(DAY)
  openWorkAdd(state, { text: '整理简历里的项目描述', urgency: 0.4 }, DAY)
  openWorkAdd(state, { text: '把 docker 镜像换成 node 22', urgency: 0.4 }, DAY + 1)
  openWorkAdd(state, { text: '给主人订周日回程的票', urgency: 0.4 }, DAY + 2)
  assert.equal(openWorkList(state).length, 3)
  assert.equal(openWorkSimilar('整理简历', '把 docker 镜像换成 node 22'), false)
})

test('推进要留痕：记过进度、试过几次、卡住怎么判', () => {
  const state = blankState(DAY)
  openWorkAdd(state, { text: '把导出流程写成一条脚本', urgency: 0.5 }, DAY)
  const id = openWorkList(state)[0].id

  openWorkNote(state, id, '脚本骨架写好了，剩参数解析', DAY + 60000)
  openWorkNote(state, id, '参数也接上了，卡在权限报错', DAY + 120000)
  openWorkNote(state, id, '权限那条绕不过去，先停这儿', DAY + 180000)
  const item = openWorkList(state)[0]
  assert.equal(item.attempts, 3)
  assert.equal(item.progressAt, DAY + 180000)
  assert.match(item.progress, /权限那条/)
  assert.equal(openWorkStuck(item, DAY + 190000), false, '刚推进过，不算卡住')

  // 过了两天没动、试过三次以上 → 卡住
  const later = DAY + 49 * 3600 * 1000
  assert.equal(openWorkStuck(item, later), true)

  openWorkDone(state, id, later, '做完了')
  assert.equal(openWorkList(state).length, 0)
  assert.equal(openWorkStuck(item, later), false, '做完的活不算卡住')
})

test('排任务打点不等于推进：连着排几次仍能判出卡住', () => {
  const state = blankState(DAY)
  openWorkAdd(state, { text: '把导出流程写成一条脚本', urgency: 0.5 }, DAY)
  const id = openWorkList(state)[0].id
  // 宿主排了三次任务但一句进度都没留下来
  openWorkNote(state, id, '', DAY + 3600000)
  openWorkNote(state, id, '', DAY + 2 * 3600000)
  openWorkNote(state, id, '', DAY + 3 * 3600000)
  const item = openWorkList(state)[0]
  assert.equal(item.attempts, 3)
  assert.ok(!item.progressAt, '空 note 不该刷新推进时间')
  assert.equal(openWorkStuck(item, DAY + 26 * 3600000), true)
})

test('continue 的 prompt 会带上「上次做到哪」', () => {
  const state = blankState(DAY)
  openWorkAdd(state, { text: '把导出流程写成一条脚本', urgency: 0.6 }, DAY)
  const id = openWorkList(state)[0].id
  openWorkNote(state, id, '脚本骨架写好了，还差命令行参数', DAY + 60000)
  const text = behaviorPrompt('continue', state, { now: DAY + 3600000 }, {})
  assert.ok(text.includes('上次做到'), '要把 progress 写进 prompt')
  assert.ok(text.includes('还差命令行参数'), 'progress 的正文不能被 map 掉')
  assert.ok(text.includes('「把导出流程写成一条脚本」'), '要点名是哪条活')
})

test('换了一种说法的长句也算同一件事（路径和标点先剥掉再比骨架）', () => {
  const a = '核完清单就通读 AGENTS.md 的说话段落，摘「AI 味」典型句式，写成左右两列对照'
  const b = '通读 AGENTS.md 说话段落，摘「AI 味」典型句式，写成左右两列对照'
  assert.equal(openWorkSimilar(a, b), true)
  // 只是「都在整理东西」这种泛泛相同不许并
  assert.equal(openWorkSimilar('把导出的 CSV 收个尾', '整理桌面上的截图'), false)
})

test('读旧文件时把攒下的重复条目并成一条，保留最早那版说法', () => {
  const now = DAY
  const state = normalizeState({
    openWork: [
      { id: 'w1', text: '把 ai-wei-duizhao.md 写成左右两列：AI 味原句 / 人家会怎么说', createdAt: now - 3000 },
      { id: 'w2', text: '把 ~/.dsh/feiyu-life/ai-wei-duizhao.md 写成左右两列对照：AI 味原句', createdAt: now - 2000 },
      { id: 'w3', text: '给主人写一份面试台本', createdAt: now - 1000 },
    ],
  }, now)
  assert.equal(state.openWork.length, 2)
  assert.equal(state.openWork[0].text, '把 ai-wei-duizhao.md 写成左右两列：AI 味原句 / 人家会怎么说')
  assert.equal(state.openWork[0].merged, 1)
  assert.equal(state.openWork[1].text, '给主人写一份面试台本')
})

test('合并保留已经留下的进度痕迹', () => {
  const now = DAY
  const state = normalizeState({
    openWork: [
      { id: 'w1', text: '把导出脚本的模板整理成左右两列对照表', createdAt: now - 3000 },
      { id: 'w2', text: '把导出脚本的模板整理成左右两列对照表，顺手补文档', createdAt: now - 2000, progress: '前两列写完了', progressAt: now - 1000, attempts: 2 },
    ],
  }, now)
  assert.equal(state.openWork.length, 1)
  assert.equal(state.openWork[0].progress, '前两列写完了')
  assert.equal(state.openWork[0].attempts, 2)
})
