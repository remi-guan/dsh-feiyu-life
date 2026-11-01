/**
 * 「他是不是还没说完」。
 *
 * 移植自 SurfCore 的 `src/v2-wait.js`（二代仿真里等待/结束回合那部分）。
 * 原版的定位就是软提示：判断结果只写进提示词，拍板仍归模型。
 * 这里保持一致——不拦话、不改行为，只给一句观察。
 *
 * 私聊里这条比群里重要：主人打完「但是」转身去倒水是常有的事，
 * 这时候抢着接一句，听着就像没在听。
 */

/** 话说一半的尾巴。只在没有终止标点时才算。 */
const UNFINISHED_TAIL_RE = /(?:你知道|等一下|我跟你讲|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|回头|回头说|待会|晚点|等会|再说吧)$/

/** 以逗号、顿号、分号、冒号结尾，也常表示还没说完。 */
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/

/** 有终止标点就是收住了：句号、叹号、问号、省略号、波浪号。 */
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/

export function looksLikeUnfinished(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (FINISHED_TAIL_RE.test(s)) return false
  if (UNFINISHED_TAIL_RE.test(s)) return true
  if (UNFINISHED_PUNCT_RE.test(s)) return true
  return false
}

/**
 * 给提示词用的一行观察。没命中就返回空串，不占 token。
 * @param {string} text 对方最后一句
 */
export function unfinishedLine(text) {
  const s = String(text ?? '').trim()
  if (!looksLikeUnfinished(s)) return ''
  const tail = s.slice(-6)
  return `对方最后一句停在「${tail}」，像没说完——先别急着接，等一会儿再看他补不补。`
}
