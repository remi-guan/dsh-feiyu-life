// dsh-feiyu-life · 右下角立绘挂饰（纯 DOM，无构建，由宿主注入 /dsh-feiyu-life/widget.js）
// ---------------------------------------------------------------------------
// 和参考实现（dsh-feiyu-mood）的差别，都是为了修它那两个毛病：
//   · 轮询不再整页重绘：面板一次性搭好，之后只改文字 / 宽度 / 滚动区
//   · 面板改成 document.body 下的 fixed 层，按视口算边，不再用挂饰内的相对坐标
// 数据只有一个来源：GET /dsh-feiyu-life/state → {ok, state, gate, next, config}
// ---------------------------------------------------------------------------
;(function () {
  'use strict'
  if (window.__feiyuLifeInited) return
  window.__feiyuLifeInited = true

  var B = '/dsh-feiyu-life'
  var POLL_MS = 15000
  var POS_KEY = 'dsh-feiyu-life:corner'
  var TIMELINE_ROWS = 3
  var WORK_ROWS = 4

  // 行为 id 和 BEHAVIORS.md 第一节一致；契约里的 label 优先，缺了用这张表兜底
  var BEHAVIOR_IDS = ['talk', 'journal', 'browse', 'continue', 'help']
  var BEHAVIOR_LABELS = {
    talk: '说两句',
    journal: '写点东西',
    browse: '出去逛逛',
    continue: '接着干活',
    help: '搭把手',
  }


  // ---- 五档表情（阈值和 client.js 的 faceImg 保持一致）----
  function faceOf(m) {
    var v = Number(m)
    if (!isFinite(v)) v = 70
    if (v >= 80) return { file: 'face-great.png', label: '欢喜' }
    if (v >= 62) return { file: 'face-good.png', label: '开心' }
    if (v >= 42) return { file: 'face-ok.png', label: '一般' }
    if (v >= 25) return { file: 'face-worry.png', label: '担心' }
    return { file: 'face-sad.png', label: '难过' }
  }
  function faceSrc(m) {
    return B + '/' + faceOf(m).file
  }

  // ---- 文案都写成函数，不堆字符串数组 ----
  function quietLine() {
    return '安安静静待着，等主人叫人家'
  }
  function heartOf(d) {
    var h = pick(d, 'heart')
    return h && typeof h === 'object' ? h : null
  }

  function heartReason(d) {
    var lh = heartOf(d) && heartOf(d).lastHeart
    return lh && typeof lh.reason === 'string' ? lh.reason : ''
  }
  // 只剩两根轴，右边只给一个词
  function moodWord(v) {
    var n = Number(v)
    if (!isFinite(n)) return ''
    if (n >= 80) return '松快'
    if (n >= 65) return '好受'
    if (n >= 45) return '平常'
    if (n >= 25) return '有点沉'
    return '难受'
  }
  function spiritWord(v) {
    var n = Number(v)
    if (!isFinite(n)) return ''
    if (n >= 75) return '来劲'
    if (n >= 55) return '还行'
    if (n >= 35) return '有点蔫'
    if (n >= 15) return '蔫着'
    return '提不起劲'
  }
  function spiritColor(v) {
    if (v < 25) return '#e2827c'
    if (v < 45) return '#e0b070'
    return '#9fd8c8'
  }
  function two(n) {
    return n < 10 ? '0' + n : String(n)
  }
  function clock(t) {
    if (!t) return '--'
    var d = new Date(t)
    return two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
  }
  function deltaWord(v) {
    var n = Number(v) || 0
    if (n > 0) return '+' + n
    if (n < 0) return String(n)
    return '±0'
  }
  function clamp01(v) {
    var n = Number(v)
    if (!isFinite(n)) return 0
    return Math.max(0, Math.min(100, n))
  }

  // ---- CSS ----
  var css = [
    '.fl-widget{position:fixed;right:20px;bottom:20px;z-index:99990;line-height:0;margin:0}',
    '.fl-btn{position:relative;display:block;width:168px;height:168px;padding:0;border:0;',
    'background:transparent;cursor:grab;user-select:none;-webkit-user-select:none;',
    '-webkit-tap-highlight-color:transparent;line-height:0;transition:transform .18s ease,filter .18s ease}',
    '.fl-btn:hover{transform:translateY(-3px);filter:brightness(1.03)}',
    '.fl-btn:active{cursor:grabbing}',
    '.fl-btn:focus-visible{outline:2px solid #7aaadc;outline-offset:4px;border-radius:16px}',
    '.fl-body{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;',
    '-webkit-user-drag:none;filter:drop-shadow(0 6px 14px rgba(20,30,60,.26))}',

    '.fl-panel{position:fixed;left:0;top:0;z-index:99991;display:none;box-sizing:border-box;',
    'width:320px;max-width:calc(100vw - 16px);max-height:760px;max-height:min(92vh,760px);',
    'flex-direction:column;overflow:hidden;padding:10px 12px 8px;border-radius:14px;',
    'border:1px solid rgba(140,160,200,.28);background:rgba(24,27,34,.97);backdrop-filter:blur(10px);',
    'color:#e7ebf3;box-shadow:0 14px 38px rgba(0,0,0,.45);text-align:left;line-height:1.55;',
    'font:13px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.fl-panel img{pointer-events:none;-webkit-user-drag:none}',

    '.fl-gate{display:flex;gap:9px;align-items:flex-start;padding:6px 9px;border-radius:10px;',
    'background:rgba(122,170,220,.10);border:1px solid rgba(122,170,220,.20)}',
    '.fl-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:6px;background:#7a8088}',
    '.fl-dot[data-on]{background:#5ddc8a;box-shadow:0 0 0 3px rgba(93,220,138,.18)}',
    '.fl-key{font-size:11px;letter-spacing:.02em;color:#93a0b6}',
    '.fl-gateval{margin-top:2px;color:#dfe6f2;overflow-wrap:anywhere}',

    '.fl-nextline{display:flex;gap:8px;align-items:baseline;padding:5px 2px 0;overflow-wrap:anywhere}',
    '.fl-nextval{color:#c6cfdd;flex:1}',

    '.fl-head{display:flex;gap:10px;align-items:center;margin:6px 0 4px}',
    '.fl-face{width:54px;height:42px;object-fit:contain;flex:0 0 auto;border-radius:8px;background:rgba(140,160,200,.10)}',
    '.fl-mood{font-size:22px;font-weight:700;line-height:1.15}',
    '.fl-mood small{font-size:12px;font-weight:500;color:#9aa6bb;margin-left:6px}',
    '.fl-reason{color:#9aa6bb;margin-top:3px;font-size:12px;overflow-wrap:anywhere}',
    '.fl-place{color:#8b97ad;margin-top:4px;font-size:12px}',

    '.fl-dim{display:flex;align-items:center;gap:8px;margin:2px 0}',
    '.fl-dimlabel{width:36px;flex:0 0 36px;color:#9aa6bb;font-size:12px}',
    '.fl-bar{flex:1;height:6px;border-radius:4px;background:rgba(140,160,200,.18);overflow:hidden}',
    '.fl-bar i{display:block;height:100%;border-radius:4px;transition:width .35s ease}',
    '.fl-val{width:48px;text-align:right;color:#9aa6bb;flex:0 0 48px;font-size:12px;white-space:nowrap}',

    '.fl-wkmini{font-size:11px;color:#7c8598;margin:5px 0 2px}',
    '.fl-fact{font-size:11px;color:#8a93a6;padding:2px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fl-sec{font-weight:600;color:#c9d2e0;margin:5px 0 3px;font-size:12px;',
    'padding-top:4px;border-top:1px solid rgba(140,160,200,.16);display:flex;justify-content:space-between;gap:8px}',
    '.fl-sec span{font-weight:400;color:#8a93a6}',

    '.fl-tlrow{display:flex;gap:7px;padding:2px 0;align-items:baseline;border-bottom:1px solid rgba(140,160,200,.10)}',
    '.fl-tlrow:last-child{border-bottom:0}',
    '.fl-tltime{flex:0 0 78px;color:#7f8899;font-size:11px}',
    '.fl-tldelta{flex:0 0 34px;font-size:11px;color:#9aa6bb;font-variant-numeric:tabular-nums}',
    '.fl-tlreason{flex:1;overflow-wrap:anywhere;word-break:break-word;font-size:12px}',
    '.fl-note{color:#8a93a6;font-size:12px;padding:3px 0}',

    '.fl-scroll{flex:1;min-height:0;overflow:hidden;margin:0 -2px;padding:0 2px}',
    '.fl-tlbox{max-height:none;overflow:visible}',

    '.fl-askline{font-size:11px;color:#77808f;padding:0 0 3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fl-heart{font-size:11px;color:#9aa6bb;padding:0 0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fl-rest{font-size:11px;color:#7f8899;padding:0 0 4px}',
    '.fl-prog{display:flex;flex-direction:column;gap:1px}',
    '.fl-progrow{font-size:11px;color:#8a93a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fl-sec-mini{font-weight:600;color:#9aa6bb;margin:6px 0 2px;font-size:11px}',
    '.fl-thoughts{padding:1px 0 0}',
    '.fl-thought{font-size:11px;color:#7f8899;overflow-wrap:anywhere;padding:1px 0}',
    '.fl-last{font-size:11px;color:#8a93a6;padding:0 0 3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fl-beh{display:flex;align-items:center;gap:7px;padding:1px 0;white-space:nowrap}',
    '.fl-behlabel{flex:0 0 58px;font-size:12px;overflow:hidden;text-overflow:ellipsis}',
    '.fl-behstate{flex:0 0 84px;font-size:11px;color:#8a93a6;overflow:hidden;text-overflow:ellipsis}',
    '.fl-behbar{flex:1;min-width:40px;height:4px;border-radius:3px;background:rgba(140,160,200,.18);overflow:hidden}',
    '.fl-behbar i{display:block;height:100%;border-radius:3px;background:#8fb4e6;transition:width .35s ease}',
    '.fl-behoff .fl-behlabel{color:#6f7683}',
    '.fl-behoff .fl-behstate{color:#a58a8a}',

    '.fl-wk{display:flex;align-items:center;gap:6px;padding:1px 0;',
    'border-bottom:1px solid rgba(140,160,200,.10)}',
    '.fl-wk:last-child{border-bottom:0}',
    '.fl-wktext{flex:1;font-size:12px;overflow-wrap:anywhere;word-break:break-word}',
    '.fl-wkact{flex:0 0 auto;border:0;background:transparent;color:#6f7a8c;font:inherit;',
    'font-size:11px;line-height:1.2;padding:0 1px;cursor:pointer}',
    '.fl-wkact:hover{color:#cfd8e6}',
    '.fl-wkact.fl-wkdel:hover{color:#e0a0a0}',
    '.fl-wkact[disabled]{opacity:.4;cursor:default}',
    '.fl-wkmore{color:#6f7a8c;font-size:11px;padding:2px 0 0}',

    '.fl-acts{display:flex;gap:8px;margin-top:12px}',
    '.fl-act{flex:1;padding:7px 0;border:1px solid rgba(140,160,200,.35);border-radius:8px;',
    'background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:center}',
    '.fl-act:hover{background:rgba(140,160,200,.14)}',
    '.fl-act[disabled]{opacity:.5;cursor:default}',
    '.fl-wide{width:100%;flex:none;margin-top:8px}',
    '.fl-status{min-height:14px;margin-top:4px;font-size:11px;color:#93a0b6}',
  ].join('')

  var style = document.createElement('style')
  style.setAttribute('data-plugin-css', 'dsh-feiyu-life-widget')
  style.textContent = css
  document.head.appendChild(style)

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function img(src, cls, alt) {
    var n = document.createElement('img')
    n.src = src
    n.className = cls || ''
    n.alt = alt || ''
    n.draggable = false
    return n
  }

  // ---------------------------------------------------------------------
  // 挂饰
  // ---------------------------------------------------------------------
  var widget = el('div', 'fl-widget')
  var body = el('button', 'fl-btn')
  body.type = 'button'
  body.setAttribute('aria-label', '小鱼的生活')
  var bodyImg = img(B + '/feiyu.png', 'fl-body', '小鱼')
  body.appendChild(bodyImg)
  widget.appendChild(body)

  // ---------------------------------------------------------------------
  // 面板：一次性搭好，之后只改值
  // ---------------------------------------------------------------------
  var panel = el('div', 'fl-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '小鱼的心情')

  var ui = {}
  ui.tlSig = ''
  ui.wkSig = ''
  ui.faceFile = ''

  function makeBar(label, color, parent) {
    var row = el('div', 'fl-dim')
    row.appendChild(el('span', 'fl-dimlabel', label))
    var bar = el('div', 'fl-bar')
    var fill = el('i')
    if (color) fill.style.background = color
    bar.appendChild(fill)
    row.appendChild(bar)
    var val = el('span', 'fl-val', '0')
    row.appendChild(val)
    ;(parent || panel).appendChild(row)
    return { fill: fill, val: val, row: row }
  }

  function setBar(bar, v, word) {
    var n = clamp01(v)
    bar.fill.style.width = n + '%'
    bar.val.textContent = word === undefined ? String(Math.round(n)) : word
  }

  // 宿主算好的一条事实，最多显示一条
  function renderFacts(d) {
    var raw = pick(d, 'facts')
    var first = Array.isArray(raw)
      ? raw.filter(function (x) { return typeof x === 'string' && x.trim() })[0]
      : ''
    if (!first) {
      ui.factWanted = false
      ui.factLine.textContent = ''
      ui.factLine.style.display = 'none'
      return
    }
    ui.factWanted = true
    ui.factLine.textContent = first
    ui.factLine.title = first
    ui.factLine.style.display = ''
  }

  // —— 现在想说的话 ——
  var gateBox = el('div', 'fl-gate')
  ui.gateDot = el('span', 'fl-dot')
  var gateInner = el('div')
  gateInner.appendChild(el('div', 'fl-key', '现在想说的话'))
  ui.gateVal = el('div', 'fl-gateval', '读一下…')
  gateInner.appendChild(ui.gateVal)
  gateBox.appendChild(ui.gateDot)
  gateBox.appendChild(gateInner)
  panel.appendChild(gateBox)

  // —— 下次大概 ——
  var nextRow = el('div', 'fl-nextline')
  ui.nextKey = el('div', 'fl-key', '下次大概')
  nextRow.appendChild(ui.nextKey)
  ui.nextVal = el('div', 'fl-nextval', '等它自己算出来')
  nextRow.appendChild(ui.nextVal)
  panel.appendChild(nextRow)

  // —— 立绘表情 + 总心情 ——
  var head = el('div', 'fl-head')
  ui.face = img(B + '/face-ok.png', 'fl-face', '表情')
  head.appendChild(ui.face)
  var headText = el('div')
  ui.mood = el('div', 'fl-mood')
  ui.moodNum = el('span', '', '--')
  ui.moodLabel = el('small', '', '')
  ui.mood.appendChild(ui.moodNum)
  ui.mood.appendChild(ui.moodLabel)
  headText.appendChild(ui.mood)
  ui.place = el('div', 'fl-place', '')
  ui.place.style.display = 'none'
  headText.appendChild(ui.place)

  ui.reason = el('div', 'fl-reason', quietLine())
  headText.appendChild(ui.reason)
  head.appendChild(headText)
  panel.appendChild(head)

  // 中间这块滚动，标题和按钮钉住
  ui.scroll = el('div', 'fl-scroll')
  panel.appendChild(ui.scroll)

  // —— 她最近自己下的决定 ——
  ui.heartLine = el('div', 'fl-heart', '')
  ui.scroll.appendChild(ui.heartLine)

  ui.useLine = el('div', 'fl-askline', '')
  ui.useLine.style.display = 'none'
  ui.scroll.appendChild(ui.useLine)

  ui.askLine = el('div', 'fl-askline', '')
  ui.askLine.style.display = 'none'
  ui.scroll.appendChild(ui.askLine)

  ui.moodBar = makeBar('心情', '#8fb4e6', ui.scroll)
  ui.spiritBar = makeBar('兴致', '#9fd8c8', ui.scroll)

  // —— 宿主算好的一条事实 ——
  ui.factLine = el('div', 'fl-fact', '')
  ui.factLine.style.display = 'none'
  ui.scroll.appendChild(ui.factLine)

  // —— 连着没人接时她自己歇着 ——
  ui.restLine = el('div', 'fl-rest', '连着几次没人接，人家先自己歇着')
  ui.restLine.style.display = 'none'
  ui.scroll.appendChild(ui.restLine)

  // —— 她在做什么：最近一次 + 五个行为 ——
  var behHead = el('div', 'fl-sec')
  behHead.appendChild(el('div', '', '人家在做什么'))
  ui.behHead = behHead

  ui.scroll.appendChild(behHead)

  ui.lastVal = el('div', 'fl-last', '还没自己做过事')
  ui.scroll.appendChild(ui.lastVal)

  // 她自己的近况，两行就够，跟「最近一次」同属一个区块
  ui.progBox = el('div', 'fl-prog')
  ui.progBox.style.display = 'none'
  ui.scroll.appendChild(ui.progBox)

  ui.behBox = el('div', 'fl-behbox')
  ui.scroll.appendChild(ui.behBox)
  ui.behRows = {}
  BEHAVIOR_IDS.forEach(function (id) {
    var row = el('div', 'fl-beh')
    var label = el('span', 'fl-behlabel', BEHAVIOR_LABELS[id])
    var state = el('span', 'fl-behstate', '')
    var bar = el('div', 'fl-behbar')
    var fill = el('i')
    bar.appendChild(fill)
    row.appendChild(label)
    row.appendChild(state)
    row.appendChild(bar)
    ui.behBox.appendChild(row)
    ui.behRows[id] = { row: row, label: label, state: state, fill: fill }
  })

  // 挂着的活并进同一个区块，前面只留一行很淡的小字
  ui.workBox = el('div', 'fl-wkbox')
  ui.scroll.appendChild(ui.workBox)

  // —— 时间线 ——
  var tlHead = el('div', 'fl-sec')
  tlHead.appendChild(el('div', '', '最近的心情'))
  tlHead.appendChild(el('span', '', '最新 ' + TIMELINE_ROWS + ' 条'))
  ui.tlHead = tlHead
  ui.scroll.appendChild(tlHead)
  ui.tlBox = el('div', 'fl-tlbox')
  ui.scroll.appendChild(ui.tlBox)

  ui.thHead = el('div', 'fl-sec-mini', '人家记下的')
  ui.thHead.style.display = 'none'
  ui.scroll.appendChild(ui.thHead)

  ui.thoughtBox = el('div', 'fl-thoughts')
  ui.thoughtBox.style.display = 'none'
  ui.scroll.appendChild(ui.thoughtBox)

  // —— 按钮 ——
  // 底部不留 CTA
  ui.status = el('div', 'fl-status', '')
  panel.appendChild(ui.status)


  document.body.appendChild(widget)
  document.body.appendChild(panel)

  // ---------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------
  var open = false
  var data = null
  var loading = false
  var acting = false

  function setStatus(t) {
    ui.status.textContent = t || ''
  }

  function latestReason(st) {
    var tl = (st && st.timeline) || []
    for (var i = tl.length - 1; i >= 0; i--) {
      if (tl[i] && tl[i].reason) return tl[i].reason
    }
    return ''
  }

  function grantsById(d) {
    var raw = pick(d, 'grants')
    var map = {}
    if (Array.isArray(raw)) {
      raw.forEach(function (g) {
        if (g && typeof g === 'object' && g.id) map[g.id] = g
      })
    }
    return map
  }

  // 「B站 的看看」这种说法，两种地方共用
  function grantPhrase(byId, use, verb) {
    var g = byId[use]
    var gname = (g && g.label) || String(use || '')
    var vname = verb
    if (g && Array.isArray(g.verbs)) {
      for (var i = 0; i < g.verbs.length; i++) {
        if (g.verbs[i] && g.verbs[i].verb === verb && g.verbs[i].label) {
          vname = g.verbs[i].label
          break
        }
      }
    }
    return gname + ' 的' + (vname || '一趟')
  }

  // 条目里带了 use，就在理由后面注明动了哪条门路
  function useNote(t, byId) {
    if (!t || !t.use) return ''
    return '（用了 ' + grantPhrase(byId, t.use, t.verb) + '）'
  }

  // 刚刚那次自己决定用了门路，单独常驻一行
  function renderLastUse(d) {
    var h = heartOf(d)
    var lh = h && h.lastHeart
    if (!lh || lh.do !== 'use' || !lh.use) {
      ui.useWanted = false
      ui.useLine.style.display = 'none'
      return
    }
    var text = '刚刚用了 ' + grantPhrase(grantsById(d), lh.use, lh.verb)
    ui.useLine.textContent = text
    ui.useLine.title = text
    ui.useWanted = true
    ui.useLine.style.display = ''
  }

  function renderTimeline(st, d) {
    var list = ((st && st.timeline) || []).slice().reverse().slice(0, TIMELINE_ROWS)
    var byId = grantsById(d)
    var sig = list.map(function (t) {
      return (t && t.at) + '|' + (t && t.delta) + '|' + (t && t.reason) + '|' + (t && t.use) + '|' + (t && t.verb)
    }).join(';')
    if (sig === ui.tlSig) return
    ui.tlSig = sig

    var box = ui.tlBox
    while (box.firstChild) box.removeChild(box.firstChild)
    if (!list.length) {
      box.appendChild(el('div', 'fl-note', '还没有记录，聊两句就有了'))
      return
    }
    list.forEach(function (t) {
      var row = el('div', 'fl-tlrow')
      row.appendChild(el('span', 'fl-tltime', clock(t.at)))
      var dv = el('span', 'fl-tldelta', deltaWord(t.delta))
      var n = Number(t.delta) || 0
      if (n > 0) dv.style.color = '#6fd08c'
      else if (n < 0) dv.style.color = '#e08a8a'
      row.appendChild(dv)
      row.appendChild(el('span', 'fl-tlreason', (t.reason || '—') + useNote(t, byId)))
      box.appendChild(row)
    })
  }

  // 契约只说 /state「增加」这些字段，没写挂在根上还是 state 里，两边都认
  function pick(d, key) {
    if (!d || typeof d !== 'object') return undefined
    if (d[key] !== undefined) return d[key]
    var st = d.state
    return st && typeof st === 'object' ? st[key] : undefined
  }

  function channelOf(d) {
    var c = pick(d, 'talkChannel')
    if (c === undefined && d && d.config) c = d.config.talkChannel
    return c === 'qq' ? 'qq' : 'session'
  }

  function decideWord(doKey, channel) {
    if (doKey === 'speak') return channel === 'qq' ? '给主人发了条消息' : '想跟主人说句话'
    if (doKey === 'ask') return '想问主人要个权限'
    return DO_WORDS[doKey] || '自己想了想'
  }

  var DO_WORDS = {
    speak: '想跟主人说句话',
    ask: '想问主人要个权限',
    act: '想做点自己的事',
    nothing: '没想动',
    failed: '想动没动成',
  }

  function renderPendingAsks(d) {
    var raw = pick(d, 'pendingAsks')
    var list = Array.isArray(raw) ? raw.filter(function (a) {
      return a && typeof a === 'object'
    }) : []
    var a = list[0]
    ui.askWanted = !!a
    if (!a) {
      ui.askLine.style.display = 'none'
      return
    }
    var label = a.label || a.verb || '一条门路'
    ui.askLine.textContent = '在等主人答应：' + label
    ui.askLine.title = ui.askLine.textContent
    ui.askLine.style.display = ''
  }

  var PROGRESS_ROWS = 2

  function progressLines(d) {
    var raw = pick(d, 'progress')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(function (x) { return typeof x === 'string' && x.trim() })
      .map(function (line) { return line.replace(/^\s*-\s*/, '') })
  }

  function renderProgress(d) {
    // 最新一条已经作为「最近一次」显示在上面，这里只放它之前的两条
    var all = progressLines(d)
    var list = all.slice(0, -1).slice(-PROGRESS_ROWS).reverse()
    var sig = list.join(';')
    if (sig === ui.pgSig) return
    ui.pgSig = sig

    var box = ui.progBox
    while (box.firstChild) box.removeChild(box.firstChild)
    ui.pgWanted = list.length > 0
    box.style.display = ui.pgWanted ? '' : 'none'
    list.forEach(function (text) {
      var row = el('div', 'fl-progrow', text)
      row.title = text
      box.appendChild(row)
    })
  }

  function renderHeart(d) {
    var h = heartOf(d)

    var lh = h && h.lastHeart
    if (!lh || typeof lh !== 'object') {
      ui.heartLine.textContent = '还没自己拿过主意'
    } else {
      var word = decideWord(lh.do, channelOf(d))
      // 她要说的话比「为什么想说」更值得看见：text 优先，没有才回落到 reason
      var said = typeof lh.text === 'string' ? lh.text.trim() : ''
      var reason = typeof lh.reason === 'string' ? lh.reason.trim() : ''
      var tail = said ? '「' + said.slice(0, 24) + '」' : reason
      ui.heartLine.textContent = '刚刚：' + word + (tail ? ' · ' + tail : '')
    }

    var wake = Number(h && h.nextWakeAt)
    if (isFinite(wake) && wake > 0) {
      var mins = Math.round((wake - Date.now()) / 60000)
      ui.nextKey.textContent = '下次'
      ui.nextVal.textContent = mins > 60
        ? '大约一小时后自己想想'
        : (mins <= 0 ? '马上自己想想' : '大约 ' + mins + ' 分钟后自己想想')
    } else {
      ui.nextKey.textContent = '下次大概'
      }

    ui.restWanted = !!(h && h.forcedRest)
    ui.restLine.style.display = ui.restWanted ? '' : 'none'

    renderThoughts(h)
  }

  function renderThoughts(h) {
    var raw = h && h.thoughts
    var list = []
    if (Array.isArray(raw)) {
      list = raw.filter(function (t) {
        return t && typeof t === 'object' && typeof t.text === 'string' && t.text
      }).slice(-2).reverse()
    }
    var sig = list.map(function (t) { return (t.at || '') + '|' + t.text }).join(';')
    if (sig === ui.thSig) return
    ui.thSig = sig

    var box = ui.thoughtBox
    while (box.firstChild) box.removeChild(box.firstChild)
    ui.thWanted = list.length > 0
    box.style.display = ui.thWanted ? '' : 'none'
    list.forEach(function (t) {
      box.appendChild(el('div', 'fl-thought', t.text))
    })
  }

  function behaviorLabel(id, fallback) {
    return (fallback && String(fallback)) || BEHAVIOR_LABELS[id] || String(id || '做事')
  }

  function renderBehaviors(d) {
    var raw = pick(d, 'behaviors')
    var byId = {}
    if (Array.isArray(raw)) {
      raw.forEach(function (b) {
        if (b && typeof b === 'object' && b.id) byId[b.id] = b
      })
    }
    BEHAVIOR_IDS.forEach(function (id) {
      var r = ui.behRows[id]
      if (!r) return
      var b = byId[id]
      if (!b) {
        r.row.style.display = 'none'
        return
      }
      r.row.style.display = ''
      // 快照只剩 enabled / used / appetite，关掉就是关掉，不再有规则理由
      var off = b.enabled === false
      r.row.classList.toggle('fl-behoff', off)

      r.label.textContent = BEHAVIOR_LABELS[id] || behaviorLabel(id, b.label)
      r.label.title = r.label.textContent

      var used = Number(b.used)
      var countText = isFinite(used) && used > 0 ? '今天做过 ' + used + ' 次' : ''
      var state = off ? '关掉了' : (countText || '还没做过')
      r.state.textContent = state
      r.state.title = state

      var score = Number(b.appetite)
      var w = isFinite(score) ? Math.max(0, Math.min(1, score)) : 0
      r.fill.style.width = Math.round(w * 100) + '%'
      r.fill.style.background = off ? '#5c636e' : '#8fb4e6'
    })
  }

  function renderLast(d) {
    var prog = progressLines(d)
    if (prog.length) {
      ui.lastVal.textContent = prog[prog.length - 1]
      return
    }
    var lb = pick(d, 'lastBehavior')
    if (!lb || typeof lb !== 'object') {
      ui.lastVal.textContent = '还没自己做过事'
      return
    }
    var note = typeof lb.note === 'string' && lb.note ? lb.note : behaviorLabel(lb.id, '')
    var when = lb.at ? clock(lb.at) : ''
    var okWord = lb.ok === true ? '做成了' : lb.ok === false ? '没做成' : ''
    var tail = [when, okWord].filter(Boolean).join(' · ')
    ui.lastVal.textContent = note + (tail ? ' · ' + tail : '')
  }

  function workAll(d) {
    var raw = pick(d, 'openWork')
    if (!Array.isArray(raw)) return []
    return raw.filter(function (it) {
      return it && typeof it === 'object' && it.id != null && !it.doneAt
    })
  }

  function renderWork(d) {
    var all = workAll(d)
    ui.wkTotal = all.length
    var list = all.slice(0, WORK_ROWS)
    var sig = list.map(function (it) {
      return it.id + '|' + it.text
    }).join(';') + '#' + all.length
    if (sig === ui.wkSig) return
    ui.wkSig = sig

    var box = ui.workBox
    while (box.firstChild) box.removeChild(box.firstChild)
    if (!list.length) {
      box.appendChild(el('div', 'fl-wkmini', '挂着的活'))
      box.appendChild(el('div', 'fl-note', '手上没挂着什么'))
      return
    }
    box.appendChild(el('div', 'fl-wkmini', '挂着的活'))
    list.forEach(function (it) {
      var row = el('div', 'fl-wk')
      row.appendChild(el('span', 'fl-wktext', it.text || '（没写是什么）'))

      var done = el('button', 'fl-wkact', '做完了')
      done.type = 'button'
      done.title = '划掉这条'
      done.addEventListener('click', function (e) {
        e.stopPropagation()
        if (acting) return
        doAction('work-done', '划…', '划掉了', { id: it.id })
      })
      row.appendChild(done)

      var drop = el('button', 'fl-wkact fl-wkdel', '不要了')
      drop.type = 'button'
      drop.title = '从列表里去掉，不算做完'
      drop.addEventListener('click', function (e) {
        e.stopPropagation()
        if (acting) return
        doAction('work-drop', '扔…', '清掉了', { id: it.id })
      })
      row.appendChild(drop)

      box.appendChild(row)
    })

    if (all.length > WORK_ROWS) {
      box.appendChild(el('div', 'fl-wkmore', '还有 ' + (all.length - WORK_ROWS) + ' 条'))
    }
  }

  // 高度不够时按重要性舍内容，不滚也不截在半行上
  function syncWorkMore() {
    var more = ui.workBox.querySelector('.fl-wkmore')
    if (!more) return
    var rows = ui.workBox.querySelectorAll('.fl-wk')
    var shown = 0
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].style.display !== 'none') shown++
    }
    var left = Math.max(0, (Number(ui.wkTotal) || 0) - shown)
    more.textContent = '还有 ' + left + ' 条'
    more.style.display = left > 0 ? '' : 'none'
  }

  function fitPanel() {
    if (!open || !ui.scroll) return
    ui.tlHead.style.display = ''
    ui.tlBox.style.display = ''
    ui.thHead.style.display = 'none'
    ui.thoughtBox.style.display = ui.thWanted ? '' : 'none'
    ui.askLine.style.display = ui.askWanted ? '' : 'none'
    ui.useLine.style.display = ui.useWanted ? '' : 'none'
    ui.restLine.style.display = ui.restWanted ? '' : 'none'
    ui.factLine.style.display = ui.factWanted ? '' : 'none'
    ui.lastVal.style.display = ''
    ui.progBox.style.display = ui.pgWanted ? '' : 'none'
    var prowReset = ui.progBox.querySelectorAll('.fl-progrow')
    for (var k = 0; k < prowReset.length; k++) prowReset[k].style.display = ''
    var brows = ui.behBox.querySelectorAll('.fl-beh')
    for (var b = 0; b < brows.length; b++) brows[b].style.display = ''
    var rows = ui.workBox.querySelectorAll('.fl-wk')
    for (var i = 0; i < rows.length; i++) rows[i].style.display = ''
    syncWorkMore()

    // 先按最大高度量，不然面板跟着内容缩，永远量不出真正的溢出
    var maxH = Math.min(Math.round(window.innerHeight * 0.92), 760)
    panel.style.height = maxH + 'px'
    trimPanel()
    panel.style.height = ''
    syncWorkMore()
  }

  // 高度不够时按主人定的顺序舍：时间线 → 近况 → 挂着的活 → 行为行
  function trimPanel() {
    var sc = ui.scroll
    if (sc.scrollHeight <= sc.clientHeight + 2) {
      syncWorkMore()
      return
    }

    if (ui.tlBox.style.display !== 'none') {
      ui.tlHead.style.display = 'none'
      ui.tlBox.style.display = 'none'
      if (ui.thWanted) ui.thHead.style.display = ''
      return trimPanel()
    }

    if (ui.factWanted && ui.factLine.style.display !== 'none') {
      ui.factLine.style.display = 'none'
      return trimPanel()
    }

    if (ui.thoughtBox.style.display !== 'none') {
      ui.thoughtBox.style.display = 'none'
      ui.thHead.style.display = 'none'
      return trimPanel()
    }

    if (ui.restLine.style.display !== 'none') {
      ui.restLine.style.display = 'none'
      return trimPanel()
    }

    if (ui.pgWanted) {
      var prows = ui.progBox.querySelectorAll('.fl-progrow')
      for (var j = prows.length - 1; j >= 0; j--) {
        if (prows[j].style.display !== 'none') {
          prows[j].style.display = 'none'
          return trimPanel()
        }
      }
      if (ui.progBox.style.display !== 'none') {
        ui.progBox.style.display = 'none'
        return trimPanel()
      }
    }

    var rows = ui.workBox.querySelectorAll('.fl-wk')
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].style.display !== 'none') {
        rows[i].style.display = 'none'
        syncWorkMore()
        return trimPanel()
      }
    }

    var more = ui.workBox.querySelector('.fl-wkmore')
    if (more && more.style.display !== 'none') {
      more.style.display = 'none'
      return trimPanel()
    }

    var brows = ui.behBox.querySelectorAll('.fl-beh')
    for (var b = brows.length - 1; b >= 0; b--) {
      if (brows[b].style.display !== 'none') {
        brows[b].style.display = 'none'
        return trimPanel()
      }
    }
  }

  // 面板关着时只干这一件事：换立绘上的表情
  function applyFace(mood) {
    var f = faceOf(mood)
    if (f.file === ui.faceFile) return
    ui.faceFile = f.file
    ui.face.src = B + '/' + f.file
    ui.face.alt = f.label
  }

  // 两个人各自在哪个屋子：后端按行为算好，这里只拼一句话
  function placeText(st) {
    var p = st && st.place
    if (!p || !p.her) return ''
    if (!p.owner) return '人家在' + p.her
    if (p.owner === p.her) return '人家在' + p.her + '，主人也在'
    return '人家在' + p.her + '，主人在' + p.owner
  }

  function applyPanel(d) {
    var st = (d && d.state) || {}
    var mood = Number(st.mood)
    var f = faceOf(mood)

    applyFace(mood)

    var heart = heartOf(d)
    var last = heart && heart.lastHeart

    ui.gateVal.textContent = heartReason(d)
    if (last && last.do === 'speak') ui.gateDot.setAttribute('data-on', '')
    else ui.gateDot.removeAttribute('data-on')

    var wake = Number(heart && heart.nextWakeAt)
    ui.nextVal.textContent = isFinite(wake) && wake > 0
      ? (function () {
        var mins = Math.round((wake - Date.now()) / 60000)
        if (mins > 60) return '大约一小时后自己想想'
        if (mins <= 0) return '马上自己想想'
        return '大约 ' + mins + ' 分钟后自己想想'
      })()
      : ''

    ui.moodNum.textContent = isFinite(mood) ? String(Math.round(mood)) : '--'
    ui.moodLabel.textContent = moodWord(mood) || f.label
    var placeTxt = placeText(st)
    ui.place.textContent = placeTxt
    ui.place.style.display = placeTxt ? '' : 'none'

    ui.reason.textContent = latestReason(st) || quietLine()

    setBar(ui.moodBar, mood, moodWord(mood))

    var spirit = Number(st.spirit)
    if (isFinite(spirit)) {
      ui.spiritBar.row.style.display = ''
      setBar(ui.spiritBar, spirit, spiritWord(spirit))
      ui.spiritBar.fill.style.background = spiritColor(spirit)
    } else {
      ui.spiritBar.row.style.display = 'none'
    }

    renderFacts(d)

    renderHeart(d)
    renderBehaviors(d)
    renderLast(d)
    renderWork(d)
    renderProgress(d)
    renderLastUse(d)
    renderPendingAsks(d)
    renderTimeline(st, d)
    fitPanel()
    positionPanel()
  }

  // ---------------------------------------------------------------------
  // 面板定位：fixed + 视口坐标，贴边就往里挤，上面放不下就翻到下面
  // ---------------------------------------------------------------------
  function positionPanel() {
    if (!open) return
    var r = widget.getBoundingClientRect()
    var pw = panel.offsetWidth || 320
    var ph = panel.offsetHeight || 360
    var winW = window.innerWidth
    var winH = window.innerHeight
    var m = 8
    var gap = 10

    var left = r.left + r.width / 2 - pw / 2
    if (left + pw > winW - m) left = winW - m - pw
    if (left < m) left = m

    // 上下哪边空得多就放哪边；两边都不够高时贴边放，允许压到挂饰一点点
    var above = r.top - gap - m
    var below = winH - r.bottom - gap - m
    var top = (above >= ph || above >= below) ? r.top - gap - ph : r.bottom + gap
    if (top + ph > winH - m) top = winH - m - ph
    if (top < m) top = m

    // 屏幕太矮、纵向怎么放都会压住立绘时，改放它左边，贴着底边对齐
    if (top < r.bottom && top + ph > r.top) {
      var sideLeft = r.left - gap - pw
      if (sideLeft >= m) {
        left = sideLeft
        top = r.bottom - ph
        if (top + ph > winH - m) top = winH - m - ph
        if (top < m) top = m
      }
    }

    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(top) + 'px'
  }

  // ---------------------------------------------------------------------
  // 轮询
  // ---------------------------------------------------------------------
  function load() {
    if (loading) return
    loading = true
    fetch(B + '/state', { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (d) {
        loading = false
        if (!d || d.ok === false) return
        data = d
        applyFace((d.state || {}).mood)
        if (open) applyPanel(d)
        updateTitle(d)
      })
      .catch(function () {
        loading = false
      })
  }

  function updateTitle(d) {
    var st = (d && d.state) || {}
    var f = faceOf(st.mood)
    var act = st.activity && st.activity.note
    body.title = '小鱼 · ' + f.label + '（点开看看，按住能拖）' + (act ? '\n正在：' + act : '')
  }

  // ---------------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------------
  function setBusy(b) {
    var btns = panel.querySelectorAll('button')
    for (var i = 0; i < btns.length; i++) btns[i].disabled = b
  }

  function doAction(action, pendingText, doneText, payload, after) {
    if (acting) return
    acting = true
    setBusy(true)
    setStatus(pendingText)
    fetch(B + '/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    })
      .then(function (res) {
        return res.json().then(function (d) {
          if (!res.ok || (d && d.ok === false)) throw new Error((d && d.error) || 'HTTP ' + res.status)
          return d
        })
      })
      .then(function () {
        setStatus(doneText)
        if (typeof after === 'function') after()
        load()
      })
      .catch(function (e) {
        setStatus('没成：' + ((e && e.message) || '网络不通'))
      })
      .then(function () {
        acting = false
        setBusy(false)
      })
  }

  // ---------------------------------------------------------------------
  // 开合
  // ---------------------------------------------------------------------
  function toggle(force) {
    var next = force == null ? !open : !!force
    if (next === open) return
    open = next
    if (open) {
      panel.style.display = 'flex'
      if (data) applyPanel(data)
      setStatus('')
      positionPanel()
      load()
      // 图片加载完高度会变，再算一次
      if (ui.face.complete) requestAnimationFrame(positionPanel)
      window.setTimeout(positionPanel, 60)
    } else {
      panel.style.display = 'none'
    }
  }

  // ---------------------------------------------------------------------
  // 拖动：拖不出屏幕，动了算拖、没动算点；位置记在 localStorage
  // ---------------------------------------------------------------------
  var dragged = false

  function clampXY(x, y) {
    var w = widget.offsetWidth || 168
    var h = widget.offsetHeight || 168
    var maxX = Math.max(0, window.innerWidth - w)
    var maxY = Math.max(0, window.innerHeight - h)
    return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) }
  }

  function placeAt(x, y) {
    var p = clampXY(x, y)
    widget.style.left = Math.round(p.x) + 'px'
    widget.style.top = Math.round(p.y) + 'px'
    widget.style.right = 'auto'
    widget.style.bottom = 'auto'
  }

  function savePos() {
    var r = widget.getBoundingClientRect()
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }))
    } catch (e) { /* 隐私模式下存不了，无所谓 */ }
  }

  function restorePos() {
    var raw = null
    try { raw = localStorage.getItem(POS_KEY) } catch (e) { return }
    if (!raw) return
    try {
      var p = JSON.parse(raw)
      if (p && isFinite(p.x) && isFinite(p.y)) {
        placeAt(p.x, p.y)
        dragged = true
      }
    } catch (e) { /* 存坏了就当没存 */ }
  }

  restorePos()

  body.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return
    var r = widget.getBoundingClientRect()
    var startX = e.clientX
    var startY = e.clientY
    var ox = r.left
    var oy = r.top
    var moved = false

    function onMove(ev) {
      var dx = ev.clientX - startX
      var dy = ev.clientY - startY
      if (!moved && Math.abs(dx) > 4) moved = true
      if (!moved && Math.abs(dy) > 4) moved = true
      if (!moved) return
      dragged = true
      placeAt(ox + dx, oy + dy)
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
      if (!moved) {
        toggle()
      } else {
        savePos()
        if (open) positionPanel()
      }
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
    e.preventDefault()
  })

  // 键盘开合（button 的 detail 为 0 表示不是鼠标点的）
  body.addEventListener('click', function (e) {
    if (e.detail === 0) toggle()
  })

  body.addEventListener('contextmenu', function (e) {
    e.preventDefault()
    toggle()
  })

  // 点面板和挂饰以外的地方就关掉
  document.addEventListener('pointerdown', function (e) {
    if (!open) return
    if (widget.contains(e.target) || panel.contains(e.target)) return
    toggle(false)
  }, true)

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) toggle(false)
  })

  window.addEventListener('resize', function () {
    if (dragged) {
      var r = widget.getBoundingClientRect()
      placeAt(r.left, r.top)
    }
    if (open) positionPanel()
  })

  ui.face.addEventListener('load', function () {
    if (open) positionPanel()
  })

  load()
  window.setInterval(load, POLL_MS)
})()
