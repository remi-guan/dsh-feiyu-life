/**
 * 出站口气：人设从设置页那份库里读，格式规矩写在 core 里。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { outboundStyle, personaTail } from '../lib/core/prompt.js'

test('默认口径是手机消息：一句一件事，不用 markdown', () => {
  const text = outboundStyle({ ownerName: '主人' })
  assert.match(text, /一句一件事/)
  assert.match(text, /不用 markdown/)
  assert.match(text, /主人/)
})

test('配了 styleText 就整段替换默认口径', () => {
  assert.equal(outboundStyle({ styleText: '就一句话' }), '就一句话')
})

test('人设尾巴只取开头几条，不腰斩到半句话中间', () => {
  const persona = { text: Array.from({ length: 40 }, (_, i) => `第${i}条规矩。`).join('\n\n') }
  const tail = personaTail(persona, { maxLines: 5 })
  const lines = tail.split('\n')
  assert.equal(lines[0], '【你自己的说话习惯】')
  assert.equal(lines.length, 6, '头一条是标题，后面正好五条')
  for (const line of lines.slice(1)) assert.ok(line.endsWith('。'), '每条都是完整的一句')
})

test('人设里的框架行不进来，空行也压掉', () => {
  const tail = personaTail({
    text: 'You are an AI agent powered by DeepSeek Harness.\n\n人家是小鱼。\n\n先做事后卖萌。',
  })
  assert.equal(tail, '【你自己的说话习惯】\n人家是小鱼。\n先做事后卖萌。')
})

test('没人设就什么都不拼', () => {
  assert.equal(personaTail(null), '')
  assert.equal(personaTail({ text: '   ' }), '')
})

test('currentPersona 读设置页的人设库，current 指哪条就是哪条', async () => {
  const home = mkdtempSync(join(tmpdir(), 'feiyu-persona-'))
  const dir = join(home, 'storages', 'dsh-persona-dafeiyu')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'personas.json'), JSON.stringify({
    version: 1,
    current: 'b',
    personas: [
      { id: 'a', name: '阿茶', text: '甲' },
      { id: 'b', name: '小鱼', text: '人家是小鱼' },
    ],
  }))
  process.env.DSH_HOME = home
  const mod = await import(`../lib/host/persona.js?shadow=${Date.now()}`)
  const persona = mod.currentPersona()
  assert.equal(persona?.name, '小鱼')
  assert.equal(persona?.text, '人家是小鱼')
})
