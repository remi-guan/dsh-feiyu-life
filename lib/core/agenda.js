/**
 * 待办（agenda）：她记着「到点该说」的事。
 *
 * 和情绪冲动是两条路：冲动看心情，待办看钟点。事情该说就说，不看冲动分；
 * 但冷场、静默时段、每日额度这些打扰门依旧管着（见 gate.js）。
 *
 * window 用绝对毫秒时间戳（from/to），宿主已经把「明天九点」这类话算成具体时刻了，
 * 这里只做 `from <= now <= to` 的比较，不碰钟点和跨零点——换算放在宿主，核账放在这里。
 */

import { clamp } from './state.js'

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/** 过期判定：dueAt 过后这么久还没说出去，就不值得再说了 */
const EXPIRE_AFTER_MS = 24 * 3600 * 1000

/** 默认上限。契约里配置也有 maxItems，这里兜一层，避免宿主没传就把数组撑爆 */
const DEFAULT_MAX_ITEMS = 20

/** 规整一条待办。脏数据（缺字段、字符串时间）在这里收口，别让筛选逻辑自己防御 */
function normalizeItem(item, now) {
  const n = (v, f) => (Number.isFinite(Number(v)) ? Number(v) : f)
  return {
    id: item.id ?? `a-${now}-${Math.round(n(item.urgency, 0) * 1000)}`,
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

/**
 * 加一条。就地写 state.agenda（v2 契约没给返回值，宿主多半直接调），
 * 同时把 state 返回，`state = agendaAdd(...)` 这种写法也不会拿到 undefined。
 * 超过 maxItems 时丢最不急、最旧的那条——新事通常比囤了两天的旧事更该记住。
 */
export function agendaAdd(state, item, now) {
  const maxItems = DEFAULT_MAX_ITEMS
  if (!Array.isArray(state.agenda)) state.agenda = []
  if (!item || !String(item.text ?? '').trim()) return state

  const next = normalizeItem(item, now)
  // id 撞了就换一个，界面按 id 删除，重复 id 会删错行
  if (state.agenda.some((it) => it.id === next.id)) next.id = `${next.id}-${state.agenda.length}`

  state.agenda.push(next)
  if (state.agenda.length > maxItems) {
    const drop = state.agenda
      .map((it, i) => ({ it, i }))
      .sort((a, b) => a.it.urgency - b.it.urgency || a.it.dueAt - b.it.dueAt)[0]
    if (drop) state.agenda.splice(drop.i, 1)
  }
  return state
}

/**
 * 清理：已说过的、以及 dueAt 过后 24h 还没说的，都丢掉。返回剩余条数。
 * 为什么要设过期：两天前的「提醒主人喝水」现在弹出来只会显得傻。
 */
export function agendaSweep(state, now) {
  if (!Array.isArray(state.agenda)) state.agenda = []
  state.agenda = state.agenda.filter((it) => {
    if (it.spokenAt != null) return false
    return now - num(it.dueAt, now) <= EXPIRE_AFTER_MS
  })
  return state.agenda.length
}

/**
 * 选一条现在能说的：到点、在窗口里、还没说过。
 * 排序按 urgency 降序、dueAt 升序；再拿不到就 null。
 *
 * 这个函数是只读的：decide 可能在一轮里被调多次（界面预览、真实判定），
 * 它不该顺手把 spokenAt 改掉。标记「说过了」由宿主在真的投递后自己做。
 */
export function agendaPick(state, now, cfg) {
  if (!Array.isArray(state.agenda) || state.agenda.length === 0) return null
  if (cfg?.agenda?.enabled === false) return null

  const candidates = state.agenda
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => {
      if (it.spokenAt != null) return false
      // 过期的也跳过：宿主可能还没跑 agendaSweep，这里自己兜一层，
      // 两天前的「提醒喝水」现在弹出来只会显得傻
      if (now - num(it.dueAt, now) > EXPIRE_AFTER_MS) return false
      if (num(it.dueAt, now) > now) return false
      if (it.window) {
        if (now < num(it.window.from, 0)) return false
        if (now > num(it.window.to, Number.MAX_SAFE_INTEGER)) return false
      }
      return true
    })

  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const du = num(b.it.urgency, 0) - num(a.it.urgency, 0)
    if (du !== 0) return du
    const dd = num(a.it.dueAt, 0) - num(b.it.dueAt, 0)
    if (dd !== 0) return dd
    return a.i - b.i
  })
  return candidates[0].it
}
