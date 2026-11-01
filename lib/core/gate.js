/**
 * 冲动与打扰门。
 *
 * 设计前提：打扰是稀缺资源，默认沉默。门没全过就是不说话，宁可少说一句，
 * 也不能在主人写代码的时候冒出来「在忙吗」。
 *
 * v2 多了两道门：精力门和待办门。精力门管「累了就别硬撑」，待办门管「到点的事不看心情」。
 * 顺序仍然是策略：开关 → 是否在对话里 → 静默 → 冷却 → 精力 → 待办 → 每日额度 → 静默时段 → 冲动。
 * 日志里第一道失败的门就是最紧的那个约束，所以顺序不能随手换。
 */

import { clamp } from './state.js'
import { agendaPick } from './agenda.js'

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/**
 * 她现在有多想开口。只看状态，不看时间：同一份状态无论什么时候问，答案一样。
 *
 * v0.9 只剩两根轴：心情好、兴致高，才有闲心说话。
 * 兴致低时整体打折——不是说不出话，是没那个劲头；折到最低也有 60%，
 * 免得蔫着的时候就永远沉默，界面上看着像死了。
 *
 * 「心疼」不再是一根数值：一件事有多急，由宿主挂的 pendingIntent 或议程的 urgency 决定。
 * 这条不参与兴致折扣——最蔫的时候，要紧的事也还是要说。
 */
export function impulseOf(state, cfg) {
  const mood = clamp(state?.mood ?? 70, 0, 100)
  const spirit = clamp(state?.spirit ?? 55, 0, 100)

  const care = careUrgency(state)
  if (care >= 0.6) {
    const value = clamp(0.4 + care * 0.45, 0, 1)
    return {
      value,
      rawValue: value,
      kind: 'comfort',
      reason: pendingText(state)
        ? `人家应下过「${pendingText(state)}」，有点放不下心`
        : '有件要紧的事挂着，想去问问主人那边怎么样了',
    }
  }

  const rawValue = clamp(((mood - 40) / 55) * 0.6 + ((spirit - 35) / 60) * 0.4, 0, 1)
  const value = clamp(rawValue * (0.6 + 0.4 * (spirit / 100)), 0, 1)

  // 心情沉的时候也会想找人说一句，只是说得短、说的是自己怎么了。
  // 这不是「高兴才配开口」：低心情给一条不算小的底线，别让难受变成失声。
  if (mood < 45) {
    const lowNeed = clamp(0.42 + (45 - mood) / 120, 0, 0.85)
    if (lowNeed > value) {
      return {
        value: lowNeed,
        rawValue: Math.max(rawValue, lowNeed),
        kind: 'comfort',
        reason: '心里有点闷，想跟主人说一句',
      }
    }
  }

  if (value < 0.28) {
    return { value, rawValue, kind: 'none', reason: '没什么特别的，就想安静待着' }
  }

  const activity = state?.activity?.kind
  if (activity === 'study' || activity === 'chore' || activity === 'play') {
    return { value, rawValue, kind: 'report', reason: '刚自己忙完一小段，想跟主人提一句' }
  }
  if (mood >= 70 && spirit >= 60) {
    return { value, rawValue, kind: 'share', reason: '这会儿心里松快，想分一点给主人' }
  }
  return { value, rawValue, kind: 'idle-chat', reason: '闲着，有点想跟主人随口说两句' }
}

/** 待办和挂着的念头里最急的那条。待办窗口没到也算挂着，urgency 是它自己的数 */
function careUrgency(state) {
  let max = clamp(state?.pendingIntent?.urgency ?? 0, 0, 1)
  const agenda = Array.isArray(state?.agenda) ? state.agenda : []
  for (const it of agenda) {
    if (!it || it.spokenAt != null) continue
    max = Math.max(max, clamp(it.urgency ?? 0, 0, 1))
  }
  return max
}

function pendingText(state) {
  const text = String(state?.pendingIntent?.text ?? state?.pendingIntent?.seed ?? '').trim()
  return text ? text.slice(0, 40) : ''
}

/**
 * 还要安静多久才算「主人那边没动静了」。
 *
 * 默认 25 分钟：刚说完话就冒出来太急。
 * 但主人经常是说完一句就去干别的了，这时候等着反而是错过——开关打开后按 `eagerSilenceMinutes`（默认 3 分钟）算。
 * 做事那几道门（顺手帮、写东西）也用这个数，不然说话放开了、做事还卡在 60 分钟上。
 */
export function silenceNeed(cfg) {
  if (cfg?.eagerAfterTalk === true) return Math.max(0, num(cfg.eagerSilenceMinutes, 3))
  return Math.max(0, num(cfg.minSilenceMinutes, 25))
}

/** 解析 "02:00-08:00"。返回当天分钟数区间，解析不了就当作没有静默时段 */
function parseQuietHours(spec) {
  if (typeof spec !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim())
  if (!m) return null
  const toMin = (h, mi) => clamp(Number(h), 0, 23) * 60 + clamp(Number(mi), 0, 59)
  return { start: toMin(m[1], m[2]), end: toMin(m[3], m[4]) }
}

/** 跨零点的区间（22:00-07:00）要拆成两段比，否则半夜永远判不进去 */
export function inQuietHours(now, spec) {
  const q = parseQuietHours(spec)
  if (!q || q.start === q.end) return false
  const date = new Date(now)
  const cur = date.getHours() * 60 + date.getMinutes()
  return q.start < q.end ? cur >= q.start && cur < q.end : cur >= q.start || cur < q.end
}

/** 她想说的那件事的种子。不用整句，给 jobPrompt 一个起点就够 */
function makeSeed(state, kind) {
  const spirit = clamp(state.spirit ?? 55, 0, 100)
  switch (kind) {
    case 'comfort':
      return spirit < 35 ? '主人今天好像很累，想问一句要不要先歇会儿' : '想问问主人手上的事顺不顺'
    case 'share':
      return '刚遇到点有意思的小事，想跟主人讲一句'
    case 'report':
      return state.activity?.note
        ? `刚在${state.activity.note}，想跟主人提一句`
        : '刚自己忙完一小段，想跟主人提一句'
    case 'idle-chat':
      return '有点想主人了，想随口说一句'
    default:
      return '没什么正事，就想说一句'
  }
}

/**
 * 决定现在要不要主动说话。
 * @param {object} state
 * @param {number} now
 * @param {{lastUserAt?:number,lastSpokeAt?:number,spokeToday?:number,answeredLast?:boolean,inTurn?:boolean,secondsSinceTick?:number}} stats
 * @param {object} cfg
 * @returns {{speak:boolean, reason:string, intent:object|null, cooldownMinutes:number, energyFloorBlocked:boolean}}
 */
export function decide(state, now, stats, cfg) {
  const s = stats ?? {}
  const c = cfg ?? {}
  const impulse = impulseOf(state, c)

  // 冷却就是冷却，不因「没被回」再加倍：主人没空回不等于不想听，
  // 拿沉默当惩罚，会把她越推越安静。
  const baseCooldown = Math.max(0, num(c.cooldownMinutes, 40))
  const cooldownMinutes = baseCooldown

  const intent =
    impulse.kind === 'none'
      ? null
      : {
          kind: impulse.kind,
          seed: makeSeed(state, impulse.kind),
          mood: clamp(state.mood ?? 70, 0, 100),
          urgency: impulse.rawValue ?? impulse.value,
          createdAt: now,
        }

  const deny = (reason, extra = {}) => ({
    speak: false,
    reason,
    intent: null,
    cooldownMinutes,
    energyFloorBlocked: false,
    ...extra,
  })

  // 门 1：总开关 / 模式
  if (c.enabled === false || c.mode === 'off') return deny('功能关着了')

  // 门 2：正在对话中不插话
  if (s.inTurn === true) return deny('主人正在说话，人家先听完')

  // 门 3：静默时长。取「最后一次用户消息」和「最后一次主动说话」里更近的那个，
  // 相当于两边都要安静够久，刚说完话不会马上被当成没人理
  const lastBase = Math.max(num(s.lastUserAt, 0), num(s.lastSpokeAt, 0))
  const silenceMinutes = lastBase > 0 ? (now - lastBase) / 60000 : Infinity
  const needSilence = silenceNeed(c)
  if (silenceMinutes < needSilence) {
    return deny(`才安静了 ${Math.round(silenceMinutes)} 分钟，还没到 ${needSilence} 分钟`)
  }

  // 门 4：冷却（含被忽略拉长）
  const lastSpoke = num(s.lastSpokeAt, 0)
  const sinceSpoke = lastSpoke > 0 ? (now - lastSpoke) / 60000 : Infinity
  if (sinceSpoke < cooldownMinutes) {
    return deny(`距上次主动才 ${Math.round(sinceSpoke)} 分钟，再等等`)
  }

  // 门 5：兴致。蔫到这个份上，只有「有件急事」或者「特别要紧的待办」还值得开口。
  // 待办按紧急度放行：答应过要提醒的事，不该因为她蔫就不提；但一般闲聊照样歇着。
  // 配置项名字留着 energyFloor（宿主的配置文件还在用），此刻它管的是兴致。
  const spirit = clamp(state.spirit ?? 55, 0, 100)
  const spiritFloor = num(c.spiritFloor ?? c.energyFloor, 25)
  const urgentComfort = impulse.kind === 'comfort' && (impulse.rawValue ?? impulse.value) >= 0.85
  const dueNow = agendaPick(state, now, c)
  const urgentAgenda = Boolean(dueNow) && clamp(dueNow.urgency ?? 0.5, 0, 1) >= 0.7
  if (spirit < spiritFloor && !urgentComfort && !urgentAgenda) {
    return deny(`兴致只剩 ${Math.round(spirit)}，先歇着不说话`, { energyFloorBlocked: true })
  }

  // 门 6：待办。到点的事不看冲动分，直接插队；但静默时段和每日额度还是管着，
  // 所以这里只准备 intent，继续往下走完全部门才真的说
  const agendaItem = dueNow
  const agendaIntent = agendaItem
    ? {
        kind: 'agenda',
        text: agendaItem.text,
        seed: agendaItem.text,
        urgency: clamp(agendaItem.urgency ?? 0.5, 0, 1),
        createdAt: now,
      }
    : null

  // 门 7：今日额度。待办也吃这个额度，不然一天堆二十条待办就等于没有上限
  const spokeToday = Math.max(0, num(s.spokeToday, 0))
  // dailyCap 为 0 或负数表示不限次：主人要是就喜欢她多说话，别拿数字卡她
  const cap = num(c.dailyCap, 8)
  if (cap > 0 && spokeToday >= cap) return deny(`今天已经主动说过 ${spokeToday} 次了，留点额度`)

  // 门 8：静默时段。只有「有急事」才破例——凌晨把主人叫醒是最贵的打扰。
  // 待办也不例外：事情放到早上说不会烂，凌晨的消息会毁一觉
  const quiet = inQuietHours(now, c.quietHours)
  if (quiet && !urgentComfort) return deny('现在是主人休息的时段')

  // 门 9：冲动够不够。待办命中就跳过这道
  if (!agendaIntent && impulse.value < num(c.impulseThreshold, 0.55)) {
    return deny(`想说的劲儿只有 ${impulse.value.toFixed(2)}，还没到 ${num(c.impulseThreshold, 0.55)}`)
  }

  if (agendaIntent) {
    return {
      speak: true,
      reason: `待办到点了：「${agendaItem.text}」`,
      intent: agendaIntent,
      cooldownMinutes,
      energyFloorBlocked: false,
    }
  }

  return { speak: true, reason: impulse.reason, intent, cooldownMinutes, energyFloorBlocked: false }
}
