/**
 * 她走手机 QQ 说话时，主会话正在聊天不该把她捂死。
 *
 * 单独一个文件、单独一个进程：宿主模块是单例，挂在同一个进程里会互相污染
 * （上一轮的异步收尾会回写 state.json）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'feiyu-life-qq-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'feiyu-life'), { recursive: true })

const SID = 'session-test-qq'
const fetched = []
let intervalFn = null

globalThis.fetch = async (url, init) => {
  if (init && init.body) fetched.push({ url: String(url), body: JSON.parse(init.body) })
  if (!init || !init.body) return { ok: true, status: 200, json: async () => ({ jobs: [] }) }
  return { ok: true, status: 201, json: async () => ({ job: { id: `job-${fetched.length}` } }) }
}

const ctx = {
  get: (name) => (name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
    : undefined),
  webServer: { getOrigin: () => 'http://127.0.0.1:59998', register: () => () => {} },
  agents: {
    list: () => [{
      session: { id: SID, meta: { title: '测试会话' }, requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }) },
      ctx: { on: () => () => {}, systemPrompt: { context: () => () => {} } },
    }],
  },
  systemPrompt: { context: () => () => {} },
  on() {},
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  interval(fn) { intervalFn = fn; return () => {} },
}

let mod
before(async () => { mod = await import('../lib/index.js') })

test('走 QQ 说话时，主会话在聊天不该把她捂死', async () => {
  const { appendOut } = await import('../lib/host/outbox.js')
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"speak","text":"主人，人家这边安静半天了，随便说一句","reason":"想跟他说说","nextMinutes":20}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  writeFileSync(join(home, 'feiyu-life', 'config.json'), JSON.stringify({
    targetSession: SID, enabled: true, mode: 'normal',
    talkChannel: 'qq', workSession: SID,
    injectMood: true, selfName: '小鱼', ownerName: '主人',
  }), 'utf8')
  const now = Date.now()
  writeFileSync(join(home, 'feiyu-life', 'state.json'), JSON.stringify({
    version: 3, mood: 90, spirit: 85, updatedAt: now - 3_600_000, lastDecayAt: now,
    timeline: [], lastUserAt: now - 30_000, lastSpeakAt: 0, spokeAt: [], nextWakeAt: 0,
    activity: { kind: 'idle', note: '', since: now }, pendingIntent: null,
  }), 'utf8')
  // 假的 QQ 发送口：不发真消息，只验证她的话走到这条出口
  writeFileSync(join(home, 'notify-qq.py'), 'print("sent")\n', 'utf8')
  // 主会话刚刚在跟主人说话：这条不该影响她发手机消息
  appendOut({ from: 'main', channel: 'session', text: '报告改完了，第七节那个数我换了来源', at: now })

  mod.apply(ctx, {})
  await intervalFn()
  const { recentFrom } = await import('../lib/host/outbox.js')
  const started = Date.now()
  while (!recentFrom('fish', 60_000).length && Date.now() - started < 1500) {
    await new Promise(r => setTimeout(r, 20))
  }

  assert.equal(fetched.length, 0, '写好原话就走 QQ 直发，不排任务')
  const fish = recentFrom('fish', 60_000)
  assert.equal(fish.length, 1, '她的话应该从 QQ 这条出口出去')
  assert.equal(fish[0].channel, 'qq')
})
