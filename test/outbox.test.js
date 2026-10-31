/**
 * 出站台账：主会话和她共用的「刚说过什么」。
 * 台账写歪了，两边就会各说各的——双发那个 bug 就是从这来的。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'feiyu-outbox-'))
process.env.DSH_HOME = home

const { appendOut, recentFrom, recentAll, MAIN_QUIET_MS } = await import('../lib/host/outbox.js')
const { buildCard } = await import('../lib/core/heart.js')

before(() => {
  appendOut({ from: 'main', text: '这份报告我改完了', at: 1000 })
  appendOut({ from: 'fish', text: '主人，人家看到一颗流星', at: 2000 })
  appendOut({ from: 'main', text: '', at: 3000 })
})

test('空话不记账', () => {
  const all = recentAll(10, 10 * 60_000, 4000)
  assert.equal(all.length, 2, '空字符串那条不该写进去')
})

test('按时间窗只挑某一侧', () => {
  const main = recentFrom('main', MAIN_QUIET_MS, 2000)
  assert.equal(main.length, 1)
  assert.equal(main[0].text, '这份报告我改完了')
  assert.equal(recentFrom('main', 500, 2000).length, 0, '一秒前那次不在窗口里')
  const fish = recentFrom('fish', 60 * 60_000, 2000)
  assert.equal(fish[0].text, '主人，人家看到一颗流星')
})

test('台账会被写进她的卡片，两边都能看见', () => {
  const card = buildCard({ mood: 70, energy: 55 }, {
    now: 2000,
    recentOut: recentAll(4, 60 * 60_000, 2000),
  }, {})
  assert.match(card, /【大厅那边】/)
  assert.match(card, /主会话：这份报告我改完了/)
  assert.match(card, /人家：主人，人家看到一颗流星/)
})

test('台账只记正文，不记内部推理和过场话', async () => {
  const { assistantTextOf } = await import('../lib/index.js')
  const reasoning = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'Let me check the state first…' }] } },
  }
  assert.equal(assistantTextOf(reasoning), '', '推理块不是她说的话')
  const passed = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '' }, { type: 'tool-call', name: 'bash' }] } },
  }
  assert.equal(assistantTextOf(passed), '', '带工具调用的过场话不算')
  const answer = {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '改好了，重启生效了喵。' }] } },
  }
  assert.equal(assistantTextOf(answer), '改好了，重启生效了喵。')
})
