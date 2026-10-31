/**
 * 把话送到主人手机上（QQ）。
 *
 * 为什么走 QQ 而不是往主会话里塞消息：她的心跳消息曾经直接投进主会话，
 * 结果是主人自己的对话里混进了 `[feiyu-life]` 这种哨兵文本。从现在起她想说的
 * 话走 QQ，主会话只留主人的对话。
 *
 * 发送用仓库里既有的 `~/.dsh/notify-qq.py`（QQ 官方 bot 私聊），不依赖
 * dsh-im 的地址和 token，脚本挂掉只影响这一条消息，不影响她别的行为。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { DSH_HOME } from './paths.js'

export const QQ_SCRIPT = join(DSH_HOME, 'notify-qq.py')

/**
 * @param {string} text
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function sendQQ(text, { timeoutMs = 25_000 } = {}) {
  // QQ 上一条塞三件事很别扭：她自己写的时候分行，一行就发一条。
  // 她说得起劲时能连着说四五句；再多就该拆成两轮了，不然像刷屏。
  const lines = String(text || '')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 5)
  if (lines.length <= 1) return sendOne(lines[0] || '', timeoutMs)
  return (async () => {
    for (const line of lines) {
      const result = await sendOne(line, timeoutMs)
      if (!result.ok) return result
    }
    return { ok: true }
  })()
}

function sendOne(body, timeoutMs) {
  if (!body) return Promise.resolve({ ok: false, error: '没什么可说的' })
  if (!existsSync(QQ_SCRIPT)) return Promise.resolve({ ok: false, error: `找不到 ${QQ_SCRIPT}` })
  return new Promise(resolve => {
    execFile('python3', [QQ_SCRIPT, body.slice(0, 1800)], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim().slice(0, 200)
        resolve({ ok: false, error: detail || 'QQ 没发出去' })
        return
      }
      const out = String(stdout || '').trim()
      if (out && !out.startsWith('sent')) {
        resolve({ ok: false, error: out.slice(0, 200) })
        return
      }
      resolve({ ok: true })
    })
  })
}
