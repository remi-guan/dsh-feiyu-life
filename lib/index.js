/**
 * dsh-feiyu-life · 宿主半边入口。
 *
 * 这个文件只做接线，规则全在 lib/core/*.js 里：
 *   - 每 60 秒 tick 一次：衰减、清议程、看她该不该醒、必要时排一条一次性定时任务
 *   - 目标会话每来一条消息、每结束一轮，翻译成情绪事件交给 appraisal
 *   - 把心情体感挂进目标会话的系统上下文（方式由 injectMode 决定）
 *   - 把状态、配置、会话列表、任务台账开给浏览器半端
 *
 * 「主动说话」唯一出口是 dsh-timer-agent 的一次性任务（lib/host/bridge.js），
 * 不直接 agent.followup：主人要能在定时任务面板里看见并且取消它。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { agendaAdd, agendaSweep } from './core/agenda.js'
import { appraise } from './core/appraisal.js'
import { BEHAVIORS, checkinPlan, planDay } from './core/behaviors.js'
import { impulseOf } from './core/gate.js'
import { findRepeat } from './core/repeat.js'
import { detectRoutine } from './core/routine.js'
import { buildCard, nextWakeAt, parseDecision } from './core/heart.js'
import { behaviorPrompt, jobPrompt, moodSnapshot, outboundStyle, personaTail } from './core/prompt.js'
import { PLACES, herPlaceOf, ownerPlaceOf, spaceOfBehavior } from './core/place.js'
import {
  blankState, decay, drift, normalizeState, noteBehavior, noteRest, noteSpoken, noteTalk, openWorkAdd,
  openWorkDone, openWorkList, pushTimeline,
} from './core/state.js'
import { listRecentJobs, spawnProactiveJob } from './host/bridge.js'
import { appendActivity, appendMeal, appendRoutine } from './host/dailylog.js'
import { askHeart, heartError, resolveModel } from './host/mind.js'
import { currentPersona } from './host/persona.js'
import {
  describeGrants,
  grantAddTaken,
  grantSetVerb,
  askPush,
  askResolve,
  askExpire,
  looksLikeYes,
  grantPrompt,
} from './core/grants.js'
import {
  SELF_SENTINEL, SENTINEL, hintOf, isLateNight, mountAgent, sessionIdOf, sessionTitleOf, sharesTopic,
  workHintOf,
} from './host/hooks.js'
import { DEFAULT_GRANTS, diag, DSH_HOME, loadConfig, patchConfig, readJson, STATE_PATH, writeJson } from './host/paths.js'
import { latestSessionId, loadSessions, noteSession, saveSessions } from './host/sessions.js'
import { appendOut, recentAll, recentFrom, MAIN_QUIET_MS } from './host/outbox.js'
import { appendProgress, progressSnapshot, recentProgress } from './host/progress.js'
import { sendQQ } from './host/qq.js'
import { registerRoutes } from './host/routes.js'

export const name = 'feiyu-life'
export const inject = ['agents', 'webServer', 'systemPrompt', 'timer', 'llm']

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 多久 tick 一次。60 秒够用：她自己拿主意，宿主只负责到点叫她，最坏晚一分钟醒。 */
const TICK_MS = 60_000
/** 主人说话之后多久叫醒她（她要能立刻反应，但不能每句话都调一次模型）。 */
const WAKE_AFTER_USER_MS = 60_000
/** 她做完一件事或说完话之后，最短多久再叫醒她（防 bug 连发，留一分钟最短间隔）。 */
const MIN_WAKE_AFTER_ACTION_MS = 1 * 60_000

/** 衰减半衰期（小时）：心情和情绪慢慢回稳，不做记录的时候不至于一直钉在某个值。 */
const DECAY_HALF_HOURS = 6

/** 主动开口后多久没回应算「被忽略」（分钟）。 */
const IGNORE_AFTER_MINUTES = 180
/** 主人说完话这几分钟内她不补刀：主会话正在答，她再发一条就是刷屏。 */
const RECENT_USER_MS = 5 * 60_000

/** 会话 → 这一侧是谁（'main' 主会话 / 'fish' 她自己的工作会话）。 */
const sideOfSession = new Map()

/**
 * 从 assistant/message 事件里抠出文字。
 * 事件的数据结构在几层之间搬过，深了浅了都有可能，所以几个位置都试一遍。
 */
export function assistantTextOf(event) {
  const data = (event && event.data) || event || {}
  const message = data.message || data.entry || data
  const content = message && (message.content || message.blocks)
  if (!Array.isArray(content)) {
    return typeof message === 'string' ? message : ''
  }
  // 只认真正的正文。reasoning/thinking 块也带 .text，按 text 存在就收会把
  // 主人的内部思考当成「大厅说的话」记进台账，她读卡片就看见一堆半截推理。
  // 带 tool-call 的那种是中间的过场话，也不算说给谁听的。
  if (content.some(part => part && part.type === 'tool-call')) return ''
  return content
    .filter(part => part && part.type === 'text')
    .map(part => String(part.text || ''))
    .join('')
    .trim()
}

/** 一次对话被打断这么久还没结束，就当成已经结束了，别一直堵着门。 */
const STALE_TURN_MS = 5 * 60_000

/** 主人安静这么久，就当他在忙别的（活动状态退回 idle）。 */
const IDLE_AFTER_MS = 20 * 60_000

/** 一夜里安静这么久，就当睡了（活动状态 sleep，不耗精力）。 */
const SLEEP_AFTER_MS = 60 * 60_000

/** 一轮干超过这么久，算在干活（记 work，不是闲聊）。 */
const WORK_TURN_MS = 45_000


const WIDGET_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-feiyu-life/widget.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

/** 本地日期串，和 core/state.js 的 dayKey() 同一种写法。 */
function dayText(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 本地零点（今日开口次数按自然日算，不按 24 小时滑窗）。 */
function startOfDay(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 解析 '09:00-23:00' 这种时段，返回 {from,to} 分钟数；格式不对返回 null。 */
function parseHours(spec) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(spec || ''))
  if (!match) return null
  return {
    from: Number(match[1]) * 60 + Number(match[2]),
    to: Number(match[3]) * 60 + Number(match[4]),
  }
}

/** 当前时刻在不在时段内（支持跨零点）。 */
function inHours(spec, now) {
  const range = parseHours(spec)
  if (!range) return true
  const date = new Date(now)
  const minute = date.getHours() * 60 + date.getMinutes()
  if (range.from === range.to) return true
  if (range.from < range.to) return minute >= range.from && minute <= range.to
  return minute >= range.from || minute <= range.to
}

/**
 * 老版 dsh-feiyu-mood 的心情文件还在、这边还没有状态时，把它接过来。
 * 她自己的心情不该因为换了个插件就归零。
 */
function adoptLegacyState() {
  const legacy = readJson(join(DSH_HOME, 'feiyu-mood', 'state.json'), null)
  if (!legacy || typeof legacy !== 'object') return null
  const base = blankState(Date.now())
  const mood = Number(legacy.mood)
  // 老版七根情绪里，开心和踏实最贴近「兴致」；其余几根本来就是对主人的描写，不再搬
  const happy = Number(legacy.dims && legacy.dims.happy)
  const calm = Number(legacy.dims && legacy.dims.calm)
  const spiritGuess = (Number.isFinite(happy) && Number.isFinite(calm))
    ? (happy + calm) / 2
    : Number.isFinite(happy) ? happy : base.spirit
  const timeline = Array.isArray(legacy.timeline)
    ? legacy.timeline.slice(-100).map(entry => ({
      at: Number(entry.at || entry.time || Date.now()),
      kind: String(entry.kind || 'legacy'),
      reason: String(entry.reason || ''),
      delta: Number(entry.delta || 0),
    }))
    : []
  return {
    ...base,
    mood: Number.isFinite(mood) ? Math.max(0, Math.min(100, mood)) : base.mood,
    spirit: Math.max(0, Math.min(100, spiritGuess)),
    timeline,
  }
}

function loadState() {
  const stored = readJson(STATE_PATH, null)
  if (!stored || typeof stored !== 'object') {
    const adopted = adoptLegacyState()
    if (adopted) diag('接手了旧版 feiyu-mood 的心情')
    return normalizeState(adopted || blankState(Date.now()), Date.now())
  }
  return normalizeState(stored, Date.now())
}

/**
 * @param {any} ctx cordis 插件上下文
 * @param {any} [pluginConfig] cordis.patch.yml 里传进来的配置（现在不用，留位）
 */
export function apply(ctx, pluginConfig = {}) {
  const cfg = loadConfig()
  if (!cfg.targetSession && process.env.DSH_SESSION_ID) cfg.targetSession = process.env.DSH_SESSION_ID
  let state = loadState()
  // v4 的字段 normalizeState 不认识，这里兜一下默认值
  state.nextWakeAt = Number(state.nextWakeAt) || 0
  state.thoughts = Array.isArray(state.thoughts) ? state.thoughts.slice(-50) : []
  state.plans = Array.isArray(state.plans) ? state.plans.slice(-20) : []
  state.lastHeart = state.lastHeart || null
  state.lastUserText = typeof state.lastUserText === 'string' ? state.lastUserText : ''
  // 门路：第一次给的时候把主人一开始给的只读权限塞进去，写操作留给她自己来求
  state.grants = Array.isArray(state.grants) ? state.grants : []
  state.pendingAsks = Array.isArray(state.pendingAsks) ? state.pendingAsks : []
  // 版本自带的门路对一遍：缺的整条补上，已有的只往「更宽」合并（granted 只增不减），
  // 所以主人自己关掉的不会被这里偷偷打开——关掉走的是 grantSetVerb 改 granted=false，
  // 这里合并的是同一份默认值，重复跑也不会翻回去。
  const missingGrants = DEFAULT_GRANTS.filter(spec => !state.grants.some(item => item && item.id === spec.id))
  for (const spec of DEFAULT_GRANTS) grantAddTaken(state, spec, Date.now())
  if (missingGrants.length > 0) {
    diag('补上了门路：' + missingGrants.map(item => item.label).join('、'))
  }
  let sessions = loadSessions()
  let sessionsDirty = false
  let dirty = false
  const mounted = new Map()
  /** 正在执行的行为 id（回合结束时用它派回执） */
  let activeBehavior = ''
  let lastTickAt = Date.now()
  let lastImpulse = null
  let inTurn = false
  let turnStartedAt = 0
  let busy = false
  /** 主会话里那几行进度摘要的节流与去重 */
  let lastProgressAt = 0
  let lastProgressText = ''

  const touch = () => { dirty = true }

  /**
   * 落盘。衰减每轮都会改小数点后好几位，那种变化不值得写一次盘：
   * 数值先按一位小数归一，和上次写下的内容一模一样就跳过。
   */
  let lastSaved = ''
  const save = (force = false) => {
    if (!dirty && !force) return
    try {
      const rounded = {
        ...state,
        mood: Math.round((Number(state.mood) || 0) * 10) / 10,
        spirit: Math.round((Number(state.spirit) || 0) * 10) / 10,
      }
      const text = JSON.stringify(rounded)
      if (!force && text === lastSaved) return
      writeJson(STATE_PATH, rounded)
      lastSaved = text
      dirty = false
    } catch (error) {
      diag(`写状态失败：${error && error.message}`)
    }
  }

  const saveSessionBook = () => {
    if (!sessionsDirty) return
    saveSessions(sessions)
    sessionsDirty = false
  }


  /**
   * 出站消息的尾巴：说话格式 + 她自己的人设前几行。
   * 人设库是设置页在管，这里只读一份，别另存；读不到就只留格式那一段。
   */
  const styleTail = () => [outboundStyle(cfg), personaTail(currentPersona())].filter(Boolean).join('\n\n')

  /**
   * 这条任务该用哪个模型。
   * timer 任务 resume 会话时不一定带着模型选择，而 preset 的人设前缀是
   * `powered by the {{model}} model`（严格插值），变量缺值整轮直接失败，
   * 所以每条任务都显式带上：配置里写死的优先，否则跟部署的默认模型。
   */
  const jobModel = () => {
    if (cfg.heartProvider && cfg.heartModel) {
      return { provider: cfg.heartProvider, model: cfg.heartModel }
    }
    try {
      const service = ctx.get('agentDefaultModel')
      const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
      if (selection && selection.provider && selection.model) {
        return { provider: selection.provider, model: selection.model }
      }
    } catch { /* 拿不到就不传，让 timer 自己兜底 */ }
    return undefined
  }

  const origin = () => {
    try {
      return ctx.webServer.getOrigin()
    } catch (error) {
      diag(`拿不到本机地址：${error && error.message}`)
      return ''
    }
  }

  /**
   * 摊给她看的事实：不问「你累不累」，只把忙了多久、做了几件、上次歇是什么时候写清楚，
   * 累不累她自己判断。这些都是从时间线现算的，不存数值。
   */
  const factsOf = (current, now) => {
    const facts = []
    const activity = current.activity || {}
    if (activity.kind === 'work' && Number(activity.since) > 0) {
      const minutes = Math.round((now - Number(activity.since)) / 60_000)
      if (minutes >= 45) {
        const clock = new Date(Number(activity.since)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        facts.push(`从 ${clock} 起一直在忙，中间没歇过，已经 ${minutes} 分钟`)
      }
    }
    const sixHoursAgo = now - 6 * 3_600_000
    const busyCount = (current.timeline || []).filter(entry => Number(entry && entry.at) >= sixHoursAgo).length
    if (busyCount > 0) facts.push(`最近六小时有事落下 ${busyCount} 件`)
    const lastRestAt = Number(current.lastRestAt) || 0
    if (lastRestAt > 0) {
      const hours = Math.round(((now - lastRestAt) / 3_600_000) * 10) / 10
      facts.push(`上次自己歇着是 ${hours} 小时前`)
    } else {
      facts.push('还没自己歇过')
    }
    return facts
  }

  /** 把 appraisal 的结果落到状态上（夹紧范围、写时间线）。 */
  const applyAppraisal = (event) => {
    const before = state.mood
    const result = appraise(state, event, cfg)
    if (!result || !result.delta) return result
    const mood = Math.max(0, Math.min(100, state.mood + (result.delta.mood || 0)))
    const spirit = Math.max(0, Math.min(100, (state.spirit ?? 55) + (result.delta.spirit || 0)))
    state = {
      ...state,
      mood,
      spirit,
      updatedAt: Date.now(),
      timeline: result.significant
        ? pushTimeline(state, {
          at: Date.now(),
          kind: event.kind,
          reason: result.reason,
          delta: Math.round(mood - before),
          confidence: result.confidence,
        }).timeline
        : state.timeline,
    }
    touch()
    return result
  }

  /** 统计今日开口次数。被忽略连击不记了：主人没空回不等于不想听 */
  const speakStats = (now) => {
    const today = startOfDay(now)
    return { spokeToday: state.spokeAt.filter(time => time >= today).length }
  }

  /**
   * 目标会话：pinned 用配置里那个，recent 用最近说过话的那个。
   * recent 是给「同时开几个会话」准备的——她在 A 说话、主人在 B 接话，
   * 固定目标会把她判成被无视。
   */
  const resolveSession = () => {
    if (cfg.sessionMode === 'recent') {
      const latest = latestSessionId(sessions)
      if (latest) return latest
    }
    return cfg.targetSession || process.env.DSH_SESSION_ID || ''
  }

  /**
   * 她自己的会话：行为、门路、写日记都在这里跑。
   * 主会话只留给主人的对话，不然 `[feiyu-life]` 这类哨兵会混进去。
   * 配空串（或会话不在）时退回目标会话，保持老行为。
   */
  const resolveWorkSession = () => cfg.workSession || resolveSession()

  /** 事件入口：hooks 翻译好的东西都进这里。 */
  const onAgentEvent = (event) => {
    const now = event.at || Date.now()
    if (event.session) {
      sessions = noteSession(sessions, {
        id: event.session,
        title: event.sessionTitle || '',
        at: now,
      })
      sessionsDirty = true
    }

    if (event.type === 'user') {
      if (event.text) state.lastUserText = String(event.text).slice(0, 300)
      if (event.text) noteTalk(state, 'owner', event.text, now)
      // 作息只从他自己说的话里认：认出来就记成事实，不猜他到底睡没睡
      const routine = event.text ? detectRoutine(event.text) : ''
      if (routine) {
        state.lastRoutine = { kind: routine, at: now }
        appendRoutine(routine, now, cfg)
        appendProgress(routine === 'sleep' ? '主人说去睡了' : '主人说醒了', now)
      }
      // 她刚问过话，这条就是回答。只认六小时内、还没答过的那一问
      const asked = state.checkin
      if (event.text && !routine && asked?.askedAt && !asked.answerAt && now - asked.askedAt < 6 * 3600_000) {
        const answer = String(event.text).trim()
        state.checkin.answer = answer.slice(0, 200)
        state.checkin.answerAt = now
        // 「嗯」「好」这种不算回答，记下来只会把笔记弄脏
        if (answer.length >= 3) {
          if (asked.askKind === 'meal') appendMeal(answer, now, cfg)
          else if (asked.askKind === 'day') appendActivity(answer, now, cfg)
        }
      }
      // 主人一开口就把她叫醒：他要是在安排任务，她该立刻反应过来
      const soon = now + WAKE_AFTER_USER_MS
      if (!state.nextWakeAt || state.nextWakeAt > soon) state.nextWakeAt = soon
      state.lastUserAt = now
      state.lastAbsenceBucket = 0
      state.activity = { kind: 'chat', note: '主人在说话', since: now }

      // 她求过权限：主人这句话就是回答。认「行/可以/给你」也认「不用了」。
      if ((state.pendingAsks || []).length > 0 && event.text) {
        const answer = String(event.text)
        const pending = state.pendingAsks[state.pendingAsks.length - 1]
        const said = looksLikeYes(answer)
        const refused = /不行|不可以|不给|别给|算了|不要|先不/.test(answer)
        if (said || refused) {
          const grant = (state.grants || []).find(item => item.id === pending.use)
          const entry = grant && (grant.verbs || []).find(item => item.verb === pending.verb)
          askResolve(state, pending.id, said, now)
          if (said) {
            applyAppraisal({ kind: 'self-activity', at: now, tag: 'granted', note: '主人答应了' })
            diag(`主人答应了门路 ${pending.use}/${pending.verb}`)
          } else {
            diag(`主人没收 ${pending.use}/${pending.verb}`)
          }
          // 让她知道结果，下一次心里有数
          state.lastUserText = answer.slice(0, 300)
          state.nextWakeAt = Math.min(state.nextWakeAt || now, now + WAKE_AFTER_USER_MS)
          state.timeline = pushTimeline(state, {
            at: now,
            kind: said ? 'grant-given' : 'grant-refused',
            reason: `${grant ? grant.label : pending.use}的${entry ? entry.label : pending.verb}${said ? '给了' : '没给'}`,
            delta: 0,
          }).timeline
        }
      }

      // 上一条主动消息有没有被接住：不是「有人说话」就算回应，
      // 敷衍一句「嗯」和被认真接话，对她来说该是两种结果。
      if (state.pendingIntent) {
        const gapMs = Math.max(0, now - (state.pendingIntent.createdAt || 0))
        const follows = gapMs <= 3 * 60_000
          && (Number(event.length) >= 6 || sharesTopic(state.pendingIntent.text, event.text))
        state.lastReply = { at: now, gapMs, length: Number(event.length) || 0, follows }
        // 被认真接住就退还这一次额度：说对了话不该占今天的次数，
        // 真正该扣的是被忽略的那种。主人愿意聊，她就能多聊。
        if (follows) {
          const stamp = Number(state.pendingIntent.createdAt) || 0
          const idx = stamp ? state.spokeAt.lastIndexOf(stamp) : -1
          if (idx >= 0) state.spokeAt = state.spokeAt.filter((_, i) => i !== idx)
        }
        applyAppraisal({ kind: 'proactive-answered', at: now, follows, tag: 'reply' })
        state.pendingIntent = null
      }

      applyAppraisal({
        kind: 'user-message',
        at: now,
        gapMs: event.gapMs,
        length: event.length,
        question: event.question,
        toneHint: event.toneHint,
        lateNight: event.lateNight,
        tired: event.tired,
        tag: event.question ? 'question' : (event.toneHint || 'talk'),
      })

      // 主人交的活她自己记下来，不用主人在界面上手动加。
      // 一件事只记一次：同一件事换个说法再说一遍，靠关键词重叠去重。
      const workHint = event.workHint || workHintOf(event.text)
      if (workHint) {
        const known = openWorkList(state, now)
        const dup = known.some(item => sharesTopic(item.text, workHint) || item.text === workHint)
        if (!dup && known.length < 50) {
          openWorkAdd(state, { text: workHint, urgency: 0.55 }, now)
          applyAppraisal({ kind: 'work-added', at: now, tag: 'work' })
          diag(`记下一件要接着做的活：${workHint}`)
        }
      }

      // 主人说做完了/搞定了，就把最像的那条划掉
      if (/(做完了|弄完了|搞定了|弄好了|交了|改好了)/.test(String(event.text || ''))) {
        const known = openWorkList(state, now)
        const hit = known.find(item => sharesTopic(item.text, event.text))
        if (hit) {
          openWorkDone(state, hit.id, now)
          diag(`划掉一件活：${hit.text}`)
        }
      }

      // 从话里捡「以后要说一声」的事：认到时间 + 任务才算，宁漏不错
      if (cfg.agenda && cfg.agenda.enabled) {
        const hint = hintOf(event.text, now)
        if (hint) {
          const added = agendaAdd(state, { ...hint, kind: 'remind', urgency: 0.6 }, now)
          if (added) {
            applyAppraisal({ kind: 'agenda-added', at: now, tag: 'remind' })
            diag(`记下一件要提醒的事：${hint.text}`)
          }
        }
      }

      inTurn = true
      turnStartedAt = now
      save()
      saveSessionBook()
      return
    }

    if (event.type === 'self-prompt') {
      // 我们自己排的那条心跳到点了：记一笔「她开口了」，不重置沉默时长
      inTurn = true
      turnStartedAt = now
      return
    }

    if (event.type === 'behavior-start') {
      // 她被派去做一件自己的事（写东西 / 上网 / 接着忙 / 帮个忙）
      const spec = behaviorSpec(event.behaviorId)
      activeBehavior = event.behaviorId
      state.activity = {
        kind: spec && spec.kind === 'self' ? 'rest' : 'work',
        note: spec ? spec.label : '自己的事',
        space: spaceOfBehavior(event.behaviorId) || String(state.activity?.space ?? ''),
        since: now,
      }
      inTurn = true
      turnStartedAt = now
      save()
      return
    }

    if (event.type === 'turn-end') {
      inTurn = false
      if (event.selfPrompt) {
        state.lastSpeakAt = now
        state.spokeAt = [...state.spokeAt, now].slice(-60)
        applyAppraisal({ kind: 'proactive-sent', at: now, tag: 'speak' })
        state.activity = { kind: 'idle', note: '', since: now }
        save(true)
        return
      }
      if (event.selfTask) {
        const id = event.behaviorId || activeBehavior
        const spec = behaviorSpec(id)
        // 精力那本账撤掉了：累不累由她自己看事实判断，这里只记她真的歇过没有
        if (id === 'rest' || (spec && spec.kind === 'rest')) noteRest(state, now)
        // 注意：当日额度在排任务时就记过一次了（doBehavior），这里只补结果，
        // 再调一次 noteBehavior 会让一天的次数翻倍
        state.lastBehavior = { id, at: now, ok: true, note: spec ? spec.label : '' }
        appendProgress(`做完了：${spec ? spec.label : '自己的事'}`, now)
        // 她自己做成了一件事，也算情绪来源；tag 决定分量（写东西 / 逛 / 帮主人）
        applyAppraisal({
          kind: 'self-done',
          at: now,
          tag: id || 'self-task',
          note: spec ? spec.label : '自己的事',
        })
        state.activity = { kind: 'rest', note: '刚忙完', since: now }
        activeBehavior = ''
        save(true)
        return
      }
      // 干得久说明在做事，不是闲聊
      state.activity = event.durationMs > WORK_TURN_MS
        ? { kind: 'work', note: '在干活', since: now }
        : { kind: 'idle', note: '', since: now }
      save()
      return
    }
  }

  const buildStats = (now) => {
    const { spokeToday } = speakStats(now)
    const staleTurn = inTurn && turnStartedAt > 0 && now - turnStartedAt > STALE_TURN_MS
    return {
      lastUserAt: state.lastUserAt,
      lastSpokeAt: state.lastSpeakAt,
      spokeToday,
      answeredLast: !state.pendingIntent,
      inTurn: inTurn && !staleTurn,
      secondsSinceTick: Math.max(0, Math.round((now - lastTickAt) / 1000)),
    }
  }

  const doSpeak = async (intent, reason, { force = false } = {}) => {
    const channel = cfg.talkChannel === 'session' ? 'session' : 'qq'
    const sessionId = channel === 'qq' ? resolveWorkSession() : resolveSession()
    if (!sessionId) return { ok: false, error: '还没选会话' }
    // 她自己想好要说的话就照说，不再让主会话替她组织措辞
    const said = String((intent && intent.text) || '').trim()
    // 真人不会把半小时前那句话原样再端上来。说过的不许重复，
    // 也不许换个说法重讲——这一层放在宿主，因为模型自己看不见全部历史。
    // 主人刚在说话，或者主会话刚答完：这一句轮不到她，再补一条就是刷屏。
    // 界面上手点「现在就说」是主人自己叫的，走 force 绕开这条。
    // 这两条只在她跟主会话抢同一个嘴（说到会话里）时才算数。
    // 她走手机 QQ 是另一条出口，主人在网页里跟我聊一晚上不该把她一整天捂死。
    const urgent = intent && Number(intent.urgency) >= 0.85
    const sameMouth = channel === 'session'
    const justTalked = sameMouth && Date.now() - (Number(state.lastUserAt) || 0) < RECENT_USER_MS
    const mainJustSaid = sameMouth && recentFrom('main', MAIN_QUIET_MS).length > 0
    if (!force && !urgent && (justTalked || mainJustSaid)) {
      diag(mainJustSaid ? '主会话刚答过，这句先不插嘴' : '主人刚在说话，这句先不插嘴')
      return { ok: false, error: mainJustSaid ? '主会话刚答过' : '主人刚在说话' }
    }
    if (said) {
      const hit = findRepeat(said, state.spoken, { now: Date.now() })
      if (hit.repeat) {
        diag(`这句话说过差不多的，先不重复：「${said.slice(0, 30)}」`)
        return { ok: false, error: '这话刚说过', repeat: true, match: hit.match }
      }
    }
    // 已经写好原话又是走 QQ：不必再排一次任务，直接送出去。
    // 没有原话（规则门那种「该说话了但没写词」）还是交给她的会话来组织，
    // prompt 里明说要落到 QQ，别在主会话里开腔。
    if (channel === 'qq' && said) {
      const sent = await sendQQ(said)
      if (!sent.ok) {
        diag(`QQ 没发出去：${sent.error}`)
        appendProgress(`想说话没发出去（${sent.error}）`, Date.now())
        return sent
      }
      const now = Date.now()
      state.lastSpeakAt = now
      state.spokeAt = [...state.spokeAt, now].slice(-60)
      state.pendingIntent = { ...intent, channel: 'qq', reason, createdAt: now }
      appendOut({ from: 'fish', channel: 'qq', text: said, at: now })
      noteSpoken(state, said, now)
      noteBehavior(state, 'talk', now)
      state.nextWakeAt = Math.max(state.nextWakeAt || 0, now + MIN_WAKE_AFTER_ACTION_MS)
      if (intent && intent.kind === 'agenda' && intent.id) {
        state.agenda = (state.agenda || []).map(item =>
          item.id === intent.id ? { ...item, spokenAt: now } : item)
        agendaSweep(state, now)
      }
      state.timeline = pushTimeline(state, {
        at: now, kind: 'proactive-sent', reason: `发给主人了：${reason}`, delta: 0,
      }).timeline
      appendProgress(`跟主人说了：${said}`, now)
      save(true)
      return { ok: true, channel: 'qq' }
    }
    const prompt = said
      ? `${SENTINEL}\n你现在想对${cfg.ownerName}说这句（是你自己刚想好的，照它的意思说出去，可以顺一点，别加解释、别复述这段说明）：\n「${said.slice(0, 400)}」`
      : jobPrompt(intent, state, cfg)
    const title = `她说：${String(intent && intent.seed ? intent.seed : '想跟主人说句话').slice(0, 18)}`
    // 走 QQ 时她自己这一轮的话不许落在会话里，得落到手机上
    const finalPrompt = channel === 'qq'
      ? `${prompt}\n\n写完之后用 bash 发出去：python3 ~/.dsh/notify-qq.py "你要对主人说的话"。不要在这轮回复里直接开口，主人看不到。`
      : prompt
    const styled = `${finalPrompt}\n\n${styleTail()}`
    const result = await spawnProactiveJob({ origin: origin(), prompt: styled, title, sessionId, modelSelection: jobModel() })
    if (result.ok) {
      const now = Date.now()
      state.lastSpeakAt = now
      state.spokeAt = [...state.spokeAt, now].slice(-60)
      state.pendingIntent = { ...intent, jobId: result.jobId, reason, createdAt: now, channel }
      if (said) noteSpoken(state, said, now)
      noteBehavior(state, 'talk', now)
      state.nextWakeAt = Math.max(state.nextWakeAt || 0, now + MIN_WAKE_AFTER_ACTION_MS)
      // 议程里的那条说出去之后就划掉
      if (intent && intent.kind === 'agenda' && intent.id) {
        state.agenda = (state.agenda || []).map(item =>
          item.id === intent.id ? { ...item, spokenAt: now } : item)
        agendaSweep(state, now)
      }
      state.timeline = pushTimeline(state, {
        at: now, kind: 'proactive-scheduled', reason: `排了一条主动消息：${reason}`, delta: 0,
      }).timeline
      save(true)
    }
    return result
  }

  /**
   * 排一条行为任务。
   * 说话有七道门，别的事各有自己的准入（都在 core/behaviors.js 的 gate 里）。
   * 出口只有一个：一条一次性定时任务，这样主人在面板里看得见也能取消。
   */
  /**
   * 有没有还没收尾的她自己的任务（避免每醒来一次就叠一条）。
   * 只看没过期的：重启后残留的 running 会一直挂着，不能让它永久堵住。
   */
  const busyJob = async (spec) => {
    const jobs = await listRecentJobs(origin(), 20)
    const ttl = (spec.timeoutMinutes || 10) * 60_000 + 5 * 60_000
    const now = Date.now()
    const stale = jobs.find(job =>
      job.status !== 'archived' && job.status !== 'failed' &&
      typeof job.createdAt === 'number' && now - job.createdAt < ttl)
    return stale ? `${stale.title || '一个任务'}（${stale.status}）` : ''
  }

  const doBehavior = async (id, reason) => {
    const sessionId = resolveWorkSession()
    if (!sessionId) return { ok: false, error: '还没选会话' }
    const spec = behaviorSpec(id)
    if (!spec) return { ok: false, error: `不认识的行为 ${id}` }
    // 主人关掉的就是关掉了：她那一步可能还想做，宿主这里必须拦
    if (!spec.enabled) return { ok: false, error: '这个行为主人关掉了' }
    const ctxForPrompt = behaviorCtx()
    // 上一条还没跑完就别再排一条：连着排会造成任务堆积、同时开工
    const busy = await busyJob(spec)
    if (busy) return { ok: false, error: `上一条还在跑（${busy}）` }
    const result = await spawnProactiveJob({
      origin: origin(),
      prompt: `${behaviorPrompt(id, state, ctxForPrompt, cfg)}\n\n${styleTail()}`,
      title: spec.title ? spec.title(state, ctxForPrompt) : spec.label,
      sessionId,
      timeoutMinutes: spec.timeoutMinutes || 10,
      modelSelection: jobModel(),
    })
    if (result.ok) {
      const now = Date.now()
      noteBehavior(state, id, now)
      // 问过的记进账本，免得同一个窗口里再问一遍
      if (id === 'checkin') {
        const plan = checkinPlan(state, now)
        if (plan) {
          const day = planDay(now)
          const same = state.checkin?.day === day ? state.checkin : null
          state.checkin = {
            day,
            meals: plan.kind === 'meal' ? [...(same?.meals ?? []), plan.slot] : (same?.meals ?? []),
            dayDone: plan.kind === 'day' ? true : same?.dayDone === true,
            askedAt: now,
            askKind: plan.kind,
            answerAt: 0,
            answer: '',
          }
        }
      }
      if (id === 'diary') state.diary = { day: planDay(now), lastAt: now }
      state.activity = {
        kind: spec.kind === 'self' ? 'rest' : 'work',
        note: spec.label,
        space: spaceOfBehavior(id),
        since: now,
      }
      state.nextWakeAt = Math.max(state.nextWakeAt || 0, now + MIN_WAKE_AFTER_ACTION_MS)
      state.timeline = pushTimeline(state, {
        at: now, kind: 'behavior-scheduled', reason: reason || `她自己去${spec.label}了`, delta: 0,
      }).timeline
      appendProgress(`去${spec.label}了（${reason || '自己想做的'}）`, now)
      save(true)
    }
    return result
  }

  /**
   * 用一次主人给的门路（权限）。跟五个行为不一样：这是她伸手去动外面的东西，
   * 所以要有明确的 grant + verb，prompt 里把边界和隐私要求写死。
   * @param {string} use
   * @param {string} verb
   * @param {string} reason
   * @returns {Promise<{ok:boolean,jobId?:string,error?:string}>}
   */
  const doGrant = async (use, verb, reason) => {
    const sessionId = resolveWorkSession()
    if (!sessionId) return { ok: false, error: '还没选会话' }
    // 她写决定时常常写中文名（「跑命令」「跑一下」），不一定记得住 id。
    // 先在 id 上找，找不到再按中文名兜一层，免得她自己想用的东西排不出去。
    const key = String(use || '').trim().toLowerCase()
    const word = String(verb || '').trim()
    const grant = (state.grants || []).find(item => item.id === use)
      || (state.grants || []).find(item => String(item.label || '').toLowerCase() === key)
      || (state.grants || []).find(item => key.includes(String(item.label || '').toLowerCase()))
    const entry = grant && ((grant.verbs || []).find(item => item.verb === verb)
      || (grant.verbs || []).find(item => String(item.label || '') === word)
      || (grant.verbs || []).find(item => word && (word.includes(String(item.label || '')) || String(item.label || '').includes(word))))
    if (!grant || !entry) return { ok: false, error: `不认识这条门路 ${use}/${verb}` }
    if (grant.id !== use || entry.verb !== verb) diag(`门路按中文名对上了：${use}/${verb} → ${grant.id}/${entry.verb}`)
    if (!entry.granted) return { ok: false, error: `${grant.label}的${entry.label}还没给她` }
    const result = await spawnProactiveJob({
      origin: origin(),
      prompt: `${grantPrompt(grant, entry, state, cfg)}\n\n${styleTail()}`,
      title: `${grant.label}·${entry.label}`,
      sessionId,
      timeoutMinutes: 10,
      modelSelection: jobModel(),
    })
    if (result.ok) {
      const now = Date.now()
      state.activity = { kind: 'work', note: `${grant.label}·${entry.label}`, since: now }
      state.nextWakeAt = Math.max(state.nextWakeAt || 0, now + MIN_WAKE_AFTER_ACTION_MS)
      state.timeline = pushTimeline(state, {
        at: now,
        kind: 'grant-used',
        reason: reason || `她自己去用${grant.label}的${entry.label}`,
        use: grant.id,
        verb: entry.verb,
        delta: 0,
      }).timeline
      appendProgress(`用了${grant.label}的${entry.label}（${reason || '自己想用的'}）`, now)
      save(true)
    }
    return result
  }

  /**
   * 她自己拿主意的一次：把现状卡片递进去，等她的决定，然后照做。
   *
   * 这里只做三件事：递卡片、解析、执行。**不判断「该不该说」**——
   * 该不该由她想。留下来的是几条防御硬线：正在回复时不插话、
   * 连续性被忽略时强制安静（防 bug 刷 token）、model 挂了退回旧规则。
   */
  const heartStep = async () => {
    const now = Date.now()
    // 主人关掉了，或者说了「安静一会儿」：关掉是连想都不用想；
    // quiet 是还能自己想、自己做事，只是不开口打扰。
    if (!cfg.enabled || cfg.mode === 'off') {
      state.nextWakeAt = now + 30 * 60_000
      return
    }
    if (!cfg.targetSession && process.env.DSH_SESSION_ID) cfg.targetSession = process.env.DSH_SESSION_ID
    const list = ctx.agents.list() || []
    const target = resolveSession()
    const agent = list.find(item => sessionIdOf(item.session) === target) || list[0] || null
    const model = resolveModel(ctx, agent, cfg)

    const card = buildCard(state, {
      now,
      mainGapMinutes: state.lastUserAt ? Math.round((now - state.lastUserAt) / 60_000) : null,
      lastUserText: state.lastUserText || '',
      recentTimeline: state.timeline.slice(-5),
      thoughts: state.thoughts,
      plans: state.plans,
      // 大厅那边刚说过什么：两边看同一本账，才不会各说各的
      recentOut: recentAll(4),
      // 累不累不靠一个数字：把「忙了多久、做了几件、上次歇是什么时候」摊给她自己看
      facts: factsOf(state, now),
    }, cfg)

    const raw = await askHeart({
      llm: ctx.llm,
      cfg,
      card,
      model,
      sessionId: (agent && agent.session && agent.session.id) || target || '',
      // 她自己写的话也要守「称主人、自称人家」的规矩：光有人设前几行不够，
      // 手机消息那套写法跟人设一起挂进来。
      extra: [outboundStyle(cfg), personaTail(currentPersona())].filter(Boolean).join('\n\n'),
    })
    const decision = raw ? parseDecision(raw) : null
    const stamp = (extra) => {
      state.lastHeart = { at: now, ...extra }
    }

    if (!decision) {
      // 她不说话、模型挂了、输出不像 JSON：都算「这一会儿没主意」，安静等下回。
      const err = heartError()
      stamp({ do: 'nothing', reason: '这次没想好（没有返回）' })
      if (/Sign in|account/i.test(err)) {
        // 顺手探一下账号服务到底有没有登录态：写进 diag，下次不用靠猜
        try {
          const acct = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
          const token = acct && typeof acct.resolveToken === 'function'
            ? await acct.resolveToken('https://api.deepseek.com/anthropic')
            : 'no-service'
          diag(`账号服务探测：${token ? `token 有（${String(token).slice(0, 6)}…）` : 'token 为空'}`)
        } catch (probeError) {
          diag(`账号服务探测炸了：${probeError && probeError.message}`)
        }
        // 刚开机那几十秒账号服务还没把登录态准备好，别等到二十分钟后才重试
        state.nextWakeAt = now + 2 * 60_000
        diag('账号那边还没热，两分钟后再问一次')
      } else {
        state.nextWakeAt = nextWakeAt(null, now, cfg)
      }
      diag('心这一步没拿到决定，先安静一会儿')
      return
    }

    const reason = String(decision.reason || '').slice(0, 160)
    if (decision.note) {
      state.thoughts = [...state.thoughts, { at: now, text: String(decision.note).slice(0, 200) }].slice(-50)
    }
    // 她自己立的计划：同时记进 plans 和挂着的活。只记进 plans 的话，卡片上看得见、
    // 挑事做的时候看不见，等于摆设。同一句话不重复挂。
    if (decision.plan) {
      const planText = String(decision.plan).slice(0, 120)
      const already = (state.openWork || []).some(it => it && !it.doneAt && String(it.text) === planText)
      state.plans = [...(state.plans || []), { at: now, text: planText }].slice(-20)
      if (!already) openWorkAdd(state, { text: planText, urgency: 0.45, createdAt: now }, now)
    }

    const quietNow = cfg.mode === 'quiet'
    if (decision.do === 'ask' && decision.use && decision.verb) {
      // 求权限也是开口：安静的时候不求，等主人说话了再说
      if (quietNow) {
        stamp({ do: 'nothing', reason: '主人说了安静一会儿，这话先不说' })
      } else {
        const grant = (state.grants || []).find(item => item.id === decision.use)
        const entry = grant && (grant.verbs || []).find(item => item.verb === decision.verb)
        const label = entry ? `${grant.label}的${entry.label}` : `${decision.use}/${decision.verb}`
        const text = String(decision.text || '').trim() || `${cfg.ownerName}，人家想问问，${label}的权限能给人家吗？`
        const item = askPush(state, {
          use: decision.use,
          verb: decision.verb,
          label: entry ? entry.label : decision.verb,
          why: reason,
          text,
        }, now, cfg)
        if (!item) {
          stamp({ do: 'nothing', reason: '想求的那件事，之前问过了' })
        } else {
          const result = await doSpeak({ kind: 'share', seed: text, text, source: 'ask' }, reason || `她想求${label}`)
          if (!result.ok) {
            diag(`她求权限的话没排上：${result.error}`)
            // 话没发出去，就别把请求挂着，不然主人永远不知道
            askResolve(state, item.id, false, Date.now())
          }
          stamp({ do: result.ok ? 'ask' : 'failed', use: decision.use, verb: decision.verb, reason, text: text.slice(0, 120) })
        }
      }
    } else if (decision.do === 'use' && decision.use && decision.verb) {
      const result = await doGrant(decision.use, decision.verb, reason || '她自己想用一下')
      if (!result.ok) diag(`她用门路没排上（${decision.use}/${decision.verb}）：${result.error}`)
      stamp({ do: result.ok ? 'use' : 'failed', use: decision.use, verb: decision.verb, reason })
    } else if (decision.do === 'speak' && quietNow) {
      // 主人说了安静一会儿：这句话先憋着，不排任务
      stamp({ do: 'nothing', reason: '主人说了安静一会儿，先不开口' })
    } else if (decision.do === 'speak' && decision.text) {
      const intent = { kind: decision.kind || 'share', seed: decision.text, text: decision.text, source: 'heart' }
      const result = await doSpeak(intent, reason || '她自己想说的')
      if (result.repeat) {
        // 说过的话不重复：这次就当没想出新东西，安静待着
        stamp({ do: 'nothing', reason: '这话刚说过，换不了新的就先不说' })
      } else {
        if (!result.ok) diag(`她的话没排上：${result.error}`)
        stamp({ do: result.ok ? 'speak' : 'failed', reason, text: decision.text.slice(0, 120) })
      }
    } else if (decision.do === 'act' && decision.act) {
      const result = await doBehavior(decision.act, reason || '她自己想做的')
      if (!result.ok) diag(`她的事没排上（${decision.act}）：${result.error}`)
      stamp({ do: result.ok ? 'act' : 'failed', act: decision.act, reason })
    } else {
      stamp({ do: 'nothing', reason: reason || '这一会儿不想动' })
    }

    const taken = state.lastHeart
    if (taken && (taken.do === 'act' || taken.do === 'use' || taken.do === 'ask' || taken.do === 'failed')) {
      // 说话已经在 doSpeak 里记过，这里只补「她做了别的事」
      appendProgress(
        `${taken.do === 'act' ? '自己做事' : taken.do === 'use' ? '用了门路' : taken.do === 'ask' ? '向主人开口求权限' : '这次没做成'}：`
        + `${taken.text || taken.act || taken.reason || ''}`,
        now,
      )
    }
    state.nextWakeAt = nextWakeAt(decision, now, cfg)
    touch()
  }

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const now = Date.now()
      lastTickAt = now
      // 衰减和昼夜漂移会改数值，但**不算「心情变了」**：updatedAt 留着给
      // 「一次变化只注入一次」做比较，这里改回去，不然每一轮都算有新变化，
      // 心情快照会变成每轮都挂的背景音。
      const lastMeaningfulAt = state.updatedAt
      state = { ...drift(decay(state, now, DECAY_HALF_HOURS), now), updatedAt: lastMeaningfulAt }
      touch()

      // 议程过期清理
      if (cfg.agenda && cfg.agenda.enabled) agendaSweep(state, now)

      // 活动状态：一直没人说话就退回 idle，夜里更久就当他睡了
      const quietFor = now - (state.lastUserAt || 0)
      if (!inTurn && state.activity && state.activity.kind !== 'work') {
        const wasBusy = state.activity.kind === 'work'
        if (isLateNight(now) && quietFor > SLEEP_AFTER_MS) state.activity = { kind: 'sleep', note: '', since: now }
        else if (quietFor > IDLE_AFTER_MS) state.activity = { kind: 'idle', note: '', since: now }
        // 手停了就算歇过：lastRestAt 用来在卡片上写「上次自己歇着是几小时前」
        if (wasBusy && state.activity.kind !== 'work') noteRest(state, now)
      }

      // 挂载目标会话（会话可能后开、也可能被换掉）
      const list = ctx.agents.list() || []
      // 没选过目标会话时，先认第一个活着的当默认：重启后主人接着打字的通常就是它。
      // 认下来立刻写进配置，界面里看得见、也改得动，不会变成暗箱。
      if (!cfg.targetSession && list.length > 0) {
        const guessed = sessionIdOf(list[0].session)
        if (guessed) {
          cfg.targetSession = guessed
          patchConfig({ targetSession: guessed })
          diag(`没配目标会话，先认了活着的 ${guessed}`)
        }
      }
      const target = resolveSession()
      // recent 策略要挂所有活着的会话：不挂就听不到别的窗口里主人说了话，
      // 「最近说话的那个」永远只能是当初选定的那个。pinned 只挂目标，省得乱。
      const wanted = new Set()
      // 她自己的会话也要挂：行为在那边跑，回来得有人把「做完了」记下来，
      // 不然精力不扣、挂着的活也划不掉。
      const work = resolveWorkSession()
      if (work) wanted.add(work)
      for (const agent of list) {
        const sid = sessionIdOf(agent.session)
        if (!sid) continue
        if (cfg.sessionMode !== 'recent' && sid !== target && sid !== work) continue
        wanted.add(sid)
        if (mounted.has(sid)) continue
        try {
          mounted.set(sid, mountFor(agent, sid))
          diag(`已挂到会话 ${sid}`)
        } catch (error) {
          diag(`挂 ${sid} 失败：${error && error.message}`)
        }
      }
      for (const [sid, entry] of mounted) {
        const alive = list.some(agent => sessionIdOf(agent.session) === sid)
        if (alive && wanted.has(sid)) continue
        try {
          entry.dispose()
        } catch {
          /* 卸载失败不影响下一次重挂 */
        }
        mounted.delete(sid)
      }

      // 求权限的请求 24 小时没人答就作废，别一直挂在她心上
      if ((state.pendingAsks || []).length > 0) {
        const before = state.pendingAsks.length
        askExpire(state, now)
        if (state.pendingAsks.length !== before) {
          diag('一条求权限的请求过期了')
          touch()
        }
      }

      // 排出去的心跳超时会没人理 → 记一笔「被忽略」，给冷却加倍
      if (state.pendingIntent && now - (state.pendingIntent.createdAt || 0) > IGNORE_AFTER_MINUTES * 60_000) {
        applyAppraisal({ kind: 'proactive-ignored', at: now, tag: 'speak' })
        state.pendingIntent = null
        touch()
      }

      // 主人很久没来：想念是加法。每满 6 小时落一次，用桶去重（主人一说话就归零）
      const absentHours = state.lastUserAt ? (now - state.lastUserAt) / 3600_000 : 0
      const absentBucket = absentHours >= 6 ? Math.floor(absentHours / 6) : 0
      if (absentBucket > (state.lastAbsenceBucket || 0)) {
        state.lastAbsenceBucket = absentBucket
        applyAppraisal({ kind: 'long-absence', at: now, hours: Math.round(absentHours) })
        touch()
      }

      const stats = buildStats(now)
      lastImpulse = impulseOf(state, cfg)

      // 只有一条路：到点把她叫起来，让她自己看一眼现状再决定。
      // 以前那条「按规则算该不该开口」的分支已经删了——那是程序替她拿主意。
      if (!stats.inTurn && !state.pendingIntent && now >= (state.nextWakeAt || 0)) {
        await heartStep()
      }
      save()
      saveSessionBook()
    } catch (error) {
      diag(`tick 异常：${error && error.message}`)
    } finally {
      busy = false
    }
  }

  /** 行为菜单的元信息：目录里的 spec，叠上配置里的单项覆盖。 */
  const behaviorSpec = (id) => {
    const spec = BEHAVIORS.find(item => item.id === id)
    if (!spec) return null
    const override = (cfg.behaviors && cfg.behaviors[id]) || {}
    return {
      ...spec,
      enabled: override.enabled === undefined ? true : Boolean(override.enabled),
      dailyCap: Number(override.dailyCap) || spec.dailyCap,
      cooldownMinutes: Number(override.cooldownMinutes) || spec.cooldownMinutes,
    }
  }

  /** 选择器要看的上下文：挂着的活、议程条数、现在在干嘛。 */
  const behaviorCtx = (now = Date.now()) => ({
    openWork: openWorkList(state, now),
    agendaCount: (state.agenda || []).filter(item => !item.spokenAt).length,
    activity: state.activity,
  })

  /**
   * 挑一件自己的事做。
   * 这里不跟「说话」争：说话由她自己拿主意，挑进来的只会是剩下四种。
   * 挑到哪种由 core/behaviors.js 决定，宿主只负责排任务。
   */
  /** 给一个 agent 挂监听 + 心情上下文。 */
  const mountFor = (agent, sid) => {
    const disposers = []
    const title = sessionTitleOf(agent.session)
    disposers.push(mountAgent({
      agent,
      onEvent: event => onAgentEvent({ ...event, session: sid, sessionTitle: title }),
    }))
    // 出站台账：她那一侧要能看见「主会话刚刚答过什么」，才不会跟着补一句。
    try {
      sideOfSession.set(sid, sid === resolveWorkSession() ? 'fish' : 'main')
      disposers.push(agent.ctx.on('session/event', (_session, event) => {
        try {
          if (!event || event.type !== 'assistant/message') return
          const text = assistantTextOf(event)
          if (!text) return
          appendOut({
            from: sideOfSession.get(sid) || 'main',
            channel: 'session',
            text,
            at: Date.now(),
            sessionId: sid,
          })
        } catch (error) {
          diag(`记出站台账失败：${error && error.message}`)
        }
      }))
    } catch (error) {
      diag(`订阅主会话出站失败：${error && error.message}`)
    }
    // injectMood 是总闸（旧字段），injectMode 只决定频率：总闸关了，一句都不挂
    const mode = cfg.injectMood === false ? 'off' : (cfg.injectMode || 'on-change')
    if (mode !== 'off') {
      try {
        disposers.push(agent.ctx.systemPrompt.context({
          name: 'feiyu-life',
          order: 899,
          text: () => {
            if (mode === 'every-turn') {
              // 每轮都挂一句体感：她说话的样子该跟着心情走，不只是主动开口时
              return moodSnapshot(state, cfg, Date.now())
            }
            // on-change：一次变化只挂一次，每轮重复同一句会变成背景音，把人定死
            if (!state.updatedAt || state.updatedAt <= (state.lastInjectedAt || 0)) return ''
            const text = moodSnapshot(state, cfg, Date.now())
            if (!text) return ''
            state.lastInjectedAt = state.updatedAt
            touch()
            return text
          },
        }))
      } catch (error) {
        diag(`注入心情上下文失败：${error && error.message}`)
      }
    }
    // 主会话里那份「她这会儿」摘要：主人问进度、问心情、问在干嘛时能直接答上来。
    // 每 15 分钟最多挂一次，内容没变就不挂——这份东西是给她当背景的，不是播报。
    if (cfg.progressReport !== false && sid === resolveSession()) {
      try {
        disposers.push(agent.ctx.systemPrompt.context({
          name: 'feiyu-life-progress',
          order: 898,
          text: () => {
            const now = Date.now()
            if (now - lastProgressAt < 15 * 60_000) return ''
            const text = progressSnapshot(state, cfg, now)
            if (!text || text === lastProgressText) return ''
            lastProgressAt = now
            lastProgressText = text
            return text
          },
        }))
      } catch (error) {
        diag(`注入进度摘要失败：${error && error.message}`)
      }
    }
    // 反过来那一半：主会话也得知道她刚在外面说过什么，不然两边会撞车。
    if (sid === resolveSession()) {
      try {
        disposers.push(agent.ctx.systemPrompt.context({
          name: 'feiyu-life-outbox',
          order: 897,
          text: () => {
            const mine = recentFrom('fish', 15 * 60_000)
            if (mine.length === 0) return ''
            const lines = mine.slice(0, 2).map(it => `- ${new Date(it.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}（${it.channel === 'qq' ? '手机' : '会话'}）${it.text.slice(0, 80)}`)
            return ['（小鱼刚在她那边对主人说过：', ...lines, '这些已经到主人眼前了，不用再答一遍；要接就接她没说的那部分。）'].join('\n')
          },
        }))
      } catch (error) {
        diag(`注入出站摘要失败：${error && error.message}`)
      }
    }

    return {
      sid,
      dispose: () => {
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* ignore */
          }
        }
      },
    }
  }

  /** 把门的理由归成界面能直接用的短码。改文案不动这里，前端就不会崩。 */
  const codeOfGate = (reason) => {
    const text = String(reason || '')
    if (/精力/.test(text)) return 'tired'
    if (/没(有)?(做完|完成)?的活|手上没|没有活/.test(text)) return 'nowork'
    if (/安静|沉默|刚说过|才.*分钟/.test(text)) return 'quiet'
    if (/睡|夜里|静默|时段/.test(text)) return 'night'
    if (/关/.test(text)) return 'off'
    return 'wait'
  }

  /**
   * 给界面看的每个行为的此刻状态。
   * 分数只是展示用的估计，真正的取舍在她自己的心那一步；
   * 这里做错最多显示得不好看，不会让她乱做事。
   */
  /**
   * 行为菜单的现状：只报事实。
   *
   * 以前这里会算「还差几分钟」「今天额度用完没」，现在没有额度也没有冷却了——
   * 她要不要做、什么时候做，是她自己看一眼卡片决定的，界面再念规则就是骗人。
   */
  const describeBehaviors = (now, stats) => {
    const ctx = behaviorCtx(now)
    const today = startOfDay(now)
    return BEHAVIORS.map((raw) => {
      const spec = behaviorSpec(raw.id)
      const box = (state.behaves && state.behaves[spec.id]) || {}
      // box.day 是 state.js 里 dayKey() 写的「2026-10-31」这种本地日期串，
      // 这里早年拿 startOfDay() 的时间戳去比，永远不相等，界面就永远是「还没做过」。
      const used = box.day === dayText(now) ? Number(box.dayCount) || 0 : 0
      const lastAt = Number(box.lastAt) || 0
      let appetite = 0
      try {
        appetite = typeof spec.appetite === 'function'
          ? Math.max(0, Math.min(1, Number(spec.appetite(state, ctx)) || 0))
          : 0
      } catch {
        appetite = 0
      }
      return {
        id: spec.id,
        label: spec.label,
        kind: spec.kind,
        cost: spec.cost,
        appetite: Math.round(appetite * 100) / 100,
        score: Math.round(appetite * (0.55 + 0.45 * (state.spirit ?? 55) / 100) * 100) / 100,
        enabled: spec.enabled,
        available: spec.enabled,
        reason: spec.enabled ? '' : '这个行为关掉了',
        code: spec.enabled ? '' : 'off',
        used,
        lastAt,
      }
    })
  }

  const controller = {
    config: () => loadConfig(),
    async snapshot() {
      const now = Date.now()
      const impulse = impulseOf(state, cfg)
      const stats = buildStats(now)
      const lastHeart = state.lastHeart || null
      return {
        ok: true,
        state: {
          mood: state.mood,
          spirit: state.spirit ?? 55,
          facts: factsOf(state, now),
          updatedAt: state.updatedAt,
          lastUserAt: state.lastUserAt,
          lastSpeakAt: state.lastSpeakAt,
          activity: state.activity,
          // 两个人在哪个屋子：界面直接显示，不用前端再推一遍
          place: {
            her: PLACES[herPlaceOf(state, now)] || '',
            owner: PLACES[ownerPlaceOf(state)] || '',
          },
          agenda: (state.agenda || []).filter(item => !item.spokenAt),
          lastReply: state.lastReply || null,
          timeline: state.timeline.slice(-40),
          pendingIntent: state.pendingIntent,
          grants: state.grants || [],
          pendingAsks: state.pendingAsks || [],
        },
        // 老字段留着但不再有意义：判断权在她自己手上，快照里给个 null 免得界面读到脏值
        gate: null,
        impulse,
        next: '',
        config: cfg,
        sessions: this.sessions(),
        targetSession: resolveSession(),
        workSession: resolveWorkSession(),
        talkChannel: cfg.talkChannel === 'session' ? 'session' : 'qq',
        progress: recentProgress(6),
        behaviors: describeBehaviors(now, stats),
        openWork: openWorkList(state, now),
        lastBehavior: state.lastBehavior || null,
        heart: {
          decider: cfg.decider || 'auto',
          nextWakeAt: state.nextWakeAt || 0,
          lastHeart: state.lastHeart || null,
          thoughts: (state.thoughts || []).slice(-8),
        },
      }
    },
    sessions() {
      const list = ctx.agents.list() || []
      const live = list.map(agent => ({
        id: sessionIdOf(agent.session),
        title: sessionTitleOf(agent.session),
      })).filter(item => item.id)
      // recent 策略下目标可能是个已经关掉的会话，也要能在下拉里看见
      for (const item of sessions) {
        if (!live.some(entry => entry.id === item.id)) live.push({ id: item.id, title: item.title || '' })
      }
      return live
    },
    async updateConfig(patch) {
      const next = patchConfig(patch || {})
      Object.assign(cfg, next)
      if (patch && patch.targetSession !== undefined) {
        for (const [sid, entry] of mounted) {
          if (sid === cfg.targetSession) continue
          try {
            entry.dispose()
          } catch {
            /* ignore */
          }
          mounted.delete(sid)
        }
      }
      diag(`配置已更新：${JSON.stringify(patch)}`)
      return cfg
    },
    async action(action, payload = {}) {
      const now = Date.now()
      if (action === 'wake-now') {
        state.nextWakeAt = Date.now()
        touch()
        save(true)
        return { ok: true }
      }
      if (action === 'grant-add') {
        const spec = {
          id: String(payload.id || '').trim().toLowerCase(),
          label: String(payload.label || '').trim(),
          from: String(payload.from || `${cfg.ownerName}在界面上给的`).slice(0, 80),
          account: String(payload.account || '').slice(0, 80),
          private: payload.private !== false,
          limits: Array.isArray(payload.limits) ? payload.limits.map(String).slice(0, 8) : [],
          verbs: Array.isArray(payload.verbs) ? payload.verbs : [],
          grantedAt: now,
        }
        if (!spec.id || !spec.label) return { ok: false, error: 'id 和名称都要有' }
        if (spec.verbs.length === 0) {
          spec.verbs = [{ verb: 'look', label: '看看', how: '', needAsk: false, granted: true }]
        }
        grantAddTaken(state, spec, now)
        save(true)
        return { ok: true, grants: state.grants }
      }
      if (action === 'grant-set') {
        const ok = grantSetVerb(state, String(payload.use || ''), String(payload.verb || ''), payload.on !== false, now)
        if (ok) save(true)
        return ok ? { ok: true, grants: state.grants } : { ok: false, error: '没找到这条门路' }
      }
      if (action === 'grant-approve' || action === 'grant-deny') {
        const id = String(payload.id || '')
        const pending = (state.pendingAsks || []).find(item => item.id === id)
        if (!pending) return { ok: false, error: '这条请求已经不在了' }
        askResolve(state, id, action === 'grant-approve', now)
        state.timeline = pushTimeline(state, {
          at: now,
          kind: action === 'grant-approve' ? 'grant-given' : 'grant-refused',
          reason: `主人${action === 'grant-approve' ? '给' : '没收'}了${pending.label || pending.verb}`,
          delta: 0,
        }).timeline
        save(true)
        return { ok: true, grants: state.grants, pendingAsks: state.pendingAsks }
      }
      if (action === 'speak-now') {
        const intent = impulseOf(state, cfg)
        const result = await doSpeak(
          {
            kind: intent.kind === 'none' ? 'idle-chat' : intent.kind,
            seed: intent.reason || '想说点话',
            mood: state.mood,
            urgency: 1,
            createdAt: now,
          },
          '主人在界面上点了「现在就说」',
        )
        return result.ok ? { ok: true, jobId: result.jobId } : { ok: false, error: result.error }
      }
      if (action === 'agenda-add') {
        const text = String(payload.text || '').trim()
        if (!text) return { ok: false, error: '要说的事不能是空的' }
        const dueAt = Number(payload.dueAt) || now + 60 * 60_000
        agendaAdd(state, {
          text: text.slice(0, 80),
          kind: ['remind', 'followup', 'report', 'care'].includes(payload.kind) ? payload.kind : 'remind',
          dueAt,
          window: payload.window && typeof payload.window === 'object' ? payload.window : null,
          urgency: Math.max(0, Math.min(1, Number(payload.urgency) || 0.6)),
        }, now)
        save(true)
        return { ok: true, agenda: state.agenda }
      }
      if (action === 'agenda-drop') {
        const id = String(payload.id || '')
        const before = (state.agenda || []).length
        state.agenda = (state.agenda || []).filter(item => item.id !== id)
        save(true)
        return { ok: state.agenda.length < before }
      }
      if (action === 'behave-now' || action === 'self-task-now') {
        // 带 id 就照指定的做（主人点的），不带就让她自己挑
        const wanted = String(payload.id || '').trim()
        if (wanted) {
          if (wanted === 'talk') {
            const intent = impulseOf(state, cfg)
            const result = await doSpeak({
              kind: intent.kind === 'none' ? 'idle-chat' : intent.kind,
              seed: intent.reason || '想说点话',
              mood: state.mood,
              urgency: 1,
              createdAt: now,
            }, '主人在界面上点了说话', { force: true })
            return result.ok ? { ok: true, jobId: result.jobId, id: 'talk' } : { ok: false, error: result.error }
          }
          const result = await doBehavior(wanted, '主人在界面上点的')
          return result.ok ? { ok: true, jobId: result.jobId, id: wanted } : { ok: false, error: result.error }
        }
        const stats = buildStats(now)
        // 没指定就挑现在劲儿最大的那个（只在她开着的里面挑）
        let picked = null
        try {
          const ctxNow = behaviorCtx(now)
          for (const raw of BEHAVIORS) {
            const spec = behaviorSpec(raw.id)
            if (!spec || !spec.enabled) continue
            const want = typeof spec.appetite === 'function' ? Number(spec.appetite(state, ctxNow)) || 0 : 0
            if (!picked || want > picked.want) picked = { id: spec.id, want, reason: spec.label }
          }
        } catch (error) {
          return { ok: false, error: `挑行为失败：${error && error.message}` }
        }
        if (!picked) return { ok: false, error: '这会儿她什么都不想做' }
        if (picked.id === 'talk') {
          const intent = impulseOf(state, cfg)
          const result = await doSpeak({
            kind: intent.kind === 'none' ? 'idle-chat' : intent.kind,
            seed: intent.reason || '想说点话',
            mood: state.mood,
            urgency: 1,
            createdAt: now,
          }, '主人在界面上点了「让她挑件事做」', { force: true })
          return result.ok ? { ok: true, jobId: result.jobId, id: 'talk' } : { ok: false, error: result.error }
        }
        const result = await doBehavior(picked.id, picked.reason)
        return result.ok ? { ok: true, jobId: result.jobId, id: picked.id } : { ok: false, error: result.error }
      }
      if (action === 'work-add') {
        const text = String(payload.text || '').trim()
        if (!text) return { ok: false, error: '要做的事不能是空的' }
        const item = openWorkAdd(state, {
          text: text.slice(0, 120),
          urgency: Math.max(0, Math.min(1, Number(payload.urgency) || 0.5)),
        }, now)
        save(true)
        return { ok: true, item, openWork: openWorkList(state, now) }
      }
      if (action === 'work-done') {
        const ok = openWorkDone(state, String(payload.id || ''), now)
        save(true)
        return { ok, openWork: openWorkList(state, now) }
      }
      if (action === 'work-drop') {
        const id = String(payload.id || '')
        const before = (state.openWork || []).length
        state.openWork = (state.openWork || []).filter(item => item.id !== id)
        save(true)
        return { ok: state.openWork.length < before, openWork: openWorkList(state, now) }
      }
      if (action === 'reset') {
        state = blankState(now)
        save(true)
        return { ok: true }
      }
      if (action === 'pause') {
        // 「安静一会儿」= 切 quiet：心情照记，只是不开口，比整个关掉更贴界面上的说法
        Object.assign(cfg, patchConfig({ mode: 'quiet' }))
        return { ok: true, config: cfg }
      }
      if (action === 'resume') {
        Object.assign(cfg, patchConfig({ mode: 'normal', enabled: true }))
        return { ok: true, config: cfg }
      }
      if (action === 'clear-timeline') {
        state = { ...state, timeline: [] }
        save(true)
        return { ok: true }
      }
      return { ok: false, error: `不认识的动作 ${action}` }
    },
    jobs: async () => listRecentJobs(origin(), 20),
  }

  registerRoutes({ ctx, packageRoot: PACKAGE_ROOT, controller })

  // 挂饰脚本注入（桌面端唯一通道）
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes('/dsh-feiyu-life/widget.js')) return
        if (row.kind === 'script-src' && row.src === '/dsh-feiyu-life/widget.js') return
      }
      table.push({ kind: 'script', placement: 'body', text: WIDGET_ROW_TEXT })
    })
  } catch (error) {
    diag(`挂饰注入失败：${error && error.message}`)
  }

  try {
    ctx.effect(() => ctx.interval(tick, TICK_MS))
  } catch (error) {
    diag(`定时器不可用：${error && error.message}`)
  }
  tick()

  ctx.effect(() => () => {
    for (const entry of mounted.values()) {
      try {
        entry.dispose()
      } catch {
        /* ignore */
      }
    }
    mounted.clear()
    save(true)
    saveSessionBook()
  })

  diag(`feiyu-life 已加载，目标会话 ${resolveSession() || '(未选)'}`)
}
