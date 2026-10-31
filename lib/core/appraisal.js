/**
 * 事件 → 心情/兴致增量。确定性规则表，零 LLM 调用。
 *
 * 为什么要有这张表：心情是模型外的状态机，同样的输入必须给出同样的增量。
 * 每轮让模型自由解释上下文，得到的不是情绪，是随机数，也没法回放和测试。
 *
 * 硬约束（违反要在本文件里拦住，不能指望调用方）：
 * 1. mood 单次 ±6，spirit 单次 ±18（饱和/敏感化缩放之后再套）。
 * 2. 心情往下走只留给「心疼、深夜、被忽略」这三类。被凶、被敷衍只压兴致，不压心情。
 * 3. 每个事件都给 reason（第一人称，具体到能看懂为什么）和 confidence（0–1）。
 *    confidence < 0.4 的事件只记一笔，不动数值。
 *
 * v0.9 两处变化：
 * - 七维撤成两根轴，数值按 STATE-v0.9 那张表折算；不再扣体力。
 * - 饱和（正向递减）和敏感化（负向放大）继续用，乘的字段换成 mood/spirit。
 */

import { clamp, noteRepeat } from './state.js'

export const EVENT_KINDS = [
  'user-message',
  'turn-end',
  'task-done',
  'task-failed',
  'idle',
  'self-activity',
  'proactive-sent',
  'proactive-answered',
  'proactive-ignored',
  'self-prompt',
  'agenda-added',
  'agenda-done',
  'work-added',
  'work-done',
  'self-done',
  'rest',
  'long-absence',
]

const MOOD_CAP = 6
const SPIRIT_CAP = 18

/** 正向饱和的地板、负向敏感化的天花板：乘到底也不能让反应变成 0 或无穷大 */
const SATURATION_FLOOR = 0.35
const SENSITIZATION_CEIL = 2.0

/** 低于这条置信度的判断不算数：模型偶尔会给出模棱两可的解读，别让它推着数值走 */
const MIN_CONFIDENCE = 0.4

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 规则累加器。一条事件常常同时命中好几条规则（久别重逢 + 问句 + 语气软），增量相加 */
function makeAcc() {
  return { mood: 0, spirit: 0, reasons: [], confidence: 0, hit: false }
}

function add(acc, part) {
  acc.hit = true
  acc.mood += num(part.mood)
  acc.spirit += num(part.spirit)
  if (part.reason) acc.reasons.push(part.reason)
  if (Number.isFinite(part.confidence)) acc.confidence = Math.max(acc.confidence, part.confidence)
}

/** 把「多久没说话」说成人话，reason 里带具体数字才像真的在想事，不像打分 */
function fmtGap(ms) {
  const minutes = ms / 60000
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} 分钟`
  return `${(minutes / 60).toFixed(1)} 小时`
}

function appraiseUserMessage(state, event, acc) {
  const gapMs = event.gapMs == null ? null : num(event.gapMs, 0)
  const length = num(event.length, 0)
  const tone = event.toneHint

  // 久别重逢。和「短间隔」互斥，先判长间隔更符合直觉
  if (gapMs != null && gapMs > 2 * 3600 * 1000) {
    add(acc, {
      mood: 3,
      spirit: 5,
      confidence: 0.78,
      reason: `隔了 ${fmtGap(gapMs)} 才又听到主人说话`,
    })
  } else if (gapMs != null && gapMs >= 0 && gapMs < 2 * 60 * 1000 && length < 20) {
    add(acc, {
      mood: 1,
      spirit: 2,
      confidence: 0.6,
      reason: '主人就在旁边，随口一句短短的',
    })
  }

  if (event.question === true) {
    add(acc, { spirit: 2, confidence: 0.55, reason: '主人是在问人家话' })
  }

  if (tone === 'warm') {
    add(acc, {
      mood: 3,
      spirit: 4,
      confidence: 0.7,
      reason: '主人语气软下来了',
    })
  } else if (tone === 'harsh') {
    // 这里没有 mood 项，也不能有。被凶只让她蔫、提不起劲，不会让她难过——
    // 她分得清「主人这会儿烦」和「主人不喜欢人家」。
    add(acc, {
      spirit: -6,
      confidence: 0.7,
      reason: '主人语气有点冲，不过知道主人不是冲着人家来的',
    })
  }

  // 心疼是唯一允许压心情的来源。深夜还在干活 / 明说累
  if (event.lateNight === true) {
    add(acc, {
      mood: -4,
      spirit: -6,
      confidence: 0.8,
      reason: '这个点主人还在忙',
    })
  }
  if (event.tired === true) {
    add(acc, {
      mood: -3,
      spirit: -4,
      confidence: 0.8,
      reason: '主人说累',
    })
  }
}

function appraiseTurnEnd(state, event, acc) {
  const failed = num(event.failedTools)
  const tools = num(event.toolCount)
  const duration = num(event.durationMs)

  if (failed > 0) {
    add(acc, {
      spirit: -4,
      confidence: 0.72,
      reason: `这一轮有 ${failed} 个工具报错了，事情没办利索`,
    })
  } else if (tools >= 8) {
    add(acc, {
      mood: 2,
      spirit: 3,
      confidence: 0.65,
      reason: `一口气跑了 ${tools} 个工具都顺下来`,
    })
  }

  if (duration > 20 * 60 * 1000) {
    add(acc, {
      spirit: -3,
      confidence: 0.6,
      reason: `这一轮忙了 ${Math.round(duration / 60000)} 分钟`,
    })
  }
}

function appraiseIdle(state, event, acc) {
  const minutes = num(event.minutes)
  // 闲着不难受，但太久没人说话会慢慢泄气。被冷落不是被讨厌，这条不压心情
  add(acc, {
    spirit: -2,
    confidence: 0.5,
    reason: minutes > 360
      ? `已经 ${Math.round(minutes / 60)} 小时没人说话了`
      : '闲着晃了一会儿，没什么人说话',
  })
}

function appraiseSelfActivity(state, event, acc) {
  // 事件本身叫 self-activity，具体在做什么放在 activity 字段（兼容 activityKind）
  const activity = event.activity ?? event.activityKind
  switch (activity) {
    case 'study':
      add(acc, { mood: 1, spirit: 3, confidence: 0.6, reason: '看了会儿书' })
      break
    case 'chore':
      add(acc, { mood: 1, spirit: 2, confidence: 0.55, reason: '把屋里收拾了一遍' })
      break
    case 'rest':
      add(acc, { mood: 1, spirit: 4, confidence: 0.6, reason: '趴着歇了一会儿' })
      break
    case 'play':
      add(acc, { mood: 1, spirit: 3, confidence: 0.6, reason: '自己玩了一会儿' })
      break
    default:
      break
  }
}

function appraiseProactive(state, event, acc) {
  switch (event.kind) {
    case 'proactive-sent':
      add(acc, { spirit: -2, confidence: 0.4, reason: '刚主动说了句' })
      break
    case 'proactive-answered':
      // 宿主会带 follows：false = 主人回了但没接住这件事，按「被敷衍」算，不能当被接住
      if (event.follows === false) {
        add(acc, {
          spirit: -3,
          confidence: 0.6,
          reason: '主人回了，但没接住人家那句话',
        })
      } else {
        add(acc, {
          mood: 4,
          spirit: 5,
          confidence: 0.85,
          reason: '主人回了人家',
        })
      }
      break
    case 'proactive-ignored':
      // 被忽略允许压心情（契约表 −3）：等不到回应是真的会难过一点，但只一点
      add(acc, {
        mood: -3,
        spirit: -4,
        confidence: 0.6,
        reason: '人家主动说了一句没等到回应，主人应该是在忙',
      })
      break
  }
}

/** 剩下几种小事。增量克制，靠重复才能堆起来 */
function appraiseNewKind(event, acc) {
  const note = event.note ? `「${event.note}」` : '这件事'
  switch (event.kind) {
    case 'long-absence': {
      // 想念是加法：越久没见，落得越重。按 6 小时一段，一段只记一次
      const hours = Math.max(1, Math.round(Number(event.hours) || 1))
      add(acc, {
        mood: -2,
        spirit: -3,
        confidence: 0.6,
        reason: `主人已经 ${hours} 小时没说话了`,
      })
      break
    }
    case 'self-prompt':
      add(acc, {
        mood: 1,
        spirit: 2,
        confidence: 0.55,
        reason: '自己想找点事做',
      })
      break
    case 'agenda-added':
      add(acc, {
        spirit: -1,
        confidence: 0.5,
        reason: `把${note}记下了`,
      })
      break
    case 'agenda-done':
      add(acc, {
        mood: 2,
        spirit: 1,
        confidence: 0.6,
        reason: `${note}到点说完了`,
      })
      break
    case 'work-added':
      add(acc, {
        mood: 1,
        confidence: 0.5,
        reason: event.note ? `「${event.note}」交到人家手上了` : '主人交了一件事给人家',
      })
      break
    case 'work-done':
      add(acc, {
        mood: 2,
        spirit: 1,
        confidence: 0.65,
        reason: '自己忙完一小段回来',
      })
      break
    case 'rest':
      add(acc, {
        mood: 1,
        spirit: 6,
        confidence: 0.6,
        reason: '歇够了',
      })
      break
    case 'self-done':
      // 她自己做的事做完了。这条是情绪的内生来源：
      // 以前她的起伏全来自主人那边，自己一整天什么都没做也不会觉得空。
      // 不同的事分量不一样，写东西比上网更有完成感，帮主人做完最踏实。
      if (event.failed) {
        add(acc, {
          mood: -2,
          spirit: -2,
          confidence: 0.7,
          reason: `${note}没做成`,
        })
        break
      }
      switch (String(event.tag ?? '')) {
        case 'journal':
          add(acc, { mood: 3, spirit: 2, confidence: 0.75, reason: `${note}写完了` })
          break
        case 'browse':
          add(acc, { mood: 1, spirit: 3, confidence: 0.65, reason: `${note}逛完了` })
          break
        case 'continue':
        case 'help':
          add(acc, { mood: 2, spirit: 4, confidence: 0.7, reason: `${note}做完了` })
          break
        default:
          add(acc, { mood: 2, spirit: 2, confidence: 0.65, reason: `${note}做完了` })
          break
      }
      break
  }
}

/** 同类事件的细分键。tag 由宿主给（'praise' / 'late-night' / 'question'），没有就退回 kind */
function repeatKey(event) {
  const tag = typeof event.tag === 'string' ? event.tag.trim() : ''
  return tag ? `${event.kind}:${tag}` : String(event.kind)
}

/** 取这次事件发生的时间。noteRepeat 需要它，但 appraise 没有 now 参数，只能从事件或状态里找 */
function eventTime(state, event, cfg) {
  const candidates = [event?.at, event?.now, cfg?.now, state?.updatedAt]
  for (const c of candidates) {
    if (Number.isFinite(Number(c)) && Number(c) > 0) return Number(c)
  }
  return 0
}

/**
 * 主入口。
 * @param {object} state 当前状态（心情数值只读；repeats 计数会被 noteRepeat 就地更新）
 * @param {{kind:string} & Record<string, any>} event 事件
 * @param {object} [cfg]
 * @returns {{delta:{mood:number,spirit:number}, reason:string, confidence:number, significant:boolean}}
 */
export function appraise(state, event, cfg) {
  const acc = makeAcc()
  const kind = event?.kind

  switch (kind) {
    case 'user-message':
      appraiseUserMessage(state, event, acc)
      break
    case 'turn-end':
      appraiseTurnEnd(state, event, acc)
      break
    case 'task-done':
      add(acc, {
        mood: 2,
        spirit: 2,
        confidence: 0.7,
        reason: event.note ? `「${event.note}」办完了` : '事情办完了',
      })
      break
    case 'task-failed':
      add(acc, {
        mood: -2,
        spirit: -3,
        confidence: 0.7,
        reason: event.note ? `「${event.note}」没成` : '事情没成',
      })
      break
    case 'idle':
      appraiseIdle(state, event, acc)
      break
    case 'self-activity':
      // 契约里 self-activity 的具体活动写作 activity（'study' 等），但 hook 很容易把
      // 'study' 直接当事件名传过来。两种写法都收，免得宿主因字段名丢掉整个事件
      appraiseSelfActivity(state, event, acc)
      break
    case 'study':
    case 'chore':
    case 'play':
      appraiseSelfActivity(state, { ...event, activity: kind }, acc)
      break
    case 'proactive-sent':
    case 'proactive-answered':
    case 'proactive-ignored':
      appraiseProactive(state, event, acc)
      break
    case 'self-prompt':
    case 'agenda-added':
    case 'agenda-done':
    case 'work-added':
    case 'work-done':
    case 'self-done':
    case 'rest':
    case 'long-absence':
      appraiseNewKind(event, acc)
      break
    default:
      return {
        delta: { mood: 0, spirit: 0 },
        reason: '这个事件人家没认出来，先记一笔不管它',
        confidence: 0,
        significant: false,
      }
  }

  // 饱和 / 敏感化：先算 raw，再按同类事件次数缩放
  const now = eventTime(state, event, cfg)
  let count = 1
  if (now > 0) count = noteRepeat(state, repeatKey(event), now)

  const rawSign = acc.mood + acc.spirit
  let mult = 1
  if (rawSign > 0) mult = Math.max(SATURATION_FLOOR, 1 / (1 + 0.3 * (count - 1)))
  else if (rawSign < 0) mult = Math.min(SENSITIZATION_CEIL, 1 + 0.25 * (count - 1))

  let delta = {
    mood: clamp(acc.mood * mult, -MOOD_CAP, MOOD_CAP),
    spirit: clamp(acc.spirit * mult, -SPIRIT_CAP, SPIRIT_CAP),
  }

  // 置信度不够就不动数值：宁可少记一次，也别让一次含糊的解读改变她的状态
  if (acc.confidence < MIN_CONFIDENCE) {
    delta = { mood: 0, spirit: 0 }
  }

  const significant =
    Math.abs(delta.mood) >= 1.5 || Math.abs(delta.spirit) >= 6

  const reason =
    acc.reasons.length > 0 ? acc.reasons.join('；') : '这一下没什么感觉，就不动心情了'

  return {
    delta,
    reason,
    confidence: acc.hit ? clamp(acc.confidence, 0, 1) : 0,
    significant,
  }
}
