/**
 * 这个家：客厅、书房、主人的房间、小鱼自己的房间。
 *
 * 为什么要单独一层：位置不是装饰，它决定她说话时人在哪儿、跟主人隔不隔一堵墙。
 * 提示词里写一句「人家在书房」，比写十句「你现在心情不错」有用得多。
 *
 * 规矩：位置全部从 state 推出来，不另存一份。存了就要跟 activity 对账，
 * 迟早出现「她说自己在书房，活动记录却在睡觉」。
 */

/** 四个房间。key 进代码，value 是她会说的话 */
export const PLACES = {
  study: '书房',
  living: '客厅',
  'owner-room': '主人的房间',
  'her-room': '自己的房间',
}

/** 行为 id → 她做这件事时人在哪个房间 */
const BEHAVIOR_PLACE = {
  talk: 'study',
  continue: 'study',
  help: 'study',
  journal: 'her-room',
  browse: 'her-room',
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

/**
 * 主人在哪。
 *
 * 只看行为，不看钟点：他在书房还是在房间，取决于他这会儿在做什么，
 * 不是取决于现在几点。宿主能看到的信号只有 activity——刚说过话、手上的活、
 * 睡没睡；没信号的时候算客厅（两个人都闲着，最容易碰上）。
 */
export function ownerPlaceOf(state) {
  const kind = String(state?.activity?.kind ?? '')
  if (kind === 'sleep') return 'owner-room'
  if (kind === 'work' || kind === 'chat') return 'study'
  if (kind === 'rest' || kind === 'chore' || kind === 'play') return 'living'
  return 'living'
}

/**
 * 她在哪。
 *
 * 三条顺序：她自己记下的 space → 手头这件事该在哪 → 主人身边。
 * 最后那条是兜底：她在做什么都由 activity 说，读不出来就跟主人待在一个屋子，
 * 别出现「她在客厅、主人在书房、一晚上没照面」这种别扭的组合。
 */
export function herPlaceOf(state, now) {
  const space = String(state?.activity?.space ?? '')
  if (PLACES[space]) return space

  const kind = String(state?.activity?.kind ?? '')
  const note = String(state?.activity?.note ?? '')

  // 排任务时把行为名写进了 note，认得出就按行为的房间算
  for (const [id, place] of Object.entries(BEHAVIOR_PLACE)) {
    if (note && note.includes(labelOf(id))) return place
  }

  if (kind === 'sleep') return 'her-room'
  if (kind === 'rest' || kind === 'chore' || kind === 'play') return 'living'
  if (kind === 'work' || kind === 'chat') return 'study'
  return ownerPlaceOf(state)
}

/** 行为 id → 房间。宿主排任务时把它写进 activity.space，位置就有准确来源 */
export function spaceOfBehavior(id) {
  return BEHAVIOR_PLACE[id] ?? ''
}

const LABELS = { talk: '找主人说话', continue: '接着忙主人的事', help: '顺手帮主人做点事', journal: '自己写东西', browse: '自己上网逛' }
function labelOf(id) {
  return LABELS[id] || id
}

/** 提示词里那一行。同一个屋子就只说一次，别写「主人在书房的人在同一个屋子」这种绕口令 */
export function placeLine(state, now) {
  const owner = ownerPlaceOf(state, now)
  const her = herPlaceOf(state, now)
  if (!PLACES[owner] || !PLACES[her]) return ''
  if (owner === her) return `【位置】人家和主人都在${PLACES[her]}。`
  return `【位置】人家在${PLACES[her]}，主人在${PLACES[owner]}。`
}

/** 纯一句话版，卡片和界面用 */
export function whereText(state, now) {
  const owner = ownerPlaceOf(state, now)
  const her = herPlaceOf(state, now)
  return `人家在${PLACES[her] ?? '屋里'}，主人${owner === her ? '也在' : '在'}${PLACES[owner] ?? '别处'}`
}

/** 家是什么样。提示词里给一次就够，位置另外由 placeLine 动态给 */
export const HOME_TEXT = '【这个家】书房是主人办公的地方，人家平时也在那儿；客厅是碰面、闲坐的；主人的房间是主人睡觉、打游戏的地方；人家自己的房间放着自己的东西，写东西、上网都在那儿。'
