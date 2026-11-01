/**
 * 会忘的记忆。
 *
 * 规则搬自 SurfCore 的 `src/memory-card.js`（清晰度阶梯、一天最多降一档、主人相关下限），
 * 但存储换了：**一个 markdown 文件就是唯一真相**，不再有 json 影子。
 * 理由很简单——这份东西主人会想翻、会想改，改完不该被下一次写盘覆盖。
 *
 * 行格式（可以手写，解析只看行尾那个方括号）：
 *   - 主人答应下周一起看那部片子 [clear 2026-10-28 80 2 owner]
 *     └ 正文（写给人看）        └ 清晰度 日期 重要度 提起次数 标签
 *
 * 解析失败的行走 `fixme` 档，原样留着不丢——宁可显示得怪，也不要悄悄吃掉主人的字。
 */

const DAY_MS = 24 * 3600 * 1000

export const CLARITY_ORDER = ['forgotten', 'trace', 'fuzzy', 'clear', 'vivid']

export const CLARITY_LABEL = {
  vivid: '清楚得像刚发生',
  clear: '记得',
  fuzzy: '有点模糊',
  trace: '只剩影子',
  forgotten: '忘了',
}

export const DEFAULT_MEMORY_CONFIG = Object.freeze({
  enabled: true,
  recentDays: 7,
  fuzzyAfterDays: 7,
  forgetAfterDays: 120,
  minOwnerImportance: 55,
  maxRecords: 400,
  promptBudgetChars: 2200,
})

const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const text = (v) => String(v ?? '').trim()
/** 记忆是「一行一条」，所以正文里的换行必须压平，不然一条会被读成两条 */
const oneLine = (v) => String(v ?? '').replace(/\s*\r?\n+\s*/g, ' ').trim()

export function normalizeMemoryConfig(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    ...DEFAULT_MEMORY_CONFIG,
    enabled: src.enabled !== false,
    recentDays: Math.max(1, num(src.recentDays, DEFAULT_MEMORY_CONFIG.recentDays)),
    fuzzyAfterDays: Math.max(1, num(src.fuzzyAfterDays, DEFAULT_MEMORY_CONFIG.fuzzyAfterDays)),
    forgetAfterDays: Math.max(1, num(src.forgetAfterDays, DEFAULT_MEMORY_CONFIG.forgetAfterDays)),
    minOwnerImportance: Math.min(100, Math.max(0, num(src.minOwnerImportance, DEFAULT_MEMORY_CONFIG.minOwnerImportance))),
    maxRecords: Math.max(20, num(src.maxRecords, DEFAULT_MEMORY_CONFIG.maxRecords)),
    promptBudgetChars: Math.max(300, num(src.promptBudgetChars, DEFAULT_MEMORY_CONFIG.promptBudgetChars)),
  }
}

const META_RE = /\[([a-z]+)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,3}))?(?:\s+(\d+))?(?:\s+([^\]]*))?\]\s*$/

function dayOf(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function timeOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''))
  if (!m) return 0
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0).getTime()
}

/**
 * 解析 markdown。只认 `- ` 开头的行，其余（标题、说明、空行）忽略。
 * @returns {{records: Array, broken: number}}
 */
export function parseMemoryMarkdown(md, now = Date.now()) {
  const records = []
  let broken = 0
  for (const line of String(md ?? '').split('\n')) {
    const row = line.trim()
    if (!row.startsWith('- ')) continue
    const body = row.slice(2).trim()
    if (!body) continue
    const m = META_RE.exec(body)
    if (!m) {
      broken += 1
      // 读不懂的行：把原始那一行整句留着，下次写盘原样吐回去，
      // 不拿今天的时间戳和默认分数去改写主人的字
      records.push({
        text: oneLine(body).slice(0, 300), clarity: 'fixme', tags: [], raw: row,
        importance: 50, createdAt: now, lastSeenAt: now, recallCount: 0,
      })
      continue
    }
    const clarity = CLARITY_ORDER.includes(m[1]) ? m[1] : 'fixme'
    records.push({
      text: oneLine(body.slice(0, m.index)).slice(0, 300),
      clarity,
      tags: m[5] ? m[5].split(/[,，\s]+/).filter(Boolean) : [],
      importance: Math.min(100, Math.max(0, num(m[3], 50))),
      createdAt: timeOf(m[2]) || now,
      lastSeenAt: timeOf(m[2]) || now,
      recallCount: Math.max(0, num(m[4], 0)),
    })
  }
  // 兜底上限：真要有人塞两万行进来，保住最近的，并且告诉调用方丢了多少
  const cap = 2000
  const kept = records.length > cap ? records.slice(-cap) : records
  return { records: kept, broken, trimmed: records.length - kept.length }
}

/**
 * 序列化成 markdown（唯一真相）。
 *
 * 给 original 就在原文上原位替换：第 k 条记忆换掉原文里第 k 个 `- ` 行，
 * 其余行（标题、说明、主人自己写的散文）一个字都不动；新记的追加到末尾。
 * 不给 original 才从头排版（第一次建文件时用）。
 */
export function renderMemoryMarkdown(records, now = Date.now(), original = '') {
  const list = (Array.isArray(records) ? records : []).filter(r => r && text(r.text))
  const line = (r) => {
    if (r.clarity === 'fixme' && r.raw) return r.raw
    const clarity = CLARITY_ORDER.includes(r.clarity) ? r.clarity : 'clear'
    const tags = (r.tags || []).join(',')
    const meta = [clarity, dayOf(Number(r.createdAt) || now), Math.round(Number(r.importance) || 0), Number(r.recallCount) || 0, tags]
      .join(' ')
      .replace(/\s+$/, '')
    return `- ${oneLine(r.text)} [${meta}]`
  }
  const stamp = `> 更新于 ${new Date(now).toLocaleString('zh-CN')}，共 ${list.filter(r => r.clarity !== 'forgotten').length} 条`

  if (!String(original || '').trim()) {
    if (!list.length) return `# 小鱼记得的事\n\n${stamp}\n\n（还什么都没记住）\n`
    return `# 小鱼记得的事\n\n${stamp}\n\n${list.map(line).join('\n')}\n`
  }

  const src = String(original).split('\n')
  const out = []
  let cursor = 0
  let stamped = false
  for (const raw of src) {
    const row = raw.trim()
    if (row.startsWith('> 更新于')) {
      out.push(stamp)
      stamped = true
      continue
    }
    if (row.startsWith('- ') && cursor < list.length) {
      out.push(line(list[cursor]))
      cursor += 1
      continue
    }
    out.push(raw)
  }
  // 新记的接在最后一条记录后面
  if (cursor < list.length) {
    const extra = list.slice(cursor).map(line)
    let at = out.length
    while (at > 0 && !out[at - 1].trim()) at -= 1
    out.splice(at, 0, ...extra)
  }
  if (!stamped) {
    let at = out.findIndex(l => l.trim() !== '')
    at = at < 0 ? 0 : at + 1
    out.splice(at, 0, '', stamp)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

/** 跟主人有关、且够重要：这部分有保留度下限，不会被彻底忘掉。 */
export function ownerImportant(record, cfg = DEFAULT_MEMORY_CONFIG) {
  const c = normalizeMemoryConfig(cfg)
  return (record.tags || []).includes('owner') && Number(record.importance) >= c.minOwnerImportance
}

/** 这条记忆「按人的规律」现在该有多清楚。 */
export function targetClarity(record, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryConfig(config)
  if (record.clarity === 'fixme') return 'fixme'
  const ageDays = Math.max(0, (now - num(record.createdAt, now)) / DAY_MS)
  const sinceSeenDays = Math.max(0, (now - num(record.lastSeenAt, now)) / DAY_MS)
  const protectedOwner = ownerImportant(record, cfg)

  if (ageDays > cfg.forgetAfterDays && Number(record.importance) < 50 && !protectedOwner) return 'forgotten'

  let retention = num(record.importance, 0)
  retention += Math.min(12, num(record.recallCount, 0) * 2)
  if (ageDays <= cfg.recentDays) retention += 18
  if (sinceSeenDays <= 2) retention += 8
  retention -= Math.min(80, Math.max(0, ageDays - cfg.fuzzyAfterDays) * (protectedOwner ? 0.12 : 0.35))
  if (protectedOwner) retention = Math.max(retention, 55)
  if (ageDays <= cfg.recentDays) retention = Math.max(retention, 50)

  if (retention >= 68) return 'vivid'
  if (retention >= 46) return 'clear'
  if (retention >= 24) return 'fuzzy'
  if (retention >= 12) return 'trace'
  return 'forgotten'
}

/**
 * 每日整理：每条最多向目标清晰度移动一格。
 * 一次只降一档才有「渐渐模糊」，一次忘光是删库，不是记忆。
 */
export function applyDailyDecay(records, config = {}, now = Date.now(), { force = false, lastDecayDay = '' } = {}) {
  const cfg = normalizeMemoryConfig(config)
  const today = dayOf(now)
  if (!force && lastDecayDay === today) return { records, changed: false, forgotten: 0, day: today }
  const keep = []
  let changed = false
  let forgotten = 0
  for (const record of records) {
    if (!record || record.clarity === 'forgotten') continue
    const curIndex = CLARITY_ORDER.indexOf(record.clarity)
    const targetIndex = CLARITY_ORDER.indexOf(targetClarity(record, cfg, now))
    if (curIndex < 0 || targetIndex < 0) {
      keep.push(record)
      continue
    }
    if (targetIndex > curIndex) {
      const next = CLARITY_ORDER[curIndex + 1]
      if (next === 'forgotten') {
        forgotten += 1
        changed = true
        continue
      }
      record.clarity = next
      changed = true
    } else if (targetIndex < curIndex) {
      record.clarity = CLARITY_ORDER[curIndex - 1]
      changed = true
    }
    keep.push(record)
  }
  return { records: keep, changed, forgotten, day: today }
}

/**
 * 记一件事。同一句话再记一次不新增，只把「她又想起来了」记上。
 */
export function addMemory(records, input = {}, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryConfig(config)
  const list = Array.isArray(records) ? records.slice() : []
  if (!cfg.enabled) return { records: list, added: false, reason: 'disabled' }
  const body = text(input.text)
  if (!body) return { records: list, added: false, reason: 'empty' }
  const norm = body.replace(/\s+/g, ' ').slice(0, 120)

  const existing = list.find((r) => {
    const prev = String(r.text || '').replace(/\s+/g, ' ')
    const short = norm.slice(0, 40)
    return prev.startsWith(short) || short.startsWith(prev.slice(0, 40))
  })
  if (existing) {
    existing.lastSeenAt = now
    existing.recallCount = (Number(existing.recallCount) || 0) + 1
    if (existing.clarity !== 'fixme' && CLARITY_ORDER.indexOf(existing.clarity) < CLARITY_ORDER.indexOf('clear')) {
      existing.clarity = 'clear'
    }
    if (Number(input.importance) > Number(existing.importance)) existing.importance = Number(input.importance)
    return { records: list, added: false, recalled: true, record: existing }
  }

  const record = {
    text: oneLine(body).slice(0, 300),
    clarity: 'vivid',
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 8) : [],
    importance: Math.min(100, Math.max(0, num(input.importance, 50))),
    createdAt: now,
    lastSeenAt: now,
    recallCount: 0,
  }
  list.push(record)
  // 超量时先丢最不清楚、最旧的；跟主人有关的不丢
  if (list.length > cfg.maxRecords) {
    // 读不懂的行（fixme）是主人手写的，超量也不许丢，只丢我们自己记的
    const sorted = list.filter(r => !ownerImportant(r, cfg) && r.clarity !== 'fixme').sort((a, b) => {
      const ai = CLARITY_ORDER.indexOf(a.clarity)
      const bi = CLARITY_ORDER.indexOf(b.clarity)
      if (ai !== bi) return ai - bi
      return Number(a.createdAt) - Number(b.createdAt)
    })
    const drop = new Set(sorted.slice(0, Math.max(0, list.length - cfg.maxRecords)))
    return { records: list.filter(r => !drop.has(r)), added: true, record }
  }
  return { records: list, added: true, record }
}

/** 把还记得的渲染成一段，有字数预算。越清楚、越重要的排前面。 */
export function renderMemoryPrompt(records, config = {}, now = Date.now()) {
  const cfg = normalizeMemoryConfig(config)
  if (!cfg.enabled) return ''
  const alive = (Array.isArray(records) ? records : [])
    .filter(r => r && r.clarity !== 'forgotten' && r.clarity !== 'fixme')
    .sort((a, b) => {
      const ai = CLARITY_ORDER.indexOf(a.clarity)
      const bi = CLARITY_ORDER.indexOf(b.clarity)
      if (ai !== bi) return bi - ai
      return Number(b.importance) - Number(a.importance)
    })
  if (!alive.length) return ''
  const lines = ['【你记得的事】']
  let used = lines[0].length
  for (const r of alive) {
    const mark = r.clarity === 'fuzzy' ? '（有点模糊）' : r.clarity === 'trace' ? '（只剩影子）' : ''
    const line = `- ${r.text}${mark}`
    if (used + line.length > cfg.promptBudgetChars) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
