/**
 * 她自己的进度本：`~/.dsh/feiyu-life/progress.md`。
 *
 * 为什么要单独一份：她的行为已经不在主会话里跑了，主会话里问「进度怎么样」
 * 「刚才在干嘛」时，光看心情状态是不够的——行为过程是她的，主会话需要一份
 * 读得懂的记录。这个文件两边都读：宿主往里写，主会话被问到时可以直接翻。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

import { DATA_DIR } from './paths.js'
import { join } from 'node:path'

export const PROGRESS_PATH = join(DATA_DIR, 'progress.md')

/** 留多少行，多了从头砍（这是流水，不是档案）。 */
const MAX_LINES = 400

const pad = value => String(value).padStart(2, '0')

/** 2026-10-31 05:12 */
export const stampOf = (at) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 记一行。
 * @param {string} text 一句话，写清楚做了什么、为什么
 * @param {number} [at]
 */
export function appendProgress(text, at = Date.now()) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  if (!line) return null
  const record = `- ${stampOf(at)} · ${line.slice(0, 400)}`
  try {
    appendFileSync(PROGRESS_PATH, `${record}\n`)
    trim()
  } catch {
    return null
  }
  return record
}

function trim() {
  try {
    const text = readFileSync(PROGRESS_PATH, 'utf8')
    const lines = text.split('\n').filter(Boolean)
    if (lines.length <= MAX_LINES) return
    const kept = lines.slice(-MAX_LINES)
    writeFileSync(PROGRESS_PATH, `${kept.join('\n')}\n`)
  } catch {
    /* 砍不掉就算了，进度本坏了不该影响主流程 */
  }
}

/**
 * 最近的几条，最新的在最后。
 * @param {number} [limit]
 * @returns {string[]}
 */
export function recentProgress(limit = 8) {
  try {
    if (!existsSync(PROGRESS_PATH)) return []
    const lines = readFileSync(PROGRESS_PATH, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit)
  } catch {
    return []
  }
}

/**
 * 给主会话的几行摘要：心情、精力、手上在忙什么、最近做过的事。
 * 只写事实，不带阈值和规则——主会话里主人的问题由这几行回答。
 * @param {object} state
 * @param {object} cfg
 * @param {number} [now]
 * @returns {string}
 */
export function progressSnapshot(state, cfg, now = Date.now()) {
  if (!state) return ''
  const mood = Math.round(state.mood)
  const spirit = Math.round(state.spirit ?? 55)
  const parts = [`心情 ${mood}，兴致 ${spirit}`]
  const activity = state.activity && state.activity.kind
  if (activity === 'work' && state.activity.note) parts.push(`手上在忙：${state.activity.note}`)
  else if (activity === 'sleep') parts.push('主人像是睡了')
  else if (activity === 'idle') parts.push('没什么事，闲着')
  const last = state.lastBehavior && state.lastBehavior.id
  if (last) parts.push(`刚做过：${last}`)
  const works = Array.isArray(state.openWork) ? state.openWork.length : 0
  if (works > 0) parts.push(`挂着 ${works} 件主人交代的活`)
  const recent = recentProgress(3)
  const body = recent.length > 0 ? `\n最近：\n${recent.join('\n')}` : ''
  const head = `（${cfg?.selfName || '小鱼'}这会儿——${parts.join('，')}）`
  return `${head}${body}`
}
