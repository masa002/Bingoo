import { Clock } from '../demo/clock'
import { LocalHub } from './hub'
import { ApiError, type Api, type Link, type LinkOptions, type LinkState, type LinkStatus, type Transport } from './link'
import type { PhoneCommand } from './protocol'
import {
  inflate,
  KEEPALIVE,
  LEAD_MS,
  type CreateReq,
  type CreateRes,
  type Down,
  type Frame,
  type HostCommand,
  type JoinReq,
  type JoinRes,
  type LoginReq,
  type LoginRes,
  type PollRes,
  type PublicState,
  type ResultRow,
  type Up,
} from './wire'

// 本番のサーバーとつなぐ部分（ブラウザ側）。
// いちばん大事なのは「全員の画面が同じ瞬間に動く」こと。サーバーはメッセージに「この時刻に画面へ渡す」（at）を付けて
// 少し前に送ってくるので、ここでサーバーとの時刻の差を測り、at になった瞬間に hub へ流す。
// 画面の部品は、デモと同じように hub を subscribe するだけでよい

// ---- 数字 -------------------------------------------------------------------

// 時計合わせ
const SYNC_GAP_MS = 200 // 続けて測るときの間隔
const SYNC_FIRST = 5 // つないだ直後に測る回数
const SYNC_AGAIN = 3 // そのあと（2 分ごと・画面が見えるようになったとき）に測る回数
const SYNC_EVERY_MS = 120_000
const DRIFT = 1e-4 // 端末の時計のずれ方の見込み（1 秒に 0.1ms）。古い測定を、その分だけ信用しなくする
const UNSYNCED_MS = 1000 // 時計がまだ合っていないとき、最初のメッセージを待たせる長さ（その間に合えば、そろえて渡せる）

// 画面へ渡す時刻
// サーバーが先に送ってくるのは LEAD_MS だけなので、それより大きく待つことになったら、端末の時計のほうがおかしい。
// 届いてからこの時間で渡してしまう（時計が狂っていても、画面が何秒も止まらないように）
const HOLD_MS = LEAD_MS + 1300
const STALE_MS = 3000 // 渡すのがこれより遅れた分は、流さずに「いまの状態」をもらい直す
const RESYNC_GAP_MS = 10_000 // もらい直しは、この間に 1 回まで（時計がおかしいときに、つなぎ直しを繰り返さないように）

// つなぎ直し
const RETRY_MIN_MS = 500
const RETRY_MAX_MS = 8000
const STABLE_MS = 5000 // これだけ続いた接続のあとは、待ち時間を最初に戻す
const CONNECT_MS = 6000 // つないでから、最初の 1 通が来るまで待つ長さ
const SWITCH_NEW = 2 // まだ通じたことのない方式は、この回数だめなら次の方式へ
const SWITCH_WORKED = 6 // 通じたことのある方式は、サーバー側の不調のことが多いので、ねばる

// 生存確認（ws）
const PING_MS = 25_000
const PONG_MS = 10_000
const WAKE_MS = 3000 // 画面が見えるようになったときは、短く確かめる（切れていたら、すぐつなぎ直したい）

// poll
const POLL_MS = 1500
const POLL_TIMEOUT_MS = 8000
// poll は 1.5 秒おきなので、みんなと同じ瞬間には動けない。ときどき、もっといい方式を試す（だめなら間隔を倍に）
const UP_FIRST_MS = 60_000
const UP_MAX_MS = 600_000

// 送る
const POST_GAP_MS = 100 // sse・poll のとき、この間の操作をまとめて 1 回で送る
const POST_TRIES = 3
const OUT_MAX = 10 // つながっていない間に取っておく操作の数
// 主催の操作は、古くなったら送らない（切れている間に押した「次へ」が、だいぶ後になって急に効くと危ない）
const HOST_HOLD_MS = 5000

// ---- 小さな道具 -------------------------------------------------------------

type Timer = ReturnType<typeof setTimeout>
type Cmd = PhoneCommand | HostCommand

const ORDER: readonly Transport[] = ['ws', 'sse', 'poll']

function usable(kind: Transport): boolean {
  if (kind === 'ws') return typeof WebSocket !== 'undefined'
  if (kind === 'sse') return typeof EventSource !== 'undefined'
  return true
}

function nextKind(kind: Transport): Transport {
  const list = ORDER.filter(usable)
  return list[(list.indexOf(kind) + 1) % list.length]
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

// '/api/…' や 'https://…' を、WebSocket の URL にする
function wsUrl(http: string): string {
  const abs = /^https?:/i.test(http) || typeof location === 'undefined' ? http : new URL(http, location.href).href
  return abs.replace(/^http/i, 'ws')
}

function offline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

// 画面の側の関数が例外を出しても、通信は止めない
function safely(fn: () => void): void {
  try {
    fn()
  } catch (e) {
    console.error(e)
  }
}

// ---- 接続 -------------------------------------------------------------------

// つなぎ 1 本
interface Conn {
  kind: Transport
  got: boolean // 1 通でも受け取った（この方式で通じている）
  openedAt: number
  deadline?: Timer
  close(): void
  write?(text: string): boolean // ws だけ。送れたら true
  check?(waitMs: number): void // ws だけ。生きているか確かめる
}

// 受け取って、渡す時刻を待っているメッセージ
interface Held {
  f: Frame
  snap: boolean
  cap: number // 端末の時計で、遅くともこの時刻には渡す
}

interface Queued {
  cmd: Cmd
  text: string
  at: number
  tries: number
}

class Remote implements Link {
  readonly hub = new LocalHub()
  readonly clock = new Clock()

  private readonly me: number
  private readonly root: string
  private readonly watchers = new Set<(s: LinkState) => void>()
  private st: LinkState
  private dead = false

  // 時計: サーバーの時刻 = 端末の時刻 + offset
  private best: { rtt: number; offset: number; at: number } | null = null
  private unsyncedUntil: number | null = null
  private syncTimers: Timer[] = []
  private readonly syncEvery: Timer

  // 受け取った分（at の順）
  private held: Held[] = []
  private last: number | null = null // 最後に受け取った通し番号
  private pumpTimer?: Timer
  private resyncAt = -Infinity
  private doubtAt = -Infinity

  // つなぎ
  private kind: Transport
  private conn: Conn | null = null
  private trial: Conn | null = null // poll のまま、もっといい方式を試している 1 本
  private readonly worked = new Set<Transport>()
  private everLive = false
  private fails = 0 // いまの方式で、1 通も受け取れないまま終わった回数（続けて）
  private attempt = 0 // 待ち時間を決める回数
  private retryTimer?: Timer
  private upTimer?: Timer
  private upWait = UP_FIRST_MS
  private trials = 0

  // 送る分
  private out: Queued[] = []
  private postTimer?: Timer

  constructor(private readonly o: LinkOptions) {
    this.me = o.role === 'player' ? (o.idx ?? -1) : -1
    this.root = `${trimSlash(o.api)}/g/${encodeURIComponent(o.code)}`
    this.kind = o.transport ?? ORDER.find(usable) ?? 'poll'
    this.st = { status: 'connecting', transport: this.kind }
    this.syncEvery = setInterval(() => this.sync(SYNC_AGAIN), SYNC_EVERY_MS)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible)
    if (typeof window !== 'undefined') window.addEventListener('online', this.hurry)
    this.open(this.kind)
  }

  // ---- 外から使う口 ---------------------------------------------------------

  state(): LinkState {
    return this.st
  }

  onState(fn: (s: LinkState) => void): () => void {
    this.watchers.add(fn)
    safely(() => fn(this.st))
    return () => {
      this.watchers.delete(fn)
    }
  }

  send(cmd: Cmd): void {
    if (this.dead) return
    const live = this.conn?.got === true
    // 途中経過は、次がすぐ来る。つながっていない間の分は取っておかない（大事な操作の場所を取らせない）
    if (!live && cmd.type === 'questProgress') return
    const text = JSON.stringify(cmd)
    // 待っている間に同じ操作を何度押しても、1 回分にする
    if (this.out.some((q) => q.text === text)) return
    this.out.push({ cmd, text, at: Date.now(), tries: 0 })
    if (this.out.length > OUT_MAX) this.out.shift()
    if (live) this.flush()
  }

  close(): void {
    this.end()
  }

  // ---- 状態 -----------------------------------------------------------------

  private set(status: LinkStatus, reason?: LinkState['reason']): void {
    if (this.st.status === status && this.st.transport === this.kind && this.st.reason === reason) return
    this.st = reason ? { status, transport: this.kind, reason } : { status, transport: this.kind }
    for (const fn of [...this.watchers]) safely(() => fn(this.st))
  }

  private waiting(): LinkStatus {
    return this.everLive ? 'retrying' : 'connecting'
  }

  // もうつながない
  private end(reason?: LinkState['reason']): void {
    if (this.dead) return
    this.dead = true
    this.drop()
    clearTimeout(this.retryTimer)
    clearTimeout(this.pumpTimer)
    clearTimeout(this.postTimer)
    clearInterval(this.syncEvery)
    this.syncTimers.forEach(clearTimeout)
    this.held = []
    this.out = []
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible)
    if (typeof window !== 'undefined') window.removeEventListener('online', this.hurry)
    this.set('closed', reason)
  }

  // ---- 時計合わせ -----------------------------------------------------------

  private sync(count: number, first = 0): void {
    this.syncTimers.forEach(clearTimeout)
    this.syncTimers = []
    for (let i = 0; i < count; i++) {
      const ms = first + i * SYNC_GAP_MS
      if (ms === 0) this.probe()
      else this.syncTimers.push(setTimeout(() => this.probe(), ms))
    }
  }

  private ping(conn: Conn): void {
    conn.write?.(JSON.stringify({ t: 'ping', c: Date.now() } satisfies Up))
  }

  private probe(): void {
    const conn = this.conn
    if (!conn || this.dead) return
    if (conn.kind === 'ws') return this.ping(conn)
    const c = Date.now()
    fetch(`${trimSlash(this.o.api)}/time`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ now?: unknown }>) : null))
      .then((j) => {
        if (j && typeof j.now === 'number') this.sample(c, j.now)
      })
      .catch(() => {})
  }

  // 1 回の測定。c は送ったときの端末の時刻、now はサーバーが返事を書いたときの時刻。
  // 返事の時刻は「行きと帰りのまんなか」だったとみなす（ずれは、多くても往復の半分）
  private sample(c: number, now: number): void {
    if (this.dead) return
    const t = Date.now()
    const rtt = t - c
    if (!(rtt >= 0 && rtt < 10_000)) return
    const offset = now + rtt / 2 - t
    const b = this.best
    // いまの値の確からしさ（往復の半分 + 測ってからの時計のずれ）。
    // 新しい測定のほうが確かなら入れかえる。食いちがっているとき（端末の時計が動かされた）も入れかえる
    const slack = b ? b.rtt / 2 + (t - b.at) * DRIFT : Infinity
    if (b && rtt / 2 > slack && Math.abs(offset - b.offset) <= rtt / 2 + slack) return
    this.best = { rtt, offset, at: t }
    this.pump()
  }

  // ---- 受け取って、時刻どおりに渡す -----------------------------------------

  private accept(f: Frame): void {
    if (this.dead || !f || typeof f.s !== 'number' || typeof f.at !== 'number') return
    const snap = (f.b?.type ?? f.p?.type) === 'snapshot'
    if (snap) {
      // 「いまの状態」が丸ごと入っているので、それより前の分はもう渡さない。
      // 通し番号が戻っていたら、ゲームが作り直されている（待っている分は全部捨てる）
      const back = this.last !== null && f.s < this.last
      this.held = back ? [] : this.held.filter((h) => h.f.s > f.s)
      this.last = back ? f.s : Math.max(this.last ?? f.s, f.s)
    } else {
      if (this.last !== null && f.s <= this.last) return // もう受け取った分
      this.last = f.s
    }
    const now = Date.now()
    if (!this.best) this.unsyncedUntil ??= now + UNSYNCED_MS
    else if (f.at - this.best.offset > now + HOLD_MS && now - this.doubtAt > RESYNC_GAP_MS) {
      // 待ちが長すぎる。時計が狂ったとみて、測り直す
      this.doubtAt = now
      this.sync(SYNC_AGAIN)
    }
    // at の順に並べる（同じ時刻なら通し番号の順）。主催宛てのように「いますぐ」の分は、先に待っている分を追い越す
    let i = this.held.length
    while (i > 0 && (this.held[i - 1].f.at > f.at || (this.held[i - 1].f.at === f.at && this.held[i - 1].f.s > f.s))) i--
    this.held.splice(i, 0, { f, snap, cap: now + HOLD_MS })
    this.pump()
  }

  // 端末の時計で、いつ渡すか
  private dueAt(h: Held): number {
    const due = this.best ? h.f.at - this.best.offset : (this.unsyncedUntil ?? 0)
    return Math.min(due, h.cap)
  }

  private pump(): void {
    clearTimeout(this.pumpTimer)
    this.pumpTimer = undefined
    while (!this.dead) {
      const head = this.held[0]
      if (!head) return
      const now = Date.now()
      const due = this.dueAt(head)
      if (due > now) {
        this.pumpTimer = setTimeout(() => this.pump(), due - now)
        return
      }
      // タブが裏に回っていてタイマーが止まっていた、など。古い演出を早回しで見せずに、いまの状態から始める
      if (this.best && !head.snap && now + this.best.offset - head.f.at > STALE_MS && now - this.resyncAt > RESYNC_GAP_MS) return this.resync()
      this.held.shift()
      safely(() => this.hub.publish(inflate(head.f, this.me)))
    }
  }

  // たまった分を捨てて、つなぎ直す。after を付けないので、サーバーは「いまの状態」（snapshot）を送ってくる
  private resync(): void {
    this.resyncAt = Date.now()
    this.held = []
    this.last = null
    this.drop()
    this.set(this.waiting())
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.open(this.kind), Math.random() * 300)
  }

  // ---- つなぐ ---------------------------------------------------------------

  private query(after = true): string {
    const q = new URLSearchParams({ role: this.o.role })
    if (this.o.role === 'player' && this.o.idx !== undefined) q.set('idx', String(this.o.idx))
    if (this.o.token) q.set('token', this.o.token)
    if (after && this.last !== null) q.set('after', String(this.last))
    return q.toString()
  }

  private open(kind: Transport): void {
    this.drop()
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.dead) return
    this.kind = kind
    this.set(this.waiting())
    this.conn = this.dial(kind, false)
    if (kind !== 'ws') this.sync(SYNC_FIRST) // ws は、開いてから ping で測る
  }

  private dial(kind: Transport, trial: boolean): Conn {
    const conn: Conn = { kind, got: false, openedAt: Date.now(), close: () => {} }
    conn.deadline = setTimeout(() => this.lost(conn), CONNECT_MS)
    try {
      if (kind === 'ws') this.dialWs(conn)
      else if (kind === 'sse') this.dialSse(conn, trial)
      else this.dialPoll(conn)
    } catch {
      // URL が作れない・https のページから ws:// など。ふつうの失敗として数える
      clearTimeout(conn.deadline)
      conn.deadline = setTimeout(() => this.lost(conn), 0)
    }
    return conn
  }

  private dialWs(conn: Conn): void {
    const ws = new WebSocket(wsUrl(`${this.root}/ws?${this.query()}`))
    let alive: Timer | undefined
    let pong: Timer | undefined
    conn.write = (text) => {
      if (ws.readyState !== 1) return false
      ws.send(text)
      return true
    }
    conn.check = (waitMs) => {
      conn.write?.(KEEPALIVE.ping)
      clearTimeout(pong)
      pong = setTimeout(() => this.lost(conn), waitMs)
    }
    conn.close = () => {
      clearInterval(alive)
      clearTimeout(pong)
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close()
      } catch {
        // もう閉じている
      }
    }
    ws.onopen = () => {
      // 最初の ping の返事が、この方式で通じたしるしになる（開くだけ開いて何も通さない経路がある）
      this.ping(conn)
      alive = setInterval(() => conn.check?.(PONG_MS), PING_MS)
    }
    ws.onmessage = (e) => {
      clearTimeout(pong) // 何か届いたなら、生きている
      this.receive(conn, e.data)
    }
    ws.onclose = ws.onerror = () => this.lost(conn)
  }

  private dialSse(conn: Conn, trial: boolean): void {
    // まだ通じたことがないときは after を付けない。かならず snapshot が流れてくるので、
    // 「開いたのに何も流れてこない」（途中でためこむ経路）を見分けられる
    const fresh = trial || !this.worked.has('sse')
    const es = new EventSource(`${this.root}/sse?${this.query(!fresh)}`)
    conn.close = () => {
      es.onopen = es.onmessage = es.onerror = null
      es.close()
    }
    es.onopen = () => {
      if (!fresh) this.up(conn)
    }
    es.onmessage = (e) => this.receive(conn, e.data)
    // EventSource は自分でつなぎ直そうとするが、after を付け直せないので、閉じて自分でやる
    es.onerror = () => this.lost(conn)
  }

  private dialPoll(conn: Conn): void {
    let timer: Timer | undefined
    let abort: AbortController | null = null
    let stopped = false
    conn.close = () => {
      stopped = true
      clearTimeout(timer)
      abort?.abort()
    }
    const tick = (): void => {
      const c = Date.now()
      abort = typeof AbortController === 'undefined' ? null : new AbortController()
      timer = setTimeout(() => this.lost(conn), POLL_TIMEOUT_MS)
      fetch(`${this.root}/poll?${this.query()}`, { cache: 'no-store', signal: abort?.signal })
        .then(async (r) => ({ r, j: (await r.json().catch(() => null)) as PollRes | null }))
        .then(({ r, j }) => {
          clearTimeout(timer)
          if (stopped) return
          if (j?.bye) return this.end(j.bye)
          if (!r.ok || !j) {
            if (r.status === 401 || r.status === 403) this.end('auth')
            else if (r.status === 404 || r.status === 410) this.end('closed')
            else this.lost(conn)
            return
          }
          this.up(conn)
          if (typeof j.now === 'number') this.sample(c, j.now)
          for (const f of j.frames ?? []) this.accept(f)
          if (!stopped) timer = setTimeout(tick, POLL_MS)
        })
        .catch(() => {
          clearTimeout(timer)
          if (!stopped) this.lost(conn)
        })
    }
    tick()
  }

  // ws・sse から届いた 1 通
  private receive(conn: Conn, data: unknown): void {
    if ((conn !== this.conn && conn !== this.trial) || typeof data !== 'string') return
    let d: Down | null = null
    if (data !== KEEPALIVE.pong) {
      try {
        d = JSON.parse(data) as Down
      } catch {
        return
      }
      if (!d || typeof d !== 'object') return
      if ('t' in d && d.t === 'bye') return this.end(d.reason)
    }
    if (conn === this.trial) this.adopt(conn)
    this.up(conn)
    if (!d) return
    if (!('t' in d)) this.accept(d)
    else if (d.t === 'pong') this.sample(d.c, d.now)
  }

  // この 1 本が通じた
  private up(conn: Conn): void {
    if (conn !== this.conn || conn.got) return
    conn.got = true
    clearTimeout(conn.deadline)
    this.kind = conn.kind
    this.worked.add(conn.kind)
    this.everLive = true
    this.fails = 0
    this.set('live')
    if (conn.kind === 'ws') this.sync(SYNC_FIRST - 1, SYNC_GAP_MS) // 1 回目は、開いたときの ping
    this.flush()
    this.planTrial()
  }

  // いまの 1 本を片付ける（試している 1 本も）
  private drop(): void {
    for (const c of [this.conn, this.trial]) {
      if (!c) continue
      clearTimeout(c.deadline)
      c.close()
    }
    this.conn = this.trial = null
    clearTimeout(this.upTimer)
  }

  // 切れた・開かなかった・返事がない
  private lost(conn: Conn): void {
    if (conn === this.trial) {
      // 試しただけ。poll はそのまま続いている
      this.trial = null
      clearTimeout(conn.deadline)
      conn.close()
      this.upWait = Math.min(UP_MAX_MS, this.upWait * 2)
      this.planTrial()
      return
    }
    if (conn !== this.conn) return
    this.drop()
    if (conn.got) {
      if (Date.now() - conn.openedAt >= STABLE_MS) this.attempt = 0
    } else if (!offline()) {
      // 電波がないだけのときは、方式のせいにしない
      this.fails++
      if (!this.o.transport && this.fails >= (this.worked.has(this.kind) ? SWITCH_WORKED : SWITCH_NEW)) {
        this.kind = nextKind(this.kind)
        this.fails = 0
      }
    }
    this.set(this.waiting())
    // 0.5 秒から倍々で最大 8 秒。そこに毎回 0〜100% のばらつきを足す
    // （サーバーが入れ替わって全員が同時に切れても、つなぎ直しが一度に来ないように）
    const base = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.attempt++)
    this.retryTimer = setTimeout(() => this.open(this.kind), base + Math.random() * base)
  }

  // 待っている途中なら、いますぐつなぐ（電波が戻った・画面に戻ってきた）
  private readonly hurry = (): void => {
    if (this.dead || this.retryTimer === undefined) return
    this.open(this.kind)
  }

  private readonly onVisible = (): void => {
    if (this.dead || document.visibilityState !== 'visible') return
    this.pump() // 裏にいる間はタイマーが止められている。たまった分を、いま確かめる
    this.hurry()
    this.sync(SYNC_AGAIN)
    if (this.conn?.got) this.conn.check?.(WAKE_MS)
  }

  // ---- poll のまま、もっといい方式を試す -----------------------------------

  private planTrial(): void {
    clearTimeout(this.upTimer)
    if (this.o.transport || this.conn?.kind !== 'poll' || !this.conn.got || this.trial) return
    this.upTimer = setTimeout(() => {
      const kinds = (['ws', 'sse'] as const).filter(usable)
      if (!kinds.length || this.conn?.kind !== 'poll' || this.trial) return
      this.trial = this.dial(kinds[this.trials++ % kinds.length], true)
    }, this.upWait)
  }

  // 試していた 1 本が通じた。poll をやめて、こちらに乗りかえる
  private adopt(conn: Conn): void {
    const old = this.conn
    this.trial = null
    this.conn = conn
    this.upWait = UP_FIRST_MS
    if (old) {
      clearTimeout(old.deadline)
      old.close()
    }
  }

  // ---- 送る -----------------------------------------------------------------

  private flush(): void {
    const conn = this.conn
    if (!conn?.got) return
    if (this.o.role === 'host') {
      const now = Date.now()
      this.out = this.out.filter((q) => now - q.at <= HOST_HOLD_MS)
    }
    if (conn.kind !== 'ws') {
      if (this.out.length) this.postTimer ??= setTimeout(() => this.post(), POST_GAP_MS)
      return
    }
    while (this.out.length) {
      if (!conn.write?.(JSON.stringify({ t: 'cmd', cmd: this.out[0].cmd } satisfies Up))) return
      this.out.shift()
    }
  }

  private post(): void {
    this.postTimer = undefined
    const conn = this.conn
    if (!conn?.got || conn.kind === 'ws') return this.flush() // 方式が変わった・切れた（つながったときに送る）
    const batch = this.out.splice(0)
    if (!batch.length) return
    fetch(`${this.root}/cmd?${this.query(false)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmds: batch.map((q) => q.cmd) }),
    })
      .then((r) => {
        if (r.status >= 500) throw new Error(String(r.status)) // 4xx は断られた分なので、送り直さない
      })
      .catch(() => {
        if (this.dead) return
        // 届かなかった分は、少し待ってもう一度（3 回まで）
        this.out = [...batch.filter((q) => ++q.tries < POST_TRIES), ...this.out].slice(-OUT_MAX)
        if (this.out.length) this.postTimer ??= setTimeout(() => this.post(), 1000)
      })
  }
}

// ---- 公開する関数 -----------------------------------------------------------

export function connect(o: LinkOptions): Link {
  return new Remote(o)
}

// API の場所。?api=… → ビルド時の VITE_API → 同じ場所の /api
// API の場所。ふつうは、画面と同じ場所の /api。画面を別の場所（GitHub Pages など）から配るときは、ビルドのときに VITE_API で決める。
// URL の問い合わせ（?api=）では変えられないようにしてある（リンクを踏ませて、主催キーをよそのサーバーに送らせることができてしまうため）
export function apiBase(): string {
  // import.meta.env.VITE_API は、この書き方のままにする（Vite がビルドのときに値へ置きかえる）
  const env: unknown = import.meta.env.VITE_API
  return trimSlash(typeof env === 'string' && /^(https?:\/\/|\/)/.test(env) ? env : '/api')
}

export function createApi(base: string): Api {
  const root = trimSlash(base)

  async function call<T>(path: string, body?: unknown): Promise<T> {
    let r: Response
    try {
      r = await fetch(root + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    } catch {
      throw new ApiError('つながりませんでした。もう一度ためしてください', 0)
    }
    const data = (await r.json().catch(() => null)) as (T & { error?: unknown }) | null
    if (r.ok && data !== null) return data
    throw new ApiError(typeof data?.error === 'string' ? data.error : 'うまくいきませんでした。もう一度ためしてください', r.status)
  }

  const game = (code: string): string => `/g/${encodeURIComponent(code)}`

  return {
    create: (req: CreateReq) => call<CreateRes>('/games', req),
    async state(code: string): Promise<PublicState | null> {
      try {
        return await call<PublicState>(`${game(code)}/state`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null // ゲームがない
        throw e
      }
    },
    join: (code: string, req: JoinReq) => call<JoinRes>(`${game(code)}/join`, req),
    login: (code: string, req: LoginReq) => call<LoginRes>(`${game(code)}/host/login`, req),
    results: (code: string, hostToken: string) => call<ResultRow[]>(`${game(code)}/results?${new URLSearchParams({ role: 'host', token: hostToken })}`),
  }
}
