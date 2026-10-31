/**
 * 情绪状态模型：初始化、迁移、衰减、昼夜漂移、重复计数、时间线。
 *
 * v0.9 只留两根轴：心情（mood）和兴致（spirit）。
 * 七根情绪撤掉的理由：它们描述的都是「她怎么看主人」，不是她自己的处境；
 * 体力是编出来的第二套配额，宿主算得出「连轴转多久」，不该再存一个数。
 *
 * 两条一直守着的规矩：
 * 1. 两根轴的数值不做隐式修改。衰减、漂移这类会改数值的函数返回新对象，
 *    宿主可以放心拿旧快照做判断。为什么：同一轮里界面、gate、日志可能各拿一份 state，
 *    共享可变对象会让它们看到的不是同一个心情。
 * 2. 账本类数据（repeats、behaves、agenda）按契约就地更新。契约给 noteRepeat 的签名
 *    只回 count，不归还新 state；宿主因此拿不到更新后的副本，就地写是唯一能让计数累积的做法。
 */

/** 两根轴。顺序固定：界面、卡片、测试都按这个顺序读 */
export const AXES = ['mood', 'spirit']

/** 回归基线。心情有正基线（她本来就是个心情不错的鲸鱼），兴致中性 */
const MOOD_BASE = 70
const SPIRIT_BASE = 55

/** 时间线只留最近 200 条。再多界面也画不下，文件还会越滚越大 */
const TIMELINE_MAX = 200

/** 没做完的活最多存 20 条：再多她也记不住，选择器每次都全量扫一遍 */
export const OPEN_WORK_MAX = 20
/** 记多少句她说过的话（够防重就行，多了反而占卡片） */
export const SPOKEN_MAX = 12
/** 记多少句往来（两边的都记，卡片上拼摘要用） */
export const TALK_MAX = 24

/** 同类事重复计数的时间窗：超过 24h 就当是新的一轮，不然周末勤快两次能压一整天 */
export const REPEAT_WINDOW_MS = 24 * 3600 * 1000

/** 内部统一保留两位小数：浮点残留会让两次衰减的结果永远「不相等」，测试和快照都难受 */
const round2 = (v) => Math.round(v * 100) / 100

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 数值收敛。所有写入 state 的值都过一遍，坏数据（NaN/undefined）也在这里被换成兜底值 */
export function clamp(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return n < lo ? lo : n > hi ? hi : n
}

/** 用一个「时钟」建一份新状态。now 从外面传，core 里不碰 Date.now()，测试才能随意摆时间 */
export function blankState(now) {
  return {
    version: 3,
    mood: MOOD_BASE,
    spirit: SPIRIT_BASE,
    updatedAt: now,
    lastDecayAt: now,
    timeline: [],
    lastUserAt: 0,
    lastSpeakAt: 0,
    spokeAt: [],
    activity: { kind: 'idle', note: '', since: now },
    pendingIntent: null,
    spoken: [],
    agenda: [],
    repeats: {},
    lastReply: null,
    // v3 行为层
    behaves: {},
    openWork: [],
    lastBehavior: null,
    // v0.5 门路：主人给过的能力、她开口求的待答请求
    grants: [],
    pendingAsks: [],
    // 账本之外的补充字段：求权限当天去重、心脏层的心跳时刻、念头与计划
    lastAskAt: 0,
    nextWakeAt: 0,
    lastHeart: 0,
    lastInjectedAt: 0,
    lastUserText: '',
    thoughts: [],
    plans: [],
    // 最近的往来（两边的都记），卡片上拼成摘要
    recentTalk: [],
    // 想念累积分了几段（每 6 小时一段），主人一说话归零
    lastAbsenceBucket: 0,
    // v0.9：最近一次自己歇着。0 表示还没歇过，卡片上说「还没自己歇过」
    lastRestAt: now,
  }
}

/**
 * 把磁盘上读出来的旧状态补成 v3。
 *
 * 迁移只做减法：mood 照抄，spirit 由 happy/calm 折算（这两根最接近「兴致」的本意），
 * 七维和体力直接丢掉。为什么不留着兼容：留着就还会有人读，迟早又绕回旧模型。
 * 未知字段照样保留——宿主自己加的账本不该因为一次升级被清空。
 */
export function normalizeState(raw, now) {
  if (!raw || typeof raw !== 'object') return blankState(now)
  const base = blankState(now)
  // 显式解构掉要删的字段：...raw 会把它们一起带进来，光在返回里不写没用
  const { dims, energy, energyFlow, ...rest } = raw

  // 有旧 dims 才折算；完全没有就落回 55，别把「没有数据」当成「兴致为零」
  const legacySpirit = raw.dims && typeof raw.dims === 'object'
    ? Math.round((num(raw.dims.happy, 0) + num(raw.dims.calm, 0)) / 2)
    : null

  const agenda = Array.isArray(raw.agenda)
    ? raw.agenda
        .filter((it) => it && typeof it === 'object')
        .slice(-20)
        .map((it, i) => normalizeAgendaItem(it, now, i))
    : []

  return {
    ...base,
    ...rest,
    version: 3,
    mood: clamp(num(raw.mood, MOOD_BASE), 0, 100),
    spirit: clamp(raw.spirit ?? legacySpirit ?? SPIRIT_BASE, 0, 100),
    updatedAt: num(raw.updatedAt, now),
    lastDecayAt: num(raw.lastDecayAt, now),
    timeline: Array.isArray(raw.timeline) ? raw.timeline.slice(-TIMELINE_MAX) : [],
    lastUserAt: num(raw.lastUserAt, 0),
    lastSpeakAt: num(raw.lastSpeakAt, 0),
    spokeAt: Array.isArray(raw.spokeAt) ? raw.spokeAt.filter((t) => Number.isFinite(Number(t))) : [],
    activity: {
      // v1 的 activity 也是这个形状，但可能有 host 写成字符串，统一收口
      kind: typeof raw.activity === 'string' ? raw.activity : raw.activity?.kind ?? 'idle',
      note: typeof raw.activity === 'object' ? raw.activity?.note ?? '' : '',
      // 她在哪个屋子。空串表示不知道，由 place.js 按活动推
      space: typeof raw.activity === 'object' ? raw.activity?.space ?? '' : '',
      since: num(raw.activity?.since, now),
    },
    pendingIntent: raw.pendingIntent ?? null,
    spoken: Array.isArray(raw.spoken)
      ? raw.spoken
          .filter((it) => it && typeof it === 'object' && typeof it.text === 'string')
          .slice(-SPOKEN_MAX)
          .map((it) => ({ at: num(it.at, now), text: String(it.text).slice(0, 400) }))
      : [],
    agenda,
    repeats: raw.repeats && typeof raw.repeats === 'object' ? raw.repeats : {},
    lastReply: raw.lastReply ?? null,
    behaves: raw.behaves && typeof raw.behaves === 'object' ? raw.behaves : {},
    openWork: Array.isArray(raw.openWork)
      ? raw.openWork
          .filter((it) => it && typeof it === 'object')
          .slice(-OPEN_WORK_MAX)
          .map((it, i) => normalizeWorkItem(it, now, i))
      : [],
    lastBehavior: raw.lastBehavior && typeof raw.lastBehavior === 'object' ? raw.lastBehavior : null,
    grants: Array.isArray(raw.grants) ? raw.grants.filter((g) => g && typeof g === 'object') : [],
    pendingAsks: Array.isArray(raw.pendingAsks)
      ? raw.pendingAsks.filter((a) => a && typeof a === 'object')
      : [],
    // 老文件没有「上次歇着」的时刻：填 now，卡片上会显示「刚歇过」，比显示「十几小时前」诚实
    lastRestAt: num(raw.lastRestAt, now),
    lastAbsenceBucket: num(raw.lastAbsenceBucket, 0),
    recentTalk: Array.isArray(raw.recentTalk)
      ? raw.recentTalk
          .filter((it) => it && typeof it === 'object' && typeof it.text === 'string')
          .slice(-TALK_MAX)
          .map((it) => ({
            at: num(it.at, now),
            who: it.who === 'owner' ? 'owner' : 'fish',
            text: String(it.text).slice(0, 200),
          }))
      : [],
  }
}

/** normalizeState 和 agendaAdd 共用的条目规整，别让窗口是字符串之类的脏数据混进筛选逻辑 */
function normalizeAgendaItem(item, now, index = 0) {
  const n = (v, f) => (Number.isFinite(Number(v)) ? Number(v) : f)
  return {
    // id 必须可复现：宿主会拿它做 agenda-drop，随机会让重启后对不上
    id: item.id ?? `a-${now}-${index}`,
    text: String(item.text ?? '').slice(0, 200),
    kind: ['remind', 'followup', 'report', 'care'].includes(item.kind) ? item.kind : 'remind',
    dueAt: n(item.dueAt, now),
    window: item.window && typeof item.window === 'object'
      ? { from: n(item.window.from, 0), to: n(item.window.to, Number.MAX_SAFE_INTEGER) }
      : null,
    urgency: clamp(item.urgency ?? 0.3, 0, 1),
    createdAt: n(item.createdAt, now),
    spokenAt: item.spokenAt ?? null,
  }
}

/** 主人的一件没做完的活。字段与契约 §3 对齐，多了会被界面顺手丢掉，少了会让排序崩 */
function normalizeWorkItem(item, now, index = 0) {
  const n = (v, f) => (Number.isFinite(Number(v)) ? Number(v) : f)
  return {
    // 和 agenda 一样要可复现：宿主拿 id 做 work-done / work-drop
    id: item.id ?? `w-${now}-${index}`,
    text: String(item.text ?? '').slice(0, 200),
    urgency: clamp(item.urgency ?? 0.3, 0, 1),
    createdAt: n(item.createdAt, now),
    doneAt: item.doneAt ?? null,
  }
}

function cloneState(state) {
  return {
    ...state,
    timeline: [...(state.timeline ?? [])],
    spokeAt: [...(state.spokeAt ?? [])],
  }
}

/**
 * 指数衰减：两个值各自向基线回归，halfHours 是半衰期。
 *
 * 为什么用半衰期而不是每秒固定减一点：固定步长会让「忙的时候衰减快、闲的时候衰减慢」——
 * 而实际上她不该因为 tick 跑得勤就变得更平静。半衰期只跟真实经过的时间有关。
 */
export function decay(state, now, halfHours) {
  const next = cloneState(state)
  const last = Number.isFinite(state.lastDecayAt) ? state.lastDecayAt : now
  const dtHours = Math.max(0, (now - last) / 3600000)

  if (!(Number(halfHours) > 0) || dtHours === 0) {
    next.lastDecayAt = now
    return next
  }

  const k = Math.pow(0.5, dtHours / halfHours)
  next.mood = round2(clamp(MOOD_BASE + (state.mood - MOOD_BASE) * k, 0, 100))
  next.spirit = round2(clamp(SPIRIT_BASE + (state.spirit - SPIRIT_BASE) * k, 0, 100))
  next.lastDecayAt = now
  return next
}

/** 向目标挪一小步，单次挪动封顶，避免某次 tick 里数值跳变 */
function stepToward(current, target, rate, cap) {
  const move = (target - current) * rate
  return current + Math.max(-cap, Math.min(cap, move))
}

/**
 * 给这个钟点定一个「该在的位置」。
 *
 * 为什么是目标值而不是每次加一个偏移：host 每 60 秒 tick 一次，直接累加的话
 * 凌晨十分钟就掉到 0 了。目标值随小时变化，数值慢慢靠过去，无论 tick 多密都收敛。
 */
function driftTarget(hour) {
  // 后半夜：困，情绪也压得低一点。早上回一点兴致，其余时间不带偏向
  if (hour <= 5) return { mood: MOOD_BASE - 3, spirit: SPIRIT_BASE - 8 }
  if (hour <= 9) return { mood: MOOD_BASE, spirit: SPIRIT_BASE + 4 }
  return { mood: MOOD_BASE, spirit: SPIRIT_BASE }
}

export function drift(state, now) {
  const next = cloneState(state)
  const hour = new Date(now).getHours()
  const target = driftTarget(hour)

  next.mood = round2(
    clamp(stepToward(clamp(state.mood, 0, 100), clamp(target.mood, 0, 100), 0.25, 1.5), 0, 100),
  )
  next.spirit = round2(
    clamp(stepToward(clamp(state.spirit, 0, 100), clamp(target.spirit, 0, 100), 0.25, 2), 0, 100),
  )
  next.updatedAt = now
  return next
}

/**
 * 记一次同类事件，返回累计次数（含这一次）。距上次超过 REPEAT_WINDOW_MS 就从 1 重计。
 *
 * 为什么必须在 core 里就地写 repeats：appraise 只有 state 可写，签名又只回 count；
 * 不就地记的话「今天第三次被你凶」这种饱和/敏感化永远只有一个 count=1。
 */
export function noteRepeat(state, key, now) {
  if (!state.repeats || typeof state.repeats !== 'object') state.repeats = {}
  const prev = state.repeats[key]
  const within = prev && Number.isFinite(prev.lastAt) && now - prev.lastAt <= REPEAT_WINDOW_MS
  const count = within ? Math.max(1, num(prev.count, 1)) + 1 : 1
  state.repeats[key] = { count, lastAt: now }
  return count
}

/**
 * 往时间线里追加一条，超过 200 条丢最旧的。
 * 为什么在 core 里截断：写入口可能有很多个（appraisal、gate、宿主 action），
 * 各自记得截断迟早有人漏掉，不如在这里一刀切。
 */
export function pushTimeline(state, entry) {
  const timeline = [...(state.timeline ?? []), entry]
  return { ...state, timeline: timeline.slice(-TIMELINE_MAX) }
}

/**
 * 她歇了一会儿。
 *
 * 为什么一定要进时间线：宿主每轮靠最近六小时的事件数算「今天做了几件」，
 * 休息不落一条，卡片上就会写成「一直在忙，中间没歇过」——那是假话。
 * 返回新对象（时间线是不可变追加），lastRestAt 跟着一起带走。
 */
export function noteRest(state, now) {
  const marked = { ...state, lastRestAt: now }
  return pushTimeline(marked, { kind: 'rest', at: now, text: '自己歇了一会儿' })
}

/**
 * 「今天」这个 key 跟着本地时区走。行为额度是自然日的，不是 24 小时滑窗——
 * 凌晨 1 点算昨天还是今天，人心里有自己的答案，机器也得跟人对齐。
 */
export function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 记一次行为，返回这个行为今天的累计次数。
 *
 * 就地写，和 noteRepeat 同一个理由：宿主只拿到次数，拿不到新 state。
 * 跨日就把 dayCount 重置成 1——额度按天算，昨天的账今天不该背着。
 */
export function noteBehavior(state, id, now) {
  if (!state.behaves || typeof state.behaves !== 'object') state.behaves = {}
  const key = String(id)
  const prev = state.behaves[key]
  const day = dayKey(now)
  const sameDay = prev && prev.day === day
  const count = sameDay ? Math.max(0, num(prev.dayCount, 0)) + 1 : 1
  state.behaves[key] = { lastAt: now, dayCount: count, day }
  return count
}

/** 加一件没做完的活。超过 20 条先丢掉最不急、最旧的，新的活通常更该被记住 */
export function openWorkAdd(state, item, now) {
  if (!Array.isArray(state.openWork)) state.openWork = []
  if (!item || !String(item.text ?? '').trim()) return state

  const next = normalizeWorkItem(item, now, state.openWork.length)
  // id 撞了就换一个，界面按 id 完成/删除，重复 id 会改错行
  if (state.openWork.some((it) => it.id === next.id)) next.id = `${next.id}-${state.openWork.length}`

  state.openWork.push(next)
  if (state.openWork.length > OPEN_WORK_MAX) {
    const drop = state.openWork
      .map((it, i) => ({ it, i }))
      .sort((a, b) => a.it.urgency - b.it.urgency || a.it.createdAt - b.it.createdAt)[0]
    if (drop) state.openWork.splice(drop.i, 1)
  }
  return state
}

/** 标记做完。找不到就原样返回，宿主那边可能连点两次 */
export function openWorkDone(state, id, now) {
  if (!Array.isArray(state.openWork)) return state
  const target = state.openWork.find((it) => it.id === id)
  if (target) target.doneAt = now
  return state
}

/**
 * 她眼里还没做完的活：过滤 doneAt，按急的在前、旧的在前。
 * 返回新数组，调用方排序或切片不会改到 state。
 */
export function openWorkList(state) {
  const list = Array.isArray(state?.openWork) ? state.openWork : []
  return list
    .filter((it) => it && it.doneAt == null)
    .slice()
    .sort((a, b) => num(b.urgency) - num(a.urgency) || num(a.createdAt) - num(b.createdAt))
}

/**
 * 记一句她说出去的话（只留最近的，旧的自己掉出去）。
 * @param {object} state
 * @param {string} text
 * @param {number} [at]
 */
export function noteSpoken(state, text, at = Date.now()) {
  const body = String(text || '').trim()
  if (!body) return state
  state.spoken = [...(state.spoken || []), { at, text: body.slice(0, 400) }].slice(-SPOKEN_MAX)
  noteTalk(state, 'fish', body, at)
  return state
}

/**
 * 记一句往来的话：谁说的、什么时候、说了什么。
 *
 * 和 spoken 分开：spoken 只记她说出去的（防重复用），
 * 这里两边都记，卡片靠它知道刚才在聊什么。
 * @param {object} state
 * @param {'owner'|'fish'} who
 * @param {string} text
 * @param {number} [at]
 * @param {number} [max]
 */
export function noteTalk(state, who, text, at = Date.now(), max = TALK_MAX) {
  const body = String(text || '').trim().replace(/\s+/g, ' ')
  if (!body) return state
  const side = who === 'owner' ? 'owner' : 'fish'
  state.recentTalk = [...(state.recentTalk || []), { at, who: side, text: body.slice(0, 200) }].slice(-max)
  return state
}
