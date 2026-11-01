/**
 * 问她的时候断流了怎么办。
 *
 * 2026-11-01 真实事故：Clash 在请求中途重设系统 DNS，流被掐断，
 * DSH 报 `upstream stream ended before a completion event`，她那一轮直接空过去。
 * 现在传输层错误重试一次，登录态错误不重试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { askHeart } from '../lib/host/mind.js'

const card = '{"now":"2026-11-01T11:28:42Z"}'

/** 按脚本吐 chunk 的假 llm：每个元素是一次 stream 调用的行为。 */
function fakeLlm(steps) {
  let i = 0
  return {
    calls: [],
    async *stream(args) {
      const step = steps[i++] ?? { text: '{"do":"nothing"}' }
      this.calls.push(args)
      for (const chunk of step.chunks ?? []) yield chunk
      if (step.error) yield { type: 'finish', reason: { kind: 'error', failure: { message: step.error } } }
      else yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

const text = (t) => ({ type: 'text-delta', text: t })

test('流中途断掉会重试一次，重试拿到的不算失败', async () => {
  const llm = fakeLlm([
    { chunks: [text('{"do"')], error: 'upstream stream ended before a completion event; this turn may be incomplete' },
    { chunks: [text('{"do":"talk"}')] },
  ])
  const out = await askHeart({ llm, cfg: {}, card, model: { provider: 'p', model: 'm' }, retryDelayMs: 0 })
  assert.equal(out, '{"do":"talk"}')
  assert.equal(llm.calls.length, 2)
})

test('登录态错误不重试，直接放弃', async () => {
  const llm = fakeLlm([
    { error: 'Sign in to DeepSeek to use the account provider. The request destination must allow account authentication.' },
    { chunks: [text('{"do":"talk"}')] },
  ])
  const out = await askHeart({ llm, cfg: {}, card, model: { provider: 'p', model: 'm' }, retryDelayMs: 0 })
  assert.equal(out, null)
  assert.equal(llm.calls.length, 1)
})

test('两次都断，返回 null 而不是抛', async () => {
  const llm = fakeLlm([
    { error: 'upstream stream ended before a completion event' },
    { error: 'socket hang up' },
  ])
  const out = await askHeart({ llm, cfg: {}, card, model: { provider: 'p', model: 'm' }, retryDelayMs: 0 })
  assert.equal(out, null)
  assert.equal(llm.calls.length, 2)
})

test('空输出压温度重问一次（沿用老行为）', async () => {
  const llm = fakeLlm([
    { chunks: [] },
    { chunks: [text('{"do":"talk"}')] },
  ])
  const out = await askHeart({ llm, cfg: {}, card, model: { provider: 'p', model: 'm' }, retryDelayMs: 0 })
  assert.equal(out, '{"do":"talk"}')
  assert.equal(llm.calls.length, 2)
  assert.equal(llm.calls[1].temperature, 0.2)
})
