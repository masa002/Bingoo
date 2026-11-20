#!/usr/bin/env node
// Bingoo の負荷試験。仮の参加者を N 人つないで 1 ゲームを最後まで回し、合格の基準と結果を表で出す。
//
//   node tools/load.mjs --url http://localhost:8787 --admin-key dev --players 1000
//   node tools/load.mjs --help
//
// Node 22 以上。追加のパッケージは要らない（組み込みの fetch と WebSocket を使う）。
// 通信の決まりは src/net/wire.ts。TypeScript は読み込めないので、要る分だけここに書き写してある
// （wire.ts を変えたら、下の「wire.ts と同じ決まり」も合わせる）。

import { createHmac } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

// ---- wire.ts と同じ決まり ---------------------------------------------------

// サーバーは「この時刻に画面へ渡す」（at）の LEAD_MS だけ前に送る。at より遅く届いたら「遅れ」
const LEAD_MS = 700
const KEEPALIVE = { ping: 'ping', pong: 'pong' }
// 先に送られないメッセージ（at が「いま」で出る）。遅れの集計には入れない
const NO_LEAD = new Set(['host', 'notice', 'snapshot'])
// 参加者には届かないメッセージ（主催だけ・大画面と主催だけ）。通し番号の飛びを数えるときに除く
const NOT_FOR_PLAYERS = new Set(['host', 'notice'])
// frameText() が作る文字列の頭。全部を JSON.parse しなくても、通し番号・時刻・種類が分かる
const HEAD = /^\{"s":(\d+),"at":(-?\d+(?:\.\d+)?)/
const B_TYPE = ',"b":{"type":"'

// ---- 端末のふるまい（src/net/remote.ts と src/live/ に合わせる） -------------

const POLL_MS = 1500
const KEEPALIVE_MS = 25000
const KEEPALIVE_WAIT_MS = 10000
const CONNECT_TIMEOUT_MS = 30000
const STALL_MS = 100000 // これだけ何も届かなければ「進行が止まった」とみなす（いちばん長い待ちは、景品の選択の 40 秒）
const IDLE_RATE = 0.1 // モグラ撃退で、叩かない人の割合

// つなぎ直しの待ち時間: 0.5 秒から倍々で最大 8 秒。毎回ばらつき（0〜100%）を足す
const backoff = (attempt) => Math.min(8000, 500 * 2 ** attempt) * (1 + Math.random())

// ---- 指定 -------------------------------------------------------------------

const SPEC = {
  url: { d: 'http://localhost:8787', help: 'サーバーの場所' },
  'admin-key': { d: process.env.BINGOO_ADMIN_KEY ?? '', help: '管理キー（ゲームを作るとき。環境変数 BINGOO_ADMIN_KEY でもよい）' },
  players: { d: 100, num: true, help: 'つなぐ仮の参加者の数' },
  code: { d: '', help: 'もうあるゲームに入る（付けなければ、新しく作る）' },
  'host-key': { d: process.env.BINGOO_HOST_KEY ?? '', help: '--code のゲームの主催キー（環境変数 BINGOO_HOST_KEY でもよい）' },
  totp: { d: '', help: '--code のゲームの、認証アプリの 6 桁（新しく作るゲームは、この道具が自分で計算する）' },
  'no-host': { flag: true, help: '進行はしない（参加者だけ入る）。2 台目からの PC で、--code と一緒に使う' },
  expect: { d: 0, num: true, help: 'この人数が参加するまで、始めるのを待つ（既定は --players + --bots）' },
  bots: { d: 0, num: true, help: 'サーバーの中の仮想の参加者を足す（接続はしない人）' },
  lower: { d: 0, num: true, help: '下位の景品の数（既定は人数の 3%）' },
  upper: { d: 0, num: true, help: '上位の景品の数（既定は下位の 1/4）' },
  dc: { d: 0, num: true, help: 'ダブルチャンスの景品の数（既定は下位の 1/6）' },
  concurrency: { d: 50, num: true, help: '参加を同時にいくつ進めるか' },
  scenario: { d: 'normal', help: 'normal か storm（途中で全員を一度に切って、つなぎ直す）' },
  'quest-at': { d: 3, num: true, help: '何回目の番号のあとで、モグラ撃退を 1 回起こすか（全員が数を送る、いちばん混む場面。0 なら起こさない）' },
  'storm-at': { d: 5, num: true, help: 'storm: 何回目の番号のあとで切るか' },
  'storm-hold': { d: 0, num: true, help: 'storm: 切ってからつなぎ直すまでに足す時間（ms）。6000 にすると、見逃した分が古くなって、全員が snapshot で戻る' },
  transport: { d: 'ws', help: 'ふつうの人の方式（ws・sse・poll）' },
  fallback: { d: 0, num: true, help: 'sse と poll でつなぐ人の割合（0.05 なら 5%。半分ずつ）' },
  challenge: { d: 0.25, num: true, help: '当たった人が上位チャレンジを選ぶ割合' },
  'min-connect': { d: 99.5, num: true, help: '合格の基準: つなげた割合（%）' },
  'min-ontime': { d: 99, num: true, help: '合格の基準: at に間に合った割合（%。ws と sse）' },
  'min-reveal': { d: 99.9, num: true, help: '合格の基準: 番号の発表を受け取った割合（%）' },
  'max-minutes': { d: 45, num: true, help: 'これを過ぎたら打ち切る' },
  json: { d: '', help: '結果を JSON でも書き出すファイル' },
  help: { flag: true, help: 'この説明を出す' },
}

function usage() {
  const lines = ['使い方: node tools/load.mjs [指定]', '']
  for (const [k, s] of Object.entries(SPEC)) {
    const left = s.flag ? `--${k}` : `--${k} <${s.num ? '数' : '文字'}>`
    const d = s.flag || s.d === '' || s.d === 0 ? '' : `（既定 ${s.d}）`
    lines.push(`  ${pad(left, 24)}${s.help}${d}`)
  }
  lines.push('', '例:')
  lines.push('  node tools/load.mjs --url http://localhost:8787 --admin-key dev --players 1000')
  lines.push('  node tools/load.mjs --url https://… --players 1000 --scenario storm --storm-hold 6000')
  lines.push('  node tools/load.mjs --url https://… --players 1000 --fallback 0.05')
  lines.push('  node tools/load.mjs --url https://… --code ABC234 --no-host --players 3000   （2 台目の PC）')
  return lines.join('\n')
}

function parseArgs(argv) {
  const o = Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, s.flag ? false : s.d]))
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = a.indexOf('=')
    const key = a.startsWith('--') ? a.slice(2, eq > 0 ? eq : undefined) : ''
    const s = SPEC[key]
    if (!s) die(`分からない指定です: ${a}\n\n${usage()}`)
    if (s.flag) {
      o[key] = true
      continue
    }
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i]
    if (v === undefined) die(`--${key} に値がありません`)
    o[key] = s.num ? Number(v) : v
    if (s.num && !Number.isFinite(o[key])) die(`--${key} は数で指定します: ${v}`)
  }
  return o
}

function die(text) {
  console.error(text)
  process.exit(2)
}

// ---- 小さな道具 -------------------------------------------------------------

const nowMs = () => performance.timeOrigin + performance.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (n) => Math.floor(Math.random() * n)

// 全角の文字は 2 桁ぶんとして、表の列をそろえる
function width(s) {
  let w = 0
  for (const ch of String(s)) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}
function pad(s, n) {
  return String(s) + ' '.repeat(Math.max(0, n - width(s)))
}
function table(rows) {
  const cols = rows[0].length
  const w = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => width(r[c]))))
  return rows.map((r) => ('  ' + r.map((cell, c) => (c === cols - 1 ? cell : pad(cell, w[c] + 2))).join('')).trimEnd()).join('\n')
}

const pct = (a, b) => (b > 0 ? (a / b) * 100 : NaN)
const fmtPct = (x) => (Number.isFinite(x) ? `${x.toFixed(2)}%` : '-')
const fmtMs = (x) => (Number.isFinite(x) ? `${Math.round(x)} ms` : '-')
const fmtSec = (x) => (Number.isFinite(x) ? `${(x / 1000).toFixed(1)} 秒` : '-')

// 1 ms きざみの度数の表。何百万通でも、覚えておく量が変わらない
class Hist {
  constructor(lo = 0, hi = 120000) {
    this.lo = lo
    this.bins = new Uint32Array(hi - lo + 1)
    this.n = 0
    this.min = Infinity
    this.max = -Infinity
  }
  add(v) {
    this.bins[Math.max(0, Math.min(this.bins.length - 1, Math.round(v) - this.lo))]++
    this.n++
    if (v < this.min) this.min = v
    if (v > this.max) this.max = v
  }
  pct(p) {
    if (!this.n) return NaN
    let need = Math.ceil((this.n * p) / 100)
    for (let i = 0; i < this.bins.length; i++) {
      need -= this.bins[i]
      if (need <= 0) return i + this.lo
    }
    return this.max
  }
  summary() {
    return this.n ? { n: this.n, p50: this.pct(50), p95: this.pct(95), p99: this.pct(99), max: Math.round(this.max) } : { n: 0 }
  }
  text() {
    return this.n ? `p50 ${fmtMs(this.pct(50))} · p95 ${fmtMs(this.pct(95))} · p99 ${fmtMs(this.pct(99))} · 最大 ${fmtMs(this.max)}` : '（なし）'
  }
}

// 並んだ配列の中で、lo < x <= hi の数
function countIn(sorted, lo, hi) {
  const upper = (x) => {
    let a = 0
    let b = sorted.length
    while (a < b) {
      const m = (a + b) >> 1
      if (sorted[m] <= x) a = m + 1
      else b = m
    }
    return a
  }
  return Math.max(0, upper(hi) - upper(lo))
}

// ---- ここから本体 -----------------------------------------------------------

const opt = parseArgs(process.argv.slice(2))
if (opt.help) {
  console.log(usage())
  process.exit(0)
}
if (typeof WebSocket !== 'function' || typeof fetch !== 'function') die('Node 22 以上で動かしてください（組み込みの WebSocket と fetch を使います）')
if (!['normal', 'storm'].includes(opt.scenario)) die('--scenario は normal か storm です')
if (!['ws', 'sse', 'poll'].includes(opt.transport)) die('--transport は ws・sse・poll のどれかです')
if (!(opt.players >= 1)) die('--players は 1 以上です')
if (opt['no-host'] && !opt.code) die('--no-host は --code と一緒に使います')
if (opt.code && !opt['no-host'] && !opt['host-key']) die('--code のゲームを進めるには --host-key が要ります（参加者だけ入るなら --no-host）')

const driving = !opt['no-host']
const base = opt.url.replace(/\/+$/, '')
const api = base.endsWith('/api') ? base : `${base}/api`
const wsBase = api.replace(/^http/, 'ws')
let code = opt.code

// サーバーの時計との差。この道具の中の端末は全部同じ PC の時計を使うので、差は 1 つでよい。
// 往復がいちばん短かった回がいちばん正確なので、それを使う
const clock = {
  offset: 0,
  rtt: Infinity,
  sample(t0, t1, serverNow) {
    const rtt = t1 - t0
    if (rtt < this.rtt) {
      this.rtt = rtt
      this.offset = serverNow - (t0 + t1) / 2
    }
  },
  server: (t) => t + clock.offset,
  local: (serverT) => serverT - clock.offset,
}

const stats = {
  attempts: 0, // つなごうとした回数
  failedAttempts: 0, // つながる前に失敗した回数
  drops: 0, // つながっていたのに切れた回数
  keepaliveLost: 0, // 生存確認の返事がなくて、こちらから切った回数
  bye: {}, // サーバーから「もうつながない」と言われた数（理由ごと）
  dup: 0, // 同じ通し番号・古い通し番号が届いた数
  noSnapshot: 0, // 初めてつないだのに snapshot から始まらなかった数
  wrongMe: 0, // snapshot の本人の番号が、自分とちがった数
  dupIdx: 0, // 別の人と同じ番号（idx）をもらった数
  bad: 0, // 読めなかったメッセージ
  joinRetries: 0,
  joinFailed: 0,
  connectFailed: 0,
  cmds: 0,
  cmdDropped: 0,
  cmdFailed: 0,
  questSent: 0,
  questOk: 0,
  choices: 0,
  challenges: 0,
  entries: 0,
  entryOk: 0,
  catchup: 0, // つなぎ直しのあとで、まとめて届いた分（遅れには数えない）
}
const hist = { join: new Hist(), connect: new Hist(), rtt: new Hist(0, 60000) }
// 届いた時刻 − at。方式ごと（crew は大画面と主催）
const lat = Object.fromEntries(['ws', 'sse', 'poll', 'crew'].map((k) => [k, { hist: new Hist(-20000, 120000), late: 0 }]))
const errors = new Map() // エラーの文 → 回数（はじめて動かしたときに、何が合っていないかが分かるように）
const reconns = [] // つなぎ直しの記録
const reveals = new Map() // 番号 → 発表の記録
const bseq = new Set() // 全員宛てのメッセージの通し番号（大画面・主催の役が見た分）
const notices = []

const run = {
  startedAt: nowMs(),
  finished: false,
  error: null,
  joinMs: NaN,
  endedAt: NaN,
  draws: 0,
  quests: 0,
  wilds: 0,
  questAsked: null,
  overSeen: false,
  dcSeen: false,
  lastNext: 0,
  lastFrameAt: nowMs(),
  storm: null,
  hostState: null,
  maxConnected: 0,
  truth: [],
  results: null,
}

let wake = () => {}
const ended = new Promise((r) => (wake = r))
function finish(error = null) {
  if (run.finished) return
  run.finished = true
  run.error = error
  run.endedAt = nowMs()
  wake()
}

function say(text) {
  console.log(`[${String(Math.round((nowMs() - run.startedAt) / 1000)).padStart(4)}s] ${text}`)
}
function noteError(kind, e) {
  const key = `${kind}: ${e?.message ?? e}`
  errors.set(key, (errors.get(key) ?? 0) + 1)
}

async function http(method, path, { query, body, timeout = 15000 } = {}) {
  const url = api + path + (query ? `?${new URLSearchParams(query)}` : '')
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // JSON でない返事（下で状態コードを見る）
  }
  if (!res.ok) {
    const e = new Error(data?.error ?? `HTTP ${res.status}`)
    e.status = res.status
    throw e
  }
  return data
}

async function syncHttp(times) {
  for (let i = 0; i < times; i++) {
    const t0 = nowMs()
    const r = await http('GET', '/time')
    if (typeof r?.now !== 'number') throw new Error('GET /api/time の返事に now がありません')
    clock.sample(t0, nowMs(), r.now)
  }
}

// 全員宛ては同じ文字列が人数ぶん届くので、直前の数通を覚えておく（1 万人ぶんの JSON.parse をしない）。
// 返したものは端末どうしで共有するので、中身は書きかえない
const parsedCache = []
function parseShared(text) {
  for (const c of parsedCache) if (c.text === text) return c.obj
  const obj = JSON.parse(text)
  parsedCache.push({ text, obj })
  if (parsedCache.length > 4) parsedCache.shift()
  return obj
}

// inflate() と同じ: 本人宛ての部分（p）を、全員宛ての部分（b）にいちばん上の項目ごと上書きする
const merged = (frame) => ({ ...(frame.b ?? {}), ...(frame.p ?? {}) })

function reveal(n) {
  let r = reveals.get(n)
  if (!r) reveals.set(n, (r = { n, drawNo: 0, at: 0, seen: false, live: 0, later: 0, snap: 0, min: Infinity, max: -Infinity }))
  return r
}

// ---- 接続 1 本（ws・sse・poll） ---------------------------------------------

class Client {
  constructor({ role, idx = -1, token = '', transport = 'ws', handler }) {
    this.role = role
    this.idx = idx
    this.token = token
    this.transport = transport
    this.group = role === 'player' ? transport : 'crew'
    this.handler = handler
    this.gen = 0 // 接続の世代。古い接続からの通知を無視するのに使う
    this.conn = null
    this.live = false
    this.closed = false
    this.attempt = 0
    this.timer = null
    this.ws = null
    this.abort = null
    this.queue = [] // つながっていない間の操作（10 通まで）
    this.pings = new Map()
    this.pingId = 0
    this.kaWait = false
    this.rec = null // まだ戻れていない、つなぎ直しの記録
    this.connectedAt = null // 最初の snapshot が届いた時刻
    this.first = new Promise((r) => (this.onFirst = r))
    // 通し番号。区間（snapshot から次の snapshot まで）ごとに、全員宛てを何通受け取ったかを数える
    this.lastSeq = null
    this.segStart = null
    this.segGot = 0
    this.segs = []
  }

  query() {
    const q = { role: this.role }
    if (this.role === 'player') q.idx = String(this.idx)
    if (this.token) q.token = this.token
    return q
  }
  queryAfter() {
    const q = this.query()
    if (this.lastSeq !== null) q.after = String(this.lastSeq)
    return q
  }

  start() {
    this.startedAt = nowMs()
    this.open()
  }

  open() {
    clearTimeout(this.timer)
    if (this.closed || run.finished) return
    const gen = ++this.gen
    this.conn = { ready: false, readyAt: Infinity, frames: 0, rec: null }
    stats.attempts++
    if (this.transport === 'ws') this.openWs(gen)
    else if (this.transport === 'sse') this.openSse(gen)
    else this.openPoll(gen)
  }

  after(gen, ms, fn) {
    setTimeout(() => gen === this.gen && !run.finished && fn(), ms)
  }

  // -- ws

  openWs(gen) {
    let ws
    try {
      ws = new WebSocket(`${wsBase}/g/${code}/ws?${new URLSearchParams(this.queryAfter())}`)
    } catch (e) {
      noteError('ws', e)
      return this.lost(gen)
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      if (gen !== this.gen) return
      for (const cmd of this.queue.splice(0)) ws.send(JSON.stringify({ t: 'cmd', cmd }))
      // 時計合わせ: ping を 5 回（200ms おき）
      for (let i = 0; i < 5; i++) this.after(gen, i * 200, () => this.ping())
      this.keepalive(gen, KEEPALIVE_MS * (0.5 + Math.random() / 2))
    })
    ws.addEventListener('message', (ev) => {
      if (gen !== this.gen) return
      const t = nowMs()
      if (typeof ev.data === 'string') this.onText(ev.data, t)
    })
    ws.addEventListener('error', () => {
      if (gen !== this.gen || this.live) return
      noteError('ws', 'つながりませんでした')
      // つなぐ途中で失敗すると、Node の WebSocket は close を出さないことがある（手元で 500 人を一度につなぎ直したとき、57 人が戻らなかった）。
      // ここで、つなぎ直しに回す（lost は世代を進めるので、あとから close が来ても 2 回は数えない）
      this.lost(gen)
    })
    ws.addEventListener('close', (ev) => {
      if (gen === this.gen && this.live && !run.finished) noteError('ws', `切れました（code ${ev.code}）`)
      this.lost(gen)
    })
  }

  ping() {
    if (this.ws?.readyState !== 1) return
    const c = ++this.pingId
    this.pings.set(c, nowMs())
    this.ws.send(JSON.stringify({ t: 'ping', c }))
  }

  // 生存確認: 25 秒に 1 回 'ping' を送り、10 秒返事がなければ切ってつなぎ直す
  keepalive(gen, wait) {
    this.after(gen, wait, () => {
      if (this.ws?.readyState !== 1) return
      this.kaWait = true
      this.ws.send(KEEPALIVE.ping)
      this.after(gen, KEEPALIVE_WAIT_MS, () => {
        if (!this.kaWait) return
        stats.keepaliveLost++
        this.lost(gen)
      })
      this.keepalive(gen, KEEPALIVE_MS)
    })
  }

  // -- sse

  async openSse(gen) {
    const ac = new AbortController()
    this.abort = ac
    try {
      const res = await fetch(`${api}/g/${code}/sse?${new URLSearchParams(this.queryAfter())}`, { headers: { accept: 'text/event-stream' }, signal: ac.signal })
      if (gen !== this.gen) return
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      this.syncByHttp(gen)
      this.ready(nowMs())
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (gen !== this.gen) return
        if (done) break
        const t = nowMs()
        buf += dec.decode(value, { stream: true })
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, buf[nl - 1] === '\r' ? nl - 1 : nl)
          buf = buf.slice(nl + 1)
          // data: の行が Down の JSON。: で始まる行は、切れないようにするためのコメント
          if (line.startsWith('data:')) this.onText(line.slice(line[5] === ' ' ? 6 : 5), t)
          if (gen !== this.gen) return
        }
      }
    } catch (e) {
      if (gen !== this.gen) return
      noteError('sse', e)
    }
    this.lost(gen)
  }

  // -- poll

  async openPoll(gen) {
    this.syncByHttp(gen)
    // 終わりの合図のあとも、閉じるまでは取りに行く（最後のメッセージを受け取るため）
    while (gen === this.gen) {
      const t0 = nowMs()
      let res
      try {
        res = await http('GET', `/g/${code}/poll`, { query: this.queryAfter() })
      } catch (e) {
        if (gen !== this.gen) return
        noteError('poll', e)
        return this.lost(gen)
      }
      if (gen !== this.gen) return
      const t = nowMs()
      if (typeof res?.now === 'number') clock.sample(t0, t, res.now)
      this.ready(t)
      for (const f of res?.frames ?? []) {
        this.onFrame(f.s, f.at, f.b?.type ?? null, () => f, t)
        if (gen !== this.gen) return
      }
      if (res?.bye) return this.bye(res.bye)
      await sleep(POLL_MS)
    }
  }

  // sse・poll の時計合わせ（GET /api/time を 3 回）
  async syncByHttp(gen) {
    for (let i = 0; i < 3 && gen === this.gen; i++) {
      const t0 = nowMs()
      try {
        const r = await http('GET', '/time')
        const t1 = nowMs()
        hist.rtt.add(t1 - t0)
        if (typeof r?.now === 'number') clock.sample(t0, t1, r.now)
      } catch (e) {
        noteError('time', e)
      }
      await sleep(200)
    }
  }

  // -- 受け取る

  onText(text, t) {
    if (text === KEEPALIVE.pong) {
      this.kaWait = false
      return
    }
    const m = HEAD.exec(text)
    if (!m) {
      let d
      try {
        d = JSON.parse(text)
      } catch {
        stats.bad++
        return
      }
      if (d && typeof d.s === 'number') return this.onFrame(d.s, d.at, d.b?.type ?? null, () => d, t)
      return this.onControl(d, t)
    }
    const i = m[0].length
    let type = null
    if (text.startsWith(B_TYPE, i)) type = text.slice(i + B_TYPE.length, text.indexOf('"', i + B_TYPE.length))
    else if (text.startsWith(',"b":', i)) type = parseShared(text).b?.type ?? null
    this.onFrame(Number(m[1]), Number(m[2]), type, () => parseShared(text), t)
  }

  onControl(d, t) {
    if (d?.t === 'pong') {
      const t0 = this.pings.get(d.c)
      if (t0 === undefined) return
      this.pings.delete(d.c)
      hist.rtt.add(t - t0)
      if (typeof d.now === 'number') clock.sample(t0, t, d.now)
      this.ready(t)
    } else if (d?.t === 'bye') this.bye(d.reason)
    else stats.bad++
  }

  // full() は、フレーム全体（{ s, at, b, p }）を返す。中身が要るときだけ呼ぶ
  onFrame(s, at, type, full, t) {
    const c = this.conn
    const firstOfConn = c.frames++ === 0
    this.ready(t)
    run.lastFrameAt = t
    if (type === 'snapshot') {
      // いまの状態をもらった。ここから新しい区間
      if (firstOfConn && c.rec) {
        c.rec.mode = 'snapshot'
        c.rec.t1 = t
      }
      if (this.segStart !== null) this.segs.push([this.segStart, this.lastSeq, this.segGot])
      this.segStart = this.lastSeq = s
      this.segGot = 0
      const b = merged(full())
      if (this.connectedAt === null) {
        this.connectedAt = t
        this.onFirst()
      }
      this.handler.snapshot(this, b, t)
      return
    }
    if (this.lastSeq === null) {
      stats.noSnapshot++
      this.segStart = s - 1
    } else if (s <= this.lastSeq) {
      stats.dup++
      return
    }
    this.lastSeq = s
    if (type !== null && !NOT_FOR_PLAYERS.has(type)) this.segGot++
    // サーバーがこれを送ったとき（at − LEAD_MS）に、もうつながっていた分だけ、遅れを測る。
    // つなぎ直しのあとでまとめて届いた分は、遅れて当たり前なので別に数える
    const live = at - LEAD_MS >= c.readyAt
    if (!NO_LEAD.has(type)) {
      if (live) {
        const d = clock.server(t) - at
        const g = lat[this.group]
        g.hist.add(d)
        if (d > 0) g.late++
      } else stats.catchup++
    }
    this.handler.frame(this, type, s, at, full, t, live)
  }

  // この接続が使えるようになった（最初の返事が届いた）
  ready(t) {
    const c = this.conn
    if (c.ready) return
    c.ready = true
    c.readyAt = clock.server(t)
    this.live = true
    this.attempt = 0
    if (this.rec) {
      // snapshot で戻ったかどうかは、この接続の最初のフレームで決まる（onFrame）
      this.rec.t1 = t
      this.rec.mode = 'resume'
      c.rec = this.rec
      this.rec = null
    }
  }

  // -- 送る

  send(cmd) {
    if (this.closed || run.finished) return
    stats.cmds++
    if (this.transport !== 'ws') {
      http('POST', `/g/${code}/cmd`, { query: this.query(), body: { cmds: [cmd] } }).catch((e) => {
        stats.cmdFailed++
        noteError('cmd', e)
      })
    } else if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'cmd', cmd }))
    else if (this.queue.length < 10) this.queue.push(cmd)
    else stats.cmdDropped++
  }

  // -- 切れる・切る

  teardown() {
    try {
      this.ws?.close()
    } catch {
      // もう閉じている
    }
    this.ws = null
    this.abort?.abort()
    this.abort = null
    this.pings.clear()
    this.kaWait = false
  }

  // 切れた（こちらから切ったのではない）。待ってから、つなぎ直す
  lost(gen) {
    if (gen !== this.gen || this.closed || run.finished) return
    this.gen++
    if (this.live) {
      stats.drops++
      this.rec ??= record(false)
    } else stats.failedAttempts++
    this.live = false
    this.teardown()
    this.timer = setTimeout(() => this.open(), backoff(this.attempt++))
  }

  // storm: わざと切る。hold だけ待ってから、ふつうのつなぎ直しをする
  forceDrop(hold) {
    if (this.closed) return
    this.gen++
    this.live = false
    this.teardown()
    this.rec ??= record(true)
    this.attempt = 0
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.open(), hold + backoff(this.attempt++))
  }

  bye(reason) {
    stats.bye[reason] = (stats.bye[reason] ?? 0) + 1
    this.close()
  }

  close() {
    this.closed = true
    this.live = false
    this.gen++
    clearTimeout(this.timer)
    this.teardown()
  }
}

function record(forced) {
  const r = { t0: nowMs(), t1: null, mode: null, forced }
  reconns.push(r)
  return r
}

// ---- 参加者 -----------------------------------------------------------------

class Player {
  constructor(i, transport) {
    this.name = `L${String(i + 1).padStart(5, '0')}`
    this.transport = transport
    this.idx = -1
    this.token = ''
    this.client = null
    this.known = new Uint8Array(76) // 知っている番号
    this.questSent = null
    this.entered = false
  }

  async join() {
    for (let attempt = 0; attempt < 3 && !run.finished; attempt++) {
      const t0 = nowMs()
      try {
        const r = await http('POST', `/g/${code}/join`, { body: { name: this.name } })
        if (typeof r?.idx !== 'number' || typeof r?.token !== 'string') throw new Error('join の返事に idx と token がありません')
        hist.join.add(nowMs() - t0)
        this.idx = r.idx
        this.token = r.token
        return true
      } catch (e) {
        noteError('join', e)
        // 断られた（満員・締め切り）なら、やり直さない
        if (e.status >= 400 && e.status < 500 && e.status !== 429) break
        stats.joinRetries++
        await sleep(backoff(attempt))
      }
    }
    stats.joinFailed++
    return false
  }

  async joinAndConnect() {
    if (!(await this.join())) return
    if (seenIdx.has(this.idx)) stats.dupIdx++
    seenIdx.add(this.idx)
    const c = (this.client = new Client({ role: 'player', idx: this.idx, token: this.token, transport: this.transport, handler: this }))
    c.start()
    const ok = await Promise.race([c.first.then(() => true), sleep(CONNECT_TIMEOUT_MS).then(() => false), ended.then(() => false)])
    if (ok) hist.connect.add(c.connectedAt - c.startedAt)
    else if (!run.finished) {
      stats.connectFailed++
      c.close()
    }
  }

  // サーバーの時刻 at に動く（画面に出る時刻を基準に、人が動くまでの間を足す）
  at(serverT, fn) {
    setTimeout(() => !run.finished && fn(), Math.max(0, clock.local(serverT) - nowMs()))
  }

  learn(n, how) {
    if (!(n >= 1 && n <= 75) || this.known[n]) return null
    this.known[n] = 1
    const r = reveal(n)
    r[how]++
    return r
  }

  snapshot(c, b) {
    if (b?.me?.idx !== this.idx) stats.wrongMe++
    for (const n of b?.drawn ?? []) this.learn(n, 'snap')
  }

  frame(c, type, s, at, full, t, live) {
    switch (type) {
      case 'numberRevealed': {
        const b = full().b
        const r = this.learn(b.n, live ? 'live' : 'later')
        if (!r) break
        r.drawNo = b.drawNo
        r.at = at
        // 受け取った時刻の広がりは、その場で受け取った ws・sse の端末で見る（poll は 1.5 秒おきなので、別）
        if (live && c.transport !== 'poll') {
          const arrived = clock.server(t)
          if (arrived < r.min) r.min = arrived
          if (arrived > r.max) r.max = arrived
        }
        break
      }
      case 'bulkDrawn':
        for (const n of full().b.numbers ?? []) this.learn(n, live ? 'live' : 'later')
        break
      case 'questStart': {
        // 叩く時間の間は 2 秒に 1 回、途中の数を送り、終わったら 1 回だけ結果を送る（スマホと同じ）
        this.questSent = null
        if (Math.random() < IDLE_RATE) break
        const m = merged(full())
        const score = Math.random() < 0.28 ? 3 + rand(10) : 18 + rand(13)
        const start = at + m.introMs
        const end = start + m.playMs
        for (let ts = start + 500 + Math.random() * 1500; ts < end; ts += 2000) {
          const sofar = Math.round((score * (ts - start)) / m.playMs)
          this.at(ts, () => c.send({ type: 'questProgress', score: sofar }))
        }
        this.at(end + Math.random() * 300, () => {
          this.questSent = score
          c.send({ type: 'questScore', score })
        })
        break
      }
      case 'questResult': {
        if (this.questSent === null) break
        // 送った数が、そのまま自分の結果になっているか（締め切りに間に合ったか）
        stats.questSent++
        if (merged(full()).me?.score === this.questSent) stats.questOk++
        this.questSent = null
        break
      }
      case 'prizeTime': {
        const b = full().b
        // 当たった人の一覧は全員で同じなので、番号で引ける表を 1 回だけ作る
        const byIdx = (b._byIdx ??= new Map((b.entries ?? []).map((e) => [e.idx, e])))
        const mine = byIdx.get(this.idx)
        if (!mine?.rarity) break
        // 本物のスマホと同じく、発表が画面に出たらすぐ「見ました」を送る（送らないスマホは、眠っているとみなされて、選ぶのを待ってもらえない）
        this.at(at, () => c.send({ type: 'prizeSeen' }))
        const kind = mine.choice?.allowed && Math.random() < opt.challenge ? 'challenge' : 'receive'
        stats.choices++
        if (kind === 'challenge') stats.challenges++
        this.at(at + (b.lastOne?.durationMs ?? 0) + 2000 + Math.random() * 6000, () => c.send({ type: 'choice', kind }))
        break
      }
      case 'dcEntry': {
        if (!merged(full()).meEligible) break
        this.at(at + 1000 + Math.random() * 12000, () => {
          this.entered = true
          c.send({ type: 'entry' })
        })
        break
      }
      case 'dcSpin': {
        if (!this.entered) break
        // エントリーが届いていれば、自分の玉が入っている
        stats.entries++
        if (merged(full()).balls?.length) stats.entryOk++
        this.entered = false
        break
      }
    }
  }
}

// ---- 見る役（大画面）と主催 --------------------------------------------------

const watcher = {
  snapshot(c, b) {
    const phase = b?.live?.phase ?? b?.totals?.phase
    if (phase === 'done') finish()
  },
  frame(c, type, s, at, full) {
    if (type !== null && !NOT_FOR_PLAYERS.has(type)) bseq.add(s)
    switch (type) {
      case 'host': {
        const h = (run.hostState = full().b)
        run.maxConnected = Math.max(run.maxConnected, h.connected ?? 0)
        if (h.phase === 'over' && !h.busy) run.overSeen = true
        if (h.phase === 'dc-entry' || h.phase === 'dc-spin') run.dcSeen = true
        if (h.phase === 'done') finish()
        drive()
        break
      }
      case 'notice':
        // 自分で頼んだモグラ撃退の「次の『次へ』で起きます」は、気になることに入れない
        if (run.questAsked === 'sent') run.questAsked = 'done'
        else notices.push(full().b.text)
        break
      case 'numberRevealed': {
        const b = full().b
        const r = reveal(b.n)
        if (r.seen) break
        r.seen = true
        r.drawNo = b.drawNo
        r.at = at
        run.draws = Math.max(run.draws, b.drawNo)
        // 主催の「イベントを手で起こす」と同じ。次の抽選の代わりに、モグラ撃退が始まる
        if (driving && hostClient && !run.questAsked && opt['quest-at'] > 0 && b.drawNo >= opt['quest-at']) {
          run.questAsked = 'sent'
          hostClient.send({ type: 'trigger', kind: 'mole' })
        }
        if (opt.scenario === 'storm' && !run.storm && b.drawNo >= opt['storm-at']) {
          run.storm = { at: null, count: 0 }
          setTimeout(storm, Math.max(0, clock.local(at) - nowMs()) + 1500)
        }
        break
      }
      case 'questStart':
        if (c.role === 'stage') run.quests++
        break
      case 'eventPlay':
        if (c.role === 'stage') run.wilds++
        break
      case 'gameOver':
        run.overSeen = true
        drive()
        break
      case 'dcEntry':
        run.dcSeen = true
        break
      case 'dcEnd':
        finish()
        break
    }
  },
}

// 主催の役: ゲームが終わったら「次へ」でダブルチャンスへ進める。
// ダブルチャンスの受付中に「次へ」を押すと締め切りになるので、押すのは 1 回だけ（届かなかったときだけ、もう一度）
function drive() {
  if (!driving || run.finished || !hostClient) return
  if (!run.overSeen || run.dcSeen || nowMs() - run.lastNext < 4000) return
  run.lastNext = nowMs()
  // 本物の主催の画面と同じく、見ていた進行の位置を付ける（届くまでに進んでいたら、サーバーが捨てる）
  hostClient.send(run.hostState?.step ? { type: 'next', from: run.hostState.step } : { type: 'next' })
}

function storm() {
  if (run.finished) return
  const targets = players.filter((p) => p.client && !p.client.closed && p.client.connectedAt !== null)
  run.storm = { at: nowMs(), count: targets.length }
  say(`全員（${targets.length} 人）を一度に切ります`)
  for (const p of targets) p.client.forceDrop(opt['storm-hold'])
}

// ---- 流れ -------------------------------------------------------------------

const seenIdx = new Set()
const players = []
let stage = null
let hostClient = null

// sse・poll の人を、番号の全体にまんべんなく散らす（受け口ごとに混ざるように）
function transportOf(i) {
  const f = Math.max(0, Math.min(1, opt.fallback))
  if (Math.floor((i + 1) * f) === Math.floor(i * f)) return opt.transport
  return Math.floor(i * f) % 2 === 0 ? 'sse' : 'poll'
}

// 認証アプリと同じ 6 桁（RFC 6238。HMAC-SHA1・30 秒・6 桁）。secret は base32
function totpNow(secret, now = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, '0')
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)))
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(now / 30000)))
  const h = createHmac('sha1', key).update(msg).digest()
  const o = h[h.length - 1] & 15
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0')
}

async function setup() {
  await syncHttp(8)
  say(`サーバーにつながりました（往復 ${fmtMs(clock.rtt)}）`)

  let hostKey = opt['host-key']
  let totpSecret = null
  if (!code) {
    const total = opt.players + opt.bots
    // 数の範囲は wire.ts の SETTINGS_LIMITS（下位 1〜1000、上位とダブルチャンスは 0〜200。整数）
    const lower = Math.min(1000, opt.lower || Math.max(3, Math.round(total * 0.03)))
    const settings = { lower, upper: Math.min(200, opt.upper || Math.max(1, Math.round(lower / 4))), dc: Math.min(200, opt.dc || Math.max(1, Math.round(lower / 6))) }
    const r = await http('POST', '/games', { body: { adminKey: opt['admin-key'], settings } })
    if (typeof r?.code !== 'string' || typeof r?.hostKey !== 'string') throw new Error('POST /api/games の返事に code と hostKey がありません')
    code = r.code
    hostKey = r.hostKey
    // 主催のログインには、認証アプリの 6 桁も要る。作ったときにもらった秘密の文字列から、この道具が自分で計算する
    totpSecret = typeof r.totpUri === 'string' ? (/[?&]secret=([^&]+)/.exec(r.totpUri)?.[1] ?? null) : null
    run.settings = settings
    say(`ゲームを作りました: ${code}（景品 下位 ${settings.lower}・上位 ${settings.upper}・ダブルチャンス ${settings.dc}）`)
    say(`大画面: ${base}/?g=${code}&view=stage　主催: ${base}/?g=${code}&view=host（主催キー ${hostKey}）`)
  }
  const st = await http('GET', `/g/${code}/state`)
  if (!st?.canJoin) throw new Error(`ゲーム ${code} には、もう参加できません（phase: ${st?.phase}）`)

  stage = new Client({ role: 'stage', handler: watcher })
  stage.start()
  if (driving) {
    const totp = opt.totp || (totpSecret ? totpNow(totpSecret) : '')
    const login = await http('POST', `/g/${code}/host/login`, { body: totp ? { hostKey, totp } : { hostKey } })
    if (typeof login?.token !== 'string') throw new Error('host/login の返事に token がありません')
    run.hostToken = login.token
    hostClient = new Client({ role: 'host', token: login.token, handler: watcher })
    hostClient.start()
  }
  const crew = [stage, hostClient].filter(Boolean)
  const ok = await Promise.race([Promise.all(crew.map((c) => c.first)).then(() => true), sleep(15000).then(() => false)])
  if (!ok) throw new Error(`${stage.connectedAt === null ? '大画面' : '主催'}の役がつながりません（ws でつないで、最初に snapshot が届くはずです）`)
}

async function joinAll() {
  for (let i = 0; i < opt.players; i++) players.push(new Player(i, transportOf(i)))
  const t0 = nowMs()
  let next = 0
  const worker = async () => {
    while (next < players.length && !run.finished) await players[next++].joinAndConnect()
  }
  const tick = setInterval(() => say(`参加 ${next} / ${players.length} 人`), 5000)
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opt.concurrency, players.length)) }, worker))
  clearInterval(tick)
  run.joinMs = nowMs() - t0
  const connected = players.filter((p) => p.client?.connectedAt != null).length
  say(`参加 ${players.length - stats.joinFailed} 人・つながった ${connected} 人（${fmtSec(run.joinMs)}）`)
  if (connected === 0) throw new Error('1 人もつながりませんでした')
}

async function startGame() {
  if (opt.bots > 0) hostClient.send({ type: 'bots', count: opt.bots })
  // 参加がそろうまで待つ。--expect のときは、ほかの PC から入る人を待つので、長めに（15 分）
  const expect = opt.expect || players.length - stats.joinFailed + opt.bots
  const limit = opt.expect ? 900 : 60
  for (let i = 0; i < limit && !run.finished; i++) {
    const st = await http('GET', `/g/${code}/state`).catch(() => null)
    if (st && st.players >= expect) break
    if (i === limit - 1) say(`参加が ${expect} 人にそろいませんでした（いま ${st?.players ?? '?'} 人）。このまま始めます`)
    else if (i % 10 === 9) say(`参加がそろうのを待っています（${st?.players ?? '?'} / ${expect} 人）`)
    await sleep(1000)
  }
  if (run.finished) return
  hostClient.send({ type: 'next' })
  hostClient.send({ type: 'auto', on: true })
  for (let i = 0; i < 20 && !run.finished; i++) {
    await sleep(1000)
    const st = await http('GET', `/g/${code}/state`).catch(() => null)
    if (st && st.phase !== 'reception') return say('ゲームを始めました（自動進行）')
  }
  if (!run.finished) throw new Error('「次へ」を送っても、ゲームが始まりませんでした')
}

function progress() {
  const on = players.filter((p) => p.client?.live).length
  const g = lat[opt.transport]
  const late = g.hist.n ? ` · 遅れた ${fmtPct(pct(g.late, g.hist.n))}` : ''
  say(`抽選 ${run.draws} 回 · つながっている ${on} / ${players.length} 人${late}`)
}

function watchdog() {
  if (run.finished) return
  if (nowMs() - run.startedAt > opt['max-minutes'] * 60000) return finish(`${opt['max-minutes']} 分たっても終わらないので、打ち切りました`)
  // 進行をしない PC では、主催が始めるまで何も届かないことがある
  if ((driving || run.draws > 0) && nowMs() - run.lastFrameAt > STALL_MS) finish(`進行が止まりました（${STALL_MS / 1000} 秒、何も届きません）`)
  drive()
}

async function main() {
  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()
  process.on('SIGINT', () => finish('途中で止めました（Ctrl+C）'))
  process.on('unhandledRejection', (e) => noteError('想定外', e))
  say(`${api} に、参加者 ${opt.players} 人でつなぎます（${opt.scenario}）`)
  try {
    await setup()
    await joinAll()
    if (!run.finished) {
      if (driving) await startGame()
      else say('主催が始めるのを待っています')
      run.lastFrameAt = nowMs()
      const timers = [setInterval(progress, 10000), setInterval(watchdog, 2000)]
      await ended
      timers.forEach(clearInterval)
    }
  } catch (e) {
    finish(e?.message ?? String(e))
  }
  // 最後のメッセージが全員に届くのを待つ（poll の人は 1.5 秒おき）
  if (!run.error) await sleep(LEAD_MS + POLL_MS + 1500)

  if (code) {
    const st = await http('GET', `/g/${code}/state`).catch(() => null)
    const seen = [...reveals.values()].filter((r) => r.seen || r.live || r.later).map((r) => r.n)
    run.truth = Array.isArray(st?.drawn) && st.drawn.length >= seen.length ? st.drawn : seen
    run.finalPhase = st?.phase ?? null
    if (run.hostToken) run.results = await http('GET', `/g/${code}/results`, { query: { role: 'host', token: run.hostToken } }).catch((e) => (noteError('results', e), null))
  }
  const liveAtEnd = new Set(players.filter((p) => p.client?.live))
  for (const c of [stage, hostClient, ...players.map((p) => p.client)]) c?.close()
  loop.disable()

  const { text, pass, summary } = report(liveAtEnd, loop)
  console.log(text)
  if (opt.json) await writeFile(opt.json, JSON.stringify(summary, null, 2))
  await new Promise((r) => process.stdout.write('', r))
  process.exit(pass ? 0 : 1)
}

// ---- 結果 -------------------------------------------------------------------

function report(liveAtEnd, loop) {
  const out = []
  const active = players.filter((p) => p.client?.connectedAt != null)
  const byTransport = { ws: 0, sse: 0, poll: 0 }
  for (const p of players) byTransport[p.transport]++

  // 番号の発表
  const truth = run.truth
  let missing = 0
  for (const p of active) for (const n of truth) if (!p.known[n]) missing++
  const revealTotal = truth.length * active.length
  const rows = truth.map((n) => reveal(n))
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0)
  const spreads = rows.filter((r) => r.max > -Infinity).map((r) => ({ drawNo: r.drawNo, spread: r.max - r.min, behind: Math.max(0, r.max - r.at) }))
  const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN)
  const worst = (k) => spreads.reduce((w, x) => (!w || x[k] > w[k] ? x : w), null)

  // 通し番号の飛び: 区間ごとに「届くはずの全員宛ての数」と「届いた数」を比べる
  const all = [...bseq].sort((a, b) => a - b)
  const lastAll = all.length ? all[all.length - 1] : 0
  let gaps = 0
  let gapPlayers = 0
  for (const p of active) {
    const c = p.client
    const segs = [...c.segs]
    // 最後までつながっていた人は、最後の全員宛てまで届いているはず
    if (c.segStart !== null) segs.push([c.segStart, liveAtEnd.has(p) ? Math.max(c.lastSeq, lastAll) : c.lastSeq, c.segGot])
    let mine = 0
    for (const [from, to, got] of segs) mine += Math.max(0, countIn(all, from, to) - got)
    gaps += mine
    if (mine) gapPlayers++
  }

  // つなぎ直し
  const forced = reconns.filter((r) => r.forced)
  const natural = reconns.filter((r) => !r.forced)
  const back = (list) => list.filter((r) => r.t1 !== null)
  const backHist = (list) => {
    const h = new Hist()
    for (const r of back(list)) h.add(r.t1 - r.t0)
    return h
  }
  const modes = (list) => `続きから ${back(list).filter((r) => r.mode === 'resume').length} · snapshot ${back(list).filter((r) => r.mode === 'snapshot').length} · 戻れず ${list.length - back(list).length}`

  // 合格の基準
  const fast = { n: lat.ws.hist.n + lat.sse.hist.n, late: lat.ws.late + lat.sse.late }
  const checks = []
  const check = (name, rule, value, ok) => checks.push({ name, rule, value, ok })
  const need = (x, min) => Number.isFinite(x) && x >= min
  const cRate = pct(active.length, players.length || opt.players)
  check('つなげた', `${opt['min-connect']}% 以上`, `${fmtPct(cRate)}（${active.length} / ${players.length || opt.players} 人）`, need(cRate, opt['min-connect']))
  const oRate = pct(fast.n - fast.late, fast.n)
  if (byTransport.ws + byTransport.sse > 0) check('at に間に合った（ws・sse）', `${opt['min-ontime']}% 以上`, `${fmtPct(oRate)}（${fast.n - fast.late} / ${fast.n} 通）`, need(oRate, opt['min-ontime']))
  const rRate = pct(revealTotal - missing, revealTotal)
  check('番号の発表を受け取った', `${opt['min-reveal']}% 以上`, `${fmtPct(rRate)}（発表 ${truth.length} 回 × ${active.length} 人）`, need(rRate, opt['min-reveal']))
  if (opt.scenario === 'storm') {
    const sRate = pct(back(forced).length, forced.length)
    check('切ったあと、つなぎ直せた', `${opt['min-connect']}% 以上`, forced.length ? `${fmtPct(sRate)}（${back(forced).length} / ${forced.length} 人）` : '切る前に終わりました', need(sRate, opt['min-connect']))
  }
  check('最後まで進んだ', 'はい', run.error ? `いいえ（${run.error}）` : 'はい', !run.error)
  const pass = checks.every((c) => c.ok)

  const took = (Number.isFinite(run.endedAt) ? run.endedAt : nowMs()) - run.startedAt
  out.push('', '==== Bingoo 負荷試験の結果 ====', '')
  out.push(
    table([
      ['サーバー', api],
      ['ゲーム', code ? `${code}${run.settings ? `（景品 下位 ${run.settings.lower}・上位 ${run.settings.upper}・ダブルチャンス ${run.settings.dc}）` : ''}` : '（作れませんでした）'],
      ['参加者', `${players.length} 人（ws ${byTransport.ws}・sse ${byTransport.sse}・poll ${byTransport.poll}）${opt.bots ? ` + 仮想 ${opt.bots} 人` : ''}`],
      ['流れ', `${opt.scenario}${opt.scenario === 'storm' ? `（${opt['storm-at']} 回目のあとで切る。足す待ち ${opt['storm-hold']} ms）` : ''}${driving ? '' : '・進行はしない'}`],
      ['かかった時間', `${Math.floor(took / 60000)} 分 ${Math.round((took % 60000) / 1000)} 秒（抽選 ${truth.length} 回・モグラ撃退 ${run.quests} 回・虹玉 ${run.wilds} 回）`],
    ]),
  )

  out.push('', '-- 合格の基準と結果', '')
  out.push(table([['項目', '基準', '結果', '判定'], ...checks.map((c) => [c.name, c.rule, c.value, c.ok ? '合格' : '不合格'])]))

  out.push('', '-- 参加とつなぐ', '')
  out.push(
    table([
      ['参加（join）', `失敗 ${stats.joinFailed} · やり直し ${stats.joinRetries}`, hist.join.text()],
      ['つなぐ（snapshot が届くまで）', `失敗 ${stats.connectFailed}`, hist.connect.text()],
      ['全員が入るまで', fmtSec(run.joinMs), `同時に ${opt.concurrency} 件ずつ`],
      ['時計合わせ', `往復の最短 ${fmtMs(clock.rtt)}`, `時刻の誤差の目安 ±${fmtMs(clock.rtt / 2)}　往復 ${hist.rtt.text()}`],
    ]),
  )

  out.push('', '-- 届いた時刻と at の差（マイナスは、at より早く届いた = 余裕）', '')
  const latRow = (name, g, note = '') => [name, String(g.hist.n), g.hist.n ? fmtPct(pct(g.hist.n - g.late, g.hist.n)) : '-', fmtMs(g.hist.pct(50)), fmtMs(g.hist.pct(95)), fmtMs(g.hist.pct(99)), `${fmtMs(g.hist.max)}${note}`]
  out.push(
    table([
      ['方式', '通数', '間に合った', 'p50', 'p95', 'p99', '最大'],
      latRow('ws', lat.ws),
      latRow('sse', lat.sse),
      latRow('poll', lat.poll, lat.poll.hist.n ? '　（1.5 秒おきに取りに行くので、遅れるのがふつう）' : ''),
      latRow('大画面・主催', lat.crew),
    ]),
  )
  out.push(`  つなぎ直しのあとでまとめて届いた分（上には入れていない）: ${stats.catchup} 通`)

  out.push('', '-- 番号の発表（numberRevealed）', '')
  out.push(
    table([
      ['その場で受け取った', String(sum('live'))],
      ['つなぎ直しのあとで届いた', String(sum('later'))],
      ['snapshot で知った', String(sum('snap'))],
      ['知らないまま終わった', String(missing)],
      ['受け取った時刻の広がり（ws・sse）', spreads.length ? `中央値 ${fmtMs(median(spreads.map((x) => x.spread)))} · 最大 ${fmtMs(worst('spread').spread)}（${worst('spread').drawNo} 回目）` : '-'],
      ['いちばん遅い端末の、at からの遅れ', spreads.length ? `中央値 ${fmtMs(median(spreads.map((x) => x.behind)))} · 最大 ${fmtMs(worst('behind').behind)}（${worst('behind').drawNo} 回目）` : '-'],
    ]),
  )

  out.push('', '-- 切れた数と、つなぎ直し', '')
  const byeText = Object.entries(stats.bye).map(([k, v]) => `${k} ${v}`).join(' · ') || 'なし'
  const reRows = [
    ['切れた（こちらから切ったのではない）', String(stats.drops), stats.keepaliveLost ? `うち、生存確認の返事なし ${stats.keepaliveLost}` : ''],
    ['つながる前の失敗', String(stats.failedAttempts), `つなごうとした回数 ${stats.attempts}`],
    ['サーバーから bye', byeText, ''],
  ]
  if (natural.length) reRows.push(['切れてから戻るまで', modes(natural), backHist(natural).text()])
  if (forced.length) {
    const lastBack = Math.max(...back(forced).map((r) => r.t1), run.storm.at)
    reRows.push(['storm: 切ってから戻るまで', modes(forced), backHist(forced).text()])
    reRows.push(['storm: 全員が戻るまで', fmtSec(lastBack - run.storm.at), `${run.storm.count} 人を一度に切った`])
  }
  out.push(table(reRows))

  out.push('', '-- 通し番号', '')
  out.push(
    table([
      ['届かなかった全員宛て（飛び）', `${gaps} 通`, gapPlayers ? `${gapPlayers} 人` : ''],
      ['同じ番号・古い番号が届いた', `${stats.dup} 通`, ''],
      ['snapshot から始まらなかった', `${stats.noSnapshot} 回`, ''],
      ['見る役が数えた全員宛て', `${all.length} 通`, stage?.segs.length || hostClient?.segs.length ? '見る役が途中で切れたので、飛びの数は少なめに出ています' : ''],
    ]),
  )

  out.push('', '-- 参加者の操作', '')
  out.push(
    table([
      ['送った操作', `${stats.cmds} 通`, `つながらず捨てた ${stats.cmdDropped} · 送れなかった ${stats.cmdFailed}`],
      ['モグラ撃退の数が届いた', stats.questSent ? `${stats.questOk} / ${stats.questSent}` : '-', '送った数が、そのまま結果になった人'],
      ['景品の選択', `${stats.choices} 回`, `うち上位チャレンジ ${stats.challenges}`],
      ['ダブルチャンスのエントリーが届いた', stats.entries ? `${stats.entryOk} / ${stats.entries}` : '-', ''],
      ['当選者の一覧', run.results ? `${run.results.length} 行` : '-', run.results ? `うち仮想 ${run.results.filter((r) => r.bot).length}` : ''],
      ['主催の画面の「つながっている数」', run.maxConnected ? `最大 ${run.maxConnected}` : '-', ''],
    ]),
  )

  const odd = [
    stats.wrongMe && `snapshot の本人の番号がちがう: ${stats.wrongMe} 回`,
    stats.dupIdx && `同じ番号（idx）を 2 人がもらった: ${stats.dupIdx} 回`,
    stats.bad && `読めないメッセージ: ${stats.bad} 通`,
    ...notices.slice(0, 5).map((t) => `主催への知らせ: ${t}`),
  ].filter(Boolean)
  if (odd.length || errors.size) {
    out.push('', '-- 気になること', '')
    for (const t of odd) out.push(`  ${t}`)
    for (const [k, v] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 12)) out.push(`  ${k} × ${v}`)
  }

  // この道具が追いついていないと、届いた時刻が実際より遅く出る
  const loopP99 = loop.percentile(99) / 1e6
  const loopMax = loop.max / 1e6
  out.push('', '-- この道具の側', '')
  out.push(`  処理の待ち: p99 ${fmtMs(loopP99)} · 最大 ${fmtMs(loopMax)}`)
  if (loopP99 > 100) out.push('  この PC が追いついていません（遅れの数字は、実際より悪く出ています）。人数を分けて、2 台目から --code と --no-host で入ってください')

  out.push('', pass ? '結果: 合格' : `結果: 不合格（${checks.filter((c) => !c.ok).map((c) => c.name).join('・')}）`, '')

  const summary = {
    pass,
    error: run.error,
    api,
    code,
    scenario: opt.scenario,
    players: players.length,
    transports: byTransport,
    tookMs: Math.round(took),
    draws: truth.length,
    checks,
    join: { failed: stats.joinFailed, retries: stats.joinRetries, ms: hist.join.summary(), allMs: Math.round(run.joinMs) },
    connect: { failed: stats.connectFailed, ms: hist.connect.summary() },
    clock: { minRttMs: clock.rtt, rtt: hist.rtt.summary() },
    lateness: Object.fromEntries(Object.entries(lat).map(([k, g]) => [k, { ...g.hist.summary(), late: g.late }])),
    reveal: { total: revealTotal, live: sum('live'), later: sum('later'), snapshot: sum('snap'), missing, spreads },
    reconnect: {
      drops: stats.drops,
      natural: { count: natural.length, back: back(natural).length, ms: backHist(natural).summary() },
      storm: forced.length ? { count: forced.length, back: back(forced).length, snapshot: back(forced).filter((r) => r.mode === 'snapshot').length, ms: backHist(forced).summary() } : null,
    },
    seq: { gaps, gapPlayers, dup: stats.dup, broadcasts: all.length },
    stats,
    errors: Object.fromEntries(errors),
    tool: { loopP99Ms: loopP99, loopMaxMs: loopMax },
  }
  return { text: out.join('\n'), pass, summary }
}

main()
