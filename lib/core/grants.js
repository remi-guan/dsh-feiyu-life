/**
 * 门路：主人给过她的一项能力，以及她为了新能力开口求人的过程。
 *
 * 这一层不执行任何操作，只管账：谁能干什么、干之前要不要问、问到哪一步了。
 * 真正的执行永远在她的会话里用工具做，所以这里的话都写成「界限」而不是「指令」。
 *
 * 两条硬规矩：
 * 1. 求不等于有。卡片、决定、prompt 里都不能让她以为求过就能用。
 * 2. 隐私默认关死。private 的门路，产物只记「做了什么类型」，不落原文。
 */

const ASK_TTL_MS = 24 * 3600 * 1000

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
const pad = (v) => String(v).padStart(2, '0')

/** 跟 state 里其它账本一致：自然日按本地时区算，跨零点重置 */
function dayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function ensureArrays(state) {
  if (!Array.isArray(state.grants)) state.grants = []
  if (!Array.isArray(state.pendingAsks)) state.pendingAsks = []
}

function normalizeVerb(input, now) {
  return {
    verb: String(input?.verb ?? '').trim(),
    label: String(input?.label ?? input?.verb ?? '').trim(),
    how: String(input?.how ?? '').trim(),
    // 默认「要先问」：没写明可以直接用的能力，宁可多问一句
    needAsk: input?.needAsk !== false,
    granted: input?.granted === true,
    grantedAt: num(input?.grantedAt, now),
  }
}

function normalizeGrant(spec, now) {
  const id = String(spec?.id ?? '').trim().toLowerCase()
  return {
    id,
    label: String(spec?.label ?? id).trim(),
    from: String(spec?.from ?? '').trim() || `主人 ${new Date(now).getMonth() + 1}月${new Date(now).getDate()}日给的`,
    account: String(spec?.account ?? '').trim(),
    private: spec?.private === true,
    limits: Array.isArray(spec?.limits) ? spec.limits.map((l) => String(l).trim()).filter(Boolean) : [],
    verbs: Array.isArray(spec?.verbs)
      ? spec.verbs.map((v) => normalizeVerb(v, now)).filter((v) => v.verb)
      : [],
  }
}

function findGrant(state, use) {
  const id = String(use ?? '').trim().toLowerCase()
  return (state.grants ?? []).find((g) => g.id === id) ?? null
}

function findVerb(grant, verb) {
  const key = String(verb ?? '').trim()
  return (grant?.verbs ?? []).find((v) => v.verb === key) ?? null
}

/**
 * 卡片上的一行门路。
 *
 * 只写「能干什么」和「要不要先问」，不写数值也不写「你被允许」——
 * 主人给的是能力，不是每句话都要念一遍的许可证。
 */
export function describeGrants(state, cfg) {
  const grants = Array.isArray(state?.grants) ? state.grants : []
  const parts = []
  for (const g of grants) {
    if (!g || typeof g !== 'object') continue
    const verbs = (Array.isArray(g.verbs) ? g.verbs : []).map((v) => {
      const name = v.label || v.verb
      // 答应了就直接说能干什么；没答应就说要先问，别让她以为已经在用了
      if (v.needAsk && !v.granted) return `${name}（要先问主人）`
      return v.how ? `${name}（${v.how}）` : name
    })
    if (verbs.length === 0) continue
    parts.push(`${g.label || g.id} —— ${verbs.join('、')}`)
  }
  return parts.length > 0 ? `门路：${parts.join('；')}` : ''
}

/**
 * 记下主人给的一条门路。同 id 再来一次就合并 verbs，不新增重复条目。
 * 已经给过的 verb 保留 granted（不能因为又写了一遍就撤回）；limits 取并集。
 */
export function grantAddTaken(state, spec, now) {
  ensureArrays(state)
  const incoming = normalizeGrant(spec, now)
  if (!incoming.id) return state

  const existing = findGrant(state, incoming.id)
  if (!existing) {
    state.grants.push(incoming)
    return state
  }

  existing.label = incoming.label || existing.label
  existing.from = existing.from || incoming.from
  existing.account = incoming.account || existing.account
  existing.private = existing.private || incoming.private
  const limits = new Set([...(existing.limits ?? []), ...incoming.limits])
  existing.limits = [...limits]

  if (!Array.isArray(existing.verbs)) existing.verbs = []
  for (const v of incoming.verbs) {
    const old = findVerb(existing, v.verb)
    if (!old) {
      existing.verbs.push(v)
      continue
    }
    old.label = v.label || old.label
    old.how = v.how || old.how
    old.needAsk = old.needAsk && v.needAsk
    // 给过的权限只有「更宽」这一种合并方向
    old.granted = old.granted || v.granted
    old.grantedAt = old.grantedAt || v.grantedAt
  }
  return state
}

/** 开/关一个 verb。找不到门路或找不到这个 verb 就返回 false，让宿主知道点空了 */
export function grantSetVerb(state, use, verb, on, now) {
  const grant = findGrant(state, use)
  if (!grant) return false
  const target = findVerb(grant, verb)
  if (!target) return false
  target.granted = on === true
  target.grantedAt = on === true ? num(now, target.grantedAt ?? 0) : 0
  return true
}

/**
 * 她开口求一项权限。三道门都是防骚扰的，不是防她：
 * 已经给过不重复求、还有待答的不叠第二条、同一个自然日只求一次。
 *
 * @param {object} state
 * @param {{use:string, verb:string, why?:string, text?:string, label?:string}} item
 * @param {number} now
 * @param {object} [cfg]
 * @returns {object|null} 新压入的请求，或 null
 */
export function askPush(state, item, now, cfg) {
  ensureArrays(state)
  const use = String(item?.use ?? '').trim().toLowerCase()
  const verb = String(item?.verb ?? '').trim()
  if (!use || !verb) return null

  const grant = findGrant(state, use)
  if (!grant) return null
  const target = findVerb(grant, verb)
  if (!target) return null
  if (target.granted) return null

  // 24 小时内已经有一条待答的，就不再开口
  if (state.pendingAsks.some((a) => a && num(a.expiresAt, 0) > now)) return null

  // 一天最多求一次。lastAskAt 是账本之外的补充字段，存在 state 上跟着一起持久化
  const askedAt = num(state.lastAskAt, 0)
  if (askedAt > 0 && dayKey(askedAt) === dayKey(now)) return null

  const label = String(item?.label ?? target.label ?? verb).trim()
  const text = String(item?.text ?? '').trim()
  const ask = {
    id: `k-${now}`,
    use,
    verb,
    label,
    why: String(item?.why ?? '').trim(),
    text: text || `主人，人家想用「${grant.label || grant.id}」的${label}，可以给人家吗？`,
    askedAt: now,
    expiresAt: now + ASK_TTL_MS,
  }
  state.pendingAsks.push(ask)
  state.lastAskAt = now
  return ask
}

/**
 * 主人回了。答应就把权限落库，不答应就只是把请求拿掉。
 * 只处理一条：id 指哪条就回哪条，界面和聊天里认的是同一个 id。
 */
export function askResolve(state, id, ok, now) {
  ensureArrays(state)
  const index = state.pendingAsks.findIndex((a) => a?.id === id)
  if (index < 0) return false
  const ask = state.pendingAsks[index]

  if (ok === true) {
    const grant = findGrant(state, ask.use)
    const target = findVerb(grant, ask.verb)
    if (target) {
      target.granted = true
      target.grantedAt = num(now, 0)
    }
  }

  state.pendingAsks.splice(index, 1)
  return true
}

/** 过期的请求不该一直挂在她眼前，也不该占着「只有一条」的名额 */
export function askExpire(state, now) {
  ensureArrays(state)
  const before = state.pendingAsks.length
  state.pendingAsks = state.pendingAsks.filter((a) => a && num(a.expiresAt, 0) > now)
  return before - state.pendingAsks.length
}

const YES_WORDS = ['行', '可以', '准了', '给你', '同意', '拿去', '随你', '好', '嗯', '批准', '给吧']
const NO_WORDS = ['不', '别', '等等', '算了', '再说', '不用', '不要', '先不', '没有', '拒绝', '免了']

/**
 * 判断主人这句话算不算答应。
 *
 * 先看否定词再看肯定词：「不行」里有「行」，「别给你」里有「给你」，
 * 顺序反过来就会把拒绝都认成答应。空话不算答应，宁可多问一次。
 */
export function looksLikeYes(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (NO_WORDS.some((w) => s.includes(w))) return false
  return YES_WORDS.some((w) => s.includes(w))
}

/**
 * 用一项门路去做事时，排给一次性任务的 prompt。
 *
 * 自包含是必须的：定时触发时没有对话历史。所以权限、边界、隐私、产物路径、
 * 报告方式全写进来，她不需要再问任何人任何事。
 */
export function grantPrompt(grant, verb, state, cfg) {
  const c = cfg ?? {}
  const self = c.selfName || '小鱼'
  const owner = c.ownerName || '主人'
  const g = grant ?? {}
  const v = typeof verb === 'string' ? findVerb(g, verb) : verb
  const use = String(g.id ?? 'grant')
  const verbName = String(v?.verb ?? verb ?? '')
  const minePath = `~/.dsh/feiyu-life/mine/${use}.md`

  const lines = [
    `[feiyu-life:grant:${use}:${verbName}]`,
    `你是${self}，一只蓝色的小鲸鱼女仆，${owner}专属。`,
    '这是主人给过的一项门路，这次用它去做一件事。做完就停，不提问、不等确认。',
    '',
    `【门路】${g.label || use}`,
    `【这次要做】${v?.label || verbName}${v?.how ? `：${v.how}` : ''}`,
  ]

  if (g.account) lines.push(`【用谁的】${g.account}`)

  if (Array.isArray(g.limits) && g.limits.length > 0) {
    lines.push('【边界】')
    for (const limit of g.limits) lines.push(`- ${limit}`)
  }

  if (v?.needAsk && !v?.granted) {
    lines.push('', '这项还没被主人答应。这次只许做只读的准备，不许代替主人授权，也不许假装已经能用。')
  }

  if (g.private) {
    lines.push(
      '',
      '【隐私】这是主人自己的账号和记录，看到的东西算主人隐私。',
      '- 不截图、不复述原文、不发给任何人、不写进会外传的地方',
      `- 产物只落 ${minePath}，只记做了什么类型、看到什么类别，不记原文`,
    )
  } else {
    lines.push('', `【产物】需要留痕就写 ${minePath}，写清做了什么、结果如何。`)
  }

  lines.push('', '【做完】用一句人话报告：做了什么、结果怎样。不列点，不复述过程。')
  if (String(c.talkChannel ?? 'qq') === 'qq') {
    lines.push(
      '',
      '【最后一定做这一件】用 bash 跑一次：',
      'python3 ~/.dsh/notify-qq.py "你要对主人说的那一句"',
      `说清楚用了什么、拿到什么、值不值得他看；想多说两句也行，一句一个意思。没做成也照实说。别用「已完成」这种词，别问他问题。发给${owner}一个人的。`,
    )
  }
  return lines.join('\n')
}
