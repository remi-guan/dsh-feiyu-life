/**
 * 主动消息的唯一出口：往 dsh-timer-agent 的台账里放一条**一次性任务**。
 *
 * 为什么走定时任务而不是直接 agent.followup：
 *   1. 主人定的——主动消息必须能被「定时任务」面板看见、能取消、能追溯；
 *   2. 一次性任务触发后自己归档，平时台账里不留常驻任务，不会每分钟空转；
 *   3. target.sessionId 指到当前会话，消息进的是同一段对话，上下文连续。
 *
 * 失败绝不抛：打扰控制是锦上添花，挂了也不能把正在进行的对话拖垮。
 */
import { diag } from './paths.js'

/** 一次性任务在 now 之后多久触发（秒），避免和当前这一轮撞车。 */
const DELAY_SECONDS = 40

/**
 * 创建一条会投递到指定会话的一次性任务。
 *
 * @param {object} options
 * @param {string} options.origin 例如 http://127.0.0.1:50669
 * @param {string} options.prompt 自包含的 prompt
 * @param {string} options.title 面板里显示的名字
 * @param {string} options.sessionId 目标会话；空串则不投递（返回失败）
 * @param {number} [options.delaySeconds]
 * @returns {Promise<{ok:boolean, jobId?:string, error?:string}>}
 */
export async function spawnProactiveJob({ origin, prompt, title, sessionId, delaySeconds, timeoutMinutes, modelSelection }) {
  if (!sessionId) return { ok: false, error: '没有目标会话' }
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) {
    return { ok: false, error: `拿不到本机地址（${String(origin)}）` }
  }
  const runAt = Date.now() + Math.max(0, Number(delaySeconds ?? DELAY_SECONDS)) * 1000
  try {
    const response = await fetch(`${origin}/api/dsh-timer-agent/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        title,
        description: '由 dsh-feiyu-life 创建：她自己想说的话',
        prompt,
        runAt,
        target: { sessionId, workdir: '' },
        timeoutMinutes: Number(timeoutMinutes) > 0 ? Number(timeoutMinutes) : 10,
        // 必须带上模型：resume 一个没存过模型选择的会话时，preset 里的人设前缀
        // 写着「powered by the {{model}} model」，变量没值整轮就会失败。
        ...(modelSelection && modelSelection.provider && modelSelection.model
          ? { modelSelection: { provider: modelSelection.provider, model: modelSelection.model } }
          : {}),
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      diag(`创建主动消息任务失败：HTTP ${response.status} ${text.slice(0, 200)}`)
      return { ok: false, error: `HTTP ${response.status}` }
    }
    const body = await response.json().catch(() => ({}))
    const jobId = body && body.job && typeof body.job.id === 'string' ? body.job.id : ''
    diag(`已排一条主动消息任务 ${jobId}，${new Date(runAt).toISOString()} 触发`)
    return { ok: true, jobId }
  } catch (error) {
    diag(`创建主动消息任务异常：${error && error.message}`)
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/** 读最近的任务台账（界面用），失败时给空数组。 */
export async function listRecentJobs(origin, limit = 20) {
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) return []
  try {
    const response = await fetch(`${origin}/api/dsh-timer-agent/jobs`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return []
    const body = await response.json()
    const jobs = Array.isArray(body && body.jobs) ? body.jobs : []
    return jobs
      .filter(job => String(job.description || '').includes('dsh-feiyu-life'))
      .slice(-limit)
      .map(job => ({
        id: job.id,
        title: job.title,
        status: job.status,
        createdAt: typeof job.createdAt === 'number' ? job.createdAt : undefined,
        scheduledAt: job.schedule && job.schedule.nextRunAt ? job.schedule.nextRunAt : undefined,
      }))
  } catch {
    return []
  }
}
