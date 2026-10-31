import test from 'node:test'
import assert from 'node:assert/strict'

import { blankState, normalizeState } from '../lib/core/state.js'
import {
  describeGrants,
  grantAddTaken,
  grantSetVerb,
  askPush,
  askResolve,
  askExpire,
  looksLikeYes,
  grantPrompt,
} from '../lib/core/grants.js'

const DAY = new Date(2026, 9, 31, 15, 0, 0).getTime()
const HOUR = 3600000

const biliSpec = {
  id: 'bili',
  label: 'B站',
  from: '主人 10月31日给的',
  account: '主人自己的账号',
  private: true,
  limits: ['不评论、不关注、不私信'],
  verbs: [
    { verb: 'look', label: '看看', how: '只读：搜视频、看推荐、翻播放记录', needAsk: false, granted: true },
    { verb: 'collect', label: '收藏', how: '把视频收进收藏夹', needAsk: true },
  ],
}

function stateWithGrant() {
  const s = blankState(DAY)
  grantAddTaken(s, biliSpec, DAY)
  return s
}

test('没有门路时描述为空串', () => {
  assert.equal(describeGrants(blankState(DAY), {}), '')
})

test('卡片行写清能干什么、哪些要先问', () => {
  const line = describeGrants(stateWithGrant(), {})
  assert.equal(
    line,
    '门路：B站 —— 看看（只读：搜视频、看推荐、翻播放记录）、收藏（要先问主人）',
  )
})

test('同一 id 重复加入只合并不重复，已给的权限不会被收回', () => {
  const s = stateWithGrant()
  grantAddTaken(s, { ...biliSpec, verbs: [{ verb: 'collect', label: '收藏', needAsk: true }] }, DAY + HOUR)
  assert.equal(s.grants.length, 1)
  assert.equal(s.grants[0].verbs.length, 2)
  assert.equal(s.grants[0].verbs[0].granted, true)
  assert.equal(s.grants[0].limits.length, 1)
})

test('grantSetVerb 开关某条权限，找不到返回 false', () => {
  const s = stateWithGrant()
  assert.equal(grantSetVerb(s, 'bili', 'collect', true, DAY), true)
  assert.equal(s.grants[0].verbs[1].granted, true)
  assert.equal(s.grants[0].verbs[1].grantedAt, DAY)
  assert.equal(grantSetVerb(s, 'bili', 'collect', false, DAY + 1), true)
  assert.equal(s.grants[0].verbs[1].granted, false)
  assert.equal(grantSetVerb(s, 'nope', 'collect', true, DAY), false)
  assert.equal(grantSetVerb(s, 'bili', 'upload', true, DAY), false)
})

test('askPush 压一条待答请求，带 id、过期时间和原话兜底', () => {
  const s = stateWithGrant()
  const ask = askPush(s, { use: 'bili', verb: 'collect', why: '想把晚点看的收起来' }, DAY, {})
  assert.ok(ask)
  assert.match(ask.id, /^k-/)
  assert.equal(ask.expiresAt, DAY + 24 * HOUR)
  assert.equal(ask.granted, undefined)
  assert.match(ask.text, /收藏/)
  assert.equal(s.pendingAsks.length, 1)
})

test('askPush 三条拒绝：已经给过、已有待答、当天已求过', () => {
  const given = stateWithGrant()
  grantSetVerb(given, 'bili', 'collect', true, DAY)
  assert.equal(askPush(given, { use: 'bili', verb: 'collect' }, DAY, {}), null)

  const pending = stateWithGrant()
  assert.ok(askPush(pending, { use: 'bili', verb: 'collect' }, DAY, {}))
  assert.equal(askPush(pending, { use: 'bili', verb: 'collect' }, DAY + HOUR, {}), null)

  const asked = stateWithGrant()
  const first = askPush(asked, { use: 'bili', verb: 'collect' }, DAY, {})
  askResolve(asked, first.id, false, DAY + HOUR)
  assert.equal(askPush(asked, { use: 'bili', verb: 'collect' }, DAY + 2 * HOUR, {}), null)
  // 第二天能再问
  assert.ok(askPush(asked, { use: 'bili', verb: 'collect' }, DAY + 26 * HOUR, {}))
})

test('askResolve 答应才落库，不答应只移出请求', () => {
  const yes = stateWithGrant()
  const ask = askPush(yes, { use: 'bili', verb: 'collect' }, DAY, {})
  assert.equal(askResolve(yes, ask.id, true, DAY + 1000), true)
  assert.equal(yes.pendingAsks.length, 0)
  assert.equal(yes.grants[0].verbs[1].granted, true)
  assert.equal(yes.grants[0].verbs[1].grantedAt, DAY + 1000)

  const no = stateWithGrant()
  const ask2 = askPush(no, { use: 'bili', verb: 'collect' }, DAY, {})
  assert.equal(askResolve(no, ask2.id, false, DAY + 1000), true)
  assert.equal(no.pendingAsks.length, 0)
  assert.equal(no.grants[0].verbs[1].granted, false)
  assert.equal(askResolve(no, 'k-nope', true, DAY), false)
})

test('askExpire 只清过期的', () => {
  const s = stateWithGrant()
  const ask = askPush(s, { use: 'bili', verb: 'collect' }, DAY, {})
  assert.equal(askExpire(s, DAY + HOUR), 0)
  assert.equal(askExpire(s, DAY + 25 * HOUR), 1)
  assert.equal(s.pendingAsks.length, 0)
  assert.ok(ask)
})

test('looksLikeYes 认答应、否定和含糊都算没答应', () => {
  for (const yes of ['行', '行吧', '可以', '准了', '给你', '同意', '拿去用', '随你', '好呀']) {
    assert.equal(looksLikeYes(yes), true, yes)
  }
  for (const no of ['不行', '不可以', '别给你', '等等', '算了', '不用', '先不', '再想想', '']) {
    assert.equal(looksLikeYes(no), false, no)
  }
})

test('grantPrompt 带哨兵、边界、隐私和产物路径', () => {
  const s = stateWithGrant()
  const prompt = grantPrompt(s.grants[0], 'collect', s, { selfName: '小鱼', ownerName: '主人' })
  assert.equal(prompt.split('\n')[0], '[feiyu-life:grant:bili:collect]')
  assert.match(prompt, /不评论、不关注、不私信/)
  assert.match(prompt, /隐私/)
  assert.match(prompt, /mine\/bili\.md/)
  assert.match(prompt, /只记.*不记原文/)
  assert.match(prompt, /一句人话报告/)
  assert.match(prompt, /不提问/)
})

test('老 state 迁移后拿到空的 grants 和 pendingAsks', () => {
  const s = normalizeState({ mood: 60, dims: { happy: 2 } }, DAY)
  assert.deepEqual(s.grants, [])
  assert.deepEqual(s.pendingAsks, [])
})
