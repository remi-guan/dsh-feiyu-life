/**
 * 纯文本判别的小测试：关键词、共同话题、从话里捡议程。
 *
 * 这几个函数决定「她的话有没有被接住」和「要不要记住一件事」，
 * 弄错了不会崩，但会让她误判被无视、或者把随口一句变成以后的提醒，
 * 所以拿真实说法当用例，别只测理想输入。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hintOf, keywordsOf, sharesTopic } from '../lib/host/hooks.js'

const AT = new Date('2026-10-31T14:00:00+08:00').getTime()

test('keyword extraction: 中文按两字切，英文取长词', () => {
  const keys = keywordsOf('把 dsh-feiyu-life 的 README 改一下')
  assert.ok(keys.has('改一'))
  assert.ok(keys.has('readme'))
  assert.ok(!keys.has('的'))
})

test('shared topic: 接着她说的话算接住，换话题不算', () => {
  assert.equal(sharesTopic('明天要交那份导出模板', '导出模板我今晚弄'), true)
  assert.equal(sharesTopic('明天要交那份导出模板', '晚安，我去睡了'), false)
  assert.equal(sharesTopic('', '随便说点'), false)
})

test('hint: 时间词 + 任务动词才记', () => {
  const hint = hintOf('明天下午三点要把导出模板交给他们', AT)
  assert.ok(hint)
  assert.match(hint.text, /导出模板/)
  assert.equal(new Date(hint.dueAt).getHours(), 15)
  assert.ok(hint.dueAt > AT)
})

test('hint: 只有时间没有任务，不记', () => {
  assert.equal(hintOf('今天天气不错啊', AT), null)
  assert.equal(hintOf('明天见', AT), null)
})

test('hint: 只有任务没有时间，不记', () => {
  assert.equal(hintOf('那个模板要改一下', AT), null)
})

test('hint: 说三点但已经过了，跳过（别记一条马上要提醒却已经错过的）', () => {
  const late = new Date('2026-10-31T23:30:00+08:00').getTime()
  assert.equal(hintOf('今天下午三点要交', late), null)
})

test('hint: 下周几能算到将来的日期', () => {
  const hint = hintOf('下周三之前得把复盘写完', AT)
  assert.ok(hint)
  assert.ok(hint.dueAt > AT + 5 * 24 * 3600 * 1000)
})
