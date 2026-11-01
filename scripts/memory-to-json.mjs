#!/usr/bin/env node
/**
 * 把记忆的 markdown 转成 json，给想拿去做统计或喂给别的脚本的人用。
 *
 * 记忆本身只存这一个 md（`~/.dsh/feiyu-life/memory-card.md`），json 是导出物，不是第二份真相。
 *
 *   node scripts/memory-to-json.mjs                     # 打到 stdout
 *   node scripts/memory-to-json.mjs -o /tmp/mem.json    # 写到文件
 *   node scripts/memory-to-json.mjs --pretty            # 缩进
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseMemoryMarkdown } from '../lib/core/memory.js'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : ''
}
const flag = (name) => args.includes(name)

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const input = opt('--in') || join(home, 'feiyu-life', 'memory-card.md')

let md = ''
try {
  md = readFileSync(input, 'utf8')
} catch (error) {
  console.error(`读不到 ${input}：${error.message}`)
  process.exit(1)
}

const now = Date.now()
const { records, broken } = parseMemoryMarkdown(md, now)
const payload = {
  source: input,
  exportedAt: new Date(now).toISOString(),
  count: records.length,
  broken,
  records: records.map((r) => ({
    text: r.text,
    clarity: r.clarity,
    tags: r.tags,
    importance: r.importance,
    createdAt: new Date(r.createdAt).toISOString(),
    lastSeenAt: new Date(r.lastSeenAt).toISOString(),
    recallCount: r.recallCount,
  })),
}

const json = JSON.stringify(payload, null, flag('--pretty') ? 2 : 0)
const out = opt('-o') || opt('--out')
if (out) {
  writeFileSync(out, `${json}\n`, 'utf8')
  console.error(`写了 ${records.length} 条到 ${out}`)
} else {
  process.stdout.write(`${json}\n`)
}
if (broken) console.error(`有 ${broken} 行没有元信息，按 fixme 记着了`)
