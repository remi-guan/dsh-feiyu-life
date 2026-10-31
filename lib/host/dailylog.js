/**
 * 把主人说过的事落到纸面上：作息、吃了什么、做了什么。
 *
 * 只追加，不改写。写失败一律吞掉——记笔记是三件顺手事，
 * 不能因为它没写成，把正事那条消息也带崩。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DSH_HOME, diag } from './paths.js'

/** 配置里的目录可能写着 ~，fs 不认，得先展开 */
const expand = (p) => String(p).replace(/^~(?=\/|$)/, homedir())

const notesDir = (cfg) => expand(String(cfg?.ownerNotesDir ?? '').trim() || join(DSH_HOME, 'notes', '主人'))

/** 2026-11-01 03:39 */
function stamp(at) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function ensureFile(file, header) {
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, header, 'utf8')
}

/** 作息：他自己说的最后一句「去睡了 / 醒了」 */
export function appendRoutine(kind, at, cfg) {
  try {
    const file = join(notesDir(cfg), '12-作息.md')
    ensureFile(file, '# 12-作息\n\n她从主人自己说的话里认出来的。记的是「他这么说」的时刻，不当成已经睡着或者已经起来。\n\n')
    appendFileSync(file, `- ${stamp(at)} ${kind === 'sleep' ? '说去睡了' : '说醒了'}\n`, 'utf8')
  } catch (err) {
    diag(`作息没记上：${err?.message ?? err}`)
  }
}

/** 吃饭：她问完、主人答的那句原话 */
export function appendMeal(text, at, cfg) {
  try {
    const t = String(text ?? '').trim().replace(/\s+/g, ' ')
    if (!t) return
    const file = join(notesDir(cfg), '11-饮食习惯.md')
    ensureFile(file, '# 11-饮食习惯\n\n## 一问一答（她问出来的）\n\n')
    const body = readFileSync(file, 'utf8')
    if (!body.includes('## 一问一答')) {
      appendFileSync(file, `\n## 一问一答（她问出来的）\n\n`, 'utf8')
    }
    appendFileSync(file, `- ${stamp(at)} 主人说：${t.slice(0, 200)}\n`, 'utf8')
  } catch (err) {
    diag(`吃饭没记上：${err?.message ?? err}`)
  }
}

/** 动向：最近动态是倒序的，新的插在标题下面第一行 */
export function appendActivity(text, at, cfg) {
  try {
    const t = String(text ?? '').trim().replace(/\s+/g, ' ')
    if (!t) return
    const file = join(notesDir(cfg), '最近动态.md')
    ensureFile(file, '# 主人的最近动态（大约记 20 条，最新的在最上面）\n\n')
    const body = readFileSync(file, 'utf8')
    const lines = body.split('\n')
    const head = lines.findIndex((l) => l.startsWith('# '))
    if (head < 0) {
      appendFileSync(file, `${stamp(at)} ${t.slice(0, 200)}\n`, 'utf8')
      return
    }
    // 标题后面第一行插新的，旧内容整体往下走，保持「最新在最上面」
    const next = [
      ...lines.slice(0, head + 1),
      '',
      `${stamp(at)} ${t.slice(0, 200)}`,
      ...lines.slice(head + 1),
    ]
    writeFileSync(file, next.join('\n'), 'utf8')
  } catch (err) {
    diag(`动态没记上：${err?.message ?? err}`)
  }
}
