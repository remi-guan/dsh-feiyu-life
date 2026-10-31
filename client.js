/**
 * dsh-feiyu-life · 浏览器半端：设置里的一页「鱼的生活」
 * ============================================================================
 * 自注册约定（和 dsh-feiyu-mood 一致）：
 *
 *   window.__ModuleLoader__.load({ id: 'dsh-feiyu-life', factory: (require) => ({ inject, apply }) })
 *
 * 所有数据只走 /dsh-feiyu-life/* （见 docs/INTERFACES.md 第三节）：
 *   GET  /state      → { ok, state, config }
 *   GET/POST /config → 读 / 改配置（POST 传 patch，宿主原地生效，不用重启）
 *   GET  /sessions   → { ok, sessions: [{ id, title, updatedAt }] }
 *   GET  /jobs       → { ok, jobs: [{ id, title, scheduledAt, status }] }
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-feiyu-life',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-feiyu-life'

    // 五档表情：阈值和 assets/widget.js 的 faceOf 保持一致
    const faceImg = (v) => {
      const m = Number(v)
      if (!Number.isFinite(m)) return API + '/face-ok.png'
      if (m >= 80) return API + '/face-great.png'
      if (m >= 62) return API + '/face-good.png'
      if (m >= 42) return API + '/face-ok.png'
      if (m >= 25) return API + '/face-worry.png'
      return API + '/face-sad.png'
    }

    const getJson = async (url) => {
      const res = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }
    const postJson = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    const two = (n) => (n < 10 ? '0' + n : String(n))
    const fmtTime = (t) => {
      if (!t) return '—'
      const d = new Date(t)
      return two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
    }
    const fmtDay = (t) => {
      if (!t) return '—'
      const d = new Date(t)
      return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate())
        + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
    }

    // 人家最近一次自己拿主意的理由，没有就空着
    const lastHeartReason = (snap) => {
      const h = snap && snap.heart
      const lh = h && h.lastHeart
      return lh && typeof lh.reason === 'string' ? lh.reason : ''
    }
    // 人家这会儿在干嘛：契约 §1 的 activity.kind，缺字段按 idle 算
    const ACTIVITY_WORDS = {
      idle: '闲着',
      chat: '在跟主人说话',
      work: '在干活',
      rest: '在休息',
      sleep: '睡着了',
    }
    const activityLine = (st) => {
      const act = st && st.activity
      const kind = (act && act.kind) || 'idle'
      const word = ACTIVITY_WORDS[kind] || ACTIVITY_WORDS.idle
      const note = act && typeof act.note === 'string' ? act.note : ''
      return '人家现在' + word + (note ? '（' + note + '）' : '')
    }
    // 两个人在哪个屋子：后端按行为算好，前端只管拼成一句话
    const placeLine = (st) => {
      const p = st && (st.place || (st.state && st.state.place))
      if (!p || !p.her) return ''
      if (!p.owner) return '人家在' + p.her
      if (p.owner === p.her) return '人家在' + p.her + '，主人也在'
      return '人家在' + p.her + '，主人在' + p.owner
    }
    // 心情一句话：只看心情和兴致两根
    const moodLine = (m, sp) => {
      if (!Number.isFinite(m)) return '还没读到，等会儿再看'
      const s = Number.isFinite(sp) ? sp : 55
      if (m >= 75 && s >= 60) return '这会儿松快，想说话'
      if (m < 35) return '有点沉，说话轻一点'
      if (s < 30) return '提不起劲，想安静待着'
      if (m >= 65) return '还行，人家在旁边'
      return '平常心，没什么起伏'
    }

    const JOB_WORDS = {
      idle: '排队中',
      scheduled: '排队中',
      pending: '排队中',
      running: '正在说',
      done: '已发出',
      fired: '已发出',
      failed: '没送出去',
      archived: '已归档',
      paused: '按住了',
    }
    const jobWord = (s) => JOB_WORDS[s] || (s || '—')

    const CSS = `
[data-fl-wrap]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;}
[data-fl-hero]{display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:12px;background:rgba(127,127,127,.08);}
[data-fl-face]{width:76px;height:60px;object-fit:contain;border-radius:10px;flex:0 0 auto;background:rgba(127,127,127,.10);}
[data-fl-line]{font-size:13px;line-height:1.6;}
[data-fl-meta]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;opacity:.72;margin-top:5px;}
[data-fl-sub]{font-size:12px;opacity:.66;margin-top:4px;}
[data-fl-sec]{display:flex;flex-direction:column;gap:9px;}
[data-fl-h]{font-size:13px;font-weight:600;opacity:.85;padding-top:8px;border-top:1px solid rgba(127,127,127,.18);}
[data-fl-note]{font-size:12px;opacity:.62;line-height:1.55;}
[data-fl-row]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-fl-grow]{flex:1;min-width:180px;}
[data-fl-label]{font-size:13px;}
[data-fl-input]{padding:6px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;min-width:120px;max-width:100%;}
[data-fl-num]{width:88px;min-width:88px;}
[data-fl-num2]{width:62px;min-width:62px;}
[data-fl-behctl]{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;}
[data-fl-inline]{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}
[data-fl-range]{width:170px;accent-color:#7aaadc;}
[data-fl-rangeval]{font-size:13px;width:48px;text-align:right;opacity:.85;}
[data-fl-btn]{padding:6px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;cursor:pointer;}
[data-fl-btn]:hover{background:rgba(127,127,127,.12);}
[data-fl-msg]{font-size:12px;opacity:.8;min-height:16px;}
[data-fl-foot]{display:flex;flex-direction:column;gap:6px;padding-top:10px;border-top:1px solid rgba(127,127,127,.18);}
[data-fl-jobrow]{display:flex;gap:8px;font-size:12px;line-height:1.6;align-items:baseline;}
[data-fl-jobtime]{opacity:.55;flex:0 0 88px;}
[data-fl-jobstate]{opacity:.75;flex:0 0 56px;}
[data-fl-jobtitle]{flex:1;overflow-wrap:anywhere;}
[data-fl-grant]{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:9px;background:rgba(127,127,127,.06);}
[data-fl-granthead]{display:flex;align-items:center;gap:8px;}
[data-fl-grantlabel]{font-size:13px;font-weight:600;}
[data-fl-tag]{font-size:11px;padding:1px 6px;border-radius:20px;background:rgba(127,127,127,.18);opacity:.8;white-space:nowrap;}
[data-fl-verb]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-fl-sublabel]{font-size:12px;display:flex;align-items:center;gap:6px;}
[data-fl-ask],[data-fl-addbox]{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:9px;border:1px solid rgba(127,127,127,.22);}
[data-fl-asktext]{font-size:13px;line-height:1.6;}
[data-fl-btnrow]{display:flex;gap:8px;}
[data-fl-sw]{width:16px;height:16px;accent-color:#7aaadc;}
[data-fl-form]{display:flex;gap:8px;flex-wrap:wrap;}
[data-fl-form] [data-fl-input]{flex:1;min-width:130px;}
`

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [st, setSt] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [jobs, setJobs] = React.useState([])
      const [msg, setMsg] = React.useState('')
      // 每个字段一个防抖计时器，两个滑块各拖各的不会互相清掉
      const [acting, setActing] = React.useState(false)
      const [addAsk, setAddAsk] = React.useState(false)
      const addId = React.useRef(null)
      const addLabel = React.useRef(null)
      const addFrom = React.useRef(null)
      const debounce = React.useRef({})

      const flash = (t) => {
        setMsg(t)
        setTimeout(() => setMsg(''), 2500)
      }

      const loadState = React.useCallback(async () => {
        try {
          const r = await getJson(API + '/state')
          if (r && r.ok !== false) {
            setSt(r)
            if (r.config) setCfg((c) => c || r.config)
          }
        } catch (e) {
          setMsg('读不到心情：' + (e && e.message))
        }
      }, [])

      const loadConfig = React.useCallback(async () => {
        try {
          const r = await getJson(API + '/config')
          if (r && r.config) {
            setCfg(r.config)
          }
        } catch (e) {
          setMsg('读不到设置：' + (e && e.message))
        }
      }, [])

      const loadJobs = React.useCallback(async () => {
        try {
          const r = await getJson(API + '/jobs')
          setJobs((r && r.jobs) || [])
        } catch (e) {
          setJobs([])
        }
      }, [])

      React.useEffect(() => {
        loadConfig()
        loadState()
        loadJobs()
        getJson(API + '/sessions')
          .then((r) => setSessions((r && r.sessions) || []))
          .catch(() => {})
        const a = setInterval(loadState, 20000)
        const b = setInterval(loadJobs, 45000)
        return () => {
          clearInterval(a)
          clearInterval(b)
          Object.keys(debounce.current || {}).forEach((k) => clearTimeout(debounce.current[k]))
        }
      }, [loadConfig, loadState, loadJobs])

      const patch = async (p, label) => {
        setCfg((c) => ({ ...c, ...p }))
        try {
          const r = await postJson(API + '/config', p)
          if (r && r.config) {
            setCfg(r.config)
          }
          flash((label || '设置') + ' 改好了')
        } catch (e) {
          flash('没写进去：' + (e && e.message))
        }
      }

      // 门路那套走 /action，不走 /config
      const act = async (p, label) => {
        if (acting) return
        setActing(true)
        try {
          const r = await postJson(API + '/action', p)
          if (r && r.ok === false) throw new Error(r.error || '没成')
          flash(label || '好了')
          await loadState()
        } catch (e) {
          flash('没成：' + ((e && e.message) || '网络不通'))
        }
        setActing(false)
      }

      if (!cfg) return h('div', { 'data-fl-wrap': '' }, h('div', { 'data-fl-note': '' }, '读取中…'))

      const sw = (key, label) => h('input', {
        type: 'checkbox',
        checked: Boolean(cfg[key]),
        onChange: (e) => patch({ [key]: e.target.checked }, label),
      })

      const numField = (key, label, note, min, max, fallback) => h('div', { 'data-fl-row': '' },
        h('div', { 'data-fl-grow': '' },
          h('div', { 'data-fl-label': '' }, label),
          note ? h('div', { 'data-fl-note': '' }, note) : null),
        h('input', {
          'data-fl-input': '', 'data-fl-num': '', type: 'number', min, max,
          value: String(cfg[key] ?? (fallback === undefined ? '' : fallback)),
          onChange: (e) => setCfg((c) => ({ ...c, [key]: e.target.value })),
          onBlur: () => {
            const cur = cfg[key] ?? fallback
            const raw = Number(cur)
            const n = Number.isFinite(raw) ? Math.max(min, Math.min(Math.round(raw), max)) : min
            if (n !== cur) patch({ [key]: n }, label)
          },
          onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
        }))

      const textField = (key, label, note, placeholder) => h('div', { 'data-fl-row': '' },
        h('div', { 'data-fl-grow': '' },
          h('div', { 'data-fl-label': '' }, label),
          note ? h('div', { 'data-fl-note': '' }, note) : null),
        h('input', {
          'data-fl-input': '', type: 'text', value: String(cfg[key] ?? ''), placeholder: placeholder || '',
          onChange: (e) => setCfg((c) => ({ ...c, [key]: e.target.value })),
          onBlur: () => patch({ [key]: cfg[key] }, label),
          onKeyDown: (e) => { if (e.key === 'Enter') e.currentTarget.blur() },
        }))

      const target = cfg.targetSession || ''
      const known = (sessions || []).some((s) => s.id === target)
      const snap = (st && st.state) || {}
      // 行为目录：id 和 BEHAVIORS.md 第一节一致，缺省值照契约
      const BEHAVIORS = [
        { id: 'talk', label: '说两句', cap: 8, cooldown: 60 },
        { id: 'journal', label: '写点东西', cap: 2, cooldown: 60 },
        { id: 'browse', label: '出去逛逛', cap: 2, cooldown: 240 },
        { id: 'continue', label: '接着干活', cap: 3, cooldown: 60 },
        { id: 'help', label: '搭把手', cap: 2, cooldown: 60 },
      ]
      const behaviorsCfg = cfg.behaviors && typeof cfg.behaviors === 'object' ? cfg.behaviors : {}
      const behOf = (id) => {
        const b = behaviorsCfg[id]
        return b && typeof b === 'object' ? b : {}
      }
      // 改一个行为的任何一个键都整块发 behaviors
      const patchBehavior = (id, p, label) =>
        patch({ behaviors: { ...behaviorsCfg, [id]: { ...behOf(id), ...p } } }, label)

      // /state 里的今日用量，字段缺了只是不显示，不报错
      const snapBehaviors = Array.isArray(snap.behaviors) ? snap.behaviors : []
      const behToday = (id) => {
        const b = snapBehaviors.find((x) => x && x.id === id)
        const used = b && Number(b.used)
        return Number.isFinite(used) && used > 0 ? String(used) + ' 次' : ''
      }

      // —— 门路 ——
      const grants = Array.isArray(snap.grants) ? snap.grants : []
      const asks = Array.isArray(snap.pendingAsks) ? snap.pendingAsks : []

      const verbRow = (g, v) => h('div', { 'data-fl-verb': '', key: g.id + ':' + v.verb },
        h('div', { 'data-fl-grow': '' },
          h('div', { 'data-fl-sublabel': '' }, v.label || v.verb || '—',
            v.granted === true
              ? null
              : h('span', { 'data-fl-tag': '' }, v.needAsk ? '人家得先问' : '还没给')),
          v.how ? h('div', { 'data-fl-note': '' }, v.how) : null),
        h('input', {
          'data-fl-sw': '', type: 'checkbox',
          'aria-label': (g.id || '') + ':' + (v.verb || ''),
          checked: v.granted === true,
          disabled: acting,
          onChange: (e) => act({
            action: 'grant-set', use: g.id, verb: v.verb, on: e.target.checked,
          }, (v.label || v.verb) + (e.target.checked ? ' 给了' : ' 收回了')),
        }))

      const grantBlock = (g) => h('div', { 'data-fl-grant': '', 'data-fl-use': g.id || '', key: g.id || g.label },
        h('div', { 'data-fl-granthead': '' },
          h('span', { 'data-fl-grantlabel': '' }, g.label || g.id || '（没名字）'),
          g.private ? h('span', { 'data-fl-tag': '' }, '不外传') : null),
        (g.from || g.account)
          ? h('div', { 'data-fl-note': '' }, [g.from, g.account].filter(Boolean).join(' · '))
          : null,
        (Array.isArray(g.verbs) ? g.verbs : []).map((v) => verbRow(g, v)),
        (Array.isArray(g.limits) && g.limits.length)
          ? h('div', { 'data-fl-note': '' }, '边界：' + g.limits.join('、'))
          : null)

      const askBlock = (a) => h('div', { 'data-fl-ask': '', 'data-fl-askid': a.id || '', key: a.id || a.text },
        h('div', { 'data-fl-asktext': '' }, '「' + (a.text || '') + '」'),
        h('div', { 'data-fl-note': '' },
          (a.label ? '想用「' + a.label + '」' : '想用一条门路') + (a.why ? '：' + a.why : '')),
        h('div', { 'data-fl-btnrow': '' },
          h('button', {
            'data-fl-btn': '', 'data-fl-approve': '', type: 'button', disabled: acting,
            onClick: () => act({ action: 'grant-approve', id: a.id }, '给了'),
          }, '给人家'),
          h('button', {
            'data-fl-btn': '', 'data-fl-deny': '', type: 'button', disabled: acting,
            onClick: () => act({ action: 'grant-deny', id: a.id }, '先算了'),
          }, '先算了')))

      const readAdd = (ref) => (ref.current && ref.current.value ? String(ref.current.value).trim() : '')

      const addGrant = () => {
        const id = readAdd(addId).toLowerCase()
        const label = readAdd(addLabel)
        const from = readAdd(addFrom)
        if (!id || !label) {
          flash('id 和名称都要填')
          return
        }
        act({
          action: 'grant-add', id, label, from,
          verbs: [{ verb: 'look', label: '看看', how: '', needAsk: Boolean(addAsk), granted: true }],
        }, '加上了')
        ;[addId, addLabel, addFrom].forEach((r) => { if (r.current) r.current.value = '' })
      }

      const behRow = (b) => {
        const cur = behOf(b.id)
        const today = behToday(b.id)
        return h('div', { 'data-fl-row': '', key: b.id },
          h('div', { 'data-fl-grow': '' },
            h('div', { 'data-fl-label': '' }, b.label),
            h('div', { 'data-fl-note': '' }, today ? '今天做过 ' + today : '今天还没做')),
          h('div', { 'data-fl-behctl': '' },
            h('label', { 'data-fl-inline': '' },
              h('input', {
                type: 'checkbox',
                checked: cur.enabled !== false,
                disabled: acting,
                onChange: (e) => patchBehavior(b.id, { enabled: e.target.checked }, b.label + '开关'),
              }),
              '开')))
      }

      return h('div', { 'data-fl-wrap': '' },

        /* ── 一句话：现在的心情 ── */
        h('div', { 'data-fl-hero': '' },
          h('img', { 'data-fl-face': '', src: faceImg(st && st.state && st.state.mood), alt: '' }),
          h('div', { 'data-fl-grow': '' },
            h('div', { 'data-fl-line': '' }, moodLine(Number(snap.mood), Number(snap.spirit))),
            h('div', { 'data-fl-meta': '' },
              placeLine(snap) ? h('span', {}, placeLine(snap) + ' · ') : null,
              h('span', {}, activityLine(snap))),
            (() => {
              const note = lastHeartReason(snap)
              if (!note) return null
              return h('div', { 'data-fl-sub': '' }, note,
                st && st.state && st.state.updatedAt
                  ? '（' + fmtDay(st.state.updatedAt) + ' 更新）'
                  : '')
            })())),

        /* ── 投递到哪 ── */
        h('div', { 'data-fl-sec': '' },
          h('div', { 'data-fl-h': '' }, '发到哪里'),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '目标会话策略'),
              h('div', { 'data-fl-note': '' },
                (cfg.sessionMode || 'pinned') === 'recent'
                  ? '跟最近说话的会话走，下面那栏只在找不到时兜底'
                  : '固定发到下面选的会话')),
            h('select', {
              'data-fl-input': '', value: cfg.sessionMode || 'pinned',
              onChange: (e) => patch({ sessionMode: e.target.value }, '目标会话策略'),
            },
              h('option', { value: 'pinned' }, '固定一个会话'),
              h('option', { value: 'recent' }, '跟最近说话的会话走'))),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '目标会话'),
              h('div', { 'data-fl-note': '' },
                target && known
                  ? '当前：' + ((sessions.find((s) => s.id === target) || {}).title || target)
                  : target
                    ? '当前：' + target + '（不在会话列表里，可能已经归档）'
                    : '当前：没选，宿主会用 DSH_SESSION_ID 兜底')),
            h('select', {
              'data-fl-input': '', value: target,
              onChange: (e) => patch({ targetSession: e.target.value }, '目标会话'),
            },
              h('option', { value: '' }, '（不指定，用默认会话）'),
              (sessions || []).map((s) => h('option', { key: s.id, value: s.id }, s.title || s.id)),
              target && !known
                ? h('option', { value: target }, '（当前：' + target.slice(0, 18) + '…）')
                : null))),

        /* ── 人家住在哪 ── */
        h('div', { 'data-fl-sec': '' },
          h('div', { 'data-fl-h': '' }, '人家住在哪'),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '人家自己的会话'),
              h('div', { 'data-fl-note': '' },
                '人家的行为、写东西、上网都在这个会话里跑，不占主人的对话')),
            h('select', {
              'data-fl-input': '', value: cfg.workSession || '',
              onChange: (e) => patch({ workSession: e.target.value }, '人家的会话'),
            },
              h('option', { value: '' }, '跟主人同一个会话'),
              (sessions || []).map((x) => h('option', { key: x.id, value: x.id }, x.title || x.id)),
              (cfg.workSession && !(sessions || []).some((x) => x.id === cfg.workSession))
                ? h('option', { value: cfg.workSession }, '（当前：' + String(cfg.workSession).slice(0, 18) + '…）')
                : null)),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '想说话时发到哪'),
              h('div', { 'data-fl-note': '' }, '发到手机上就用 QQ；说进会话就直接落在主人的对话里')),
            h('select', {
              'data-fl-input': '', value: cfg.talkChannel || 'session',
              onChange: (e) => patch({ talkChannel: e.target.value }, '说话通道'),
            },
              h('option', { value: 'qq' }, '说到手机 QQ 上'),
              h('option', { value: 'session' }, '说进主人的会话'))),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '在主对话里留一行近况'),
              h('div', { 'data-fl-note': '' }, '开着的话，人家做事时会往主人的会话里写一行进度；关掉就完全不注入')),
            sw('progressReport', '留近况'))),

        /* ── 开关和模式 ── */
        h('div', { 'data-fl-sec': '' },
          h('div', { 'data-fl-h': '' }, '说不说话'),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '总开关'),
              h('div', { 'data-fl-note': '' }, '关掉就什么都不发了，心情照记')),
            sw('enabled', '总开关')),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '模式'),
              h('div', { 'data-fl-note': '' }, '正常 = 该说就说；只记账 = 心情照记，不主动开口；关掉 = 整个停住')),
            h('select', {
              'data-fl-input': '', value: cfg.mode || 'normal',
              onChange: (e) => patch({ mode: e.target.value }, '模式'),
            },
              h('option', { value: 'normal' }, '正常'),
              h('option', { value: 'quiet' }, '只记账，不说话'),
              h('option', { value: 'off' }, '关掉'))),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '把心情告诉它'),
              h('div', { 'data-fl-note': '' }, '开着的话，它开口前会看到一行现在的心情，口气会跟着变')),
            sw('injectMood', '注入心情')),
          h('div', { 'data-fl-row': '' },
            h('div', { 'data-fl-grow': '' },
              h('div', { 'data-fl-label': '' }, '心情注入方式'),
              h('div', { 'data-fl-note': '' },
                '上面关掉就一句都不注入；这里选频率：心情变了才说一句 / 每轮都说 / 不注入')),
            h('select', {
              'data-fl-input': '', value: cfg.injectMode || 'on-change',
              onChange: (e) => patch({ injectMode: e.target.value }, '注入方式'),
            },
              h('option', { value: 'on-change' }, '变了才注入'),
              h('option', { value: 'every-turn' }, '每轮一句'),
              h('option', { value: 'off' }, '不注入')))),

        /* ── 人家自己拿主意 ── */
        h('div', { 'data-fl-sec': '' },
          h('div', { 'data-fl-h': '' }, '人家自己拿主意'),
          numField('heartMinMinutes', '最短间隔（分钟）',
            '两次自己想事之间最少隔这么久（1–1440）', 1, 1440, 1),
          numField('heartMaxMinutes', '最长间隔（分钟）',
            '最多等这么久就叫人家想想（1–1440）', 1, 1440, 60),
          numField('heartDefaultMinutes', '默认间隔（分钟）',
            '平时按这个间隔来（1–1440）', 1, 1440, 20),
          textField('heartProvider', '模型服务（可留空）',
            '留空就不用管，跟人家正在用的会话一致', ''),
          textField('heartModel', '模型（可留空）',
            '留空就不用管，跟人家正在用的会话一致', '')),

        /* ── 门路 ── */
        h('div', { 'data-fl-sec': '' },
          h('div', { 'data-fl-h': '' }, '门路'),
          h('div', { 'data-fl-note': '' },
            '人家只能用手上这些去替主人做事；开关是主人给的，关掉就不能再碰。'),
          grants.length
            ? grants.map(grantBlock)
            : h('div', { 'data-fl-note': '' }, '还没给过人家什么'),
          asks.length
            ? h('div', { 'data-fl-h': '' }, '在等主人答应')
            : null,
          asks.map(askBlock),
          h('div', { 'data-fl-addbox': '' },
            h('div', { 'data-fl-sublabel': '' }, '加一条门路'),
            h('div', { 'data-fl-note': '' }, 'id 用小写短名；说明写谁的账号或者从哪来的，人家会照着边界来。'),
            h('div', { 'data-fl-form': '' },
              h('input', { 'data-fl-input': '', type: 'text', placeholder: 'id，比如 bili', ref: addId }),
              h('input', { 'data-fl-input': '', type: 'text', placeholder: '名称，比如 B站', ref: addLabel }),
              h('input', { 'data-fl-input': '', type: 'text', placeholder: '一句说明，比如 主人自己的账号', ref: addFrom }),
              h('label', { 'data-fl-inline': '' },
                h('input', {
                  'data-fl-needask': '', type: 'checkbox', checked: addAsk,
                  onChange: (e) => setAddAsk(e.target.checked),
                }),
                '要不要先问'),
              h('button', {
                'data-fl-btn': '', 'data-fl-addgrant': '', type: 'button', disabled: acting,
                onClick: addGrant,
              }, '加上')))),

        /* ── 做什么：行为选择 ── */
        h('div', { 'data-fl-sec': '' },
          h('div', { 'data-fl-h': '' }, '做什么'),
          h('div', { 'data-fl-note': '' },
            '开关是主人给的；做不做、什么时候做，人家自己看一眼现状决定。'),
          BEHAVIORS.map(behRow)),

        /* ── 底部：主动消息是怎么来的 ── */
        h('div', { 'data-fl-foot': '' },
          h('div', { 'data-fl-note': '' },
            '人家的会话：' + (cfg.workSession ? String(cfg.workSession).slice(0, 10) + '…' : '跟主人同一个')),
          h('div', { 'data-fl-note': '' },
            '主动消息不是弹窗，是真的会话消息：每次它想说话，宿主都会建一条一次性定时任务，到点由那条任务把话送进上面的会话。下面是最近的 3 条。'),
          jobs.length
            ? jobs.slice(0, 3).map((j, i) => h('div', { 'data-fl-jobrow': '', key: j.id || i },
              h('span', { 'data-fl-jobtime': '' }, fmtTime(j.scheduledAt)),
              h('span', { 'data-fl-jobstate': '' }, jobWord(j.status)),
              h('span', { 'data-fl-jobtitle': '' }, j.title || '—')))
            : h('div', { 'data-fl-note': '' }, '还没有发过主动消息')),

        h('div', { 'data-fl-msg': '' }, msg),
      )
    }

    // 渲染出错时别留白屏：把错误摆出来，同时记到 window 上方便在 console 里查
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      componentDidCatch(err, info) {
        window.__feiyuLifeError = {
          message: String((err && err.message) || err),
          stack: String((err && err.stack) || ''),
        }
        console.error('dsh-feiyu-life: 设置页渲染失败', err, info)
      }
      render() {
        if (this.state.err) {
          const msg = String((this.state.err && this.state.err.message) || this.state.err)
          return h('div', { 'data-fl-wrap': '' },
            h('div', { 'data-fl-note': '' }, '这一页没渲染出来：'),
            h('div', { 'data-fl-note': '' }, msg),
            h('button', {
              'data-fl-btn': '', type: 'button',
              onClick: () => this.setState({ err: null }),
            }, '再试一次'))
        }
        return h(Panel)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-feiyu-life')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-feiyu-life: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'life', order: 40, label: '鱼的生活' },
          () => h(PanelBoundary),
        ))
      },
    }
  },
})
