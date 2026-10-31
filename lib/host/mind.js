/**
 * 她的「心」：一次模型调用，让她自己决定这一会儿干什么。
 *
 * v4 的关键就在于这层不判断对错、不给阈值——卡片递进去，决定她来做。
 * 宿主只负责把决定执行掉，以及几条防御硬线（见 index.js 的 forcedRest）。
 */
import { randomUUID } from 'node:crypto'
import { heartSystem } from '../core/heart.js'
import { diag } from './paths.js'

/** 上一次问她时错的原文（宿主拿它决定「是模型挂了」还是「登录态还没热」）。 */
let lastErrorText = ''
export function heartError() {
  return lastErrorText
}

/**
 * 挑一个模型：配置里选了就用配置的，否则跟着目标会话正在用的模型走。
 * @param {object} agent
 * @returns {{provider:string,model:string}|null}
 */
export function pickModel(agent) {
  try {
    const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader()
      : null
    const box = header && header.config
    if (box && box.provider && box.model) return { provider: box.provider, model: box.model }
  } catch {
    /* 拿不到就往下走 */
  }
  try {
    const options = agent && agent.options
    if (options && options.provider && options.model) {
      return { provider: options.provider, model: options.model }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * 定一个模型，按可信度排序：
 *   1. 设置里指定了就用指定的（主人挑的优先）；
 *   2. 目标会话这次请求用的 route（最贴近「她平时用哪个」）；
 *   3. 宿主默认模型服务。
 * 第 2 步在刚重启、会话还没发过请求时是空的，所以第 3 步不是可选项。
 * @param {object} ctx
 * @param {object} agent
 * @param {object} cfg
 * @returns {{provider:string,model:string}|null}
 */
export function resolveModel(ctx, agent, cfg) {
  if (cfg && cfg.heartProvider && cfg.heartModel) {
    return { provider: cfg.heartProvider, model: cfg.heartModel }
  }
  const fromSession = pickModel(agent)
  if (fromSession) return fromSession
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
    if (selection && selection.provider && selection.model) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch (error) {
    diag(`拿不到默认模型：${error && error.message}`)
  }
  return null
}

/**
 * 问她一句「这会儿你想做什么」。
 *
 * @param {object} args
 * @param {object} args.llm ctx.llm
 * @param {object} args.cfg
 * @param {string} args.card buildCard() 的产物
 * @param {{provider:string,model:string}|null} args.model
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.sessionId] 目标会话 id，账号型 provider 靠它归属请求
 * @returns {Promise<string|null>} 她的原话（未解析），失败返回 null
 */
export async function askHeart({ llm, cfg, card, model, signal, sessionId, extra = '' }) {
  if (!llm || typeof llm.stream !== 'function') {
    diag('没有 llm 服务，问不了心')
    return null
  }
  if (!model || !model.provider || !model.model) {
    diag('拿不到模型，问不了心')
    return null
  }
  const messages = [{
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: card }],
    source: { kind: 'plugin', plugin: 'feiyu-life' },
  }]
  let out = ''
  let sawText = false
  let finishReason = ''
  diag(`问她：provider=${model.provider} model=${model.model} session=${sessionId || '(无)'}`)
  try {
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      system: [heartSystem(cfg), String(extra ?? '').trim()].filter(Boolean).join('\n\n'),
      messages,
      // 不设输出上限：设小了会被 reasoning 吃光，一个字都吐不出来
      // 带上会话 id：账号型 provider 靠它把请求归到这次登录的会话上，缺了会报没登录
      ...(sessionId ? { sessionId } : {}),
      temperature: 0.8,
      signal,
    })) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') {
        out += chunk.text || ''
        sawText = true
      }
      if (chunk.type === 'finish' && chunk.reason) {
        finishReason = String(chunk.reason.kind || '')
        if (chunk.reason.kind === 'error') {
          lastErrorText = String(chunk.reason.failure?.message || 'unknown')
          diag(`问她的时候出错：${lastErrorText}`)
          return null
        }
      }
    }
  } catch (error) {
    lastErrorText = String((error && error.message) || 'unknown')
    diag(`问她的时候抛了：${lastErrorText}`)
    return null
  }
  if (!sawText || !out.trim()) {
    // 空输出不是错，但会让她整段「想不出来」。记下 finish 原因，再压一次温度重问：
    // deepseek-flash 在温度高、只让它吐 JSON 的时候偶尔会一个人字都不说。
    diag(`她这次什么都没说（空输出，finish=${finishReason || '无'}），压温度再问一次`)
    const nudge = '只输出那一个 JSON 对象，不要任何解释、不要代码块。'
    let again = ''
    try {
      for await (const chunk of llm.stream({
        provider: model.provider,
        model: model.model,
        system: [heartSystem(cfg), String(extra ?? '').trim(), nudge].filter(Boolean).join('\n\n'),
        messages,
        ...(sessionId ? { sessionId } : {}),
        temperature: 0.2,
        signal,
      })) {
        if (chunk && chunk.type === 'text-delta') again += chunk.text || ''
        if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          lastErrorText = String(chunk.reason.failure?.message || 'unknown')
          diag(`重问也失败：${lastErrorText}`)
          return null
        }
      }
    } catch (error) {
      diag(`重问抛了：${(error && error.message) || 'unknown'}`)
      return null
    }
    if (!again.trim()) {
      diag('重问还是空的，这一轮先不动')
      return null
    }
    diag('压温度重问拿到了决定')
    return again
  }
  return out
}
