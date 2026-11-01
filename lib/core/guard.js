/**
 * 护栏：她自己发起的回合也要有个刹车。
 *
 * 只留三条，够用就行——一天醒几次、两次之间隔多久、今天花了多少。
 * 三条都是「0 或负数 = 不限」，不是「关掉」；要全关就 `enabled: false`。
 * 别的（每分钟/每小时/一次发几条/单轮步数）都去掉了：那些要么本该在提示词里说，
 * 要么插件根本没有执行权（取消一轮是宿主的事），留着只是给人「我们有防护」的错觉。
 */

export const DEFAULT_WAKE_GUARD = Object.freeze({
  enabled: true,
  maxWakesPerDay: 20,
  minWakeGapMs: 120_000,
  maxDailyCostCNY: 8,
  costPerMTokens: 2,
})

const num = (v, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function normalizeGuard(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    ...DEFAULT_WAKE_GUARD,
    enabled: src.enabled !== false,
    maxWakesPerDay: Math.max(0, Math.round(num(src.maxWakesPerDay, DEFAULT_WAKE_GUARD.maxWakesPerDay))),
    minWakeGapMs: Math.max(0, Math.round(num(src.minWakeGapMs, DEFAULT_WAKE_GUARD.minWakeGapMs))),
    maxDailyCostCNY: Math.max(0, num(src.maxDailyCostCNY, DEFAULT_WAKE_GUARD.maxDailyCostCNY)),
    costPerMTokens: Math.max(0, num(src.costPerMTokens, DEFAULT_WAKE_GUARD.costPerMTokens)),
  }
}

/** 本地时间的零点。按天算次数和花费都用它。 */
export function localDayStart(now = Date.now()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * @returns {{blocked:boolean, reason?:string, error?:string, retryAfterMs?:number, dayCount?:number, spent?:number}}
 */
export function evaluateWakeBudget({ wakeTimes = [], now = Date.now(), guard = DEFAULT_WAKE_GUARD, cost = 0 } = {}) {
  const g = normalizeGuard(guard)
  if (!g.enabled) return { blocked: false }
  const dayStart = localDayStart(now)
  const times = (Array.isArray(wakeTimes) ? wakeTimes : []).map(Number).filter(t => t >= dayStart)
  const spent = num(cost, 0)

  if (g.maxDailyCostCNY > 0 && spent >= g.maxDailyCostCNY) {
    return {
      blocked: true,
      reason: 'cost',
      spent,
      error: `今天已经花掉 ¥${spent.toFixed(2)}，超过 ¥${g.maxDailyCostCNY} 就先歇着`,
      retryAfterMs: dayStart + 86_400_000 - now,
    }
  }
  if (g.maxWakesPerDay > 0 && times.length >= g.maxWakesPerDay) {
    return {
      blocked: true,
      reason: 'day',
      dayCount: times.length,
      error: `今天自己醒了 ${times.length}/${g.maxWakesPerDay} 次，剩下的留到明天`,
      retryAfterMs: dayStart + 86_400_000 - now,
    }
  }
  const last = times.length ? Math.max(...times) : 0
  if (g.minWakeGapMs > 0 && last && now - last < g.minWakeGapMs) {
    return {
      blocked: true,
      reason: 'gap',
      error: `两次醒至少隔 ${Math.round(g.minWakeGapMs / 1000)} 秒`,
      retryAfterMs: g.minWakeGapMs - (now - last),
    }
  }
  return { blocked: false, dayCount: times.length, spent }
}

/** 从 DSH 的 usage 里估一个人民币花费；只当刹车，不当账单。 */
export function estimateCost(usage, guard = DEFAULT_WAKE_GUARD) {
  const g = normalizeGuard(guard)
  if (!usage || typeof usage !== 'object') return 0
  const input = num(usage.inputTokens ?? usage.promptTokens, 0)
  const output = num(usage.outputTokens ?? usage.completionTokens, 0)
  const cached = num(usage.cachedInputTokens ?? usage.cacheReadTokens, 0)
  const rate = g.costPerMTokens / 1_000_000
  // 缓存命中按三折算，只为了别估得太离谱
  // 宿主的 inputTokens 不一定含缓存命中：减出负数会让护栏以为没花钱
  const fresh = Math.max(0, input - cached)
  return Math.round((fresh + cached * 0.3 + output) * rate * 10000) / 10000
}

/** 记一笔花费，返回今天的累计。换天自动清零。 */
export function noteSpend(state, costYuan, now = Date.now()) {
  if (!state || !Number.isFinite(costYuan) || costYuan <= 0) return 0
  const day = localDayStart(now)
  const prev = state.spend && Number(state.spend.day) === day ? Number(state.spend.yuan) || 0 : 0
  const next = Math.round((prev + costYuan) * 10000) / 10000
  state.spend = { day, yuan: next }
  return next
}

/** 界面和提示词用的一行摘要。 */
export function guardSummary(state, guard = DEFAULT_WAKE_GUARD, now = Date.now()) {
  const g = normalizeGuard(guard)
  const day = localDayStart(now)
  const times = (Array.isArray(state?.wakeTimes) ? state.wakeTimes : []).filter(t => Number(t) >= day)
  const spent = state?.spend && Number(state.spend.day) === day ? Number(state.spend.yuan) || 0 : 0
  return {
    dayCount: times.length,
    maxWakesPerDay: g.maxWakesPerDay,
    spent: Math.round(spent * 100) / 100,
    maxDailyCostCNY: g.maxDailyCostCNY,
    blocked: state?.guardBlocked && Number(state.guardBlocked.at) >= day ? state.guardBlocked : null,
  }
}
