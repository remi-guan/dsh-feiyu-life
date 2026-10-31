/**
 * 会话账本：recent 策略靠它挑投递目标，挑错了她会以为被无视。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { latestSessionId, noteSession } from '../lib/host/sessions.js'

test('最近说话的排最前，重复说话不产生重复条目', () => {
  let book = []
  book = noteSession(book, { id: 'a', title: 'A', at: 100 })
  book = noteSession(book, { id: 'b', title: 'B', at: 200 })
  assert.equal(book[0].id, 'b')
  book = noteSession(book, { id: 'a', title: 'A', at: 300 })
  assert.deepEqual(book.map(item => item.id), ['a', 'b'])
  assert.equal(latestSessionId(book), 'a')
})

test('空账本没有目标，别返回 undefined', () => {
  assert.equal(latestSessionId([]), '')
  assert.deepEqual(noteSession([], { id: '', at: 1 }), [])
})

test('最多留 20 条', () => {
  let book = []
  for (let index = 0; index < 30; index += 1) book = noteSession(book, { id: `s${index}`, at: index })
  assert.equal(book.length, 20)
  assert.equal(book[0].id, 's29')
})
