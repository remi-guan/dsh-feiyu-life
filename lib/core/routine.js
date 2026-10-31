/**
 * 主人的作息：只从他自己说的话里认，认出来就记成事实。
 *
 * 这里不猜。他说「去睡了」，记的是「他这么说的时候」，不当作已经睡着——
 * 说完常还要洗漱、刷手机，二十几分钟才躺下。
 */

/** 说要去睡的说法。只认短的、明确的，长句里夹一句不算 */
const SLEEP_WORDS = ['去睡了', '去睡', '睡觉了', '我要睡', '先睡', '睡了', '睡觉', '躺下', '晚安', '洗洗睡', '眯一会']

/** 说醒了的说法 */
const WAKE_WORDS = ['醒了', '起床', '起来了', '睡醒', '早上好', '爬起来']

/** 否定和问句都不算：他没睡、睡不着、在问人家睡没睡 */
const DENY = /还没睡|没睡|不睡|睡不着|不想睡|先不睡|不困/
const ASK = /[？?]\s*$/

/**
 * 认一条主人说的话是不是在讲作息。
 *
 * @param {string} text
 * @returns {'sleep'|'wake'|''}
 */
export function detectRoutine(text) {
  const t = String(text ?? '').trim()
  if (!t || t.length > 120) return ''
  if (DENY.test(t) || ASK.test(t)) return ''
  if (WAKE_WORDS.some(word => t.includes(word))) return 'wake'
  if (SLEEP_WORDS.some(word => t.includes(word))) return 'sleep'
  return ''
}

/** 卡片、进度里怎么说这一条 */
export function routineText(kind) {
  if (kind === 'sleep') return '说去睡了'
  if (kind === 'wake') return '说醒了'
  return ''
}
