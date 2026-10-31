/**
 * 会话最近活动的小账本。
 *
 * 为什么需要：主动消息只能发到一个会话。固定一个「目标会话」在主人同时开几个
 * 会话时会失准——她在 A 里说了话、主人在 B 里接了一句，她会以为被无视，
 * 冷却翻倍，越等越不敢说。sessionMode = 'recent' 时改用这份账本挑最近发言的那个。
 *
 * 只存 {id, title, lastUserAt}，最多 20 条，落 ~/.dsh/feiyu-life/sessions.json。
 */
import { readJson, SESSIONS_PATH, writeJson } from './paths.js'

const MAX_SESSIONS = 20

/** 读账本，坏文件当空。 */
export function loadSessions() {
  const raw = readJson(SESSIONS_PATH, {})
  const list = raw && Array.isArray(raw.sessions) ? raw.sessions : []
  return list
    .filter(item => item && typeof item.id === 'string' && item.id)
    .map(item => ({
      id: item.id,
      title: typeof item.title === 'string' ? item.title : '',
      lastUserAt: Number(item.lastUserAt) || 0,
    }))
    .slice(0, MAX_SESSIONS)
}

/** 记一笔：这个会话刚有人说话。 */
export function noteSession(sessions, { id, title, at }) {
  if (!id) return sessions
  const rest = sessions.filter(item => item.id !== id)
  const merged = [{ id, title: title || '', lastUserAt: Number(at) || Date.now() }, ...rest]
  return merged.slice(0, MAX_SESSIONS)
}

export function saveSessions(sessions) {
  try {
    writeJson(SESSIONS_PATH, { sessions })
  } catch {
    /* 写不进去就算了，下次 tick 还会再记 */
  }
}

/** 最近说过话的会话 id（recent 策略的目标）。 */
export function latestSessionId(sessions) {
  let best = ''
  let bestAt = 0
  for (const item of sessions) {
    if (item.lastUserAt > bestAt) {
      bestAt = item.lastUserAt
      best = item.id
    }
  }
  return best
}
