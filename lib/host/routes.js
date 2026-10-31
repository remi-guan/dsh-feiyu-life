/**
 * /dsh-feiyu-life/* 的全部 HTTP 路由。
 *
 * 一个前缀路由 + 内部按子路径分发，而不是十几条 exact 路由：
 * 后者好处只是「重复注册会抛错」的早期报警，代价是注册表里一堆同族条目，
 * 排查时反而看不清。前缀路由已经足够，冲突也会被 webserver 直接抛。
 *
 * 注意：这些路由挂在全局鉴权之后，未授权请求一律 401，所以不能用 401
 * 判断「插件有没有加载」——要看 /state 能不能返回 JSON。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { diag } from './paths.js'

const PREFIX = '/dsh-feiyu-life'

/** 允许浏览器半端直接取的文件（防止路径穿越：白名单，不是拼接）。 */
const ASSET_FILES = new Map([
  ['feiyu.png', 'image/png'],
  ['face-great.png', 'image/png'],
  ['face-good.png', 'image/png'],
  ['face-ok.png', 'image/png'],
  ['face-worry.png', 'image/png'],
  ['face-sad.png', 'image/png'],
  ['widget.js', 'text/javascript; charset=utf-8'],
])

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读请求体（上限 256KB），坏 JSON 返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 注册路由。
 *
 * @param {object} options
 * @param {any} options.ctx 插件上下文（需要 webServer）
 * @param {string} options.packageRoot 包根目录（assets 在这里）
 * @param {{snapshot:Function, updateConfig:Function, action:Function, sessions:Function, jobs:Function}} options.controller
 * @returns {() => void} 卸载
 */
export function registerRoutes({ ctx, packageRoot, controller }) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const sub = url.pathname.slice(PREFIX.length) || '/'
    const method = (req.method || 'GET').toUpperCase()
    try {
      if (sub === '/state' && method === 'GET') return sendJson(res, 200, await controller.snapshot())
      if (sub === '/config' && method === 'GET') return sendJson(res, 200, { ok: true, config: controller.config() })
      if (sub === '/config' && method === 'POST') {
        const patch = await readJsonBody(req)
        return sendJson(res, 200, { ok: true, config: await controller.updateConfig(patch) })
      }
      if (sub === '/sessions' && method === 'GET') return sendJson(res, 200, { ok: true, sessions: controller.sessions() })
      if (sub === '/jobs' && method === 'GET') return sendJson(res, 200, { ok: true, jobs: await controller.jobs() })
      if (sub === '/action' && method === 'POST') {
        const body = await readJsonBody(req)
        const result = await controller.action(String((body && body.action) || ''), body || {})
        return sendJson(res, result && result.ok === false ? 400 : 200, result)
      }
      const name = sub.startsWith('/') ? sub.slice(1) : sub
      const type = ASSET_FILES.get(name)
      if (type && method === 'GET') {
        const buffer = readFileSync(join(packageRoot, 'assets', name))
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buffer.length })
        res.end(buffer)
        return
      }
      sendJson(res, 404, { ok: false, error: `未知路径 ${sub}` })
    } catch (error) {
      diag(`路由 ${method} ${sub} 失败：${error && error.message}`)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error && error.message) })
      else res.destroy()
    }
  }

  return ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }))
}
