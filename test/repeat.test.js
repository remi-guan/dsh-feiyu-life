/**
 * 防重复：她说过的话不许原样（或换汤不换药地）再说一遍。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findRepeat, grams, normalize, similarity } from '../lib/core/repeat.js'

test('标点和空白不影响判断', () => {
  assert.equal(normalize('主人，人家 想你了！'), '主人人家想你了')
})

test('整句重复能抓出来', () => {
  assert.ok(similarity('主人，人家刚想起来一件事', '主人人家刚想起来一件事') > 0.9)
})

test('换了话题就不算重复', () => {
  assert.ok(similarity('主人该喝水了', '主人，人家想给你看个视频') < 0.3)
})

test('短句退回单字也认得出', () => {
  assert.deepEqual([...grams('好')], ['好'])
  assert.ok(similarity('好', '好') === 1)
})

test('findRepeat 认得十二小时内的旧话', () => {
  const now = Date.now()
  const said = [{ at: now - 3_600_000, text: '主人，人家把这话记在手上了，能不能跟人家说说哪一步闪退' }]
  const hit = findRepeat('主人，人家把这话记在手上了，能不能跟人家说说哪一步闪退？', said, { now })
  assert.equal(hit.repeat, true)
})

test('太久以前说过的不算（隔了半天可以换个话题重提）', () => {
  const now = Date.now()
  const said = [{ at: now - 20 * 3_600_000, text: '主人，人家把这话记在手上了' }]
  assert.equal(findRepeat('主人，人家把这话记在手上了', said, { now }).repeat, false)
})

test('空话、没记录都不算重复', () => {
  assert.equal(findRepeat('', [], {}).repeat, false)
  assert.equal(findRepeat('随便说一句', [], {}).repeat, false)
})
