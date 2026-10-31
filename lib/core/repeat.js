/**
 * 别把说过的话再说一遍。
 *
 * 真人不会隔半小时把同一段话原样端上来，更不会把上一个会话里聊过的事
 * 当成新问题再问一遍。这个文件只做一件事：判断「这句话她是不是刚说过」。
 *
 * 只用字符二元组重合度，不引依赖：中文没有空格，按 2-gram 切片最稳；
 * 顺带压掉标点和空白，免得加个逗号就算新话。
 */

const PUNCT = /[\s，。！？、；：""''（）()…—\-·,.!?;:"'`]+/gu

/** 归一：去标点空白、全角转半角、英文小写。 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(PUNCT, '')
    .toLowerCase()
}

/** 2-gram 集合；太短的句子退回单字集合。 */
export function grams(text) {
  const s = normalize(text)
  if (s.length < 2) return new Set(s ? [s] : [])
  const set = new Set()
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2))
  return set
}

/**
 * 两句有多像：0 到 1。
 * Jaccard 对短句偏严，这里用「重合数 / 较短那句的 gram 数」——
 * 「主人，人家刚想起来一件事」和「主人人家刚想起来一件事」应该算同一句。
 */
export function similarity(a, b) {
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let shared = 0
  for (const gram of ga) if (gb.has(gram)) shared += 1
  return shared / Math.min(ga.size, gb.size)
}

/**
 * 默认门槛：重合 0.5 就当同一句。
 * 实测：换了个问法的重复（「把这话记在手上」「哪一步闪退」）落在 0.55 附近，
 * 而不同话题之间最高只到 0.43，0.5 这条线两边都留了余量。
 */
export const REPEAT_THRESHOLD = 0.5

/**
 * 这句话是不是最近说过。
 * @param {string} text
 * @param {Array<{text?:string,at?:number}|string>} said 最近说过的话，新的在前或后都行
 * @param {{threshold?:number, maxAgeMs?:number, now?:number}} [options]
 * @returns {{repeat:boolean, match?:string, score?:number}}
 */
export function findRepeat(text, said, { threshold = REPEAT_THRESHOLD, maxAgeMs = 12 * 3_600_000, now = Date.now() } = {}) {
  const body = String(text ?? '').trim()
  if (!body) return { repeat: false }
  const list = Array.isArray(said) ? said : []
  for (const item of list) {
    const previous = typeof item === 'string' ? item : item && item.text
    if (!previous) continue
    const at = typeof item === 'object' && item ? Number(item.at) : NaN
    if (Number.isFinite(at) && now - at > maxAgeMs) continue
    const score = similarity(body, previous)
    if (score >= threshold) return { repeat: true, match: previous, score }
  }
  return { repeat: false }
}
