import { DurableObject } from 'cloudflare:workers'
import { Engine, type EngineDump, type EngineHost, type Outbound, type Seat } from '../src/engine/engine'
import type { PhoneCommand } from '../src/net/protocol'
import {
  CREW_SHARD,
  LEAD_MS,
  MAX_PLAYERS,
  SHARD_SIZE,
  shardOf,
  type CreateRes,
  type Delivery,
  type HostCommand,
  type JoinReq,
  type JoinRes,
  type LiveSettings,
  type LoginReq,
  type LoginRes,
  type PublicState,
  type ResultRow,
} from '../src/net/wire'
import {
  HOST_TOKEN_MS,
  checkHostToken,
  checkPlayerToken,
  cleanName,
  hostKeyHash,
  hostToken,
  newHostKey,
  newTotpSecret,
  playerToken,
  randomHex,
  safeEqual,
  tokenKey,
  totpUri,
  totpWindow,
  type AppEnv,
} from './auth'
import type { RoomDO } from './room'

// ゲームごとに 1 つの Durable Object。進行役（Engine）を動かす包み。
// ここが受け持つのは、保存・アラーム・通し番号・受け口（Room）への配信だけ。ゲームの決まりは Engine の中にある。
//
// どの入口も同じ順に進む: Engine を（なければ保存から）用意 → Engine を呼ぶ → 出てきたメッセージに通し番号を振る → 保存 → Room へ配る。
// 保存してから配るので、配ったあとにサーバーが入れ替わっても、端末が見たものより前の状態に戻ることはない

// 入口のあとで何を保存するか。true: 全部。'seats': 参加者の表だけ。false: 保存しない
type Save = boolean | 'seats'

// 断るときの返事。error は人に見せる文、status は HTTP の状態コード
export interface Fail {
  error: string
  status: number
}

// Room から、まとめて届く操作。i は参加者の番号（主催の操作は null）。中身は端末から届いたままなので、ここで確かめる
export interface CmdItem {
  i: number | null
  c: unknown
}

// つないだ端末に渡す「いまの状態」を、まとめて頼む
export interface HelloReq {
  idxs: number[] // 参加者の番号
  crew: boolean // 大画面・主催用も要る
  host: boolean // 主催がつないだ（進行の状態も送り直す）
}
export interface HelloRes {
  s: number // この状態は、通し番号 s までを反映している
  at: number
  snaps: Record<number, string> // 参加者の番号 → snapshot の JSON
  crew: string | null
}

interface Meta {
  code: string
  key: string // トークン用の鍵（16 進）
  hostHash: string
  totp: string | null
  created: number
  seq: number // 最後に振った通し番号
  lastP: number // 参加者の Room に最後に配った通し番号
  lastC: number // 'crew' の Room に最後に配った通し番号
  fails: number // 主催のログインで、主催キーは合っていて 6 桁を続けて間違えた回数
  lockedUntil: number
  totpLast: number // 最後にログインを通した、6 桁の時間枠の番号（この枠と、それより古い枠の 6 桁は断る）
}

// 作ってからこの時間がたったら、片付ける（参加者の名前を残しっぱなしにしない）
const LIFETIME_MS = 48 * 60 * 60 * 1000
// 状態の JSON は、この大きさごとに分けて入れる（1 行に入る大きさに上限があるため。1 万人で数百 KB になる）
const CHUNK = 1 << 20
const BACKUP_MS = 5000
// Room への配信が、これより多くたまったら捨てる（Room は番号の飛びに気づいて、端末に「いまの状態」を配り直す）
const QUEUE_MAX = 50
const LOGIN = { tries: 5, lockMs: 60000 }

// Room への配信が一時的に失敗したら、少し待って同じ prev のまま送り直す（この間隔で、この回数まで）
const RESEND_MS = [150, 500]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, secret TEXT NOT NULL, host_hash TEXT NOT NULL, totp TEXT,
  created INTEGER NOT NULL, seq INTEGER NOT NULL, last_p INTEGER NOT NULL, last_c INTEGER NOT NULL,
  fails INTEGER NOT NULL, locked_until INTEGER NOT NULL, totp_last INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seats (idx INTEGER PRIMARY KEY, name TEXT NOT NULL, card INTEGER NOT NULL, bot INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS state (part INTEGER PRIMARY KEY, body BLOB NOT NULL);
`

const enc = new TextEncoder()

export class GameDO extends DurableObject<AppEnv> {
  // undefined: まだ読んでいない。null: このコードのゲームはない
  private meta: Meta | null | undefined
  private engine: Engine | null = null
  private hkey: CryptoKey | null = null
  // 入口を 1 つずつ通すための列。Engine の一部は await をはさむ（ハッシュの計算）ので、その間に別の入口が割り込まないようにする
  private tail: Promise<unknown> = Promise.resolve()

  // 1 つの入口の間に Engine から出てきたもの
  private out: Outbound[] = []
  private wantAlarm: number | null = null
  // いま掛けてあるアラームの時刻（分からなければ undefined）
  private armed: number | null | undefined

  private savedSeats = 0
  private savedRoster = 0
  private stateText = ''

  private readonly chains = new Map<string, { tail: Promise<void>; depth: number }>()
  private readonly counts = new Map<string, number>()

  private backupAt = 0
  private backupTimer: ReturnType<typeof setTimeout> | null = null
  private resultsSaved = false

  private readonly host: EngineHost = {
    now: () => Date.now(),
    // Engine は入口の中で何度も時刻を決め直す。本当に掛けるのは、入口の終わりに 1 回だけ
    setAlarm: (at) => {
      this.wantAlarm = at
    },
    emit: (o) => {
      this.out.push(o)
    },
    secret: () => randomHex(16),
  }

  // ---- 入口（Worker と Room から RPC で呼ぶ） -------------------------------

  // ゲームを作る。このコードがもう使われていれば null（呼ぶ側が、別のコードで作り直す）
  // 認証アプリの 6 桁は、どのゲームでも必須（主催キーが漏れても、それだけでは入れない）
  async create(code: string, settings: LiveSettings): Promise<CreateRes | null> {
    return this.serial(async () => {
      if (this.load()) return null
      const key = randomHex(32)
      const hostKey = newHostKey()
      const secret = newTotpSecret()
      const hostHash = await hostKeyHash(key, hostKey)
      const engine = await Engine.create(this.host, LEAD_MS, settings)
      const meta: Meta = { code, key, hostHash, totp: secret, created: Date.now(), seq: 0, lastP: 0, lastC: 0, fails: 0, lockedUntil: 0, totpLast: 0 }
      const sql = this.ctx.storage.sql
      sql.exec(SCHEMA)
      sql.exec(
        'INSERT INTO meta (id, code, secret, host_hash, totp, created, seq, last_p, last_c, fails, locked_until) VALUES (1, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)',
        code,
        key,
        hostHash,
        secret,
        meta.created,
      )
      this.meta = meta
      this.engine = engine
      this.hkey = null
      this.savedSeats = 0
      this.savedRoster = engine.roster
      this.stateText = ''
      this.commit(engine, meta, true)
      await this.arm(meta)
      return { code, hostKey, totpUri: totpUri(secret, code) }
    })
  }

  // だれでも見られる今の状態。ゲームがなければ null
  publicState(): Promise<PublicState | null> {
    return this.run((e, meta) => [{ ...e.publicState(meta.code), totp: meta.totp !== null }, false])
  }

  // 参加する。idx と token が付いていて正しければ、同じ人として返す（ページを開き直した人を、もう 1 人に数えない）
  join(req: JoinReq): Promise<JoinRes | Fail | null> {
    return this.run<JoinRes | Fail>(async (e, meta) => {
      const key = await this.tokens(meta)
      const again = req?.idx
      if (typeof again === 'number' && Number.isInteger(again) && again >= 0 && again < e.game.size && !e.isBot(again) && (await checkPlayerToken(key, again, req.token))) {
        return [{ idx: again, token: req.token!, name: e.game.players[again].name }, false]
      }
      const name = cleanName(req?.name)
      if (!name) return [{ error: '名前を入れてください', status: 400 }, false]
      const r = e.join(name)
      if ('error' in r) return [{ error: r.error, status: 409 }, false]
      // 参加では、参加者の表に 1 行足すだけ（全員分の状態は書き直さない。足りない分は、戻すときに Game.load が補う）
      return [{ idx: r.idx, token: await playerToken(key, r.idx), name }, 'seats']
    })
  }

  // 主催のログイン。主催キーが合っていて 6 桁を 5 回続けて間違えたら、1 分止める（6 桁の総当たりを防ぐ）。
  // 主催キーの間違いは数えない: 数えると、大画面のコードを見ただけの人が、でたらめなキーを送り続けて本物の主催を締め出せる。
  // 主催キーは約 79 bit あるので、数えなくても総当たりは間に合わない
  login(req: LoginReq): Promise<LoginRes | Fail | null> {
    return this.serial(async () => {
      const meta = this.load()
      if (!meta) return null
      const now = Date.now()
      const keyOk = typeof req?.hostKey === 'string' && (await safeEqual(await hostKeyHash(meta.key, req.hostKey), meta.hostHash))
      if (!keyOk) return { error: '主催キーが違います', status: 401 }
      if (meta.lockedUntil > now) return { error: 'まちがいが続いたので、少し止めています。1 分待ってから、もう一度ためしてください', status: 429 }
      if (meta.totp) {
        const win = await totpWindow(meta.totp, req?.totp, now)
        if (win === null) {
          meta.fails++
          if (meta.fails >= LOGIN.tries) {
            meta.fails = 0
            meta.lockedUntil = now + LOGIN.lockMs
          }
          this.saveLogin(meta)
          return { error: '6 桁の数字が違います', status: 401 }
        }
        // 前に通した 6 桁（か、それより古い 6 桁）。見られた 6 桁を、もう一度使わせない。打ちまちがいではないので、数えない
        if (win <= meta.totpLast) return { error: 'この 6 桁は、もう使われました。認証アプリの数字が変わってから、入れ直してください', status: 401 }
        meta.totpLast = win
        meta.fails = 0
        this.saveLogin(meta)
      } else if (meta.fails) {
        meta.fails = 0
        this.saveLogin(meta)
      }
      const expiresAt = now + HOST_TOKEN_MS
      return { token: await hostToken(await this.tokens(meta), expiresAt), expiresAt }
    })
  }

  // Room がトークンを確かめるための鍵（Room は 1 回だけ聞いて覚える）。ゲームがなければ null
  async keys(): Promise<{ key: string } | null> {
    const meta = this.load()
    return meta ? { key: meta.key } : null
  }

  // つないだ（つなぎ直した）端末に渡す「いまの状態」。Room がまとめて頼んでくる
  hello(req: HelloReq): Promise<HelloRes | null> {
    return this.run((e, meta) => {
      // Engine の状態は、画面より LEAD_MS だけ先に進んでいる（少し先の at の出来事まで、もう入っている）。
      // 「いま」で渡すと、つなぎ直した端末だけ次の番号が早く見えるので、ほかの端末と同じだけ待たせる
      const at = Date.now() + LEAD_MS
      const res: HelloRes = { s: meta.seq, at, snaps: {}, crew: req.crew ? JSON.stringify(e.snapshot(null)) : null }
      for (const idx of req.idxs) {
        if (Number.isInteger(idx) && idx >= 0 && idx < e.game.size) res.snaps[idx] = JSON.stringify(e.snapshot(idx))
      }
      // 進行の状態（host）は、変わったときにしか出ない。つないだばかりの主催には、いまの分を送り直す
      if (req.host) this.out.push({ at, to: 'host', msg: e.hostState() })
      return [res, false]
    })
  }

  // 端末からの操作（Room が 50ms ほどためて、まとめて渡してくる）。
  // 参加者の操作は、Engine が受け付けたときだけ保存する（中身がおかしい・時機が外れている・同じ操作の連打では書かない）
  async commands(items: CmdItem[]): Promise<void> {
    await this.run(async (e) => {
      let changed = false
      for (const { i, c } of items) {
        if (i === null) {
          const cmd = cleanHostCommand(c)
          if (!cmd) continue
          await e.command(cmd)
          changed = true // 主催の操作は少ないので、届いたら保存する
        } else if (Number.isInteger(i)) {
          const cmd = cleanPhoneCommand(c)
          if (cmd && e.player(i, cmd)) changed = true
        }
      }
      return [undefined, changed]
    })
  }

  // モグラ撃退の、叩いている途中の数の合計（Room ごと）。大画面に出すだけなので保存しない
  async progress(shard: string, total: number): Promise<void> {
    await this.run((e) => {
      e.progress(shard, total)
      return [undefined, false]
    })
  }

  // Room につながっている端末の数。全部の Room の分を足して、主催の画面に出す。保存しない
  async presence(shard: string, connected: number): Promise<void> {
    await this.run((e) => {
      this.counts.set(shard, connected)
      let sum = 0
      for (const n of this.counts.values()) sum += n
      e.presence(sum)
      return [undefined, false]
    })
  }

  // 当選者の一覧（主催だけ）
  results(token: string): Promise<ResultRow[] | Fail | null> {
    return this.run<ResultRow[] | Fail>(async (e, meta) => {
      if (!(await checkHostToken(await this.tokens(meta), token, Date.now()))) return [{ error: 'もう一度ログインしてください', status: 401 }, false]
      return [e.results(), false]
    })
  }

  // 時刻が来た（Engine の次の段か、片付けの時刻）
  async alarm(): Promise<void> {
    await this.serial(async () => {
      this.armed = null
      const meta = this.load()
      if (!meta) return
      if (Date.now() >= meta.created + LIFETIME_MS) return this.cleanup(meta)
      await this.step((e) => {
        e.onAlarm()
        return [undefined, true]
      })
    })
  }

  // ---- 入口の共通の流れ -----------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => {})
    return run
  }

  // fn は [返す値, 保存するか] を返す（'seats' は、参加者の表だけ）。ゲームがなければ、fn を呼ばずに null
  private run<T>(fn: (e: Engine, meta: Meta) => [T, Save] | Promise<[T, Save]>): Promise<T | null> {
    return this.serial(() => this.step(fn))
  }

  private async step<T>(fn: (e: Engine, meta: Meta) => [T, Save] | Promise<[T, Save]>): Promise<T | null> {
    const meta = this.load()
    if (!meta) return null
    try {
      const e = this.wake()
      const [result, save] = await fn(e, meta)
      this.commit(e, meta, save)
      await this.arm(meta)
      return result
    } catch (err) {
      // 途中で失敗したら、メモリの中の進行役を捨てる。次の入口は、最後に保存した状態から始める（半端な状態のまま進めない）
      this.engine = null
      this.meta = undefined
      this.out = []
      this.armed = undefined
      throw err
    }
  }

  private load(): Meta | null {
    if (this.meta !== undefined) return this.meta
    const sql = this.ctx.storage.sql
    // 表を作るのは create のときだけ。でたらめなコードで呼ばれても、保存領域を使わない
    const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0
    const row = exists ? sql.exec('SELECT * FROM meta WHERE id = 1').toArray()[0] : undefined
    // 2026-11-20 より前に作ったゲームの表には totp_last の列がない。足してから使う（いまのゲームを止めずに、そのまま続けられるように）
    if (row && row.totp_last === undefined) sql.exec('ALTER TABLE meta ADD COLUMN totp_last INTEGER NOT NULL DEFAULT 0')
    this.meta = row
      ? {
          code: row.code as string,
          key: row.secret as string,
          hostHash: row.host_hash as string,
          totp: row.totp as string | null,
          created: row.created as number,
          seq: row.seq as number,
          lastP: row.last_p as number,
          lastC: row.last_c as number,
          fails: row.fails as number,
          lockedUntil: row.locked_until as number,
          totpLast: (row.totp_last as number | undefined) ?? 0,
        }
      : null
    return this.meta
  }

  // Engine を用意する（メモリになければ、保存した状態から戻す）
  private wake(): Engine {
    if (this.engine) return this.engine
    const sql = this.ctx.storage.sql
    const parts = sql
      .exec('SELECT body FROM state ORDER BY part')
      .toArray()
      .map((r) => new Uint8Array(r.body as ArrayBuffer))
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      bytes.set(p, at)
      at += p.length
    }
    this.stateText = new TextDecoder().decode(bytes)
    const dump = JSON.parse(this.stateText) as EngineDump
    const seats: Seat[] = sql
      .exec('SELECT name, card, bot FROM seats ORDER BY idx')
      .toArray()
      .map((r) => ({ name: r.name as string, cardNo: r.card as number, bot: r.bot === 1 }))
    this.engine = Engine.restore(this.host, LEAD_MS, dump, seats)
    this.savedSeats = seats.length
    this.savedRoster = dump.roster
    return this.engine
  }

  private async tokens(meta: Meta): Promise<CryptoKey> {
    return (this.hkey ??= await tokenKey(meta.key))
  }

  // 出てきたメッセージに通し番号を振って、保存して、Room へ配る
  private commit(e: Engine, meta: Meta, save: Save): void {
    const out = this.out.splice(0)
    const rooms = Math.ceil(e.game.size / SHARD_SIZE)
    const prevP = meta.lastP
    const prevC = meta.lastC
    const crew: Delivery[] = []
    const players: Delivery[][] = Array.from({ length: rooms }, () => [])
    for (const o of out) {
      const s = ++meta.seq
      const b = o.msg ? JSON.stringify(o.msg) : null
      if (o.to !== 'players') {
        crew.push({ s, at: o.at, to: o.to, b, p: null })
        meta.lastC = s
      }
      if (o.to === 'all' || o.to === 'players') {
        // 本人宛ての部分は、Room ごとに分けて、文字列にしておく（Room は、つなぐだけで送れる）
        const parts = new Array<Record<number, string> | null>(rooms).fill(null)
        for (const [idx, part] of o.personal ?? []) {
          const k = Math.floor(idx / SHARD_SIZE)
          if (k < rooms) (parts[k] ??= {})[idx] = JSON.stringify(part)
        }
        // 自分宛ての分がない Room にも送る（Room が「前の番号から続いているか」で、取りこぼしに気づけるように）
        for (let k = 0; k < rooms; k++) players[k].push({ s, at: o.at, to: o.to, b, p: parts[k] })
        meta.lastP = s
      }
    }

    // 書くのは、実際に変わった分だけ（状態が同じなら状態を、通し番号が進んでいなければ meta を書かない）
    if (save || out.length) {
      const sql = this.ctx.storage.sql
      let wrote = false
      this.ctx.storage.transactionSync(() => {
        if (save === 'seats') this.saveSeats(e)
        else if (save) wrote = this.saveState(e)
        if (out.length) sql.exec('UPDATE meta SET seq = ?, last_p = ?, last_c = ? WHERE id = 1', meta.seq, meta.lastP, meta.lastC)
      })
      if (wrote) this.backupSoon()
    }

    if (crew.length) this.push(meta.code, CREW_SHARD, crew, prevC)
    players.forEach((batch, k) => {
      if (batch.length) this.push(meta.code, shardOf(k * SHARD_SIZE), batch, prevP)
    })
  }

  // 状態を書いた（前に書いたものから変わっていた）ら true
  private saveState(e: Engine): boolean {
    const sql = this.ctx.storage.sql
    this.saveSeats(e)
    const text = JSON.stringify(e.dump())
    if (text === this.stateText) return false
    this.stateText = text
    const bytes = enc.encode(text)
    const count = Math.max(1, Math.ceil(bytes.length / CHUNK))
    for (let i = 0; i < count; i++) sql.exec('INSERT OR REPLACE INTO state (part, body) VALUES (?, ?)', i, bytes.slice(i * CHUNK, (i + 1) * CHUNK).buffer)
    sql.exec('DELETE FROM state WHERE part >= ?', count)
    return true
  }

  private saveSeats(e: Engine): void {
    const sql = this.ctx.storage.sql
    // やり直し（reset）で配り直したら、参加者の表は丸ごと書き直す。ふだんは、増えた分だけ足す
    if (e.roster !== this.savedRoster) {
      sql.exec('DELETE FROM seats')
      this.savedSeats = 0
      this.savedRoster = e.roster
    }
    if (e.game.size > this.savedSeats) {
      e.seats(this.savedSeats).forEach((s, i) => sql.exec('INSERT INTO seats (idx, name, card, bot) VALUES (?, ?, ?, ?)', this.savedSeats + i, s.name, s.cardNo, s.bot ? 1 : 0))
      this.savedSeats = e.game.size
    }
  }

  private saveLogin(meta: Meta): void {
    this.ctx.storage.sql.exec('UPDATE meta SET fails = ?, locked_until = ?, totp_last = ? WHERE id = 1', meta.fails, meta.lockedUntil, meta.totpLast)
  }

  // Engine の次の時刻と、片付けの時刻の、早いほうにアラームを掛ける
  private async arm(meta: Meta): Promise<void> {
    // 切り上げる: 少しでも早く起きると、Engine は「まだ時刻が来ていない」と見て何もしない
    const at = Math.ceil(Math.min(this.wantAlarm ?? Infinity, meta.created + LIFETIME_MS))
    if (at === this.armed) return
    this.armed = at
    await this.ctx.storage.setAlarm(at)
  }

  // ---- Room への配信 --------------------------------------------------------

  private room(code: string, shard: string): DurableObjectStub<RoomDO> {
    return this.env.ROOM.get(this.env.ROOM.idFromName(`${code}:${shard}`), { locationHint: 'apac' })
  }

  // Room ごとに順番を守って送る（前の分が終わってから次）。Room どうしは並列。
  // 終わるのを待たない: Room が落ちていても、ゲームは止めない（端末は、つなぎ直しで追いつく）。
  // 通り道の一時的な失敗（retryable）なら、少し待って同じ prev のまま送り直す。届いていたのに返事だけが失われた場合も、
  // Room は同じ配信の重なりを見分けて捨てるので、二重には流れない
  private push(code: string, shard: string, batch: Delivery[], prev: number): void {
    const chain = this.chains.get(shard) ?? { tail: Promise.resolve(), depth: 0 }
    this.chains.set(shard, chain)
    if (chain.depth >= QUEUE_MAX) {
      console.error(`deliver to ${shard}: queue is full, dropped ${batch.length}`)
      return
    }
    chain.depth++
    chain.tail = chain.tail.then(async () => {
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            // 失敗のあとは、作り直した stub で送る（失敗した stub は、使えなくなっていることがある）
            const connected = await this.room(code, shard).deliver(batch, prev)
            // 返事に、つながっている数が付いてくる（Game が入れ替わって数を忘れても、次の配信で戻る）
            if (this.counts.get(shard) !== connected) void this.presence(shard, connected).catch(() => {})
            return
          } catch (err) {
            const wait = RESEND_MS[attempt]
            if (wait === undefined || !(err as { retryable?: boolean })?.retryable || (err as { overloaded?: boolean })?.overloaded) {
              console.error(`deliver to ${shard} failed`, err)
              return
            }
            await new Promise((r) => setTimeout(r, wait))
          }
        }
      } finally {
        chain.depth--
      }
    })
    this.ctx.waitUntil(chain.tail)
  }

  // ---- 退避（R2）と片付け ---------------------------------------------------

  // 保存のあと、5 秒に 1 回まで R2 に写す（Durable Object の保存領域ごと失っても、手で戻せるように）。R2 がなければ何もしない
  private backupSoon(): void {
    const bucket = this.env.BACKUP
    if (!bucket || this.backupTimer) return
    this.backupTimer = setTimeout(
      () => {
        this.backupTimer = null
        this.backupAt = Date.now()
        this.ctx.waitUntil(this.backup(bucket))
      },
      Math.max(0, this.backupAt + BACKUP_MS - Date.now()),
    )
  }

  private async backup(bucket: R2Bucket): Promise<void> {
    try {
      // 入口の列に並んで写しを取る（配り直しの途中の、半端な表を写さないように）。R2 に送るのは、列の外で
      const copy = await this.serial(async () => {
        const meta = this.load()
        if (!meta || !this.engine) return null
        const e = this.engine
        return {
          code: meta.code,
          state: `{"savedAt":${Date.now()},"seq":${meta.seq},"dump":${this.stateText},"seats":${JSON.stringify(e.seats())}}`,
          results: e.phase === 'done' && !this.resultsSaved ? JSON.stringify(e.results()) : null,
        }
      })
      if (!copy) return
      await bucket.put(`${copy.code}/state.json`, copy.state)
      if (copy.results) {
        await bucket.put(`${copy.code}/results.json`, copy.results)
        this.resultsSaved = true
      }
    } catch (err) {
      console.error('backup failed', err)
    }
  }

  // 端末に「ゲームは終わりました」を伝えて、保存領域を消す
  private async cleanup(meta: Meta): Promise<void> {
    const seats = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM seats').one().n as number
    const shards = [CREW_SHARD, ...Array.from({ length: Math.ceil(seats / SHARD_SIZE) }, (_, k) => shardOf(k * SHARD_SIZE))]
    await Promise.allSettled(shards.map((shard) => this.room(meta.code, shard).shutdown()))
    if (this.backupTimer) clearTimeout(this.backupTimer)
    this.backupTimer = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    this.meta = undefined
    this.engine = null
    this.hkey = null
    this.out = []
    this.wantAlarm = null
    this.armed = undefined
    this.chains.clear()
    this.counts.clear()
  }
}

// ---- 端末から届いた操作を確かめる -------------------------------------------

function cleanHostCommand(c: unknown): HostCommand | null {
  if (!c || typeof c !== 'object') return null
  const x = c as Record<string, unknown>
  switch (x.type) {
    case 'next':
      // from（押した画面が見ていた進行の位置）は短い文字列だけ通す。形がおかしければ、その「次へ」は捨てる（from なしで通すと、二重に進みうる）
      if (x.from === undefined || x.from === null) return { type: 'next' }
      return typeof x.from === 'string' && x.from.length <= 64 ? { type: 'next', from: x.from } : null
    case 'auto':
      return typeof x.on === 'boolean' ? { type: 'auto', on: x.on } : null
    case 'trigger':
      return x.kind === 'wild' || x.kind === 'mole' || x.kind === null ? { type: 'trigger', kind: x.kind } : null
    case 'bots':
      return typeof x.count === 'number' && Number.isFinite(x.count) ? { type: 'bots', count: Math.max(0, Math.min(MAX_PLAYERS, Math.round(x.count))) } : null
    case 'reset':
      // 景品の数は Engine が確かめる（おかしければ、やり直さずに主催へ知らせる）
      return x.settings === undefined || x.settings === null ? { type: 'reset' } : { type: 'reset', settings: x.settings as LiveSettings }
    default:
      return null
  }
}

function cleanPhoneCommand(c: unknown): PhoneCommand | null {
  if (!c || typeof c !== 'object') return null
  const x = c as Record<string, unknown>
  switch (x.type) {
    case 'questScore':
      return { type: 'questScore', score: typeof x.score === 'number' ? x.score : Number.NaN }
    case 'choice':
      return x.kind === 'receive' || x.kind === 'challenge' ? { type: 'choice', kind: x.kind } : null
    case 'prizeSeen':
      return { type: 'prizeSeen' }
    case 'entry':
      return { type: 'entry' }
    default:
      return null
  }
}
