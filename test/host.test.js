/**
 * 宿主半边的冒烟测试：不启动 DSH，用假 ctx 跑通「tick → 过门 → 排任务」。
 *
 * 只测接线最容易错的地方：
 *   1. 心情够了、门都开的时候，真的会往 timer-agent 排一条一次性任务
 *   2. 那条任务的 target.sessionId 是配置的会话，prompt 第一行带哨兵
 *   3. 哨兵消息进来时不当成「主人说话了」（沉默计时不被重置）
 *   4. 默认的静默时段里不许开口
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'


const home = mkdtempSync(join(tmpdir(), 'feiyu-life-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'feiyu-life'), { recursive: true })

const SID = 'session-test-1'
const fetched = []
let intervalFn = null
const handlers = {}

globalThis.fetch = async (url, init) => {
  // 只记真正排任务的请求；读台账那几次（GET）不记，免得干扰条数断言
  if (init && init.body) {
    fetched.push({ url: String(url), body: JSON.parse(init.body) })
  }
  if (!init || !init.body) {
    return { ok: true, status: 200, json: async () => ({ jobs: [] }), text: async () => '' }
  }
  return {
    ok: true,
    status: 201,
    json: async () => ({ job: { id: `job-${fetched.length}` } }),
    text: async () => '',
  }
}

function fakeAgent() {
  return {
    session: {
      id: SID,
      meta: { title: '测试会话' },
      // 「心」要拿模型：跟着会话在用的那个走
      requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
    },
    ctx: {
      on(event, callback) {
        handlers[event] = callback
        return () => {}
      },
      systemPrompt: { context: () => () => {} },
    },
  }
}

const agents = [fakeAgent()]

const ctx = {
  get: (name) => (name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
    : undefined),
  webServer: { getOrigin: () => 'http://127.0.0.1:59999', register: () => () => {} },
  agents: { list: () => agents },
  systemPrompt: { context: () => () => {} },
  on() {},
  effect(fn) {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  interval(fn) {
    intervalFn = fn
    return () => {}
  },
}

/** 写一份能立刻开口的状态：开心到冲动过线、没有冷却、没人理也不算被忽略。 */
function prime({
  mood = 92, spirit = 88,
  // 默认按老口径测：话投进会话、行为也在这个会话里跑。
  // 走 QQ / 独立工作会话的分支在专门的两条用例里测。
  talkChannel = 'session', workSession = SID,
} = {}) {
  writeFileSync(join(home, 'feiyu-life', 'config.json'), JSON.stringify({
    targetSession: SID,
    enabled: true,
    mode: 'normal',
    talkChannel,
    workSession,
    injectMood: true,
    selfName: '小鱼',
    ownerName: '主人',
  }), 'utf8')
  const now = Date.now()
  writeFileSync(join(home, 'feiyu-life', 'state.json'), JSON.stringify({
    version: 3,
    mood,
    spirit,
    updatedAt: now - 3_600_000,
    lastDecayAt: now,
    timeline: [],
    lastUserAt: 0,
    lastSpeakAt: 0,
    spokeAt: [],
    activity: { kind: 'idle', note: '', since: now },
    pendingIntent: null,
  }), 'utf8')
}

const STATE_FILE = join(home, 'feiyu-life', 'state.json')
const readState = () => JSON.parse(readFileSync(STATE_FILE, 'utf8'))

/** 造一条「已经说出去、等着被回」的消息（测反馈判定用）。 */
function primePending(text) {
  const state = readState()
  state.pendingIntent = { kind: 'share', seed: text, reason: text, createdAt: Date.now() - 60_000 }
  writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8')
}

/** 等一个条件成立（tick 里 spawn 是异步的，apply 时那次 tick 也不等）。 */
async function waitFor(check, timeoutMs = 1500) {
  const started = Date.now()
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

let mod
before(async () => {
  mod = await import('../lib/index.js')
})

after(() => {
  process.env.DSH_HOME = ''
})

test('主会话刚答过话，她就不再补一条', async () => {
  const { appendOut } = await import('../lib/host/outbox.js')
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"speak","text":"主人，人家也想说一句","reason":"想凑个热闹","nextMinutes":20}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  appendOut({ from: 'main', channel: 'session', text: '报告改完了，第七节那个数我换了来源', at: Date.now() })
  const statePath = join(home, 'feiyu-life', 'state.json')
  const pre = JSON.parse(readFileSync(statePath, 'utf8'))
  pre.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(pre), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  await waitFor(() => readState().lastHeart && readState().lastHeart.do !== undefined)

  assert.equal(fetched.length, 0, '大厅刚答过，她这句该咽回去')
  const state = readState()
  assert.equal(state.pendingIntent, null)
  assert.equal(state.lastHeart.do, 'failed', '被让位也算这一轮没成')
  // 台账是共用的：这条用例写了一条「主会话刚说话」，不清掉会连累后面所有用例
  writeFileSync(join(home, 'feiyu-life', 'outbox.json'), '[]', 'utf8')
})

test('她自己说要说话：排一条投递到目标会话的一次性任务', async () => {
  // 「心」的输出是宿主唯一的分支依据——规则档已经删了，这里直接喂一个决定
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"speak","text":"主人，人家刚想到个事","reason":"想说说","nextMinutes":20}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const before = JSON.parse(readFileSync(statePath, 'utf8'))
  before.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(before), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  await waitFor(() => fetched.length > 0)

  assert.equal(fetched.length, 1, '应该正好排了一条')
  const { url, body } = fetched[0]
  assert.match(url, /\/api\/dsh-timer-agent\/jobs$/)
  assert.equal(body.target.sessionId, SID)
  assert.equal(body.target.workdir, '')
  // 出站的 prompt 末尾钉着「手机消息」的口气，不然任务轮很容易写成小报告
  assert.match(body.prompt, /一句一件事/)
  assert.equal(body.prompt.split('\n')[0], '[feiyu-life]')
  assert.ok(body.prompt.includes('人家刚想到个事'), '要用她自己写好的原话')
  assert.ok(body.runAt > Date.now(), 'runAt 要在将来')
  assert.equal(body.kind, undefined, '不传 kind 就是默认的 agent 任务')

  const state = await waitFor(() => {
    const parsed = JSON.parse(readFileSync(join(home, 'feiyu-life', 'state.json'), 'utf8'))
    return parsed.pendingIntent ? parsed : null
  })
  assert.ok(state, '状态里应该记下这条待发的消息')
  assert.equal(state.pendingIntent.jobId, 'job-1')
  assert.ok(state.lastSpeakAt > 0)
})

test('哨兵消息不算主人说话，沉默计时不被重置', async () => {
  prime()
  fetched.length = 0
  mod.apply(ctx, {})
  const before = JSON.parse(readFileSync(join(home, 'feiyu-life', 'state.json'), 'utf8')).lastUserAt
  handlers['agent/inbox/inserted']({ message: { content: [{ type: 'text', text: '[feiyu-life]\n到点了' }], source: { kind: 'user' } } })
  const after = JSON.parse(readFileSync(join(home, 'feiyu-life', 'state.json'), 'utf8')).lastUserAt
  assert.equal(after, before)
})

test('主动消息被认真接住：lastReply.follows 为 true，不算被忽略', async () => {
  prime()
  primePending('那份导出模板')
  mod.apply(ctx, {})
  handlers['agent/inbox/inserted']({
    message: { content: [{ type: 'text', text: '导出模板我今晚弄，你别操心' }], source: { kind: 'user' } },
  })
  const state = await waitFor(() => (readState().lastReply ? readState() : null))
  assert.ok(state, '应该记下这次回应')
  assert.equal(state.lastReply.follows, true)
  assert.equal(state.pendingIntent, null, '回应过就不再挂着')
  assert.ok(state.timeline.some(entry => entry.kind === 'proactive-answered'))
})

test('敷衍一句就算没接住：follows 为 false，冷却会翻倍', async () => {
  prime()
  primePending('那份导出模板')
  mod.apply(ctx, {})
  handlers['agent/inbox/inserted']({
    message: { content: [{ type: 'text', text: '嗯' }], source: { kind: 'user' } },
  })
  const state = await waitFor(() => (readState().lastReply ? readState() : null))
  assert.ok(state)
  assert.equal(state.lastReply.follows, false)
})

test('主人话里带着时间+任务，会记进议程', async () => {
  prime()
  mod.apply(ctx, {})
  handlers['agent/inbox/inserted']({
    message: { content: [{ type: 'text', text: '明天下午三点要把导出模板交上去' }], source: { kind: 'user' } },
  })
  const state = await waitFor(() => {
    const parsed = readState()
    return parsed.agenda && parsed.agenda.length > 0 ? parsed : null
  })
  assert.ok(state, '应该挂上一件事')
  assert.equal(state.agenda[0].kind, 'remind')
  assert.ok(state.agenda[0].dueAt > Date.now())
})

test('她决定做点自己的事：排一条带行为哨兵的任务', async () => {
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"act","act":"journal","reason":"有点想写两句","nextMinutes":30}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(state), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const job = await waitFor(() => fetched.find(item => item.body && /^\[feiyu-life:behave:journal\]/.test(item.body.prompt || '')))
  assert.ok(job, '应该排一条行为任务')
  assert.equal(job.body.target.sessionId, SID)
  assert.ok(job.body.timeoutMinutes >= 8, '自己的事给足时间')
  const after = await waitFor(() => (readState().behaves && Object.keys(readState().behaves).length > 0 ? readState() : null))
  assert.ok(after, '今日用量要记一笔')
})

test('挂着的活她自己会接着忙，哨兵是 continue', async () => {
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"act","act":"continue","reason":"手上那件事还没完","nextMinutes":25}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.nextWakeAt = 0
  state.openWork = [{ id: 'w-1', text: '把导出模板做完', urgency: 0.9, createdAt: Date.now() }]
  writeFileSync(statePath, JSON.stringify(state), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const job = await waitFor(() => fetched.find(item => item.body && /^\[feiyu-life:behave:continue\]/.test(item.body.prompt || '')))
  assert.ok(job, '有挂着的活就该去接着忙')
  assert.match(job.body.prompt, /导出模板/, '提示词里要带上那件事')
})

test('recent 策略：挂上所有活着的会话，账本里最近说话的那个排第一', async () => {
  const otherHandlers = {}
  const otherAgent = {
    session: { id: 'session-test-2', meta: { title: '另一个会话' } },
    ctx: {
      on(event, callback) {
        if (event === 'agent/inbox/inserted') otherHandlers.inbox = callback
        return () => {}
      },
      systemPrompt: { context: () => () => {} },
    },
  }
  const ctx2 = { ...ctx, agents: { list: () => [agents[0], otherAgent] } }
  prime()
  const cfgPath = join(home, 'feiyu-life', 'config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfg.sessionMode = 'recent'
  writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8')

  mod.apply(ctx2, {})
  await intervalFn()
  assert.ok(otherHandlers.inbox, 'recent 策略要把所有活着的会话都挂上，不然听不到别的窗口')
  otherHandlers.inbox({ message: { content: [{ type: 'text', text: '我在另一个窗口里说话' }], source: { kind: 'user' } } })

  const book = await waitFor(() => {
    try {
      const parsed = JSON.parse(readFileSync(join(home, 'feiyu-life', 'sessions.json'), 'utf8'))
      return parsed.sessions && parsed.sessions[0] && parsed.sessions[0].id === 'session-test-2' ? parsed : null
    } catch {
      return null
    }
  })
  assert.ok(book, '最近说过话的会话要排到账本最前面，投递目标才不会认错')
})

test('主人交的活她自己记下来，不用界面手动加；同一件事不重复记', async () => {
  prime()
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const inbox = handlers['agent/inbox/inserted']
  assert.ok(inbox, '应该挂上了 inbox 监听')

  const say = (text) => inbox({ message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })

  say('帮我把导出模板做完')
  const first = await waitFor(() => {
    const live = readState().openWork || []
    return live.length > 0 ? live : null
  })
  assert.ok(first, '应该记下这件活')
  assert.match(first[0].text, /导出模板/)

  // 换个说法再说一遍：不该记成两条
  say('那个导出模板，帮我把导出模板弄完')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal((readState().openWork || []).length, 1, '同一件事不该记两遍')

  // 主人说做完了：最像的那条被划掉
  say('导出模板做完了')
  const left = await waitFor(() => {
    const live = (readState().openWork || []).filter(item => !item.doneAt)
    return live.length === 0 ? live : null
  })
  assert.ok(left, '说做完之后列表该空了')
})

test('被认真接住就退还一次额度；被敷衍则照扣', async () => {
  prime({ quietHours: '' })
  const statePath = join(home, 'feiyu-life', 'state.json')
  const now = Date.now()
  // 今天已经说过三次，第三次是排出去的那条
  const stamp = now - 60_000
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.spokeAt = [now - 3 * 3600_000, now - 2 * 3600_000, stamp]
  state.pendingIntent = { kind: 'share', text: '导出模板的报错人家看过了', createdAt: stamp, jobId: 'job-x' }
  writeFileSync(statePath, JSON.stringify(state), 'utf8')

  mod.apply(ctx, {})
  await intervalFn()
  const inbox = handlers['agent/inbox/inserted']
  const say = (text) => inbox({ message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } })

  say('导出模板那个报错我也看到了，谢谢你')
  const refunded = await waitFor(() => {
    const live = readState()
    return live.spokeAt.length === 2 ? live : null
  })
  assert.ok(refunded, '被接住应该退还这次额度')
  assert.ok(!refunded.spokeAt.includes(stamp), '被接住的那次从今天次数里划掉')
})

test('她自己拿主意：说要做就说，想歇着就歇着（同一套接线）', async () => {
  const replies = []
  ctx.llm = {
    stream: async function* () {
      const text = replies.shift() || '{"do":"nothing","reason":"不想动","nextMinutes":20}'
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }

  // ① 她想说话：真的排出一条任务，而且用的是她自己写的原话
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  replies.push('{"do":"speak","text":"主人，人家刚看到那个报错其实是个拼写错","reason":"有个发现想马上说","nextMinutes":15}')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const job = await waitFor(() => (fetched.length > 0 ? fetched[0] : null))
  assert.ok(job, '她说要说话，就该排一条任务')
  assert.ok(job.body.prompt.includes('拼写错'), 'prompt 里要有她自己的原话')
  assert.equal(job.body.target.sessionId, SID)
  const after = readState()
  assert.ok(after.nextWakeAt > Date.now(), '下一次叫醒要排到将来')

  // ② 她说不想动：什么都不排，只记一笔
  prime()
  const second = JSON.parse(readFileSync(statePath, 'utf8'))
  second.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(second), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(fetched.length, 0, '她说不想动就不该排任务')
  assert.equal(readState().lastHeart.do, 'nothing')
})

test('她求权限：话发出去，请求挂在她身上等主人答', async () => {
  ctx.llm = {
    stream: async function* () {
      const text = '{"do":"ask","use":"browser","verb":"click","why":"想翻下一页看看","nextMinutes":20}'
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const job = await waitFor(() => (fetched.length > 0 ? fetched[0] : null))
  assert.ok(job, '求权限也要真的发一条话给主人')
  assert.ok(job.body.prompt.includes('点一下'), '兜底原话要用中文名，不能是 click')
  const after = readState()
  assert.equal(after.pendingAsks.length, 1, '请求要挂在状态里')
  assert.equal(after.pendingAsks[0].use, 'browser')
  // 没答应之前她拿不到点击权限
  const grant = after.grants.find(item => item.id === 'browser')
  assert.equal(grant.verbs.find(v => v.verb === 'click').granted, false)
})

test('主人一句「行」就算答应了：权限落库，请求清空', async () => {
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.grants = [{
    id: 'browser', label: '主人的浏览器', from: '主人给的', account: '主人的', private: true, limits: [],
    verbs: [
      { verb: 'open', label: '开个页', how: '', needAsk: false, granted: true },
      { verb: 'click', label: '点一下', how: '', needAsk: true, granted: false },
    ],
  }]
  current.pendingAsks = [{
    id: 'k-test', use: 'browser', verb: 'click', label: '点一下',
    why: '想收藏', text: '主人，收藏权限能给人家吗？',
    askedAt: Date.now(), expiresAt: Date.now() + 24 * 3600_000,
  }]
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  mod.apply(ctx, {})
  handlers['agent/inbox/inserted']({
    message: { content: [{ type: 'text', text: '行，给你' }], source: { kind: 'user' } },
  })
  const state = await waitFor(() => (readState().pendingAsks.length === 0 ? readState() : null))
  assert.ok(state, '答应了就把请求清空')
  const grant = state.grants.find(item => item.id === 'browser')
  assert.equal(grant.verbs.find(v => v.verb === 'click').granted, true, '点击权限该给了')
  assert.ok(state.timeline.some(entry => entry.kind === 'grant-given'))
})

test('主人说「先不给」就真的不给', async () => {
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.grants = [{
    id: 'browser', label: '主人的浏览器', from: '主人给的', account: '主人的', private: true, limits: [],
    verbs: [
      { verb: 'open', label: '开个页', how: '', needAsk: false, granted: true },
      { verb: 'click', label: '点一下', how: '', needAsk: true, granted: false },
    ],
  }]
  current.pendingAsks = [{
    id: 'k-test2', use: 'browser', verb: 'click', label: '点一下',
    why: '想收藏', text: '主人，收藏权限能给人家吗？',
    askedAt: Date.now(), expiresAt: Date.now() + 24 * 3600_000,
  }]
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  mod.apply(ctx, {})
  handlers['agent/inbox/inserted']({
    message: { content: [{ type: 'text', text: '先不给吧，再说' }], source: { kind: 'user' } },
  })
  const state = await waitFor(() => (readState().pendingAsks.length === 0 ? readState() : null))
  assert.ok(state)
  const grant = state.grants.find(item => item.id === 'browser')
  assert.equal(grant.verbs.find(v => v.verb === 'click').granted, false)
})

test('她想用已给的权限：排一条带门路哨兵的任务', async () => {
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"use","use":"bili","verb":"look","reason":"想看看主人最近在刷什么","nextMinutes":30}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.nextWakeAt = 0
  current.grants = [{
    id: 'bili', label: 'B站', from: '主人给的', account: '主人的', private: true,
    limits: ['不评论'], verbs: [{ verb: 'look', label: '看看', how: '只读', needAsk: false, granted: true }],
  }]
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const job = await waitFor(() => (fetched.length > 0 ? fetched[0] : null))
  assert.ok(job, '有权限就该真的排一条活')
  assert.ok(job.body.prompt.startsWith('[feiyu-life:grant:bili:look]'), 'prompt 第一行是门路哨兵')
  assert.ok(job.body.prompt.includes('不评论'), '边界要写进 prompt')
  assert.equal(job.body.target.sessionId, SID)
})

test('没给的权限她动不了：不排任务', async () => {
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"use","use":"browser","verb":"click","reason":"想翻下一页","nextMinutes":30}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.nextWakeAt = 0
  current.grants = [{
    id: 'browser', label: '主人的浏览器', from: '主人给的', account: '主人的', private: true, limits: [],
    verbs: [{ verb: 'click', label: '点一下', how: '', needAsk: true, granted: false }],
  }]
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(fetched.length, 0, '没答应的权限一条都不该排')
})

test('行为跑在她自己的会话里，不是主会话', async () => {
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"act","act":"journal","reason":"想写点东西","nextMinutes":30}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const WORK = 'session-work-1'
  prime({ workSession: WORK })
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const job = await waitFor(() => (fetched.length > 0 ? fetched[0] : null))
  assert.ok(job, '她决定写点东西，就该排一条活')
  assert.equal(job.body.target.sessionId, WORK, '行为任务投到工作会话，不是主会话')
  assert.equal(job.body.modelSelection.model, 'test-model', '每条任务都带模型，不然 resume 时会人设前缀的 {{model}} 没值')
})

test('走 QQ：写好原话就直接发出去，不排任务也不碰会话', async () => {
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"speak","text":"主人，人家刚想到一件事","reason":"想说说","nextMinutes":20}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime({ talkChannel: 'qq' })
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.nextWakeAt = 0
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  await waitFor(() => {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return parsed.lastHeart && parsed.lastHeart.do === 'failed'
  })
  assert.equal(fetched.length, 0, 'QQ 通道不排会话任务，话不进主会话')
  const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(parsed.lastHeart.do, 'failed', '测试环境没有 notify-qq.py，发不出去要如实记成失败')
})

test('说过的话不许再说一遍：重复就安静，不排任务也不发 QQ', async () => {
  const SAME = '主人，人家把这话记在手上了，能不能跟人家说说哪一步闪退'
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: JSON.stringify({ do: 'speak', text: `${SAME}？`, reason: '想再问问', nextMinutes: 20 }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime({ talkChannel: 'qq' })
  const statePath = join(home, 'feiyu-life', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  current.nextWakeAt = 0
  current.spoken = [{ at: Date.now() - 600_000, text: SAME }]
  writeFileSync(statePath, JSON.stringify(current), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  const done = await waitFor(() => {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    return parsed.lastHeart && parsed.lastHeart.do === 'nothing'
  })
  assert.ok(done, '重复的话要判成「没什么可说的」')
  assert.equal(fetched.length, 0, '重复的话不该再排一条任务')
  const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(parsed.spoken.length, 1, '被拦下的话不写进说过的话里')
})

test('主人刚说完话的这几分钟，她不另起一条', async () => {
  ctx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '{"do":"speak","text":"主人，人家想问问那个配置改好没","reason":"想问一句","nextMinutes":20}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.nextWakeAt = 0
  state.lastUserAt = Date.now() - 60_000   // 一分钟前主人刚说过话
  writeFileSync(statePath, JSON.stringify(state), 'utf8')
  fetched.length = 0
  mod.apply(ctx, {})
  await intervalFn()
  await new Promise(resolve => setTimeout(resolve, 200))
  const spoke = fetched.some(item => item.body && item.body.prompt && item.body.prompt.startsWith('[feiyu-life]'))
  assert.equal(spoke, false, '主人在说话的时候不该她再排一条')
  const after = readState()
  assert.equal(after.lastHeart.do, 'failed', '这一轮该被拦下，而不是当作说成了')
  assert.match(String(after.lastHeart.reason), /想问一句/, '她的理由还记着')
  assert.equal(after.pendingIntent, null, '被拦下就不该挂着待发')
})

test('她写的话也要守称呼：心的系统提示里带着「不许用你指主人」', async () => {
  let captured = ''
  ctx.llm = {
    stream: async function* (options) {
      captured = String(options && options.system)
      yield { type: 'text-delta', text: '{"do":"nothing","reason":"不想动","nextMinutes":20}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  prime()
  const statePath = join(home, 'feiyu-life', 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.nextWakeAt = 0
  state.lastUserAt = 0
  writeFileSync(statePath, JSON.stringify(state), 'utf8')
  mod.apply(ctx, {})
  await intervalFn()
  await waitFor(() => (captured ? captured : null))
  assert.match(captured, /不要用「你」指主人/, '心的提示词里要有这条硬规矩')
})
