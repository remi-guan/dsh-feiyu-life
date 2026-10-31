/**
 * 出站台账：谁、什么时候、对主人说了什么。
 *
 * 主会话（主人正在聊的那个）和她（feiyu-life）本来是两个互不相干的出声口，
 * 于是出现过「主人问一句、主会话答一段、她过两分钟又补一条」的双发。
 * 这里记同一本账，两边都写、两边都读，谁刚说过话另一侧看得见。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { OUTBOX_PATH, diag } from './paths.js'

const MAX_ENTRIES = 40
/** 主会话说完话这几分钟内，她不再补一条。 */
export const MAIN_QUIET_MS = 5 * 60_000

function readAll() {
  try {
    const raw = JSON.parse(readFileSync(OUTBOX_PATH, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeAll(list) {
  try {
    mkdirSync(dirname(OUTBOX_PATH), { recursive: true })
    const tmp = `${OUTBOX_PATH}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(list.slice(-MAX_ENTRIES)), 'utf8')
    renameSync(tmp, OUTBOX_PATH)
  } catch (error) {
    diag(`出站台账没写成：${error && error.message}`)
  }
}

/**
 * 记一条出站消息。
 * @param {{from:'main'|'fish', channel?:'session'|'qq', text:string, at?:number, sessionId?:string}} entry
 */
export function appendOut(entry) {
  const text = String((entry && entry.text) || '').trim()
  if (!text) return null
  const item = {
    at: Number(entry.at) || Date.now(),
    from: entry.from === 'main' ? 'main' : 'fish',
    channel: entry.channel === 'session' ? 'session' : 'qq',
    text: text.slice(0, 400),
    sessionId: entry.sessionId ? String(entry.sessionId) : '',
  }
  const list = readAll()
  list.push(item)
  writeAll(list)
  return item
}

/**
 * 最近这段时间里某一侧说过的话（新的在前）。
 * @param {'main'|'fish'} from
 * @param {number} withinMs
 * @param {number} [now]
 */
export function recentFrom(from, withinMs, now = Date.now()) {
  return readAll()
    .filter(item => item && item.from === from && now - Number(item.at) <= withinMs)
    .slice(-6)
    .reverse()
}

/** 最近几条，不分谁说的（写进她的现状卡片用）。 */
export function recentAll(limit = 6, withinMs = 60 * 60_000, now = Date.now()) {
  return readAll()
    .filter(item => item && now - Number(item.at) <= withinMs)
    .slice(-limit)
    .reverse()
}
