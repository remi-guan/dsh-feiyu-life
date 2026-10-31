/**
 * 文件落盘与目录：配置、状态、日志。
 *
 * 为什么不用 ctx.storage.domain：那个服务和 profile 的组合顺序绑得很死，
 * 插件一旦在 storage 服务挂上去之前 apply 就会拿不到；这里只是一个几十 KB
 * 的 json，自己原子写更省事，DSH 重启时也不会留下悬空的 domain 记录。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** ~/.dsh，可用 DSH_HOME 覆盖（测试用）。 */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/** 插件自己的目录。 */
export const DATA_DIR = join(DSH_HOME, 'feiyu-life')

export const CONFIG_PATH = join(DATA_DIR, 'config.json')
export const STATE_PATH = join(DATA_DIR, 'state.json')
export const DIAG_PATH = join(DATA_DIR, 'diag.log')
/** 出站台账：主会话和她共用的「刚说过什么」 */
export const OUTBOX_PATH = join(DATA_DIR, 'outbox.json')

/** 默认配置。字段含义见 docs/INTERFACES.md 第四节。 */
export const DEFAULT_CONFIG = {
  targetSession: '',
  enabled: true,
  mode: 'normal',
  // v4：她自己的「心」——决定权在模型，宿主只执行。
  // 没有「规则档」了：什么时候开口、做什么，她自己看一眼现状决定。
  heartMinMinutes: 1,
  heartMaxMinutes: 60,
  heartDefaultMinutes: 20,
  heartProvider: '',
  heartModel: '',
  injectMood: true,
  judgeProvider: '',
  judgeModel: '',
  useLlmAppraisal: false,
  selfName: '小鱼',
  /** 自定义说出去的口气；填了就不用人设库那段 */
  styleText: '',
  /** 她自己的笔记目录（提示词里让她往这写东西） */
  herNotesDir: '~/.dsh/notes/女仆小鱼',
  /** 主人的笔记目录（提示词里让她把主人的偏好记到这） */
  ownerNotesDir: '~/.dsh/notes/主人',
  /** 日记目录：一天一篇，文件名叫日期 */
  diaryDir: '~/.dsh/notes/日记',
  ownerName: '主人',
  // ---- v2 ----
  injectMode: 'on-change',
  sessionMode: 'pinned',
  spiritFloor: 25,
  // 行为只剩开关：没有额度、没有冷却，做不做由她自己定
  behaviors: {
    talk: { enabled: true },
    checkin: { enabled: true },
    journal: { enabled: true },
    diary: { enabled: true },
    browse: { enabled: true },
    continue: { enabled: true },
    help: { enabled: true },
  },
  agenda: { enabled: true, maxItems: 20 },
  // ---- v6：她的行为搬进自己的会话，想说的话走 QQ ----
  // workSession 空串表示跟 targetSession 一样（旧行为）
  workSession: '',
  talkChannel: 'qq',
  progressReport: true,
}

/** 会话最近活动的落盘位置（recent 策略要用）。 */
export const SESSIONS_PATH = join(DATA_DIR, 'sessions.json')

function ensureDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* 目录已存在或无权创建：后面的写会自己报错 */
  }
}

/** 读一个 json 文件；不存在或坏掉时返回 fallback。 */
export function readJson(path, fallback) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : fallback
  } catch {
    return fallback
  }
}

/** 原子写：同目录 tmp + rename，写一半断电也不会留下半个 json。 */
export function writeJson(path, value) {
  ensureDir()
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/** 读配置，缺失的键用默认值补齐（老版本配置文件不会因为少字段炸掉）。 */
export function loadConfig() {
  const stored = readJson(CONFIG_PATH, {})
  return { ...DEFAULT_CONFIG, ...stored }
}

/** 覆盖式保存配置。 */
export function saveConfig(config) {
  writeJson(CONFIG_PATH, config)
}

/** 改一部分配置，返回改完的完整配置。 */
export function patchConfig(patch) {
  const current = loadConfig()
  const next = { ...current }
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (value === undefined || value === null) continue
    next[key] = typeof DEFAULT_CONFIG[key] === 'number' ? Number(value) : value
  }
  saveConfig(next)
  return next
}

/** 追加一行诊断日志（按天不切分，超过 1MB 时清空重来，避免无限长）。 */
export function diag(message) {
  try {
    ensureDir()
    const line = `${new Date().toISOString()}  ${String(message).replace(/\n/g, ' ')}\n`
    appendFileSync(DIAG_PATH, line, 'utf8')
    if (readFileSync(DIAG_PATH, 'utf8').length > 1024 * 1024) writeFileSync(DIAG_PATH, line, 'utf8')
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

/**
 * 主人第一次给她的门路。只读的「看看」直接给；
 * 收藏、点赞、点击这类写操作留成 ungranted + needAsk，让她自己来要（主人 2026-10-31 要求）。
 * 2026-10-31 追加：上网（任意网站只读）、主人的浏览器（lcu 只读开页）、跑命令与写自己的目录。
 */
export const DEFAULT_GRANTS = [
  {
    id: 'bili',
    label: 'B站',
    from: '主人 10月31日给的',
    account: '主人自己的账号',
    private: true,
    limits: ['不发表任何内容：不评论、不发弹幕、不发动态', '不关注、不私信、不改资料', '收藏夹和稍后再看里只加不删'],
    verbs: [
      { verb: 'look', label: '看看', how: '只读：搜视频、看推荐、翻播放记录', needAsk: false, granted: true },
      { verb: 'collect', label: '收藏', how: '把视频收进收藏夹', needAsk: false, granted: true },
      { verb: 'like', label: '点赞', how: '给视频点个赞', needAsk: false, granted: true },
      { verb: 'later', label: '稍后再看', how: '加进「稍后再看」，主人打开 B站 就能看到', needAsk: false, granted: true },
    ],
  },
  {
    id: 'web',
    label: '上网',
    from: '主人 10月31日给的',
    account: '公开网页，不登录',
    private: false,
    limits: [
      '银行、支付宝、邮箱、密码管理器、微信和飞书后台都不进',
      '不登录任何账号、不发评论、不填表单',
      '看到的东西记给自己看，不往外说',
    ],
    verbs: [
      {
        verb: 'look',
        label: '看看',
        how: 'curl -s https://r.jina.ai/<网址> 读正文（直连多半不通）；想读结构化数据先试 curl -s <网址>',
        needAsk: false,
        granted: true,
      },
      {
        verb: 'save',
        label: '存下来',
        how: '把看中的内容写进 ~/.dsh/feiyu-life/mine/ 下的一个 md 里，注明来源和时间',
        needAsk: false,
        granted: true,
      },
    ],
  },
  {
    id: 'browser',
    label: '主人的浏览器',
    from: '主人 10月31日给的',
    account: '主人的 Chrome，带着他的登录态',
    private: true,
    limits: [
      '不付款、不下单、不发评论、不改账号设置',
      '只在主人没用电脑的时候开，开完把标签收掉',
      '看到的东西不外传',
    ],
    verbs: [
      {
        verb: 'open',
        label: '开个页',
        how: '用 lcu 在主人的 Chrome 里开一个标签，读页面文字（只读，不点不填）',
        needAsk: false,
        granted: true,
      },
      {
        verb: 'click',
        label: '点一下',
        how: '翻页、滚动、点开一个视频或一篇文章——只导航，不提交、不支付',
        needAsk: true,
        granted: false,
      },
    ],
  },
  {
    id: 'shell',
    label: '跑命令',
    from: '主人 10月31日给的',
    account: '这台 Mac 上她自己的会话',
    private: false,
    limits: [
      '不删东西、不动 git 历史、不装全局依赖',
      '不改主人项目的代码，要看只看，要改先说',
      '不可逆的事停下来问',
    ],
    verbs: [
      {
        verb: 'run',
        label: '跑一下',
        how: '在 bash 里跑只读命令：ls、cat、grep、curl、node --test 这类',
        needAsk: false,
        granted: true,
      },
      {
        verb: 'write',
        label: '改文件',
        how: '写她自己的目录（~/.dsh/feiyu-life/、~/Projects/dsh-feiyu-life/）',
        needAsk: false,
        granted: true,
      },
    ],
  },
]
