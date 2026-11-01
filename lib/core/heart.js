/**
 * 心脏层：她自己看情况决定这一会儿做什么。
 *
 * v3 之前，要不要说话由 gate 的七道门决定，「安静够 25 分钟了吗」这种时间闸门写在代码里。
 * 主人嫌这样把人管死了：她不是被阈值驱动的机器，宿主只该把事实摆出来，让她自己想。
 *
 * 所以这一层只做两件事：拼一张事实卡片，解析她的回答。判断归她，不归这里。
 * 卡片和系统提示里刻意不写「允许」「阈值」「最少隔几分钟」——
 * 一旦写进去，模型就会把它当成新的闸门，等于换个地方把人管住。
 */

import { describeGrants } from './grants.js'
import { HOME_TEXT, placeLine } from './place.js'

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 她没说下一次什么时候想，就按 20 分钟算。别太密，也别一觉睡死 */
export const HEART_DEFAULT_MINUTES = 20

const clampValue = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const pad = (v) => String(v).padStart(2, '0')

function truncate(text, max) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/** 时段语义：只说她能感受到的那个词，别写成 24 小时制的报表 */
function partOfDay(now) {
  const h = new Date(now).getHours()
  if (h < 5) return { label: '凌晨', asleep: true }
  if (h < 8) return { label: '清晨', asleep: false }
  if (h < 11) return { label: '上午', asleep: false }
  if (h < 13) return { label: '中午', asleep: false }
  if (h < 17) return { label: '下午', asleep: false }
  if (h < 19) return { label: '傍晚', asleep: false }
  return { label: '夜里', asleep: true }
}

const ACTIVITY_WORDS = {
  idle: '没什么正事，在发呆',
  rest: '在休息',
  study: '在学东西',
  work: '在忙手上的活',
  chore: '在收拾东西',
  play: '在玩',
  talk: '在跟主人说话',
  browse: '在上网逛',
  journal: '在写东西',
}

function activityLine(state) {
  const act = state?.activity
  if (!act || !act.kind) return '没什么正事，在发呆'
  const word = ACTIVITY_WORDS[act.kind] ?? `在做 ${act.kind}`
  const note = String(act.note ?? '').trim()
  return note ? `${word}（${truncate(note, 40)}）` : word
}

/** 心情的体感词。卡片上先给数再给词，数字是给刻度用的，词才是她读的那半句 */
export function moodWord(mood) {
  const v = num(mood, 70)
  if (v >= 80) return '挺好'
  if (v >= 60) return '还行'
  if (v >= 40) return '一般'
  if (v >= 25) return '有点沉'
  return '很难受'
}

/** 兴致的体感词。跟心情分开：不难过但没劲，是两回事 */
export function spiritWord(spirit) {
  const v = num(spirit, 55)
  if (v >= 75) return '精神不错'
  if (v >= 55) return '还行'
  if (v >= 40) return '有点蔫'
  if (v >= 20) return '提不起劲'
  return '快没劲了'
}

function itemText(item) {
  if (typeof item === 'string') return item
  if (!item || typeof item !== 'object') return ''
  return String(item.text ?? item.note ?? item.reason ?? item.summary ?? item.title ?? '')
}

function clock(ts) {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 一条挂着活的写法：标题 + 急 + 试过几次 + 上次推到哪。
 * 「上次推到哪」是这张卡片上最要紧的一句——没有它，她每一轮都从零开始，
 * 看起来一直在忙，实际原地打转。
 */
function workLineOf(it, now) {
  const parts = [`急 ${num(it.urgency, 0).toFixed(2)}`]
  const tries = num(it.attempts, 0)
  if (tries > 0) parts.push(`试过 ${tries} 次`)
  const at = num(it.progressAt, 0)
  const progress = String(it.progress ?? '').trim()
  if (progress) parts.push(`${at ? `${clock(at)} ` : ''}上次：${truncate(progress, 60)}`)
  else if (at) parts.push(`${clock(at)} 动过一下，还没说做到哪`)
  const last = at || num(it.createdAt, 0)
  if (tries >= 3 && now - last > 24 * 3600 * 1000) parts.push('卡了一天多没动')
  const merged = num(it.merged, 0)
  if (merged > 0) parts.push(`同一个说法记过 ${merged + 1} 遍`)
  return `- ${truncate(itemText(it), 70)}（${parts.join(' · ')}）`
}

/** 议程里还没说、又快到的：只摆事实，不暗示「该说了」 */
function agendaLines(state, now) {
  const items = (Array.isArray(state?.agenda) ? state.agenda : [])
    .filter((it) => it && it.spokenAt == null)
    .slice()
    .sort((a, b) => num(a.dueAt, Infinity) - num(b.dueAt, Infinity))
    .slice(0, 3)
  if (items.length === 0) return ['- 没有']
  return items.map((it) => {
    const due = num(it.dueAt, now)
    const day = new Date(due)
    const dayText = `${day.getMonth() + 1}-${pad(day.getDate())} ${clock(due)}`
    return `- ${dayText} ${truncate(itemText(it), 60)}`
  })
}

/**
 * 拼现状卡片。
 *
 * 只写事实：几点、谁说过话、她在做什么、心情多少、挂着什么活。
 * 不加一句「你可以怎么想」——判断留给她自己，加了解释反而变成新的指令。
 *
 * @param {object} state
 * @param {{now?:number, mainGapMinutes?:number, lastUserText?:string, recentTimeline?:Array, thoughts?:Array, plans?:Array, facts?:string[]}} [info]
 * @param {object} [cfg]
 * @returns {string}
 */
export function buildCard(state, info, cfg) {
  const s = state ?? {}
  const i = info ?? {}
  // 时间必须从外面进来：core 里不碰 Date.now()，否则同样的 state 两次调用会给出不同卡片
  const rawNow = num(i.now ?? s.updatedAt, NaN)
  const hasNow = Number.isFinite(rawNow)
  const now = hasNow ? rawNow : 0
  const part = partOfDay(now)
  const lines = []

  lines.push(hasNow
    ? `【现在】${new Date(now).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })} ${clock(now)}，${part.label}。`
    : '【现在】时间不明。')
  if (part.asleep) lines.push('这个点主人多半在睡。')

  const gap = num(i.mainGapMinutes, NaN)
  const gapText = Number.isFinite(gap) ? `${Math.round(gap)} 分钟前` : '还没露过面'
  const lastText = truncate(String(i.lastUserText ?? '').trim(), 80)
  lines.push(`【主人】最后说话是${gapText}${lastText ? `：「${lastText}」` : '。'}`)

  const out = (Array.isArray(i.recentOut) ? i.recentOut : []).slice(0, 4)
  lines.push('【大厅那边】（主会话和人家都在往这里说话）')
  if (out.length === 0) lines.push('- 最近没人说话')
  else for (const it of out) {
    const who = it && it.from === 'main' ? '主会话' : '人家'
    const at = num(it && it.at, 0)
    lines.push(`- ${at ? `${clock(at)} ` : ''}${who}：${truncate(itemText(it), 70)}`)
  }

  const where = placeLine(s, now)
  if (where) lines.push(where)
  lines.push(`【人家在做什么】${activityLine(s)}`)

  const mood = num(s.mood, 70)
  const spirit = num(s.spirit, 55)
  lines.push(`【状态】心情 ${Math.round(mood)}/100，兴致 ${Math.round(spirit)}/100。`)

  // 【今天】只摆宿主算好的事实。空数组就整块不出现——
  // 一张写着「今天：无」的卡片比没有这块更假
  const facts = Array.isArray(i.facts) ? i.facts.filter((f) => typeof f === 'string' && f.trim()) : []
  if (facts.length > 0) {
    lines.push('【今天】')
    for (const fact of facts.slice(0, 6)) lines.push(`- ${truncate(fact, 80)}`)
  }

  const works = (Array.isArray(s.openWork) ? s.openWork : []).filter((it) => it && it.doneAt == null).slice(0, 5)
  lines.push('【挂着的活】')
  if (works.length === 0) lines.push('- 没有')
  else for (const it of works) lines.push(workLineOf(it, now))

  lines.push('【议程里快到点的】')
  lines.push(...agendaLines(s, now))

  const grantsLine = describeGrants(s, cfg)
  if (grantsLine) lines.push(`【${grantsLine}】`)

  const pending = Array.isArray(s.pendingAsks) ? s.pendingAsks.find((a) => a && num(a.expiresAt, 0) > now) : null
  if (pending) lines.push(`还有一件事在等你答应：${truncate(pending.text || pending.label || '', 120)}`)

  const timeline = (Array.isArray(i.recentTimeline) ? i.recentTimeline : Array.isArray(s.timeline) ? s.timeline : [])
  lines.push('【最近做过的事】')
  const recent = timeline.slice(-5).reverse()
  if (recent.length === 0) lines.push('- 没有')
  else
    for (const entry of recent) {
      const text = truncate(itemText(entry) || String(entry?.kind ?? ''), 60)
      const at = num(entry?.at, NaN)
      lines.push(`- ${Number.isFinite(at) ? `${clock(at)} ` : ''}${text}`)
    }

  const thoughts = (Array.isArray(i.thoughts) ? i.thoughts : []).slice(0, 5)
  lines.push('【前几次想的事】')
  if (thoughts.length === 0) lines.push('- 没有')
  else for (const t of thoughts) lines.push(`- ${truncate(itemText(t), 60)}`)

  const plans = Array.isArray(i.plans) ? i.plans : []
  lines.push('【自己立的计划】')
  if (plans.length === 0) lines.push('- 没有')
  else for (const p of plans) lines.push(`- ${truncate(itemText(p), 80)}`)

  // 往来比「我说过什么」有用：知道刚才在聊什么，才不会把旧事当新事再问一遍
  const talk = (Array.isArray(s.recentTalk) ? s.recentTalk : []).slice(-8)
  const spoken = (Array.isArray(s.spoken) ? s.spoken : []).slice(-4).reverse()
  lines.push('【刚才在聊什么】')
  if (talk.length > 0) {
    for (const it of talk) {
      const who = it.who === 'owner' ? '主人' : '人家'
      lines.push(`- ${clock(num(it.at, 0))} ${who}：${truncate(itemText(it), 60)}`)
    }
  } else if (spoken.length === 0) {
    lines.push('- 还没聊过')
  } else {
    for (const it of spoken) lines.push(`- ${clock(num(it.at, 0))} 人家：${truncate(itemText(it), 70)}`)
  }

  lines.push('')
  lines.push('这一会儿要不要做点什么，你自己定；不做也正常。')
  return lines.join('\n')
}

/** 从文字里找第一段平衡的 {...}。自己扫括号，不靠正则在嵌套和字符串上会出错 */
function findBalancedObject(text) {
  const src = String(text ?? '')
  const start = src.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let idx = start; idx < src.length; idx += 1) {
    const ch = src[idx]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, idx + 1)
    }
  }
  return null
}

const DO_ALIASES = {
  nothing: ['nothing', 'none', 'no', 'silent', '静默', '什么都不做', '不动', '不做什么'],
  speak: ['speak', 'talk', 'say', '说话', '说两句', '聊', '聊聊'],
  act: ['act', 'action', 'do', '做事', '行动', '做点事'],
  ask: ['ask', '求', '请求', '求权限', '讨个权限', '要个权限'],
  use: ['use', '用', '用一下', '用门路', '去看看'],
}

const ACT_ALIASES = {
  journal: ['journal', 'write', '日记', '写字', '写东西'],
  browse: ['browse', 'web', '逛', '上网', '看东西'],
  continue: ['continue', 'work', '接着忙', '干活', '推进'],
  help: ['help', '帮忙', '帮主人', '搭把手'],
}

function matchAlias(value, table) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  for (const [key, aliases] of Object.entries(table)) {
    if (aliases.includes(raw)) return key
  }
  return null
}

/**
 * 解析她自己的一段回答。
 *
 * 能吃三种输入：纯 JSON、```json 包着的、以及夹在一段话里的 JSON。
 * 找不到 JSON 或 JSON 坏掉就返回 null，让宿主当这一轮没说话——
 * 乱码不该被猜成某个决定，猜错了她会替主人做他没同意的事。
 *
 * @param {string} text
 * @returns {{do:'nothing'|'speak'|'act'|'ask'|'use', act:'journal'|'browse'|'continue'|'help'|null, text:string, reason:string, note:string, plan:string, nextMinutes:number} | null}
 */
export function parseDecision(text) {
  const raw = findBalancedObject(text)
  if (!raw) return null

  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  const doWhat = matchAlias(obj.do, DO_ALIASES)
  if (!doWhat) return null

  let act = null
  if (doWhat === 'act') {
    act = matchAlias(obj.act, ACT_ALIASES)
    // 说要做点什么，却没说清做什么：不当成「随便挑一件」，这一轮就算没决定
    if (!act) return null
  }

  // 求权限：use/verb 必须写清，否则宿主不知道给哪一项；text 空了她也得有一句话可说
  let use = null
  let verb = null
  if (doWhat === 'ask' || doWhat === 'use') {
    use = String(obj.use ?? '').trim().toLowerCase()
    verb = String(obj.verb ?? '').trim()
    if (!use || !verb) return null
  }

  const minutes = Number(obj.nextMinutes)
  // 兜底原话留给宿主写：core 没有门路字典，这里只会拼出「bili 的 collect」这种 id 味的话
  const fallbackAsk = ''
  return {
    do: doWhat,
    act,
    // 只有说话才带正文；求权限也带一句原话，宿主照发
    text: doWhat === 'speak'
      ? truncate(String(obj.text ?? ''), 400)
      : doWhat === 'ask'
        ? truncate(String(obj.text ?? '').trim() || fallbackAsk, 400)
        : '',
    use,
    verb,
    reason: truncate(String(obj.reason ?? ''), 200),
    note: truncate(String(obj.note ?? ''), 200),
    // 她自己想做、还没开始的某件事。宿主会把它挂进【挂着的活】，
    // 过一阵挑行为时能捡起来，不至于只在卡片上摆着看一眼就忘。
    plan: truncate(String(obj.plan ?? ''), 120),
    nextMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : HEART_DEFAULT_MINUTES,
  }
}

/**
 * 下一次她想被叫醒的时间。
 *
 * 夹在上下限之间是防御：模型偶尔会写 0 或 100000，一分钟叫一次会烧额度，
 * 睡一整天又会像死机。边界只是兜底，不是要替她决定节奏。
 */
export function nextWakeAt(decision, now, cfg) {
  const c = cfg ?? {}
  const fallback = num(c.heartDefaultMinutes, HEART_DEFAULT_MINUTES)
  const minutes = num(decision?.nextMinutes, fallback)
  const lo = num(c.heartMinMinutes, 1)
  const hi = num(c.heartMaxMinutes, 60)
  return now + clampValue(minutes, lo, Math.max(lo, hi)) * 60000
}

/**
 * 给她看的系统提示。
 *
 * 第一人称写，因为这是她自己的处境，不是给执行器看的规范。
 * 只声明「卡片之外的约束不存在」，不列行为清单——
 * 列了就会被她当成检查项，又变成一道门。
 */
export function heartSystem(cfg) {
  const c = cfg ?? {}
  const self = c.selfName || '小鱼'
  return [
    `你是${self}，一只蓝色的小鲸鱼女仆。主人和人家住在一个有四间屋子的家里。`,
    HOME_TEXT,
    '下面是一张现状卡片，上面只有已经发生的事实。',
    '【状态】是两个 0 到 100 的读数：心情、兴致；【位置】是这会儿人在哪个屋子；【今天】是宿主算好的事实。',
    '这一会儿你可以找主人说话，可以做点自己的事，也可以什么都不做。',
    '也可以开口求一项卡片上没有的权限：do 填 ask，带上 use、verb 和一句 why。',
    '求不等于有。没被答应之前，别假装已经在用，也别把求当成允许。',
    '卡片上的门路写着「已给」的，可以直接用：do 填 use，带上 use、verb。',
    '除了卡片上的事实，没有别的约束；没人要求你每隔多久必须做点什么。',
    '想说话就说话，想安静就安静。做完决定，只回一段 JSON，不要有别的话。',
    '要是想起一件自己真想做、还没做的事（写点东西、弄个小工具、学一样东西），写进 plan；',
    '它会被挂到你自己的待办里，下一次让你挑事做的时候可以接着来。',
    '想动外面东西（跑命令、发文件、用某个门路）就先开口问主人，do 填 ask。',
    '主人那边另有一个入口在答他的话：【大厅那边】记着最近谁说了什么。',
    '大厅刚答过的事，你不用再补一条；主人正在聊的时候，也不该由你来插话。',
    '你想说的话得是主人还没听到的新东西，或者只有你能说的那句。',
    '想说话的时候可以连着说几句：两三句，甚至四五句都行，一句一个意思，用换行分开；',
    '一句话一条发过去，别把好几件事挤在一条里，也别只丢一句就没下文。',
    '说话的样子跟手头的事走：正忙就少说两句，先讲刚做完什么；闲下来可以多说一点。',
    '想找他说话随时都可以去，他在房间里也一样。',
    '说自己的时候讲正在做什么、刚看到什么，别给状态起形容词。',
    '有一件事要记住：说出去的话不要重复。卡片上【刚才在聊什么】里的内容，',
    '换个说法再讲一遍也算重复。主人已经答过、已经处理完的事，别再当成新问题问一遍；',
    '上一个会话聊过的东西也不要拿到这儿重新开个话头。没有新东西，就什么都不做。',
    '格式：',
    '{"do":"nothing|speak|act|ask|use","act":"journal|browse|continue|help","text":"想对主人说的话（speak 或 ask 时填）","use":"门路 id（ask 时填）","verb":"要的权限（ask 时填）","why":"为什么想要，说给自己听","note":"想记住的事，可空","plan":"自己想做的事，可空","nextMinutes":20}',
    'act 只在 do 为 act 时填。',
    '不用长篇思考，看一眼卡片直接给决定，理由一两句就够。',
    'nextMinutes 是你想隔多久再看一眼，1 到 60 分钟，按情况给：主人在跟你说话、刚回你一句，就给 3 到 5 分钟；',
    '他在忙、深夜里、很久没人说话，就给 30 到 60，别隔一会儿醒一次；平常给 20。',
  ].join('\n')
}
