/**
 * 人设从哪儿来：直接读 dsh-persona-dafeiyu 的人设库。
 *
 * 为什么不自己在 feiyu-life 里再存一份：主人改人设是在设置页改的，
 * 那边一改、这边另存一份就会慢慢对不上。这里只读，不写。
 *
 * 读不到就当没有——插件不该因为别人的库结构变了就挂掉。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DSH_HOME } from './paths.js'

const STORE_PATH = join(DSH_HOME, 'storages', 'dsh-persona-dafeiyu', 'personas.json')

let cache = { at: 0, value: null }

/**
 * 当前生效的人设（global 档）。
 * @returns {{id:string,name:string,text:string}|null}
 */
export function currentPersona() {
  try {
    const stamp = statSync(STORE_PATH).mtimeMs
    if (cache.at === stamp) return cache.value
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    const currentId = typeof raw?.current === 'string' ? raw.current : ''
    const found = (Array.isArray(raw?.personas) ? raw.personas : []).find((p) => p && p.id === currentId)
    const value = found && typeof found.text === 'string' && found.text.trim()
      ? { id: String(found.id), name: String(found.name ?? ''), text: found.text }
      : null
    cache = { at: stamp, value }
    return value
  } catch {
    return null
  }
}

/**
 * 人设的前几行，够定住口吻就行。
 * 整段一千多字塞进每次任务的 prompt 不划算，模型手里还有系统提示那一份。
 * @param {{text?:string}|null} persona
 * @param {number} [maxChars]
 */
export function personaHead(persona, maxChars = 320) {
  const text = String(persona?.text ?? '').trim()
  if (!text) return ''
  if (text.length <= maxChars) return text
  // 尽量在换行处截断，别把一句话腰斩
  const cut = text.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n')
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trim()
}
