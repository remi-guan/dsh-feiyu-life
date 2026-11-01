/**
 * 回话时的「状况单」。
 *
 * 醒来那一套（buildCard + wakeExtras）是给「她自己找话说」用的。主人在跟她说话时，
 * 她手上其实只有一句心情——不知道这是回话还是自己起的话头、不知道对方连发了几条、
 * 不知道上一段收在哪、也不知道这一轮该发几条。这张单子补的就是这段。
 *
 * 写它的时候刻意守着两条：
 *   1. 只放事实，不放结论。「他连着发了 4 条」是事实，「他有点急」是替人拿主意。
 *   2. 每一条都能对应一个动作。写一堆无关的数字只会稀释注意力，跟 wakes 里那些
 *      「此刻状态」是一个道理。
 */

export const DEFAULT_REPLY_BRIEF = {
  enabled: true,
  /** 多长时间里算「连着发」 */
  burstWindowMinutes: 10,
  /** 窗口内到几条算刷屏 */
  burstCount: 4,
  /** 正常一轮最多发几条 */
  maxMessages: 3,
  /** 刷屏那会儿收成一条 */
  burstMaxMessages: 1,
  /** 隔这么久没开口才算「又时隔很久」 */
  quietGapMinutes: 30,
}

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

export function normalizeReplyBrief(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const normalize = (value, fallback, min, max) => {
    const n = num(value, fallback)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  return {
    enabled: source.enabled !== false,
    burstWindowMinutes: normalize(source.burstWindowMinutes, DEFAULT_REPLY_BRIEF.burstWindowMinutes, 1, 120),
    burstCount: normalize(source.burstCount, DEFAULT_REPLY_BRIEF.burstCount, 2, 50),
    maxMessages: normalize(source.maxMessages, DEFAULT_REPLY_BRIEF.maxMessages, 1, 10),
    burstMaxMessages: normalize(source.burstMaxMessages, DEFAULT_REPLY_BRIEF.burstMaxMessages, 1, 10),
    quietGapMinutes: normalize(source.quietGapMinutes, DEFAULT_REPLY_BRIEF.quietGapMinutes, 1, 24 * 60),
  }
}

/**
 * 窗口内他说了几条。
 * @param {{at:number,who:string}[]} talk recentTalk
 * @param {'owner'|'fish'} who
 */
export function countBurst(talk, who, now, windowMs) {
  if (!Array.isArray(talk)) return 0
  return talk.filter(item => item && item.who === who && Number(item.at) >= now - windowMs).length
}

/** 「3 分钟前」这种说法；超过一小时就换成小时。 */
export function agoText(ms) {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/**
 * 拼这张单子。
 *
 * @param {object} input
 * @param {string} input.owner 主人的称呼
 * @param {string} [input.name] 她自己的名字
 * @param {number} input.now
 * @param {{at:number,who:string,text:string}[]} [input.talk] 最近的对话
 * @param {string} [input.lastUserText] 他最后一句
 * @param {number} [input.lastUserAt]
 * @param {number} [input.lastSpeakAt]
 * @param {string} [input.memory] 记忆简报（renderMemoryPrompt 的产物）
 * @param {string} [input.unfinished] 他没说完时的那句提醒
 * @param {string} [input.closure] 收尾相关的建议
 * @param {number} [input.openWorkCount]
 * @param {object} [input.config] 已经 normalize 过的配置
 * @returns {string}
 */
export function buildReplyBrief(input) {
  const cfg = normalizeReplyBrief(input && input.config)
  if (!cfg.enabled) return ''
  const now = num(input.now, Date.now())
  const owner = String(input.owner || '主人')
  const lines = []
  lines.push(`【这一轮】${owner}在跟你说话，你在回话，不是自己起的话头。`)

  const gap = input.lastUserAt ? now - Number(input.lastUserAt) : 0
  if (gap > cfg.quietGapMinutes * 60_000) {
    lines.push(`他上一次说话是${agoText(gap)}，中间隔了一阵子。`)
  }
  if (input.lastSpeakAt) {
    lines.push(`你上次开口是${agoText(now - Number(input.lastSpeakAt))}。`)
  }

  const burst = countBurst(input.talk, 'owner', now, cfg.burstWindowMinutes * 60_000)
  const maxMessages = burst >= cfg.burstCount ? cfg.burstMaxMessages : cfg.maxMessages
  if (burst >= cfg.burstCount) {
    lines.push(`他 ${cfg.burstWindowMinutes} 分钟里连发了 ${burst} 条，别一条一条回，攒成一条说。`)
  }
  lines.push(`这一轮最多发 ${maxMessages} 条，一条只说一件事。`)

  const said = String(input.lastUserText || '').trim()
  if (said) lines.push(`他最后一句：「${said.slice(0, 120)}」`)
  if (input.unfinished) lines.push(input.unfinished)
  if (input.closure) lines.push(input.closure)
  if (input.memory) lines.push(input.memory)
  if (num(input.openWorkCount, 0) > 0) {
    lines.push(`你手上还挂着 ${input.openWorkCount} 件没做完的事，他现在问的不是那些就先别扯。`)
  }
  return lines.join('\n')
}
