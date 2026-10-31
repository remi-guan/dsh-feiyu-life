/**
 * 会话事件 → 情绪事件。
 *
 * 这里只做「翻译」：把 agent 上下文里发生的事转成 {type, ...} 喂给上层，
 * 不做任何打分（打分在 lib/core/appraisal.js），也不碰状态文件。
 *
 * 为什么要记 lastUserAt / inTurn：打扰门的核心是「主人安静了多久」，
 * 而这个值只有从会话事件里才拿得准；用 tick 时间去猜会把手动输入也算进去。
 */
import { diag } from './paths.js'

/**
 * 我们自己排出去的那条定时任务 prompt 的标记。
 * 它投递进会话时 source.kind 是 'user'（timer-agent 写死的），
 * 跟主人手打的区分不开，只能靠这段哨兵文本认。
 */
export const SENTINEL = '[feiyu-life]'

/**
 * 「自己找点事做」那类任务的标记。
 * 和主动说话用的 SENTINEL 分开：一次是她说，一次是她干活，情绪后果不一样。
 */
export const SELF_SENTINEL = '[feiyu-life:self]'
/** v3 行为任务的哨兵前缀，后面跟行为 id，例如 [feiyu-life:behave:journal] */
export const BEHAVE_PREFIX = '[feiyu-life:behave:'

/** 从提示词里认出是哪种行为；认不出返回空串。 */
export function behaviorIdOf(text) {
  const raw = String(text || '')
  if (raw.startsWith(SELF_SENTINEL)) return 'continue'
  if (!raw.startsWith(BEHAVE_PREFIX)) return ''
  const end = raw.indexOf(']', BEHAVE_PREFIX.length)
  if (end === -1) return ''
  return raw.slice(BEHAVE_PREFIX.length, end).trim()
}

/** 宿主或别的插件注入的上下文，不是主人在说话。 */
const INJECTED_SOURCES = new Set([
  'runtime-context', 'time-context', 'system-reminder', 'system', 'time-sampled',
  'skill-catalog', 'persona-context', 'better-sidebar',
])

/** 从各种奇怪形状的消息里抠出纯文本。 */
export function textOf(message) {
  if (!message) return ''
  if (typeof message === 'string') return message.slice(0, 4000)
  if (typeof message.text === 'string') return message.text.slice(0, 4000)
  if (typeof message.content === 'string') return message.content.slice(0, 4000)
  if (Array.isArray(message.content)) {
    const parts = []
    for (const block of message.content) {
      if (typeof block === 'string') parts.push(block)
      else if (block && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join(' ').slice(0, 4000)
  }
  return ''
}

/** 会话 id（不同版本的 session 对象字段名不一样，挨个试）。 */
export function sessionIdOf(session) {
  if (!session) return ''
  for (const key of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    try {
      const value = session[key]
      if (typeof value === 'string' && value) return value
    } catch {
      /* 有些字段是 getter，读崩了跳过 */
    }
  }
  return ''
}

/** 会话标题（界面下拉用），拿不到就退回 id 尾段。 */
export function sessionTitleOf(session) {
  try {
    const meta = session && session.meta
    if (meta && typeof meta.title === 'string' && meta.title) return meta.title
  } catch {
    /* ignore */
  }
  const id = sessionIdOf(session)
  return id ? id.slice(-8) : '(未命名会话)'
}

/** 一句话里像不像在问问题（门里用不到，appraisal 里用来加 calm）。 */
export function looksLikeQuestion(text) {
  return /[?？]\s*$/.test(String(text).trim()) || /(吗|呢|么|怎么样|如何)[?？]?\s*$/.test(String(text).trim())
}

/** 粗粒度语气判断：只认明显的词，判不出来就 neutral，绝不猜。 */
export function toneOf(text) {
  const value = String(text)
  if (!value) return 'neutral'
  if (/(滚|闭嘴|烦死|没用|废物|讨厌你|别说了)/.test(value)) return 'harsh'
  if (/(辛苦|谢谢|乖|抱|喜欢|爱你|好棒|真棒|可爱|么么|亲亲)/.test(value)) return 'warm'
  return 'neutral'
}

/** 凌晨（0–5 点）：这是唯一允许把 mood 往下压的时间线索之一。 */
export function isLateNight(now) {
  const hour = new Date(now).getHours()
  return hour >= 0 && hour < 5
}

/** 主人自己说累了/困了。只认明确说出来，不靠语气猜。 */
/**
 * 从主人话里认「他交了一件事给我」。
 * 只认带任务动词、又不带疑问的短句，宁可漏，不乱记：
 * 记错了她会去忙一件没人安排的事，比没记还糟。
 * @param {string} text
 * @returns {string} 任务文字（空串表示没认出来）
 */
export function workHintOf(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (raw.length < 4 || raw.length > 120) return ''
  if (looksLikeQuestion(raw)) return ''
  const tail = '(?:一下|吧|了|掉|嘛)?[。！!～~]*$'
  const patterns = [
    new RegExp(`(?:帮|替|给)我(?:把|将)?(.{2,40}?)(?:做|弄|搞|整理|处理|改|写|查|看看|看一下)${tail}`),
    new RegExp(`(?:把|将)(.{2,40}?)(?:做完|弄完|搞定|弄好|改好|整理好|交上去|交了)${tail}`),
    new RegExp(`(?:把|将)(.{2,40}?)(?:改成|换成|加上|删掉|分开|拆开)`),
    /(?:记得|别忘了|不要忘)(.{2,40})[。！!～~]*$/,
    new RegExp(`(?:回头|待会|待会儿|一会儿|晚点|明天|后天)(?:去|要|得)?(?:看一下|看看|处理一下|弄一下|做一下)?(.{2,40})$`),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(raw)
    if (!match) continue
    const task = match[1].trim()
    if (task.length < 2) continue
    return task.slice(0, 60)
  }
  return ''
}

export function looksTired(text) {
  return /(累死|好累|累了|累瘫|困死|好困|困了|熬夜|加班到|没睡)/.test(String(text))
}

/**
 * 往一个 agent 身上挂监听。
 *
 * @param {object} options
 * @param {any} options.agent 宿主 agent 句柄
 * @param {(event:object)=>void} options.onEvent 翻译后的事件
 * @returns {() => void} 卸载函数
 */
export function mountAgent({ agent, onEvent }) {
  const disposers = []
  let lastUserAt = 0
  let turnStartAt = 0
  let pendingSelfPrompt = ''

  const emit = (event) => {
    try {
      onEvent(event)
    } catch (error) {
      diag(`处理事件 ${event.type} 失败：${error && error.message}`)
    }
  }

  try {
    disposers.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
      const message = payload && payload.message ? payload.message : payload
      const text = textOf(message)
      if (!text) return
      const sourceKind = message && message.source && message.source.kind ? String(message.source.kind) : ''
      if (INJECTED_SOURCES.has(sourceKind)) return

      const now = Date.now()
      const behaviorId = behaviorIdOf(text)
      if (behaviorId) {
        // 她被派去做一件自己的事，不是说话
        pendingSelfPrompt = { kind: 'behave', id: behaviorId }
        turnStartAt = now
        emit({ type: 'behavior-start', at: now, behaviorId })
        return
      }
      if (text.startsWith(SENTINEL)) {
        // 是我们自己排出去的心跳：主人并没有说话，别重置沉默时长
        pendingSelfPrompt = { kind: 'speak' }
        turnStartAt = now
        emit({ type: 'self-prompt', at: now })
        return
      }
      if (sourceKind && sourceKind !== 'user') {
        // 别的插件的推送（定时巡检之类）：既不算主人说话，也不算我们开口
        emit({ type: 'foreign', sourceKind, at: now })
        return
      }
      const gapMs = lastUserAt === 0 ? 0 : now - lastUserAt
      lastUserAt = now
      turnStartAt = now
      emit({
        type: 'user',
        at: now,
        text,
        gapMs,
        length: text.length,
        question: looksLikeQuestion(text),
        toneHint: toneOf(text),
        lateNight: isLateNight(now),
        tired: looksTired(text),
        workHint: workHintOf(text),
      })
    }))
  } catch (error) {
    diag(`监听 inbox 失败：${error && error.message}`)
  }

  try {
    disposers.push(agent.ctx.on('agent/turn-stopping', () => {
      const now = Date.now()
      const durationMs = turnStartAt === 0 ? 0 : now - turnStartAt
      const kind = pendingSelfPrompt && pendingSelfPrompt.kind
      const behaviorId = kind === 'behave' ? pendingSelfPrompt.id : ''
      const selfPrompt = kind === 'speak'
      const selfTask = kind === 'behave'
      pendingSelfPrompt = false
      turnStartAt = 0
      emit({ type: 'turn-end', at: now, durationMs, selfPrompt, selfTask, behaviorId })
    }))
  } catch (error) {
    diag(`监听 turn-stopping 失败：${error && error.message}`)
  }

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 卸载失败不影响别的 */
      }
    }
  }
}

/* ------------------------------------------------------------------------- *
 * 议程（agenda）与「有没有接住」
 *
 * 这两件事都是纯文本规则，不调模型：要的是便宜、可预测、出错也不伤人。
 * ------------------------------------------------------------------------- */

const CJK = /[\u4e00-\u9fa5]/

/**
 * 抽关键词：中文按相邻两字切片，英文按单词。
 * 只用来判断「主人这句话是不是接着她说的」，粗一点没关系。
 */
export function keywordsOf(text) {
  const out = new Set()
  if (typeof text !== 'string' || !text) return out
  const lowered = text.toLowerCase()
  for (const word of lowered.match(/[a-z][a-z0-9_+-]{1,}/g) || []) {
    if (word.length >= 3) out.add(word)
  }
  for (const run of lowered.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return out
}

/** 两段文字有没有共同的词（用于判断主人是不是接住了她的话）。 */
export function sharesTopic(a, b) {
  if (!a || !b) return false
  const left = keywordsOf(a)
  if (left.size === 0) return false
  for (const key of keywordsOf(b)) {
    if (left.has(key)) return true
  }
  return false
}

const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const TASK_WORDS = /(要|得|需要|记得|别忘|交|发|做|写|准备|改|开|上线|截止|deadline|到期|测|复盘|交稿|提交|出发|会议)/

/** 从一句话里猜「几点」：返回当日分钟数，猜不到返回 null。 */
function hourOf(text) {
  const half = /(半)/.test(text) ? 30 : 0
  const numeric = text.match(/(\d{1,2})\s*[点:：](\d{1,2})?/)
  const chinese = text.match(/([一二两三四五六七八九十]{1,3})\s*[点]/)
  let hour = null
  if (numeric) hour = Number(numeric[1]) + (numeric[2] ? Number(numeric[2]) / 60 : half / 60)
  else if (chinese) {
    const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    const raw = chinese[1]
    if (raw.length === 1) hour = digits[raw] ?? null
    else if (raw === '十一') hour = 11
    else if (raw === '十二') hour = 12
    else if (raw.length === 2 && raw[0] === '十') hour = 10 + (digits[raw[1]] || 0)
    else if (raw.length === 2 && raw[1] === '十') hour = (digits[raw[0]] || 0) * 10
  }
  if (hour === null) return null
  if (/下午|晚上|傍晚|夜/.test(text) && hour < 12) hour += 12
  if (/凌晨|半夜/.test(text) && hour >= 12) hour -= 12
  return hour
}

/**
 * 从主人一句话里认「以后要提醒的事」。
 * 认到时间词 + 任务动词才算，否则宁可不记：瞎记一条以后会真的说出来，比漏记更糟。
 *
 * @returns {{text:string, dueAt:number, window:{from:number,to:number}|null}|null}
 */
export function hintOf(text, now = Date.now()) {
  if (typeof text !== 'string' || text.length < 4) return null
  if (!TASK_WORDS.test(text)) return null

  const dayWords = /(明天|明早|明晚|后天|今晚|今天|待会儿|等会儿)/
  const weekMatch = text.match(/(下?)(?:周|星期|礼拜)([一二三四五六日天])/)
  const hasWeekday = Boolean(weekMatch)
  if (!dayWords.test(text) && !hasWeekday) return null

  const date = new Date(now)
  let dayOffset = null
  if (/明天|明早|明晚/.test(text)) dayOffset = 1
  else if (/后天/.test(text)) dayOffset = 2
  else if (/今天|今晚|待会儿|等会儿/.test(text)) dayOffset = 0
  if (hasWeekday) {
    const target = WEEKDAYS[weekMatch[2]]
    const current = date.getDay() === 0 ? 7 : date.getDay()
    let delta = target - current
    if (delta <= 0) delta += 7
    if (weekMatch[1] === '下') delta += 7
    dayOffset = delta
  }
  if (dayOffset === null) return null

  const minutes = hourOf(text)
  const due = new Date(now)
  due.setDate(due.getDate() + dayOffset)
  // 没说钟点就按「下午」算：早上说完一整天都能提醒，比定死在清晨有用
  const hour = minutes === null ? 15 : minutes
  due.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0)
  if (due.getTime() <= now + 5 * 60_000) return null

  const sentence = String(text)
    .split(/[。！？!?\n]/)
    .map(part => part.trim())
    .filter(Boolean)
    .sort((a, b) => (TASK_WORDS.test(b) ? 1 : 0) - (TASK_WORDS.test(a) ? 1 : 0))[0] || text
  const body = sentence.replace(SENTINEL, '').replace(SELF_SENTINEL, '').trim().slice(0, 60)
  if (!body || !CJK.test(body)) return null

  const from = new Date(due.getTime() - 30 * 60_000)
  const to = new Date(due.getTime() + 6 * 60 * 60_000)
  return {
    text: body,
    dueAt: due.getTime(),
    window: { from: from.getTime(), to: to.getTime() },
  }
}
