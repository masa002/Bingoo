import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver'
import { CREW_SHARD, KEEPALIVE, QUEST_MAX_SCORE, RESUME_MS, RING_SIZE, frameText, shardOf, type Control, type Delivery, type Role } from '../src/net/wire'
import { checkHostToken, checkPlayerToken, tokenKey, type AppEnv } from './auth'
import type { CmdItem, GameDO } from './game'

// 接続の受け口。参加者 800 人ごとに 1 つ（名前は `${code}:p0` など）と、大画面・主催用の 1 つ（`${code}:crew`）。
// Game から届いた配信を各端末へ送り、端末からの操作をまとめて Game に渡す。ゲームの中身は知らない。
//
// WebSocket は Hibernation（つないだまま、この Durable Object はメモリから降りられる）。
// 降りると、メモリの中のもの（覚えておく分・タイマー）は消える。接続ごとに要るものだけ、接続に付けておく（Att）

// 接続に付けておくもの（眠っても残る）
interface Att {
  role: Role
  idx: number // 参加者の番号（大画面・主催は -1）
  ready: boolean // 「いまの状態」か続きの分を渡し終えた（ここから先は、ふだんの配信を送ってよい）
  from: number // これより新しい通し番号だけを送る
}

// つながっている端末 1 台（WebSocket か SSE）
interface Peer extends Att {
  id: string
  ws: Connection<Att> | null
  send(text: string): void
  close(code: number, reason: string): void
  beat?: () => void // SSE だけ: 切れないように、ときどき空の行を送る
}

// 「いまの状態」を待っているもの（つないだばかりの端末か、poll の 1 回分）
interface Waiter {
  role: Role
  idx: number
  done(texts: string[] | null, s: number): void // texts が null なら、ゲームはもうない
  fail(): void
}

type Bye = Extract<Control, { t: 'bye' }>['reason']

const BATCH_MS = 50 // 「いまの状態」の頼みと、端末からの操作を、この時間だけためてまとめる
const PRESENCE_MS = 2000
const PROGRESS_MS = 500
const SSE_BEAT_MS = 15000
const SSE_BACKLOG = 400 // SSE の端末が受け取りきれずに、これだけたまったら切る
const CMD_QUEUE = 5000
const UP_MAX = { player: 512, stage: 512, host: 512 * 1024 } // 端末から届く 1 通の長さの上限（文字）

const enc = new TextEncoder()

function bye(reason: Bye): string {
  return `{"t":"bye","reason":"${reason}"}`
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function afterOf(q: URLSearchParams): number | null {
  const a = q.get('after')
  return a !== null && /^\d{1,15}$/.test(a) ? Number(a) : null
}

export class RoomDO extends Server<AppEnv> {
  static options = { hibernate: true }

  private up = false
  private code = ''
  private shard = ''
  private keyWait: Promise<CryptoKey | null> | null = null
  private goneUntil = 0

  private readonly peers = new Map<string, Peer>()
  private readonly byIdx = new Map<number, Peer>() // 参加者は 1 人 1 接続
  private sseNo = 0
  private sseTimer: ReturnType<typeof setInterval> | null = null

  // 覚えておく分（つなぎ直した端末に、続きから流すため）。
  // floor より新しい通し番号で、この Room 宛てのものは、全部 ring に入っている（floor が null なら、分からない）
  private ring: Delivery[] = []
  private lastSeq: number | null = null
  private floor: number | null = null

  private snapQ: Waiter[] = []
  private snapTimer: ReturnType<typeof setTimeout> | null = null
  private snapBusy = false

  private cmdQ: CmdItem[] = []
  private cmdTimer: ReturnType<typeof setTimeout> | null = null

  private readonly quest = new Map<number, number>() // 人 → 叩いている途中の数
  private questTimer: ReturnType<typeof setTimeout> | null = null

  private presTimer: ReturnType<typeof setTimeout> | null = null
  private presAt = 0
  private presSent: number | null = null

  // ---- 起きたとき -----------------------------------------------------------

  onStart(): void {
    this.wake()
  }

  // メモリに上がったときに 1 回だけ。眠る前からつながっている接続を、接続に付けておいたものから並べ直す。
  // RPC は partyserver の入口（fetch・webSocketMessage）を通らないので、どの入口でも最初に呼ぶ
  private wake(): void {
    if (this.up) return
    this.up = true
    const at = this.name.lastIndexOf(':')
    this.code = this.name.slice(0, at)
    this.shard = this.name.slice(at + 1)
    // 生存確認には、眠ったまま返事をする（この Durable Object を起こさない）
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE.ping, KEEPALIVE.pong))
    for (const c of this.getConnections<Att>()) {
      const att = c.state
      if (!att) {
        // だれなのかを確かめ終わる前に落ちた接続。端末につなぎ直してもらう
        try {
          c.close(1012, 'restart')
        } catch {}
        continue
      }
      const peer = this.wsPeer(c, { ...att })
      this.keep(peer)
      if (!peer.ready) this.wantSnap(this.waiterOf(peer))
    }
  }

  private game(): DurableObjectStub<GameDO> {
    return this.env.GAME.get(this.env.GAME.idFromName(this.code), { locationHint: 'apac' })
  }

  // ---- だれなのかを確かめる -------------------------------------------------

  // トークンを確かめる鍵。Game に 1 回だけ聞いて、保存領域にも置く。ゲームがなければ null
  private tokens(): Promise<CryptoKey | null> {
    if (Date.now() < this.goneUntil) return Promise.resolve(null)
    return (this.keyWait ??= this.fetchKey().then(
      (key) => {
        if (!key) this.keyWait = null
        return key
      },
      (err) => {
        this.keyWait = null
        throw err
      },
    ))
  }

  private async fetchKey(): Promise<CryptoKey | null> {
    let hex = await this.ctx.storage.get<string>('key')
    if (!hex) {
      const res = await this.game().keys()
      if (!res) {
        // でたらめなコードで何度も来ても、そのたびに Game を起こさない。保存領域も使わない
        this.goneUntil = Date.now() + 3000
        if (!this.peers.size) await this.ctx.storage.deleteAll()
        return null
      }
      hex = res.key
      await this.ctx.storage.put('key', hex)
    }
    return tokenKey(hex)
  }

  // auth: トークンが違う・期限が切れた。closed: ゲームがない
  private async identify(q: URLSearchParams): Promise<{ role: Role; idx: number } | 'auth' | 'closed'> {
    const key = await this.tokens()
    if (!key) return 'closed'
    const role = q.get('role')
    if (role === 'stage') return this.shard === CREW_SHARD ? { role, idx: -1 } : 'auth'
    if (role === 'host') return this.shard === CREW_SHARD && (await checkHostToken(key, q.get('token'), Date.now())) ? { role, idx: -1 } : 'auth'
    const n = q.get('idx') ?? ''
    if (role !== 'player' || !/^\d{1,6}$/.test(n)) return 'auth'
    const idx = Number(n)
    return shardOf(idx) === this.shard && (await checkPlayerToken(key, idx, q.get('token'))) ? { role, idx } : 'auth'
  }

  // ---- つながっている端末 ---------------------------------------------------

  private wsPeer(c: Connection<Att>, att: Att): Peer {
    return { ...att, id: c.id, ws: c, send: (text) => c.send(text), close: (code, reason) => c.close(code, reason) }
  }

  private keep(peer: Peer): void {
    if (peer.role === 'player') {
      // 同じ人が別の端末・タブでつないだら、前の接続は閉じる（1 人 1 接続）
      const old = this.byIdx.get(peer.idx)
      if (old && old !== peer) this.kick(old, 'replaced', 4001)
      this.byIdx.set(peer.idx, peer)
    }
    this.peers.set(peer.id, peer)
    this.touch()
  }

  private drop(peer: Peer): void {
    if (this.peers.get(peer.id) !== peer) return
    this.peers.delete(peer.id)
    if (this.byIdx.get(peer.idx) === peer) this.byIdx.delete(peer.idx)
    if (this.sseTimer && ![...this.peers.values()].some((p) => p.beat)) {
      clearInterval(this.sseTimer)
      this.sseTimer = null
    }
    this.touch()
  }

  private say(peer: Peer, text: string): void {
    try {
      peer.send(text)
    } catch {
      this.drop(peer)
    }
  }

  // 理由を伝えてから閉じる（端末は、bye を受け取ったら、もうつなぎ直さない）
  private kick(peer: Peer, reason: Bye, code: number): void {
    this.say(peer, bye(reason))
    this.drop(peer)
    try {
      peer.close(code, reason)
    } catch {}
  }

  private setReady(peer: Peer, ready: boolean, from: number): void {
    peer.ready = ready
    peer.from = from
    try {
      peer.ws?.setState({ role: peer.role, idx: peer.idx, ready, from })
    } catch {}
  }

  // つながっている数が変わったら、2 秒に 1 回まで Game に知らせる（主催の画面に出る）
  private touch(): void {
    if (this.presTimer) return
    this.presTimer = setTimeout(
      () => {
        this.presTimer = null
        this.presAt = Date.now()
        const n = this.peers.size
        if (n === this.presSent) return
        this.presSent = n
        this.game()
          .presence(this.shard, n)
          .catch(() => {
            this.presSent = null
          })
      },
      Math.max(0, this.presAt + PRESENCE_MS - Date.now()),
    )
  }

  // ---- つないだ直後（ws・sse・poll で同じ決まり） ---------------------------

  // 見逃した分を、覚えている分から続きで流せるなら、その分（なければ空）。流せなければ null（「いまの状態」を渡す）
  private resume(role: Role, idx: number, after: number | null): string[] | null {
    if (after === null || this.floor === null || after < this.floor) return null
    const old = Date.now() - RESUME_MS
    const texts: string[] = []
    for (const d of this.ring) {
      if (d.s <= after) continue
      const text = this.textFor(d, role, idx)
      if (text === null) continue
      // 見逃した分が古すぎる。終わった演出を早回しで見せるより、いまの状態から始める
      if (!texts.length && d.at <= old) return null
      texts.push(text)
    }
    return texts
  }

  private attach(peer: Peer, after: number | null): void {
    const texts = this.resume(peer.role, peer.idx, after)
    if (texts) {
      for (const t of texts) this.say(peer, t)
      this.setReady(peer, true, this.lastSeq ?? after ?? 0)
    } else {
      this.wantSnap(this.waiterOf(peer))
    }
  }

  private waiterOf(peer: Peer): Waiter {
    return {
      role: peer.role,
      idx: peer.idx,
      done: (texts, s) => {
        if (this.peers.get(peer.id) !== peer) return
        if (!texts) return this.kick(peer, 'closed', 4002)
        for (const t of texts) this.say(peer, t)
        this.setReady(peer, true, s)
      },
      // Game に聞けなかった。いったん切って、端末につなぎ直してもらう
      fail: () => {
        if (this.peers.get(peer.id) !== peer) return
        this.drop(peer)
        try {
          peer.close(1013, 'retry')
        } catch {}
      },
    }
  }

  // 「いまの状態」は、少しためて、まとめて Game に頼む（つなぎ直しが一斉に来ても、Game を呼ぶ回数が増えないように）
  private wantSnap(w: Waiter): void {
    this.snapQ.push(w)
    this.snapTimer ??= setTimeout(() => void this.flushSnaps(), BATCH_MS)
  }

  private async flushSnaps(): Promise<void> {
    this.snapTimer = null
    // 前の頼みの返事を待っている間は、次を出さない（その間に来た分は、返事のあとでまとめて頼む）
    if (this.snapBusy || !this.snapQ.length) return
    this.snapBusy = true
    const q = this.snapQ.splice(0)
    try {
      const idxs = [...new Set(q.filter((w) => w.role === 'player').map((w) => w.idx))]
      const res = await this.game().hello({ idxs, crew: q.some((w) => w.role !== 'player'), host: q.some((w) => w.role === 'host') })
      if (!res) {
        for (const w of q) w.done(null, 0)
        return
      }
      // Game の通し番号が分かった。これより新しい分は、これから届く（か、もう ring にある）
      if (this.floor === null) this.floor = res.s
      for (const w of q) {
        const snap = w.role === 'player' ? res.snaps[w.idx] : res.crew
        if (!snap) {
          w.fail()
          continue
        }
        const texts = [`{"s":${res.s},"at":${res.at},"b":${snap}}`]
        // 頼んでいる間に届いた、それより新しい分を続ける（この端末には、まだ送っていない）
        for (const d of this.ring) {
          const text = d.s > res.s ? this.textFor(d, w.role, w.idx) : null
          if (text !== null) texts.push(text)
        }
        w.done(texts, res.s)
      }
    } catch (err) {
      console.error(`${this.name}: hello failed`, err)
      for (const w of q) w.fail()
    } finally {
      this.snapBusy = false
      if (this.snapQ.length) this.snapTimer ??= setTimeout(() => void this.flushSnaps(), BATCH_MS)
    }
  }

  // ---- Game からの RPC ------------------------------------------------------

  // 配信。prev は、Game がこの Room にこの前に配った最後の通し番号。返すのは、いまつながっている数
  async deliver(batch: Delivery[], prev: number): Promise<number> {
    this.wake()
    const gap = this.lastSeq !== null && prev !== this.lastSeq
    if (this.floor === null || gap) {
      this.ring = []
      this.floor = prev
    }
    if (gap) {
      // 取りこぼした（前の配信が届かなかった）。つながっている端末には、「いまの状態」を配り直す
      console.error(`${this.name}: missed deliveries between ${this.lastSeq} and ${prev}`)
      for (const peer of this.peers.values()) {
        if (!peer.ready) continue
        this.setReady(peer, false, 0)
        this.wantSnap(this.waiterOf(peer))
      }
    }
    for (const d of batch) {
      this.ring.push(d)
      if (this.ring.length > RING_SIZE) this.floor = this.ring.shift()!.s
      this.lastSeq = d.s
      // クエストの次の配信が来たら、叩いている途中の数は消す
      const type = d.b ? /^\{"type":"(\w+)"/.exec(d.b)?.[1] : undefined
      if (type === 'questStart' || type === 'questResult' || type === 'snapshot') this.quest.clear()
      this.fan(d)
    }
    this.presSent = this.peers.size
    return this.peers.size
  }

  // ゲームが片付けられた。端末に伝えて、覚えているものを消す
  async shutdown(): Promise<void> {
    this.wake()
    for (const peer of [...this.peers.values()]) this.kick(peer, 'closed', 4002)
    for (const w of this.snapQ.splice(0)) w.done(null, 0)
    this.ring = []
    this.lastSeq = null
    this.floor = null
    this.cmdQ = []
    this.quest.clear()
    this.keyWait = null
    await this.ctx.storage.deleteAll()
  }

  private heard(d: Delivery, role: Role): boolean {
    if (d.to === 'host') return role === 'host'
    if (d.to === 'crew') return role !== 'player'
    if (d.to === 'players') return role === 'player'
    return true
  }

  private textFor(d: Delivery, role: Role, idx: number): string | null {
    return this.heard(d, role) ? frameText(d, role === 'player' ? idx : null) : null
  }

  private fan(d: Delivery): void {
    // 本人宛ての部分がない人には、同じ文字列を使い回す
    const common = frameText(d, null)
    for (const peer of this.peers.values()) {
      // ready でない端末には送らない（「いまの状態」より先に届くと、順番が前後する）
      if (!peer.ready || d.s <= peer.from || !this.heard(d, peer.role)) continue
      const text = peer.role === 'player' && d.p?.[peer.idx] !== undefined ? frameText(d, peer.idx) : common
      if (text !== null) this.say(peer, text)
    }
  }

  // ---- WebSocket ------------------------------------------------------------

  async onConnect(c: Connection<Att>, ctx: ConnectionContext): Promise<void> {
    const q = new URL(ctx.request.url).searchParams
    let who: Awaited<ReturnType<RoomDO['identify']>>
    try {
      who = await this.identify(q)
    } catch (err) {
      console.error(`${this.name}: identify failed`, err)
      c.close(1013, 'retry')
      return
    }
    if (typeof who === 'string') {
      c.send(bye(who))
      c.close(who === 'auth' ? 4003 : 4002, who)
      return
    }
    const att: Att = { ...who, ready: false, from: 0 }
    c.setState(att)
    const peer = this.wsPeer(c, att)
    this.keep(peer)
    this.attach(peer, afterOf(q))
  }

  onMessage(c: Connection<Att>, message: WSMessage): void {
    if (typeof message !== 'string') return
    // ふだんは、眠ったままの自動の返事が先に答える。ここに来るのは、その設定が効く前の分だけ
    if (message === KEEPALIVE.ping) return c.send(KEEPALIVE.pong)
    const peer = this.peers.get(c.id)
    if (message.length > UP_MAX[peer?.role ?? 'stage']) return
    let up: { t?: unknown; c?: unknown; cmd?: unknown }
    try {
      up = JSON.parse(message)
    } catch {
      return
    }
    if (!up || typeof up !== 'object') return
    if (up.t === 'ping') {
      if (typeof up.c === 'number' && Number.isFinite(up.c)) c.send(`{"t":"pong","c":${up.c},"now":${Date.now()}}`)
    } else if (up.t === 'cmd' && peer) {
      this.accept(peer.role, peer.idx, up.cmd)
    }
  }

  onClose(c: Connection<Att>): void {
    const peer = this.peers.get(c.id)
    if (peer) this.drop(peer)
  }

  onError(c: Connection<Att>): void {
    this.onClose(c)
  }

  // ---- 端末からの操作 -------------------------------------------------------

  // 役割を付けて、Game に渡す列に足す（中身は Game が確かめる）。
  // 主催の操作は主催の接続からだけ、参加者の操作は参加者の接続からだけ: i が null のものだけが主催の操作として扱われる
  private accept(role: Role, idx: number, cmd: unknown): void {
    if (role === 'stage' || !cmd || typeof cmd !== 'object') return
    if (role === 'player') {
      const c = cmd as { type?: unknown; score?: unknown }
      // 叩いている途中の数は Game に渡さず、ここで合計して 0.5 秒に 1 回だけ送る（1 万人が 2 秒おきに送ってくる）
      if (c.type === 'questProgress' || c.type === 'questScore') this.noteScore(idx, c.score)
      if (c.type === 'questProgress') return
    }
    if (this.cmdQ.length >= CMD_QUEUE) return
    this.cmdQ.push({ i: role === 'host' ? null : idx, c: cmd })
    this.cmdTimer ??= setTimeout(() => void this.flushCmds(), BATCH_MS)
  }

  private async flushCmds(): Promise<void> {
    this.cmdTimer = null
    const items = this.cmdQ.splice(0)
    if (!items.length) return
    try {
      await this.game().commands(items)
    } catch (err) {
      console.error(`${this.name}: commands failed`, err)
      // 通り道の一時的な失敗（Game が入れ替わった直後など）だけ、もう 1 回ためす
      if ((err as { retryable?: boolean })?.retryable) await this.game().commands(items).catch(() => {})
    }
  }

  private noteScore(idx: number, score: unknown): void {
    if (typeof score !== 'number' || !Number.isFinite(score)) return
    this.quest.set(idx, Math.max(0, Math.min(QUEST_MAX_SCORE, Math.round(score))))
    this.questTimer ??= setTimeout(() => {
      this.questTimer = null
      let total = 0
      for (const n of this.quest.values()) total += n
      this.game()
        .progress(this.shard, total)
        .catch(() => {})
    }, PROGRESS_MS)
  }

  // ---- HTTP（WebSocket が通らない端末の代わり） -----------------------------

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const kind = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    if (kind === 'sse') return this.sse(url.searchParams)
    if (kind === 'poll') return this.poll(url.searchParams)
    if (kind === 'cmd') return this.cmd(request, url.searchParams)
    return json('{"error":"このページはありません"}', 404)
  }

  // 流しっぱなしの応答。data: の 1 行が、WebSocket の 1 通と同じ
  private async sse(q: URLSearchParams): Promise<Response> {
    const who = await this.identify(q)
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const w = writable.getWriter()
    const res = new Response(readable, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' },
    })
    if (typeof who === 'string') {
      // EventSource は状態コードを読めないので、ふつうに流し始めてから理由を伝える
      void w
        .write(enc.encode(`data: ${bye(who)}\n\n`))
        .then(() => w.close())
        .catch(() => {})
      return res
    }
    let backlog = 0
    const write = (text: string): void => {
      if (++backlog > SSE_BACKLOG) return shut()
      w.write(enc.encode(text)).then(
        () => {
          backlog--
        },
        () => this.drop(peer),
      )
    }
    const shut = (): void => {
      this.drop(peer)
      w.close().catch(() => {})
    }
    const peer: Peer = {
      ...who,
      ready: false,
      from: 0,
      id: `sse:${++this.sseNo}`,
      ws: null,
      send: (text) => write(`data: ${text}\n\n`),
      close: shut,
      beat: () => write(': \n\n'),
    }
    // 端末が切った
    w.closed.catch(() => this.drop(peer))
    this.keep(peer)
    this.sseTimer ??= setInterval(() => {
      for (const p of this.peers.values()) p.beat?.()
    }, SSE_BEAT_MS)
    peer.beat!() // 最初に 1 行送って、応答を始める
    this.attach(peer, afterOf(q))
    return res
  }

  // 接続は持たない。毎回トークンを確かめて、after より新しい分（か、いまの状態）を返す
  private async poll(q: URLSearchParams): Promise<Response> {
    const who = await this.identify(q)
    if (typeof who === 'string') return json(`{"now":${Date.now()},"frames":[],"bye":"${who}"}`)
    let texts = this.resume(who.role, who.idx, afterOf(q))
    if (!texts) {
      try {
        texts = await new Promise<string[] | null>((resolve, reject) => this.wantSnap({ ...who, done: resolve, fail: () => reject(new Error('hello failed')) }))
      } catch {
        return json('{"error":"いま混み合っています。少し待って、もう一度ためしてください"}', 503)
      }
      if (!texts) return json(`{"now":${Date.now()},"frames":[],"bye":"closed"}`)
    }
    return json(`{"now":${Date.now()},"frames":[${texts.join(',')}]}`)
  }

  // sse・poll の端末からの操作
  private async cmd(request: Request, q: URLSearchParams): Promise<Response> {
    if (request.method !== 'POST') return json('{"error":"このページはありません"}', 404)
    const who = await this.identify(q)
    if (who === 'closed') return json('{"error":"このゲームは見つかりません"}', 404)
    if (who === 'auth') return json(q.get('role') === 'host' ? '{"error":"もう一度ログインしてください"}' : '{"error":"もう一度参加してください"}', 401)
    const text = await request.text()
    let body: { cmds?: unknown } | null = null
    try {
      if (text.length <= UP_MAX[who.role]) body = JSON.parse(text)
    } catch {}
    if (!body || !Array.isArray(body.cmds)) return json('{"error":"送られた内容を読めませんでした"}', 400)
    for (const c of body.cmds.slice(0, 32)) this.accept(who.role, who.idx, c)
    return json('{"ok":true}')
  }
}
