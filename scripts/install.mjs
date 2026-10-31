/**
 * 把 dsh-feiyu-life 装进 desktop profile。
 *
 * 装法就三步（DSH 不是扫描 local-plugins 目录，是读 profile 的 bundles 列表）：
 *   1. profile 的 node_modules 里放一个软链，指向仓库本体
 *   2. package.json 的 dsh.profile.bundles 里加一条
 *   3. cordis.patch.yml 留一个 id 条目，将来要改配置有地方写
 *
 * 幂等：重复跑不会重复加。改之前备份两个文件。
 *
 * 用法：node scripts/install.mjs [--dry-run]
 */
import { copyFileSync, existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const PROFILE_JSON = join(PROFILE, 'package.json')
const PATCH_YML = join(PROFILE, 'cordis.patch.yml')
const LINK = join(PROFILE, 'node_modules', 'dsh-feiyu-life')
const PACKAGE_NAME = 'dsh-feiyu-life'
const ENTRY_ID = 'feiyu-life'

const dryRun = process.argv.includes('--dry-run')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)

function log(message) {
  console.log(`${dryRun ? '[dry] ' : ''}${message}`)
}

function backup(path) {
  if (dryRun || !existsSync(path)) return
  const target = `${path}.bak-${stamp}`
  copyFileSync(path, target)
  log(`备份 ${path} → ${target}`)
}

// 1) 软链
let current = ''
try {
  current = readlinkSync(LINK)
} catch {
  current = '' // 不存在，或已经是真目录
}
if (current === REPO) {
  log('软链已经对')
} else {
  if (current) log(`软链指向 ${current}，改成 ${REPO}`)
  else if (existsSync(LINK)) log(`${LINK} 已存在且不是指向仓库的软链，先手动处理`)
  else log(`建软链 ${LINK} → ${REPO}`)
  if (!current && existsSync(LINK)) {
    console.error('目标位置被别的东西占了，没有动它')
    process.exit(1)
  }
  if (!dryRun) {
    if (current) unlinkSync(LINK)
    symlinkSync(REPO, LINK, 'dir')
  }
}

// 2) bundles 列表
const profileJson = JSON.parse(readFileSync(PROFILE_JSON, 'utf8'))
const bundles = profileJson.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('profile package.json 里找不到 dsh.profile.bundles，先别自动改')
  process.exit(1)
}
if (!bundles.includes(PACKAGE_NAME)) {
  log('bundles 里加一条')
  if (!dryRun) {
    backup(PROFILE_JSON)
    bundles.push(PACKAGE_NAME)
    writeFileSync(PROFILE_JSON, `${JSON.stringify(profileJson, null, 2)}\n`, 'utf8')
  }
} else {
  log('bundles 里已经有')
}

// 3) patch 条目（只在缺失时追加；已存在则不动，避免覆盖主人的配置）
const patchText = existsSync(PATCH_YML) ? readFileSync(PATCH_YML, 'utf8') : ''
if (!new RegExp(`id:\\s*${ENTRY_ID}\\b`).test(patchText)) {
  log('cordis.patch.yml 追加 id 条目')
  if (!dryRun) {
    backup(PATCH_YML)
    const addition = `${patchText.endsWith('\n') ? '' : '\n'}- id: ${ENTRY_ID}\n  name: ${PACKAGE_NAME}\n`
    writeFileSync(PATCH_YML, patchText + addition, 'utf8')
  }
} else {
  log('patch 里已经有 id 条目')
}

log(dryRun ? '演练结束，没有改任何文件' : '装好了：重启 DSH 才生效')
