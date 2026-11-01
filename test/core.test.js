import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AXES,
  blankState,
  clamp,
  decay,
  drift,
  noteRepeat,
  noteRest,
  noteTalk,
  normalizeState,
  pushTimeline,
} from '../lib/core/state.js'
import { appraise, EVENT_KINDS } from '../lib/core/appraisal.js'
import { impulseOf, decide } from '../lib/core/gate.js'
import {
  moodSnapshot,
  jobPrompt,
  selfTaskPrompt,
  replyFollows,
  nextHint,
} from '../lib/core/prompt.js'
import { agendaAdd, agendaPick, agendaSweep } from '../lib/core/agenda.js'

// 固定时钟，避免测试跟着本机时区/当前时间漂
const NOW = new Date(2026, 9, 31, 14, 0, 0).getTime()
const at = (hour, minute = 0, day = 31) => new Date(2026, 9, day, hour, minute, 0).getTime()
const HOUR = 3600 * 1000

const BASE_CFG = {
  enabled: true,
  mode: 'normal',
  minSilenceMinutes: 25,
  cooldownMinutes: 40,
  dailyCap: 6,
  quietHours: '23:30-08:30',
  impulseThreshold: 0.55,
  energyFloor: 25,
  agenda: { enabled: true },
}

/** 默认统计：安静很久、没说过话、额度没用 */
const silentStats = (extra = {}) => ({
  lastUserAt: 0,
  lastSpokeAt: 0,
  spokeToday: 0,
  inTurn: false,
  secondsSinceTick: 60,
  ...extra,
})

const shareState = (now = NOW) => {
  const s = blankState(now)
  s.mood = 90
  s.spirit = 80
  return s
}

test('blankState：两根轴各自在基线上，没有 dims / energy', () => {
  const s = blankState(NOW)
  assert.equal(s.version, 4)
  assert.equal(s.mood, 70)
  assert.equal(s.spirit, 55)
  assert.equal(s.dims, undefined)
  assert.equal(s.energy, undefined)
  assert.equal(s.energyFlow, undefined)
  assert.equal(s.lastRestAt, NOW)
  for (const key of AXES) assert.ok(Number.isFinite(s[key]))
})

test('blankState：数组字段都是空的，不会共享引用', () => {
  const a = blankState(NOW)
  const b = blankState(NOW)
  a.timeline.push({ kind: 'x' })
  assert.equal(b.timeline.length, 0)
  assert.deepEqual(b.agenda, [])
  assert.deepEqual(b.behaves, {})
})

test('clamp：越界夹住，NaN 落回下界', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-5, 0, 10), 0)
  assert.equal(clamp(50, 0, 10), 10)
  assert.equal(clamp(NaN, 3, 10), 3)
})

test('decay：半衰期到点，两根轴各自向基线走一半', () => {
  const s = blankState(NOW)
  s.mood = 100
  s.spirit = 100
  const half = decay(s, NOW + 2 * HOUR, 2)
  assert.equal(half.mood, 85)
  assert.equal(half.spirit, 77.5)
})

test('decay：时间足够长会收敛到基线，不会穿过去', () => {
  const s = blankState(NOW)
  s.mood = 0
  s.spirit = 0
  const cur = decay(s, NOW + 240 * HOUR, 2)
  assert.ok(Math.abs(cur.mood - 70) < 0.1, `mood 应回到 70，实际 ${cur.mood}`)
  assert.ok(Math.abs(cur.spirit - 55) < 0.1, `spirit 应回到 55，实际 ${cur.spirit}`)
  assert.ok(cur.mood >= 0 && cur.mood <= 100)
})

test('decay 不改入参，只返回新对象', () => {
  const s = blankState(NOW)
  s.mood = 100
  const out = decay(s, NOW + HOUR, 2)
  assert.equal(s.mood, 100)
  assert.notEqual(out.mood, 100)
})

test('drift：凌晨心情略低、兴致明显低，而且不会跑飞', () => {
  const s = blankState(NOW)
  s.mood = 80
  s.spirit = 56
  const n = drift(s, at(3))
  assert.ok(n.mood < 80)
  assert.ok(n.spirit < 55, `凌晨 spirit 应偏低，实际 ${n.spirit}`)
  assert.ok(n.spirit > 0)
})

test('drift：早上兴致回抬，傍晚从低位往上走', () => {
  const s = blankState(NOW)
  s.mood = 70
  s.spirit = 50
  const morning = drift(s, at(8))
  assert.ok(morning.spirit > 50, `早上 spirit 应回升，实际 ${morning.spirit}`)

  const low = blankState(NOW)
  low.spirit = 45
  const evening = drift(low, at(20))
  assert.ok(evening.spirit > 45)
})

test('drift 不改入参', () => {
  const s = blankState(NOW)
  s.spirit = 80
  drift(s, at(3))
  assert.equal(s.spirit, 80)
})

test('pushTimeline：追加不修改原对象，超过 200 条截掉最旧的', () => {
  const s = blankState(NOW)
  const next = pushTimeline(s, { kind: 'note', at: NOW })
  assert.equal(s.timeline.length, 0)
  assert.equal(next.timeline.length, 1)

  let full = blankState(NOW)
  for (let i = 0; i < 205; i += 1) full = pushTimeline(full, { kind: 'note', at: i })
  assert.equal(full.timeline.length, 200)
  assert.equal(full.timeline[0].at, 5)
})

test('noteRest：记下歇着的时刻，并往时间线里留一条', () => {
  const s = blankState(NOW)
  const out = noteRest(s, NOW + HOUR)
  assert.equal(out.lastRestAt, NOW + HOUR)
  assert.equal(out.timeline.at(-1).kind, 'rest')
  assert.equal(s.lastRestAt, NOW, '不能改入参')
})

test('normalizeState：只出现行字段，老版本留下的杂项一律丢掉', () => {
  const raw = {
    version: 2,
    mood: 80,
    dims: { happy: 30, calm: 10 },
    energy: 61,
    energyFlow: { spent: 3, gained: 0, since: NOW },
    someOldThing: '宿主的旧账本',
  }
  const s = normalizeState(raw, NOW)
  assert.equal(s.version, 4)
  assert.equal(s.mood, 80)
  assert.equal(s.dims, undefined)
  assert.equal(s.energy, undefined)
  assert.equal(s.someOldThing, undefined, '不认识的字段不再带进新状态')
})

test('normalizeState：每轮都在用的活账本一个都不许丢', () => {
  const raw = {
    lastHeart: { do: 'speak', text: '我回来了' },
    thoughts: [{ at: 1, text: '想去看那部片子' }],
    plans: [{ at: 2, text: '把六步清单补完' }],
    nextWakeAt: 12345,
    lastUserText: '人家先去洗澡了',
    lastAskAt: 7,
    lastInjectedAt: 9,
    unread: 3,
    wakeTimes: [NOW - 1000, NOW - 2 * 864e5 * 9],
    spend: { day: NOW, yuan: 1.25 },
    memoryDay: '2026-11-01',
  }
  const s = normalizeState(raw, NOW)
  assert.deepEqual(s.lastHeart, { do: 'speak', text: '我回来了' })
  assert.equal(s.thoughts.length, 1)
  assert.equal(s.plans[0].text, '把六步清单补完')
  assert.equal(s.nextWakeAt, 12345)
  assert.equal(s.lastUserText, '人家先去洗澡了')
  assert.equal(s.lastAskAt, 7)
  assert.equal(s.lastInjectedAt, 9)
  assert.equal(s.unread, 3)
  assert.equal(s.spend.yuan, 1.25)
  assert.equal(s.memoryDay, '2026-11-01')
  assert.deepEqual(s.wakeTimes, [NOW - 1000], '超过三天的唤醒时刻清掉')
})

test('normalizeState：全新或坏掉的状态落回基线', () => {
  assert.deepEqual(
    [normalizeState(null, NOW).mood, normalizeState(null, NOW).spirit],
    [70, 55],
  )
  assert.equal(normalizeState({ mood: '坏了' }, NOW).mood, 70)
})

test('noteRepeat：24 小时内累加，超过就从头数', () => {
  const s = blankState(NOW)
  assert.equal(noteRepeat(s, 'user-message:praise', NOW), 1)
  assert.equal(noteRepeat(s, 'user-message:praise', NOW + 1000), 2)
  assert.equal(noteRepeat(s, 'user-message:praise', NOW + 25 * HOUR), 1)
})

test('EVENT_KINDS：17 个事件，v0.9 两轴都在表里', () => {
  assert.equal(EVENT_KINDS.length, 17)
  for (const k of ['user-message', 'turn-end', 'work-added', 'rest', 'self-done', 'long-absence']) {
    assert.ok(EVENT_KINDS.includes(k), `缺 ${k}`)
  }
})

test('user-message：短间隔 short 句 → 心情和兴致都往上一点', () => {
  const s = blankState(NOW)
  const r = appraise(s, { kind: 'user-message', gapMs: 30000, length: 5, at: NOW })
  assert.ok(r.delta.mood > 0)
  assert.ok(r.delta.spirit > 0)
})

test('user-message：久别重逢 → mood+ spirit+，reason 带时长', () => {
  const s = blankState(NOW)
  const r = appraise(s, { kind: 'user-message', gapMs: 3 * HOUR, length: 12, at: NOW })
  assert.ok(r.delta.mood > 0)
  assert.ok(r.delta.spirit > 0)
  assert.match(r.reason, /小时/)
})

test('user-message：问句和软语气都让兴致涨，叠起来也不越界', () => {
  const s = blankState(NOW)
  const r = appraise(s, {
    kind: 'user-message',
    gapMs: 3 * HOUR,
    length: 10,
    question: true,
    toneHint: 'warm',
    at: NOW,
  })
  assert.ok(r.delta.mood > 0)
  assert.ok(r.delta.spirit > 0)
  assert.ok(r.delta.mood <= 6)
  assert.ok(r.delta.spirit <= 18)
})

test('user-message：harsh 只压兴致，绝不动心情', () => {
  const s = blankState(NOW)
  const r = appraise(s, { kind: 'user-message', gapMs: 600000, length: 3, toneHint: 'harsh', at: NOW })
  assert.equal(r.delta.mood, 0)
  assert.ok(r.delta.spirit < 0)
})

test('user-message：深夜还在干活 → 心疼，心情和兴致都往下', () => {
  const s = blankState(NOW)
  const r = appraise(s, { kind: 'user-message', gapMs: 60000, length: 8, lateNight: true, at: NOW })
  assert.ok(r.delta.mood < 0)
  assert.ok(r.delta.spirit < 0)
})

test('user-message：主人说累 → 心情往下，这是少数允许的来源', () => {
  const s = blankState(NOW)
  const r = appraise(s, { kind: 'user-message', gapMs: 60000, length: 4, tired: true, at: NOW })
  assert.ok(r.delta.mood < 0)
  assert.ok(r.delta.mood >= -6)
})

test('turn-end：有工具失败 → 兴致掉；没失败跑很多工具 → 心情和兴致都涨', () => {
  const s = blankState(NOW)
  const bad = appraise(s, { kind: 'turn-end', failedTools: 2, toolCount: 3, at: NOW })
  assert.ok(bad.delta.spirit < 0)

  const good = appraise(blankState(NOW), { kind: 'turn-end', failedTools: 0, toolCount: 9, at: NOW })
  assert.ok(good.delta.mood > 0)
  assert.ok(good.delta.spirit > 0)

  const long = appraise(blankState(NOW), { kind: 'turn-end', failedTools: 0, toolCount: 2, durationMs: 30 * 60000, at: NOW })
  assert.ok(long.delta.spirit < 0)
})

test('task-done / task-failed：成事涨一点，败事压一点', () => {
  const done = appraise(blankState(NOW), { kind: 'task-done', note: '跑完测试', at: NOW })
  assert.ok(done.delta.mood > 0)
  assert.ok(done.delta.spirit > 0)
  assert.match(done.reason, /跑完测试/)

  const fail = appraise(blankState(NOW), { kind: 'task-failed', note: '构建', at: NOW })
  assert.ok(fail.delta.mood < 0)
  assert.ok(fail.delta.spirit < 0)
})

test('idle：闲着只慢慢泄兴致，不压心情', () => {
  const r = appraise(blankState(NOW), { kind: 'idle', minutes: 120, at: NOW })
  assert.equal(r.delta.mood, 0)
  assert.ok(r.delta.spirit < 0)

  const long = appraise(blankState(NOW), { kind: 'idle', minutes: 400, at: NOW })
  assert.equal(long.delta.mood, 0)
  assert.ok(long.delta.spirit < 0)
  assert.match(long.reason, /小时/)
})

test('self-activity：读书、家务、休息、玩各有各的说法', () => {
  const study = appraise(blankState(NOW), { kind: 'self-activity', activity: 'study', at: NOW })
  assert.ok(study.delta.spirit > 0)
  assert.ok(study.delta.mood > 0)

  const chore = appraise(blankState(NOW), { kind: 'self-activity', activity: 'chore', at: NOW })
  assert.ok(chore.delta.spirit > 0)

  const rest = appraise(blankState(NOW), { kind: 'self-activity', activity: 'rest', at: NOW })
  assert.ok(rest.delta.spirit > 0)

  const play = appraise(blankState(NOW), { kind: 'self-activity', activity: 'play', at: NOW })
  assert.ok(play.delta.mood > 0)
})

test('self-activity：活动名直接当事件名传过来也认', () => {
  const r = appraise(blankState(NOW), { kind: 'study', at: NOW })
  assert.ok(r.delta.spirit > 0)
})

test('proactive：说了掉兴致，被回应涨心情，被忽略掉心情但有限', () => {
  const sent = appraise(blankState(NOW), { kind: 'proactive-sent', at: NOW })
  assert.ok(sent.delta.spirit < 0)

  const answered = appraise(blankState(NOW), { kind: 'proactive-answered', follows: true, at: NOW })
  assert.ok(answered.delta.mood >= 4)
  assert.ok(answered.delta.spirit >= 5)

  const ignored = appraise(blankState(NOW), { kind: 'proactive-ignored', at: NOW })
  assert.ok(ignored.delta.mood < 0, '被忽略允许难过一点')
  assert.ok(ignored.delta.mood >= -6, '但不能垮掉')
  assert.ok(ignored.delta.spirit < 0)
})

test('proactive：回了但没接住（follows=false）走敷衍分支，不算被回应', () => {
  const r = appraise(blankState(NOW), { kind: 'proactive-answered', follows: false, at: NOW })
  assert.equal(r.delta.mood, 0)
  assert.ok(r.delta.spirit < 0)
  assert.match(r.reason, /没接住/)
})

test('rest 和议程/活计的几个小事件都有增量', () => {
  const rest = appraise(blankState(NOW), { kind: 'rest', at: NOW })
  assert.ok(rest.delta.spirit > 0)

  const added = appraise(blankState(NOW), { kind: 'work-added', note: '整理笔记', at: NOW })
  assert.ok(added.delta.mood > 0)

  const agendaAdded = appraise(blankState(NOW), { kind: 'agenda-added', note: '喝水', at: NOW })
  assert.ok(agendaAdded.delta.spirit < 0)

  const agendaDone = appraise(blankState(NOW), { kind: 'agenda-done', note: '喝水', at: NOW })
  assert.ok(agendaDone.delta.mood > 0)
})

test('增量硬顶：mood ±6，spirit ±18，叠满条件也不越界', () => {
  const s = blankState(NOW)
  const r = appraise(s, {
    kind: 'user-message',
    gapMs: 3600000,
    length: 5,
    toneHint: 'harsh',
    lateNight: true,
    tired: true,
    at: NOW,
  })
  assert.ok(r.delta.mood >= -6, `mood 超了 ${r.delta.mood}`)
  assert.ok(Math.abs(r.delta.spirit) <= 18, `spirit 超了 ${r.delta.spirit}`)
})

test('认不出的事件什么都不改，也不假装有信心', () => {
  const r = appraise(blankState(NOW), { kind: 'meteor', at: NOW })
  assert.deepEqual(r.delta, { mood: 0, spirit: 0 })
  assert.equal(r.confidence, 0)
  assert.equal(r.significant, false)
})

test('每次事件都给 reason 和 0–1 的 confidence', () => {
  for (const kind of EVENT_KINDS) {
    const r = appraise(blankState(NOW), { kind, at: NOW, minutes: 100, activity: 'study', note: 'x' })
    assert.ok(r.reason.length > 0, `${kind} 没给 reason`)
    assert.ok(r.confidence >= 0 && r.confidence <= 1, `${kind} 的 confidence 越界`)
  }
})

test('饱和：同类正向事件连着来，增量一次比一次小', () => {
  const s = blankState(NOW)
  const values = []
  for (let i = 0; i < 5; i += 1) {
    const r = appraise(s, { kind: 'user-message', toneHint: 'warm', gapMs: 60000, length: 4, at: NOW + i * 1000 })
    values.push(r.delta.mood)
  }
  assert.ok(values[0] > values[1])
  assert.ok(values[1] > values[4])
  assert.ok(values[4] > 0, '饱和到底也要留一点反应')
})

test('敏感化：同类负向事件连着来，一次比一次重，但心情不破硬顶', () => {
  const s = blankState(NOW)
  const first = appraise(s, { kind: 'user-message', lateNight: true, gapMs: 60000, length: 5, at: NOW })
  const later = appraise(s, { kind: 'user-message', lateNight: true, gapMs: 60000, length: 5, at: NOW + 1000 })
  assert.ok(later.delta.mood < first.delta.mood)
  assert.ok(later.delta.mood >= -6)
})

test('impulseOf：平静时会沉默，心情兴致都满时才想分享', () => {
  const calm = impulseOf(blankState(NOW), BASE_CFG)
  assert.ok(calm.value < BASE_CFG.impulseThreshold)

  const happy = impulseOf(shareState(), BASE_CFG)
  assert.equal(happy.kind, 'share')
  assert.ok(happy.value >= BASE_CFG.impulseThreshold)
})

test('impulseOf：兴致低时被打折，但仍保留一点表达空间', () => {
  const s = blankState(NOW)
  s.mood = 70
  s.spirit = 20
  const low = impulseOf(s, BASE_CFG)
  assert.ok(low.value < 0.28)

  const full = impulseOf(blankState(NOW), BASE_CFG)
  assert.ok(full.value > low.value)
})

test('impulseOf：挂着没办完的事会变成心疼型冲动，不打兴致折扣', () => {
  const s = blankState(NOW)
  s.spirit = 15
  s.pendingIntent = { kind: 'remind', text: '提醒主人喝水', urgency: 0.9 }
  const care = impulseOf(s, BASE_CFG)
  assert.equal(care.kind, 'comfort')
  assert.ok(care.value > 0.7)
  assert.match(care.reason, /喝水/)

  const share = impulseOf(shareState(), BASE_CFG)
  assert.notEqual(share.value, care.value)
})

test('impulseOf：议程里未说的急事也能触发心疼型冲动', () => {
  const s = blankState(NOW)
  s.agenda = [{ id: 'a1', text: '问主人今天几点睡', kind: 'care', dueAt: NOW - 1000, urgency: 0.95, createdAt: NOW - 10000 }]
  const care = impulseOf(s, BASE_CFG)
  assert.equal(care.kind, 'comfort')
})

test('impulseOf 只看状态，不改入参', () => {
  const s = shareState()
  impulseOf(s, BASE_CFG)
  assert.deepEqual([s.mood, s.spirit], [90, 80])
})

test('decide：全部门都过的时候会说话，intent 带着种子和 moods', () => {
  const r = decide(shareState(), NOW, silentStats(), BASE_CFG)
  assert.equal(r.speak, true)
  assert.ok(r.intent)
  assert.equal(typeof r.intent.seed, 'string')
  assert.ok(r.intent.seed.length > 0)
  assert.equal(r.energyFloorBlocked, false)
})

test('门 1：功能关了就不说话', () => {
  assert.equal(decide(shareState(), NOW, silentStats(), { ...BASE_CFG, enabled: false }).speak, false)
  assert.equal(decide(shareState(), NOW, silentStats(), { ...BASE_CFG, mode: 'off' }).speak, false)
})

test('门 2：主人在对话里时不插话', () => {
  const r = decide(shareState(), NOW, silentStats({ inTurn: true }), BASE_CFG)
  assert.equal(r.speak, false)
  assert.match(r.reason, /正在说话/)
})

test('门 3：安静不够久就不说话', () => {
  const r = decide(shareState(), NOW, silentStats({ lastUserAt: NOW - 5 * 60000 }), BASE_CFG)
  assert.equal(r.speak, false)
  assert.match(r.reason, /还没到/)
})

test('门 4：冷却没到就不说话', () => {
  const r = decide(shareState(), NOW, silentStats({ lastSpokeAt: NOW - 30 * 60000 }), BASE_CFG)
  assert.equal(r.speak, false)
  assert.match(r.reason, /再等等/)
})

test('没人回也不加倍冷却：冷却按配置走', () => {
  const r = decide(shareState(), NOW, silentStats({ lastSpokeAt: NOW - 55 * 60000 }), BASE_CFG)
  assert.equal(r.speak, true)
  assert.equal(r.cooldownMinutes, BASE_CFG.cooldownMinutes)
})

test('门 5：兴致低于地板时沉默，并标记 energyFloorBlocked', () => {
  const s = blankState(NOW)
  s.mood = 70
  s.spirit = 20
  const r = decide(s, NOW, silentStats(), BASE_CFG)
  assert.equal(r.speak, false)
  assert.equal(r.energyFloorBlocked, true)
  assert.match(r.reason, /兴致/)
})

test('门 5：急事可以穿过兴致地板', () => {
  const s = blankState(NOW)
  s.mood = 70
  s.spirit = 20
  s.pendingIntent = { kind: 'remind', text: '睡前提醒', urgency: 1 }
  const r = decide(s, NOW, silentStats(), BASE_CFG)
  assert.equal(r.speak, true)
  assert.equal(r.intent.kind, 'comfort')
})

test('门 5：待办紧急度高时也能穿过兴致地板', () => {
  const s = blankState(NOW)
  s.spirit = 20
  s.agenda = [{ id: 'a1', text: '提醒吃药', kind: 'remind', dueAt: NOW - 1000, urgency: 0.9, createdAt: NOW - 5000 }]
  const r = decide(s, NOW, silentStats(), BASE_CFG)
  assert.equal(r.speak, true)
  assert.equal(r.intent.kind, 'agenda')
})

test('门 7：今日额度用完了就留到明天', () => {
  const r = decide(shareState(), NOW, silentStats({ spokeToday: 6 }), BASE_CFG)
  assert.equal(r.speak, false)
  assert.match(r.reason, /额度/)
})

test('门 8：静默时段跨零点也算，半夜不喊人', () => {
  const night = at(23, 45)
  const r = decide(shareState(night), night, silentStats(), BASE_CFG)
  assert.equal(r.speak, false)
  assert.match(r.reason, /休息/)

  const early = at(7, 30)
  const r2 = decide(shareState(early), early, silentStats(), BASE_CFG)
  assert.equal(r2.speak, false)

  const noon = at(12, 0)
  assert.equal(decide(shareState(noon), noon, silentStats(), BASE_CFG).speak, true)
})

test('门 8：急事可以破静默时段，闲聊不行', () => {
  const night = at(0, 30)
  const s = shareState(night)
  s.pendingIntent = { kind: 'remind', text: '主人没吃药', urgency: 1 }
  const r = decide(s, night, silentStats(), BASE_CFG)
  assert.equal(r.speak, true)
})

test('门 9：冲动不够就沉默', () => {
  const s = blankState(NOW)
  s.mood = 72
  s.spirit = 56
  const r = decide(s, NOW, silentStats(), { ...BASE_CFG, impulseThreshold: 0.9 })
  assert.equal(r.speak, false)
})

test('待办门：到点的事跳过冲动阈值，直接说话', () => {
  const s = blankState(NOW)
  s.mood = 75
  s.spirit = 60
  s.agenda = [{ id: 'a1', text: '提醒主人开会', kind: 'remind', dueAt: NOW - 60000, urgency: 0.5, createdAt: NOW - HOUR }]
  const r = decide(s, NOW, silentStats(), BASE_CFG)
  assert.equal(r.speak, true)
  assert.equal(r.intent.kind, 'agenda')
  assert.equal(r.intent.text, '提醒主人开会')
})

test('decide：没说话时也返回冷却分钟数，界面能拿去算提示', () => {
  const r = decide(blankState(NOW), NOW, silentStats({ lastUserAt: NOW - 60000 }), BASE_CFG)
  assert.equal(r.speak, false)
  assert.equal(r.cooldownMinutes, 40)
})

test('agendaAdd：追加到议程，最多 20 条，踢最不急的那条', () => {
  let s = blankState(NOW)
  for (let i = 0; i < 20; i += 1) {
    s = { ...s, agenda: agendaAdd(s, { text: `第 ${i} 件`, kind: 'remind', dueAt: NOW + i, urgency: 0.5 }, NOW).agenda }
  }
  assert.equal(s.agenda.length, 20)
  s = { ...s, agenda: agendaAdd(s, { text: '最急', kind: 'remind', dueAt: NOW + 1, urgency: 1 }, NOW).agenda }
  assert.equal(s.agenda.length, 20)
  assert.ok(s.agenda.some((it) => it.text === '最急'))
  assert.ok(!s.agenda.some((it) => it.urgency === 0.5 && it.text === '第 0 件'))
})

test('agendaPick：只挑到点、没说、窗口内的，急的优先', () => {
  const s = blankState(NOW)
  s.agenda = [
    { id: 'a1', text: '不急', kind: 'remind', dueAt: NOW - 1000, urgency: 0.3, createdAt: NOW - 10000 },
    { id: 'a2', text: '很急', kind: 'care', dueAt: NOW - 2000, urgency: 0.9, createdAt: NOW - 10000 },
    { id: 'a3', text: '没到点', kind: 'remind', dueAt: NOW + 60000, urgency: 1, createdAt: NOW },
    { id: 'a4', text: '说过了', kind: 'remind', dueAt: NOW - 1000, urgency: 1, createdAt: NOW, spokenAt: NOW - 500 },
  ]
  const picked = agendaPick(s, NOW, BASE_CFG)
  assert.equal(picked.id, 'a2')
})

test('agendaPick：window 用绝对毫秒，窗口没到就不挑', () => {
  const s = blankState(NOW)
  s.agenda = [
    {
      id: 'a1',
      text: '早上再说',
      kind: 'remind',
      dueAt: at(6),
      urgency: 0.9,
      createdAt: at(5),
      window: { from: at(8), to: at(11) },
    },
  ]
  assert.equal(agendaPick(s, at(7), BASE_CFG), null)
  assert.equal(agendaPick(s, at(9), BASE_CFG).id, 'a1')
})

test('agendaPick：配置关掉就永远不挑', () => {
  const s = blankState(NOW)
  s.agenda = [{ id: 'a1', text: 'x', kind: 'remind', dueAt: NOW - 1, urgency: 1, createdAt: NOW }]
  assert.equal(agendaPick(s, NOW, { agenda: { enabled: false } }), null)
})

test('agendaSweep：过期的、说过的都清掉，返回剩余条数', () => {
  const s = blankState(NOW)
  s.agenda = [
    { id: 'a1', text: '过期了', kind: 'remind', dueAt: NOW - 25 * HOUR, urgency: 0.5, createdAt: NOW - 30 * HOUR },
    { id: 'a2', text: '说过了', kind: 'remind', dueAt: NOW - HOUR, urgency: 0.5, createdAt: NOW - 2 * HOUR, spokenAt: NOW - 1000 },
    { id: 'a3', text: '还早', kind: 'remind', dueAt: NOW + HOUR, urgency: 0.5, createdAt: NOW },
  ]
  const left = agendaSweep(s, NOW)
  assert.equal(left, 1)
})

test('moodSnapshot：报位置和两个读数，不写形容词', () => {
  const s = blankState(NOW)
  s.mood = 40
  s.spirit = 30
  s.activity = { kind: 'work', note: '写东西', space: 'study', since: NOW }
  const text = moodSnapshot(s, {}, NOW)
  assert.match(text, /【位置】/)
  assert.match(text, /心情 40\/100/)
  assert.match(text, /兴致 30\/100/)
  assert.match(text, /【手头】写东西/)
  assert.ok(!/有点沉|起了劲|快蔫了|松快|提不起劲/.test(text), `不该出现形容词：${text}`)
})

test('moodSnapshot：位置跟着自己和主人的动静走', () => {
  const day = new Date(NOW)
  day.setHours(15, 0, 0, 0)
  const noon = day.getTime()
  const s = blankState(noon)
  s.activity = { kind: 'chat', note: '', space: '', since: noon }
  assert.match(moodSnapshot(s, {}, noon), /都在书房/)

  const night = new Date(NOW)
  night.setHours(3, 0, 0, 0)
  const late = night.getTime()
  const t = blankState(late)
  t.activity = { kind: 'sleep', note: '', space: '', since: late }
  const text = moodSnapshot(t, {}, late)
  assert.match(text, /自己的房间/)
  assert.match(text, /主人的房间/)
})

test('moodSnapshot：注入关掉时返回空串', () => {
  assert.equal(moodSnapshot(shareState(), { injectMood: false }), '')
  assert.equal(moodSnapshot(shareState(), { mode: 'off' }), '')
})

test('jobPrompt：首行是识别前缀，包含口吻约束和结束条件', () => {
  const text = jobPrompt({ kind: 'share', seed: '想跟主人说今天看到的事', urgency: 0.6 }, shareState(), {})
  const lines = text.split('\n')
  assert.equal(lines[0], '[feiyu-life]')
  assert.match(text, /不是被派活/)
  assert.match(text, /说完就停/)
  assert.match(text, /称呼主人为「主人」/)
  assert.match(text, /想跟主人说今天看到的事/)
  assert.match(text, /不要用「你」/)
})

test('jobPrompt：待办作为重点时换成「这次要提的事」', () => {
  const text = jobPrompt({ kind: 'agenda', text: '提醒主人带伞', urgency: 0.8 }, shareState(), {})
  assert.equal(text.split('\n')[0], '[feiyu-life]')
  assert.match(text, /【这次要提的事】/)
  assert.match(text, /提醒主人带伞/)
})

test('jobPrompt：跟上一次没被接住时，明确别追问', () => {
  const s = shareState()
  s.lastReply = { at: NOW, gapMs: 300000, length: 1, follows: false }
  const text = jobPrompt({ kind: 'share', seed: 'x', urgency: 0.5 }, s, {})
  assert.match(text, /没接住/)
  assert.match(text, /别再提那件事/)
})

test('replyFollows：三种状态三种说法，undefined 时给空串', () => {
  assert.match(replyFollows({ lastReply: { follows: false } }), /没接住/)
  assert.match(replyFollows({ lastReply: { follows: null } }), /脑补/)
  assert.equal(replyFollows({ lastReply: { follows: true } }), '')
  assert.equal(replyFollows(blankState(NOW)), '')
})

test('selfTaskPrompt：首行是自派活前缀，写明做完就停', () => {
  const text = selfTaskPrompt(shareState(), {})
  assert.equal(text.split('\n')[0], '[feiyu-life:self]')
  assert.match(text, /不是主人在派活/)
  assert.match(text, /别碰主人的文件/)
})

test('nextHint：待办直说到点的事，闲聊给大概分钟数', () => {
  assert.match(nextHint({ kind: 'agenda', text: '提醒喝水' }, blankState(NOW), {}), /到点的事/)
  const hint = nextHint({ kind: 'share', urgency: 0.5 }, shareState(), { cooldownMinutes: 40 })
  assert.match(hint, /大概 \d+ 分钟后/)
})

test('nextHint：没有想说的意图时也不装', () => {
  assert.match(nextHint(null, blankState(NOW), {}), /还没攒够/)
})

test('心情好的时候话多、欢快；心情沉的时候也开口，但话短', async () => {
  const { talkToneOf, jobPrompt } = await import('../lib/core/prompt.js')
  const happy = { ...blankState(NOW), mood: 88, spirit: 70 }
  const sad = { ...blankState(NOW), mood: 20, spirit: 40 }
  const bright = talkToneOf(happy)
  assert.ok(bright.includes('主人主人'))
  assert.ok(bright.includes('说得多一点'))
  const low = talkToneOf(sad)
  assert.ok(low.includes('唔'))
  assert.ok(low.includes('情绪不太好'))
  assert.ok(!low.includes('主人主人'))

  const prompt = jobPrompt({ seed: '刚看完一篇文章', kind: 'share' }, sad, BASE_CFG)
  assert.ok(prompt.includes('情绪不太好'), '低落时提示词要带自己的状态')
})

test('心情低于 45 时她仍然想找人说话，不会被「高兴才配开口」掐掉', () => {
  const low = { ...blankState(NOW), mood: 22, spirit: 30 }
  const r = impulseOf(low, BASE_CFG)
  assert.ok(r.value >= 0.4, `低落也要有开口的冲动，实际 ${r.value}`)
  assert.equal(r.kind, 'comfort')
})


test('往来两边都记，只留最近的二十四条', () => {
  const s = blankState(1000)
  for (let i = 0; i < 30; i += 1) noteTalk(s, i % 2 ? 'owner' : 'fish', `第${i}句`, 1000 + i)
  assert.equal(s.recentTalk.length, 24)
  assert.equal(s.recentTalk.at(-1).text, '第29句')
  assert.ok(s.recentTalk.some((it) => it.who === 'owner'))
  assert.ok(s.recentTalk.some((it) => it.who === 'fish'))
})

test('空白话不进往来，空白和换行会被压掉', () => {
  const s = blankState(1000)
  noteTalk(s, 'owner', '   ', 1000)
  noteTalk(s, 'owner', ' 主  人说\n了两行 ', 1001)
  assert.equal(s.recentTalk.length, 1)
  assert.equal(s.recentTalk[0].text, '主 人说 了两行')
})

test('很久没见：long-absence 压心情和兴致，理由带上小时数', () => {
  const s = blankState(1000)
  const r = appraise(s, { kind: 'long-absence', at: 2000, hours: 18 })
  assert.ok(r.delta.mood < 0)
  assert.ok(r.delta.spirit < 0)
  assert.match(r.reason, /18 小时/)
})
