# 门路（grants）契约 v0.5

「门路」= 主人给过她的一项能力。插件不认识任何网站：一条授权就是一份数据，
写着这个能力能干什么、边界在哪、要不要先问。执行永远是她在自己的会话里用工具做。

## 数据（存在 State 里，跟心情一起跨会话）

```js
state.grants = [{
  id: 'bili',                    // 稳定短 id，小写
  label: 'B站',
  from: '主人 10月31日给的',      // 来源，人话
  account: '主人自己的账号',
  private: true,                 // 看到的东西算主人隐私，不外传、不写进会外传的地方
  limits: ['不评论、不关注、不私信'],
  verbs: [{ verb: 'look', label: '看看', how: '只读：搜视频、看推荐、翻播放记录',
            needAsk: false, granted: true, grantedAt: 0 }]
}]

state.pendingAsks = [{
  id: 'k-<now>', use: 'bili', verb: 'collect', label: '收藏',
  why: '<她自己写的理由>', text: '<她要说的原话>',
  askedAt: 0, expiresAt: 0          // 默认 24 小时后作废
}]
```

## 四条规矩

1. **权限由主人给**，她只能「求」。`do:'ask'` 是她的第七种决定，不等于有了权限。
2. **她可以自己求**，但要写成话发给主人：`text` 就是她要说出口的原句，宿主照发。
3. 同时只允许**一条**待答请求，24 小时过期，一天最多求一次（防御性防骚扰）。
4. 主人答应了才落库。答应方式两种：界面点「给她」，或者主人下一句话里认了（「行」「可以」
   「给你」「准了」且不带「不」「别」「等等」）。

## 她要怎么用

- 卡片上给她一行：「门路：B站 —— 看看（只读：搜视频）、收藏（要先问主人）」。
- 决定里带 `use` + `verb`，宿主排一条一次性的活，prompt 里写清权限、边界、产物落哪。
- 产物一律落 `~/.dsh/feiyu-life/mine/<id>.md`，只记类型不记原文（隐私）。

## 谁写什么

- `lib/core/grants.js`（core-engine）：`describeGrants(state,cfg)`、`grantAddTaken`、
  `grantSetVerb(state,use,verb,on,now)`、`askPush(state,item,now,cfg)`、`askResolve(state,id,ok,now)`、
  `askExpire(state,now)`、`looksLikeYes(text)`、`grantPrompt(grant,verb,state,cfg)`。
- 宿主（lead）：`/action` 增 `grant-ask`/`grant-approve`/`grant-deny`/`grant-set`；
  user 消息里带待答请求时判 `looksLikeYes`；卡片塞 `describeGrants`。
- 界面（ui-half）：设置页「门路」一节，列出每条门路与它的 verbs，待答请求带「给她／先算了」。

## 实现时定下的补充（v0.5 core）

- **`state.lastAskAt`**：契约的数据模型里没有这个字段，但「一天最多求一次」不能只看
  `pendingAsks`——答应或拒绝之后请求会被移出，当天就能无痕再求。所以 `askPush` 成功时
  写一笔 `lastAskAt`，按本地自然日比较。旧 state 没有这个字段时按 0 处理。
- **求的门路必须已存在**：`askPush` 要求 `use` 能在 `state.grants` 里找到，`verb` 也必须
  是那条门路已声明的 verb，否则返回 `null`。求一项不存在的权限没有落库的落点，
  答应了也无从生效。
- **同 id 合并规则**：`grantAddTaken` 对已存在的门路只合并不新建；`limits` 取并集，
  `granted` 只增不减（不能因为第二次给的 spec 没勾就撤回），`needAsk` 取与（两边都
  允许直接做才算不用问）。
- **`do:'ask'` 的容错**：`use`、`verb` 缺任意一个就整条不认（返回 `null`），不做
  「随便挑一项」的猜测；`text` 缺失时兜底一句
  `主人，人家想用「<use>」的<verb>，可以给人家吗？`。core 不查门路字典，
  所以兜底句里的 verb 是 id 本身，不是中文 label。
- **产物路径固定**：`grantPrompt` 里产物一律写 `~/.dsh/feiyu-life/mine/<grant.id>.md`，
  非 private 的门路也写这里；private 额外要求「只记类型不记原文」。
- **答应判定顺序**：`looksLikeYes` 先查否定词（不/别/等等/算了/再说/不用/不要/先不/
  没有/拒绝/免了），命中就返回 false，再看肯定词。空字符串不算答应。

## 实现时定下的补充（v0.5 宿主 + 界面）

- **多了一种决定 `do:'use'`**：原来的 6 种决定（nothing/speak/act/ask）表达不了「用一项已给
  的权限」。`use` 带 `use` + `verb`，解析规则同 `ask`（缺一个就整条不认）。系统的提示里
  写了两句：门路标着「已给」的可以直接用；标着「要先问主人」的只能求。
- **兜底原话由宿主写**：core 的 `parseDecision` 不再拼兜底句（它没有中文 label），
  `text` 为空时宿主用「人物+门路中文名」拼一句，所以主人看到的是「B站的收藏」，不是「bili 的 collect」。
- **说话与求权限都算「开口」**：静默时段（mode=quiet）里不许求；连续被忽略的强制安静也管
  `ask`，但不管 `act` 和 `use`——她想自己干活、想用权限，不算打扰主人。
- **主人口头答应也认**：待答请求存在时，主人下一句含「行/可以/给你/准了/同意/拿去」且不含
  「不/别/等等/算了/再说」就落库；明确的「不行/不给/算了」直接作废。界面上的「给她／先算了」
  是另一条可靠路径（口头判定只是省事，不是唯一入口）。
- **初始门路**：`lib/host/paths.js` 的 `DEFAULT_GRANTS` 给了 B 站的 `look`（只读，已给），
  `collect`（收藏）和 `like`（点赞）留成「要先问主人」——这样她第一次用权限就得自己开口要，
  主人也就不用记得给。

## 初始门路（v0.9.2）

| id | 名称 | 直接给 | 要问 | 不能碰 |
| --- | --- | --- | --- | --- |
| `bili` | B站 | look / collect / like / later（稍后再看） | — | 不发表任何内容（不评论、不发弹幕、不发动态）、不关注、不私信、不改资料、收藏和稍后再看只加不删 |
| `web` | 上网 | look（`curl -s https://r.jina.ai/<网址>`）、save（存进 `mine/`） | — | 银行、支付宝、邮箱、密码管理器、微信飞书后台；不登录、不评论、不填表 |
| `browser` | 主人的浏览器 | open（lcu 开标签读页面） | click（翻页、点开内容，只导航） | 不付款、不下单、不发评论、不改设置；主人用电脑时不开 |
| `shell` | 跑命令 | run（只读命令）、write（只写 `~/.dsh/feiyu-life/` 与 `~/Projects/dsh-feiyu-life/`） | — | 不删东西、不动 git 历史、不装全局依赖、不改主人的项目 |

三条新门路 2026-10-31 由主人授权。她的会话本来就有 bash 与 lcu，门路是「她自己知道可以做什么」的清单；真要硬拦，得配 DSH 的权限档。
