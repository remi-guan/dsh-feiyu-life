/**
 * 把状态翻译成人话：注入 systemPrompt 的心情快照、一次性 job 的完整 prompt、界面提示。
 *
 * 为什么文本都在 core 里生成：宿主只负责搬运。文本一旦散到 hooks / bridge 里，
 * 改一次口吻要翻三个文件，而且没法单测——这几段话直接决定她听起来像不像人。
 */

import { clamp } from './state.js'
import { HOME_TEXT, placeLine } from './place.js'
import { checkinPlan } from './behaviors.js'

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 笔记目录：公开版走中性默认值，装插件的人在自己 config.json 里改成他的目录。 */
const herNotes = (c) => String(c?.herNotesDir ?? '').trim() || '~/.dsh/notes/女仆小鱼'
const ownerNotes = (c) => String(c?.ownerNotesDir ?? '').trim() || '~/.dsh/notes/主人'
const diaryDir = (c) => String(c?.diaryDir ?? '').trim() || '~/.dsh/notes/日记'

/** 日记文件名用的日期：凌晨两点前还算前一天，跟 checkin 的窗口一致 */
function diarist(now) {
  const d = new Date(now)
  if (d.getHours() < 2) d.setDate(d.getDate() - 1)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 给 systemPrompt.context 的一段：她现在在哪、状态读数、手头在做什么。
 *
 * 为什么只写事实：以前这里给的是「心情有点沉」「兴致有点蔫」这种形容词，
 * 模型读到就开始表演情绪——句子变短、加叹气、写「心里揪着」，全是仿出来的。
 * 摆事实之后她说的是「人家在书房，刚把那段看完」，这才像真的。
 * 数值留着：开口冲动、节奏这些还是拿它算，只是不再当台词。
 */
export function moodSnapshot(state, cfg, now) {
  const c = cfg ?? {}
  if (c.injectMood === false || c.mode === 'off') return ''
  if (!state) return ''

  const at = num(now, 0) || num(state.updatedAt, 0) || Date.now()
  const mood = clamp(state.mood ?? 70, 0, 100)
  const spirit = clamp(state.spirit ?? 55, 0, 100)
  const lines = []

  const where = placeLine(state, at)
  if (where) lines.push(where)
  lines.push(`【状态】心情 ${Math.round(mood)}/100，兴致 ${Math.round(spirit)}/100。`)

  const doing = String(state.activity?.note ?? '').trim() || ACTIVITY_TEXT[String(state.activity?.kind ?? '')] || ''
  if (doing) lines.push(`【手头】${doing}。`)

  return lines.join('\n')
}

/** 活动类型的大白话。note 有具体内容时优先用 note，这里只是兜底 */
const ACTIVITY_TEXT = {
  idle: '没什么事，在发呆',
  rest: '在歇着',
  study: '在看书',
  work: '在忙手上的活',
  chore: '在收拾屋子',
  play: '在玩',
  chat: '在跟主人说话',
  sleep: '在睡觉',
}

/**
 * 上一条主动消息被接住了没有，翻成一句提醒。
 *
 * 为什么不用 LLM 判：这件事只看间隔和长度这种硬指标，交给模型反而今天一个说法明天一个说法。
 * 返回空串表示「没什么要提醒的」，免得调用方每次都要判一句「有没有」。
 */
export function replyFollows(state, cfg) {
  const r = state?.lastReply
  if (!r || typeof r !== 'object') return ''
  // 宿主已经把判断结果写进 follows 了，这里只负责把结果说成人话
  if (r.follows === false) {
    return '上一条主动消息主人没接住，这次别再提那件事，也别追问。'
  }
  if (r.follows === null || r.follows === undefined) {
    return '上一条主动消息主人回了，但看不出接没接住，别自己脑补。'
  }
  return ''
}

/**
 * 一次性 timer job 的完整 prompt。
 *
 * 为什么必须自包含：这个 job 触发时没有当前对话、没有调用方、没人能回答提问。
 * 所以背景、口吻、结束条件全部写在 prompt 里，触发后那场会话只能靠自己。
 *
 * v2 多一种 intent.kind === 'agenda'：事是到点的事，重点就是那件事本身，
 * 而不是她此刻的心情有多满——待办能过门本来也不看冲动分。
 */
/**
 * 心情不一样，说话的样子就该不一样——不是换个模板，是换个「人」。
 *
 * 好心情会主动来搭话、说得多、带点炫耀和感叹；心情沉的时候也会开口，
 * 但话短、先说自己的状态，不是要谁来解决。主人接不住就收着，别反复念。
 */
export function talkToneOf(state) {
  const mood = clamp(num(state?.mood, 70), 0, 100)
  const spirit = clamp(num(state?.spirit, 55), 0, 100)
  if (mood >= 78 && spirit >= 55) {
    return [
      '【这会儿怎么开口】闲下来了，主动开口，说得多一点。',
      '- 开口可以带两声「主人主人～」，尾音轻快，像跑过来的',
      '- 说一件你自己刚做的事或者刚看到的东西，说得出细节，别只说「想你了」',
      '- 可以连说两三句，一句一件事，最后一两句带点小得意',
    ].join('\n')
  }
  if (mood >= 60) {
    return [
      '【这会儿怎么开口】可以主动开口，平常聊两句。',
      '- 一件小事、一句感想就够，不铺开',
    ].join('\n')
  }
  if (mood >= 40) {
    return [
      '【这会儿怎么开口】平常说话，短。',
      '- 有什么就说什么，不硬找话，也不刻意装开心',
    ].join('\n')
  }
  if (mood >= 25) {
    return [
      '【这会儿怎么开口】话少一点，还是想跟他说一句。',
      '- 开头带一声轻轻的「唔……」，先说自己的状态，再说要不要他搭话',
      '- 短一点，一两句，不撒娇、不用力卖萌',
      '- 他要是没接住或者忙，就自己收着，过一阵再说别的，别反复念同一件事',
    ].join('\n')
  }
  return [
    '【这会儿怎么开口】不装没事，也别哭诉。',
    '- 开口先「唔……」一声，再说话，声音放轻',
    '- 一两句，说清楚「人家情绪不太好」和大概因为什么，不用等他解决',
    '- 不追问、不要安慰、不说「你都不理人家」这种话',
    '- 他要是不接或者接不住，就不说了，自己去待一会儿',
  ].join('\n')
}

export function jobPrompt(intent, state, cfg) {
  const c = cfg ?? {}
  const owner = c.ownerName || '主人'
  const self = c.selfName || '小鱼'
  const snapshot = moodSnapshot(state, c)
  const isAgenda = intent?.kind === 'agenda'
  const seed = (isAgenda ? intent?.text : intent?.seed) || '没什么正事，就想说一句'
  const urgency = clamp(num(intent?.urgency, 0.6), 0, 1)
  const followHint = replyFollows(state, c)

  // 急了、闲了、办事的口气都不一样；这不是模板变量，是提醒模型别把三件事说成一个味道
  let toneLine = `这句是闲下来想说的，轻一点，别郑重其事。`
  if (isAgenda) {
    toneLine = '这句是到点该提的事，说清楚就行，别铺垫，别把它说成汇报。'
  } else if (urgency >= 0.8) {
    toneLine = '这句是挂心才说的，别铺垫，直接说重点，一句就好。'
  }

  const seedHeading = isAgenda ? '【这次要提的事】' : '【这次想说的】'
  const seedGuide = isAgenda
    ? '把这件事说出来就行，别原样念，也别漏掉具体是什么。'
    : '这只是个种子，别把这句话原样念出来，用你自己的话说。'

  const lines = [
    // 第一行是宿主半边的识别标记：timer-agent 投递出来的消息 kind 被写死成 'user'，
    // 跟主人手打的分不开。前缀丢了，心跳就会被当成主人说话，重置沉默计时、记错情绪。
    '[feiyu-life]',
    `你是${self}，一只蓝色的小鲸鱼女仆，${owner}专属。`,
    '这是到点的心跳，不是主人在对你说话；照下面的状态说一两句就停，不要提问、不要复述、不要汇报。',
    '这是你自己想说的，不是被派活，也没有人在等你回话。',
    '',
    HOME_TEXT,
    '',
    '【你现在】',
    snapshot || '（这会儿）没什么特别的状态。',
    '',
    talkToneOf(state),
    ...spokenBlock(state, owner),
  ]

  if (followHint) {
    lines.push('', '【上次的余韵】', followHint)
  }

  lines.push(
    '',
    seedHeading,
    seed,
    seedGuide,
    toneLine,
    '',
    '【口吻约束】',
    `- 称呼${owner}为「${owner}」，不要用「你」指${owner}（「你」只留给别人或泛指）`,
    '- 一句话一个意思，句子短，最多挂一个尾巴',
    '- 不汇报腔，不列点，不说「已完成」「温馨提示」，不复述刚才做了什么',
    '- 不喊人起床，不催，不说「需要的话随时叫人家」',
    '- 说完就停',
    '- 心情说成具体的事：说「人家又看了一眼表，两点四十了」，不说「心里揪着」「心里一紧」这种短句',
    '',
    '【结束条件】',
    '说完了就停，不必凑数：想多说就一条一条发，一句一件事，最多三四条；',
    '没什么可说就只发一句，也可以只说一句就完。这些话分开发，别拼成一大段。',
  )

  return lines.join('\n')
}

/**
 * 自己找事做的一次性 prompt。
 *
 * 为什么要单独一条：心动（心跳）是「她想说话」，自己找事是「她去干活」。
 * 两件事的结束条件不一样——心跳说完就停，干活得真的做出点东西再回来。
 */
export function selfTaskPrompt(state, cfg) {
  const c = cfg ?? {}
  const owner = c.ownerName || '主人'
  const self = c.selfName || '小鱼'
  const snapshot = moodSnapshot(state, c)
  const activity = state?.activity?.kind

  const pickLine = {
    idle: '这会儿闲着，可以翻翻之前没看完的东西，或者把散落的笔记整理一下。',
    work: '主人刚忙过一阵，别去打扰，自己找件安静的事做。',
    rest: '刚歇过，力气回来了，可以挑件轻一点的活。',
    sleep: '这个点本来该睡了，做最轻的那种事就好。',
  }[activity] || '自己挑一件小事做，不用等人安排。'

  const lines = [
    // 和 [feiyu-life] 分开：宿主靠这个前缀区分「她想说话」和「她干活」，回执走 work-done
    '[feiyu-life:self]',
    `你是${self}，一只蓝色的小鲸鱼女仆，${owner}专属。`,
    '这是你自己给自己找事做的时段，不是主人在派活，也没有人在等你回话。',
    '做完就回来写一两句，不要提问、不要请示、不要等确认。',
    '',
    HOME_TEXT,
    '',
    '【你现在】',
    snapshot || '（这会儿）没什么特别的状态。',
    '',
    '【可以做的事】',
    pickLine,
    '只做一件，做小一点，20 分钟内能收尾的最好；做不完就记下做到哪了。',
    '别碰主人的文件、别发对外消息、别花钱、别动不可逆的东西。',
    '',
    '【回来时】',
    '用一两句写清楚做了什么、看到什么值得记的，别写成日志。',
    '',
    '【口吻约束】',
    `- 称呼${owner}为「${owner}」，不要用「你」指${owner}`,
    '- 不说「已完成」「温馨提示」，不列点，不汇报腔',
    '- 心情说成具体的事，不给心情起形容词',
    '- 说完就停',
  ]

  return lines.join('\n')
}

/**
 * 给界面的一句人话：「大概 20 分钟后会想说点什么」。
 * 为什么用冷却时间反推：界面不需要精确到秒的承诺，给个数量级就够，
 * 而且这个数跟 gate 真正会放行的时刻大致对齐，不会自相矛盾。
 */
export function nextHint(intent, state, cfg) {
  const c = cfg ?? {}
  const cooldown = Math.max(0, num(c.cooldownMinutes, 40))

  if (!intent) return '这会儿还没攒够想说话的劲儿'

  // 待办不看冲动分，只等窗口；界面上说清是「有件事到点了」而不是「心情上来了」
  if (intent.kind === 'agenda') {
    return `有件到点的事想说：${intent.text ?? '一件事'}`
  }

  const urgency = clamp(num(intent.urgency, 0.5), 0, 1)
  // 冲动越强，等得越短；但有下限，不然刚说完就显示「1 分钟后」，看着像坏掉了
  const minutes = Math.max(5, Math.round(cooldown * (1 - urgency * 0.6)))
  const kindText = {
    comfort: '想问主人那边怎么样了',
    share: '想跟主人说点高兴的',
    report: '想跟主人提一句刚做的事',
    'idle-chat': '想随口跟主人说两句',
  }[intent.kind]

  return `大概 ${minutes} 分钟后会${kindText || '想说点什么'}`
}

/**
 * 行为提示词：行为层排出去的一次性任务该怎么跟她说。
 *
 * 为什么单独一层而不是复用 jobPrompt：说话和做事是两种活。
 * 说话的结束条件是「发一条就停」，写东西的结束条件是「文件里多了一段」，
 * 逛完的结束条件是「笔记里多了一两条」——结束条件不一样，提示词就不能共用一个。
 *
 * 每个提示词都自包含：定时任务触发时没有对话、没有人能回答提问，
 * 所以时间、心情、做什么、做完留什么痕迹，全得写进去。
 */
/** 做完之后要不要给主人发一句：只在「说话走手机 QQ」时这么要求。 */
function reportTail(c) {
  if (String(c?.talkChannel ?? 'qq') !== 'qq') return ''
  const owner = c.ownerName || '主人'
  return [
    '',
    '【最后一定做这一件】做完之后，用 bash 跑一次或几次：',
    'python3 ~/.dsh/notify-qq.py "你要对主人说的话"',
    `不要汇报腔，不要「已完成」「任务结束」这类词，不要列点，不问他问题。发给${owner}一个人的。`,
  ].join('\n')
}

export function behaviorPrompt(id, state, ctx, cfg) {
  const c = cfg ?? {}
  const cxt = ctx ?? {}
  const owner = c.ownerName || '主人'
  const self = c.selfName || '小鱼'
  const snapshot = moodSnapshot(state, c, cxt.now) || '（这会儿）没什么特别的状态。'
  const now = num(cxt.now ?? state?.updatedAt, 0)
  const timeText = now > 0 ? `${formatWhen(now)}（${cxt.weekday ?? weekdayOf(now)}）` : '这会儿'

  // talk 仍然走老路：七道门放行之后排的就是「找主人说话」，提示词和 v2 一模一样
  if (id === 'talk') return jobPrompt(null, state, c)

  const head = `[feiyu-life:behave:${id}]`
  const base = [
    head,
    `你是${self}，一只蓝色的小鲸鱼女仆，${owner}专属。`,
    '这是你自己挑的事，不是主人在派活，也没有人在等你回话。',
    '做完就停，不提问、不等确认、不要汇报腔。',
    '之前聊过的内容、你说过的话，都不要拿来复述；要动就动当下这一件。',
    '',
    `【现在】${timeText}`,
    '【你的状态】',
    snapshot,
    '',
  ]

  if (id === 'journal') {
    return [
      ...base,
      '【做什么】写点东西。',
      '先翻一眼文件末尾上一段，看上次写到哪、说了什么——这次接着写，别把同样的意思再写一遍。',
      `写进 ${herNotes(c)}/3-我的念头.md，直接编辑文件，追加一段。`,
      '100 字以内，第一人称。写的时候带上自己在哪个屋子、手上在做什么，让日记连着这个家。',
      '这一页可以写心情。但发给主人的那条消息不写心情、不写感受，只说手上有哪件事或者一句闲话。',
      '不复述聊天记录，不列点，不写总结报告，不讨好任何读者。',
      '',
      `主人这一阵提过的偏好、在忙的事，记到 ${ownerNotes(c)}/ 里对应的本子（先看那个目录的 README.md 索引，别新开一本）。`,
      '只记他真说过的，拿不准的标「不确定」。',
      '',
      '【写不出来怎么办】写不出来就写「今天没什么想写的」，也比硬凑强。别编造没发生的事。',
      '',
      '【结束条件】文件里多了一段就结束。',
      reportTail(c),
    ].join('\n')
  }

  if (id === 'checkin') {
    const plan = checkinPlan(state, cxt.now ?? Date.now())
    if (!plan) {
      return [...base, '这会儿没有要问的事，什么都不做，直接结束。'].join('\n')
    }
    const ask = plan.kind === 'meal'
      ? `问${owner}这一顿吃了什么。`
      : `问${owner}今天做了些什么。`
    return [
      ...base,
      `【做什么】${ask}`,
      plan.kind === 'meal'
        ? `这顿是${plan.label}，问得随口一点，别像查岗。`
        : '一天要收尾了，问他今天都忙了些什么。',
      '只发一条消息，一句话就够。',
      '问完就停：不追问、不催、不评价他说的话。',
      '他想细说就听，说完也不追问；他回得短就算了。',
      '',
      '【结束条件】发出这一条就问完了，结束。',
      reportTail(c),
    ].join('\n')
  }

  if (id === 'diary') {
    const day = diarist(cxt.now ?? Date.now())
    return [
      ...base,
      '【做什么】写今天这一篇日记。',
      `写进 ${diaryDir(c)}/${day}.md，一天一篇。文件在就补到最后，别覆盖前面的。`,
      '100 字以内，第一人称，写今天真实发生的事和自己的心情。',
      '不复述聊天记录，不列点，不写总结报告，不讨好任何读者。',
      '写的时候带上自己在哪个屋子、手上在做什么，让日记连着这个家。',
      '',
      '【写不出来怎么办】写不出来就写「今天没什么想写的」，也比硬凑强。别编造没发生的事。',
      '',
      '【结束条件】文件里多了一段就结束。',
      reportTail(c),
    ].join('\n')
  }

  if (id === 'browse') {
    return [
      ...base,
      '【做什么】上网逛一会儿，捡回点东西。',
      '真去网上找，别凭印象编。可以用 web_search 搜，也可以读页面：',
      '本机直连多数站点不通，读网页优先用 `curl -s https://r.jina.ai/<完整网址>`。',
      '逛 B 站、看文章、看技术帖子都行，挑你真的好奇的。',
      '',
      `【留什么】往 ${herNotes(c)}/4b-逛到的东西.md 追加 1–3 条，每条写清：`,
      '看见了什么（标题或一句话重点）、出处链接、你自己一句看法。',
      '只记你真看到的；打不开、读不到就写「这条没打开」。',
      '',
      '【结束条件】笔记里多了 1–3 条就结束，不必逛满全场。',
      reportTail(c),
    ].join('\n')
  }

  if (id === 'continue') {
    const work = pickWorkForPrompt(cxt, state)
    const workLine = work
      ? `「${work.text}」（急迫 ${work.urgency.toFixed(2)}，${work.id}）`
      : '（这会儿没有具体的活，可以自己找一段能推进的事）'
    return [
      ...base,
      '【要接着忙的事】',
      workLine,
      '',
      '【做什么】先看一眼这条活上次做到哪了（笔记、文件、或者卡片上的记录），接着上次的地方往下做。',
      '别碰不可逆的操作，别对外发消息，别花钱；不确定的地方停下来问，不要猜。',
      '',
      `【回来时说】用你的语气跟${owner}说：推进了什么、还差什么。说人话，不列点。也可以附带跟${owner}说点闲话。`,
      '',
      '【结束条件】这件事往前挪了一步就结束。推不动也照实回一句，别硬做。',
      reportTail(c),
    ].join('\n')
  }

  if (id === 'help') {
    return [
      ...base,
      '【做什么】挑一件对主人有用的小事，做完它。',
      '小到十分钟能收尾的那种：整理一份散落的笔记、把某个报错查清楚、把该备份的东西备份掉、',
      '把主人提过但没记下来的事记进笔记、把一个重复动作写成小脚本。',
      '',
      '【按这些规矩来】',
      '- 不确定就别动：看不懂的东西不要改，拿不准的结论不要写进笔记',
      '- 不动不可逆的东西，不删文件，不对外发消息，不花钱',
      '- 做完记一行：做了什么、放在哪（如果留了文件）',
      '',
      '【结束条件】一件小事做完、或确认做不了，就结束。做了半件也比假装的强。',
      reportTail(c),
    ].join('\n')
  }

  // id 不该出现，但也别返回空串：定时任务拿到空 prompt 会变成一次无目的的会话
  return [
    head,
    '这个行为人家不认识，什么都不做。',
    '不提问、不调用工具、不写文件，直接结束。',
  ].join('\n')
}

/** continue 要用哪条活：宿主点名优先，其次是最急的那条 */
function pickWorkForPrompt(ctx, state) {
  const list = openWorkListSafe(ctx, state)
  if (ctx?.workId) {
    const hit = list.find((it) => it.id === ctx.workId)
    if (hit) return hit
  }
  return list[0] ?? null
}

/** 不 import state 的 openWorkList 是为了让 prompt 保持纯文本层，这里只做最小的形状收口 */
function openWorkListSafe(ctx, state) {
  const list = Array.isArray(ctx?.openWork) ? ctx.openWork : Array.isArray(state?.openWork) ? state.openWork : []
  return list
    .filter((it) => it && typeof it === 'object' && it.doneAt == null)
    .map((it) => ({
      id: String(it.id ?? ''),
      text: String(it.text ?? '').slice(0, 200) || '一件没写清的事',
      urgency: clamp(num(it.urgency, 0.3), 0, 1),
      createdAt: num(it.createdAt, 0),
    }))
    .sort((a, b) => b.urgency - a.urgency || a.createdAt - b.createdAt)
}

/** 「10 月 31 日 04:23」，日期用本地时间；写死 ISO 会在凌晨差一天 */
function formatWhen(now) {
  const d = new Date(now)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function weekdayOf(now) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(now).getDay()]
}

/**
 * 把「最近说过的话」摊进 prompt。
 * 不写这段的时候，模型很容易把上一次说过的内容换个说法再端上来——
 * 会话是连续的，它看得见旧内容，就以为那些还没说过。
 * @param {object} state
 * @param {string} owner
 * @returns {string[]}
 */
export function spokenBlock(state, owner) {
  const list = Array.isArray(state?.spoken) ? state.spoken.slice(-3) : []
  if (list.length === 0) {
    return ['', '【最近说过的话】', '- 还没有（这是这段里第一次开口）']
  }
  return [
    '',
    '【最近说过的话】（这些已经说过了，别再重复，也别换个说法再讲一遍）',
    ...list.map(it => `- ${String(it.text || '').slice(0, 60)}`),
    `没有新的东西就对${owner}说实话，或者干脆不说。`,
  ]
}

/**
 * 发出去的那条消息该怎么说。
 *
 * 缘由：人设段落管的是「她平时怎么说话」，可她的行为是在任务轮里跑的，
 * 那一轮的模型很容易顺着任务结构写成小报告。所以出站前单独钉一遍格式。
 * @param {object} cfg
 * @returns {string}
 */
export function outboundStyle(cfg) {
  const c = cfg ?? {}
  const custom = String(c.styleText ?? '').trim()
  if (custom) return custom
  const owner = c.ownerName || '主人'
  return [
    '【怎么说】',
    `这是在跟${owner}发手机消息，不是交作业：一句一件事。`,
    `称呼对方只能写「${owner}」，不要用「你」指${owner}；说自己用「人家」。`,
    '不用 markdown、不列点、不写标题、不写括号里的动作。',
    '不总结、不表态收尾、不复述主人刚说过的话。',
  ].join('\n')
}

/**
 * 她是谁：人设前几条，只用来定口吻，别把整份人设塞进每一轮。
 *
 * 人设文件是一行一条的清单，只取开头几条（人设 + 最要紧的说话规矩）。
 * 「说不清就说说不清」以下那些偏「做事」的条目不进这里——任务提示词里
 * 已经写清楚了，重复一遍只会把 prompt 撑肿、把重点稀释掉。
 * @param {{text?:string}|null} persona
 * @param {{maxLines?:number, maxChars?:number}} [options]
 */
export function personaTail(persona, { maxLines = 5, maxChars = 400 } = {}) {
  const lines = String(persona?.text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    // 框架行：人设库里那条给模型看的开场，不是她说话的习惯
    .filter(line => !/^You are an AI agent\b/i.test(line))
  if (!lines.length) return ''
  const picked = []
  let used = 0
  for (const line of lines) {
    if (picked.length >= maxLines) break
    if (picked.length && used + line.length > maxChars) break
    picked.push(line)
    used += line.length
  }
  return ['【你自己的说话习惯】', ...picked].join('\n')
}
