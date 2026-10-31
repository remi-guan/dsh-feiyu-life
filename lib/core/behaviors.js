/**
 * 行为层：她能主动做的不止「说话」。
 *
 * v2 里所有主动都通向消息，v3 把出口扩成「做事」——写东西、逛、接着忙主人的活、顺手帮忙。
 * 每件事有自己的准入、代价、冷却和额度，选择器只负责挑一件。
 *
 * appetite 的公式照抄契约 §1，别拍脑袋改：它是「此刻想不想做这件事」的确定性表达，
 * 一旦随手调，行为分布就会跟着变，而界面和测试都按这套分布写的。
 */

import { clamp, openWorkList } from './state.js'
import { impulseOf, inQuietHours } from './gate.js'

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

const DEFAULTS = {
  behaviorThreshold: 0.3,
  behaviorIntervalMinutes: 30,
}

/** 自然日 key，跟主人的本地时区走：额度是「今天」的额度，不是 24 小时滑窗 */
function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 主人安静了多少分钟。没见过用户消息就当作很久——第一次 tick 不该被误判成「刚说完话」 */
function quietMinutes(stats, now) {
  const last = num(stats?.lastUserAt, 0)
  return last > 0 ? (now - last) / 60000 : Infinity
}

/** "07:00-02:00" → 当天分钟数区间，24:00 当一天的末尾 */
function parseHours(spec) {
  if (typeof spec !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (!m) return null
  return {
    start: clamp(Number(m[1]), 0, 24) * 60 + clamp(Number(m[2]), 0, 59),
    end: clamp(Number(m[3]), 0, 24) * 60 + clamp(Number(m[4]), 0, 59),
  }
}

/** 时段判定。跨零点的（07:00-02:00）拆两段比，00:00-24:00 全天放行 */
function inHours(now, spec) {
  const h = parseHours(spec)
  if (!h) return true
  const d = new Date(now)
  const cur = d.getHours() * 60 + d.getMinutes()
  if (h.start === 0 && h.end >= 1440) return true
  if (h.start === h.end) return false
  return h.start < h.end ? cur >= h.start && cur < h.end : cur >= h.start || cur < h.end
}

function spiritOf(state) {
  return clamp(state?.spirit ?? 55, 0, 100)
}

/** 配置单项覆盖：enabled / dailyCap / cooldownMinutes / hours 都允许宿主改 */
function withConfig(spec, cfg) {
  const override = cfg?.behaviors?.[spec.id] ?? {}
  return {
    ...spec,
    enabled: override.enabled !== false,
    dailyCap: num(override.dailyCap, spec.dailyCap),
    cooldownMinutes: num(override.cooldownMinutes, spec.cooldownMinutes),
    hours: typeof override.hours === 'string' ? override.hours : spec.hours,
  }
}


/** 一天里的第几分钟。作息和问询都按它判窗口 */
function minuteOfDay(now) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}

/**
 * 逻辑日：凌晨 0 点到 2 点还算是前一天的事。
 * 不这么切，23:50 问过「今天做了什么」，00:10 又能再问一遍。
 */
export function planDay(now) {
  const d = new Date(now)
  if (d.getHours() < 2) d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 三顿饭的窗口。问饭只在他刚吃完、还没到下一顿的时候 */
const MEAL_WINDOWS = [
  { slot: 0, label: '早饭', from: 7 * 60 + 30, to: 9 * 60 + 30 },
  { slot: 1, label: '午饭', from: 11 * 60 + 30, to: 13 * 60 + 30 },
  { slot: 2, label: '晚饭', from: 18 * 60, to: 20 * 60 },
]

/** 「今天做了什么」问在睡前：21:30 到 01:00 */
const DAY_FROM = 21 * 60 + 30
const DAY_TO_EARLY = 60

/**
 * 这会儿该问哪件事，没得问就返回 null。
 *
 * 只挂一个待答问题：窗口不重叠（饭点最晚到 20:00，问今天从 21:30 开始），
 * 所以主人下一条消息一定是在回这一条，不用猜。
 *
 * @returns {{kind:'meal'|'day', slot:number, label:string}|null}
 */
export function checkinPlan(state, now) {
  const rec = state?.checkin ?? {}
  const day = planDay(now)
  const today = rec.day === day ? rec : null
  const cur = minuteOfDay(now)

  const meals = Array.isArray(today?.meals) ? today.meals : []
  for (const w of MEAL_WINDOWS) {
    if (cur >= w.from && cur < w.to && !meals.includes(w.slot)) {
      return { kind: 'meal', slot: w.slot, label: w.label }
    }
  }
  const inDay = cur >= DAY_FROM || cur < DAY_TO_EARLY
  if (inDay && today?.dayDone !== true) return { kind: 'day', slot: -1, label: '今天做了什么' }
  return null
}

/**
 * 七个行为的目录。id 固定，界面、配置、哨兵都按它认人。
 * 顺序就是平手时的优先级：talk → checkin → continue → help → journal → diary → browse。
 */
export const BEHAVIORS = [
  {
    id: 'talk',
    label: '找主人说话',
    kind: 'speak',
    cost: 6,
    timeoutMinutes: 10,
    cooldownMinutes: 60,
    dailyCap: 0,
    hours: '00:00-24:00',
    // 说不说由她自己定：旧的九道门（静默 25 分、冷却 40 分、冲动 0.55、每日 8 次）
    // 全撤了。那些门是怕她烦人设的，结果把人管得说不出话；
    // 只留两条真在保护主人的——别在他说话时插嘴，别在半夜把人叫醒。
    gate(state, now, stats, cfg) {
      if (stats?.inTurn) return '主人正在说话'
      if (inQuietHours(now, cfg?.quietHours)) return '现在是主人休息的时段'
      return null
    },
    appetite(state, ctx, cfg) {
      return clamp(impulseOf(state, cfg).value, 0, 1)
    },
  },
  {
    id: 'checkin',
    label: '问问主人的今天',
    kind: 'speak',
    cost: 4,
    timeoutMinutes: 10,
    cooldownMinutes: 90,
    dailyCap: 0,
    hours: '00:00-24:00',
    // 问饭和问「今天做了什么」都靠窗口，问过就记进 state.checkin，
    // 不靠额度也不靠冷却——一天几顿是几顿，不该因为超了次数就不问
    gate(state, now, stats) {
      if (stats?.inTurn) return '主人正在说话'
      if (!checkinPlan(state, now)) return '这会儿还不到问的时候'
      return null
    },
    // 窗口一开就该问：比他随手说句话更值得占这个位置
    appetite() {
      return 0.95
    },
  },
  {
    id: 'continue',
    label: '接着忙主人的事',
    kind: 'work',
    cost: 12,
    timeoutMinutes: 25,
    cooldownMinutes: 30,
    dailyCap: 0,
    hours: '00:00-24:00',
    gate(state, now, stats, cfg, ctx) {
      return openWorkList({ openWork: ctx?.openWork ?? state?.openWork }).length > 0
        ? null
        : '手里没有没做完的活'
    },
    // 有活时才想做：越急越想做，但没有活就是 0，不给「想干活」的空转机会
    appetite(state, ctx) {
      const list = openWorkList({ openWork: ctx?.openWork ?? state?.openWork })
      if (list.length === 0) return 0
      const top = list.reduce((max, it) => Math.max(max, clamp(num(it.urgency, 0), 0, 1)), 0)
      return clamp(0.45 + top * 0.4, 0, 1)
    },
  },
  {
    id: 'help',
    label: '顺手帮主人做点事',
    kind: 'work',
    cost: 10,
    timeoutMinutes: 15,
    cooldownMinutes: 120,
    dailyCap: 0,
    hours: '00:00-24:00',
    gate(state, now, stats) {
      if (spiritOf(state) < 45) return '兴致不高，帮不上忙'
      if (quietMinutes(stats, now) < 60) return '主人才刚说完话，先不凑过去'
      return null
    },
    // 有急活、心情又不差的时候更想搭把手。底数 0.3 保证平常也会偶尔顺手
    appetite(state, ctx) {
      const list = openWorkList({ openWork: ctx?.openWork ?? state?.openWork })
      const top = list.reduce((max, it) => Math.max(max, clamp(num(it.urgency, 0), 0, 1)), 0)
      const mood = clamp(state?.mood ?? 70, 0, 100)
      return clamp(0.3 + top * 0.35 + (mood >= 60 ? 0.1 : 0), 0, 1)
    },
  },
  {
    id: 'journal',
    label: '自己写东西',
    kind: 'self',
    cost: 8,
    timeoutMinutes: 10,
    cooldownMinutes: 180,
    dailyCap: 0,
    hours: '07:00-02:00',
    gate(state, now, stats, cfg) {
      if (spiritOf(state) < 40) return '提不起劲，不写了'
      if (quietMinutes(stats, now) < 40) return '主人还在说话，等安静下来再写'
      // gate 签名只有五个参数，拿不到 spec 本身，所以时段覆盖从 cfg 里直接读
      if (!inHours(now, cfg?.behaviors?.journal?.hours ?? '07:00-02:00')) return '这个点不写字'
      return null
    },
    // 心情越低越想写：mood 40 时 0.47，mood 0 时 0.8，夹到 1
    appetite(state) {
      const mood = clamp(state?.mood ?? 70, 0, 100)
      return clamp(0.3 + (60 - mood) / 120, 0, 1)
    },
  },
  {
    id: 'diary',
    label: '写今天的日记',
    kind: 'self',
    cost: 6,
    timeoutMinutes: 10,
    cooldownMinutes: 60,
    dailyCap: 0,
    hours: '00:00-24:00',
    // 一天一篇，21:30 之后开写。窗口按逻辑日算，凌晨一点写的还算今天的
    gate(state, now) {
      const day = planDay(now)
      if (state?.diary?.day === day) return '今天的日记写过了'
      const cur = minuteOfDay(now)
      if (!(cur >= DAY_FROM || cur < 2 * 60)) return '还没到写日记的时候'
      return null
    },
    // 写日记不该靠心情推：到点就写，比「今天想不想写」稳
    appetite() {
      return 0.72
    },
  },
  {
    id: 'browse',
    label: '自己上网逛',
    kind: 'self',
    cost: 10,
    timeoutMinutes: 15,
    cooldownMinutes: 240,
    dailyCap: 0,
    hours: '09:00-01:00',
    gate(state, now, stats, cfg) {
      if (spiritOf(state) < 55) return '兴致不够，逛不动'
      if (!inHours(now, cfg?.behaviors?.browse?.hours ?? '09:00-01:00')) return '这个点不逛了'
      return null
    },
    // 有兴致才想逛：spirit 0 时 0.15，100 时 0.75
    appetite(state) {
      return clamp(0.15 + (spiritOf(state) / 100) * 0.6, 0, 1)
    },
  },
]

/** 账本里这个行为的当日已用次数。跨日自动算 0，不用等 noteBehavior 来重置 */
function usedToday(behaves, id, now) {
  const rec = behaves?.[id]
  if (!rec || rec.day !== dayKey(now)) return 0
  return Math.max(0, num(rec.dayCount, 0))
}

/**
 * 挑一个行为。
 *
 * 顺序严格按契约：gate 过滤 → score=appetite×精力 → 排除冷却/额度 → 阈值 → 全局间隔 → 平手顺序。
 * 先打分后排除的写法看起来绕，但这样「被排除的行为」不会占住最高分的位置，
 * 挑出来的一定是真的能做的那个。
 *
 * @param {object} state
 * @param {number} now
 * @param {object} stats
 * @param {object} cfg
 * @param {{openWork?: Array, agendaCount?: number, activity?: object}} [ctx]
 * @returns {{id:string, appetite:number, score:number, reason:string} | null}
 */
export function pickBehavior(state, now, stats, cfg, ctx) {
  const c = cfg ?? {}
  const s = stats ?? {}
  const cxt = ctx ?? {}
  const behaves = state?.behaves ?? {}

  const threshold = num(c.behaviorThreshold, DEFAULTS.behaviorThreshold)
  const interval = Math.max(0, num(c.behaviorIntervalMinutes, DEFAULTS.behaviorIntervalMinutes))
  const spirit = spiritOf(state)

  // 全局间隔：任何行为之间都要隔够。账本里最近的 lastAt 说了算
  const lastAt = Object.values(behaves).reduce((max, rec) => Math.max(max, num(rec?.lastAt, 0)), 0)
  const gapBlocked = lastAt > 0 && now - lastAt < interval * 60000

  let best = null
  for (const rawSpec of BEHAVIORS) {
    const spec = withConfig(rawSpec, c)
    if (!spec.enabled) continue

    // 1. gate 过滤。ctx.openWork 不是数组时 gate 自己兜（openWorkList 会返回 []）
    let blocked = null
    try {
      blocked = spec.gate(state, now, s, c, cxt)
    } catch {
      blocked = '准入检查出错，先跳过'
    }
    if (blocked) continue

    // 2. 冷却与额度。算分之前排除，避免它们跑进 reason 里骗人
    const rec = behaves[spec.id]
    const lastBehaviorAt = num(rec?.lastAt, 0)
    if (lastBehaviorAt > 0 && now - lastBehaviorAt < spec.cooldownMinutes * 60000) continue
    // 每日上限取消了：她自己想做什么不该被配额卡住，只留冷却防连续折腾
    if (spec.dailyCap > 0 && usedToday(behaves, spec.id, now) >= spec.dailyCap) continue

    const appetite = clamp(num(spec.appetite(state, cxt, c), 0), 0, 1)
    // 兴致只打八折到满格之间：直接乘 spirit/100 会让平静状态下的
    // 自娱类行为永远进不了阈值（journal 底数 0.3、spirit 55 时只剩 0.17）
    const spiritFactor = 0.55 + 0.45 * (spirit / 100)
    const score = clamp(appetite * spiritFactor, 0, 1)

    // 平手时保留先出现的那个，BEHAVIORS 的顺序就是优先级
    if (!best || score > best.score) {
      best = { id: spec.id, appetite, score, spec, blocked: false }
    }
  }

  // 3. 阈值
  if (!best || best.score < threshold) return null

  // 4. 全局间隔
  if (gapBlocked) return null

  const reasonParts = [`想${labelVerb(best.spec)}`]
  if (best.score < threshold + 0.2) reasonParts.push('还没那么急')
  const reason = `${reasonParts.join('，')}（想头 ${best.appetite.toFixed(2)}，兴致 ${Math.round(spirit)}）`

  return { id: best.id, appetite: best.appetite, score: best.score, reason }
}

function labelVerb(spec) {
  switch (spec.id) {
    case 'talk':
      return '跟主人说两句'
    case 'journal':
      return '写点东西'
    case 'browse':
      return '上网逛逛'
    case 'continue':
      return '接着忙手上的活'
    case 'help':
      return '顺手帮个忙'
    case 'checkin':
      return '问问主人的今天'
    case 'diary':
      return '写今天的日记'
    default:
      return spec.label
  }
}
