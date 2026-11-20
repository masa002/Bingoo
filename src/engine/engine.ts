import { FREE_CELL, labelOf, popcount, waitingCells } from '../core/card'
import { CAN, CH_FREE, CH_LINES, Game, challengeChance, dumpGame, restoreGame, type GameDump, type Impact, type Player } from '../core/game'
import { fakeName } from '../core/names'
import { HELD_REASON, PrizeStock, RANKS, addHold, commitHash, doubleChancePrizes, packLook, type BallColor, type Holds, type Prize, type Rarity, type StockDump } from '../core/prizes'
import { Rng } from '../core/rng'
import { drawTiming, personalTier, pickStyle, venueBeats, type MachineStyle, type PersonalOutcome } from '../core/show'
import type { ChoiceOffer, LiveState, Msg, MsgOf, Phase, PhoneCommand, PrizeEntry, Totals, Who } from '../net/protocol'
import { MAX_PLAYERS, QUEST_MAX_SCORE, cleanSettings, type HostCommand, type LiveSettings, type PersonalDraw, type PublicState, type ResultRow } from '../net/wire'

// 本番の進行役（権威）。山札・判定・演出の計画・景品の割り当てを、参加者の全員分まとめて受け持つ。
// デモの DemoAuthority（自分 1 人 + 仮想の参加者）と同じ決まりを、全員が本物の参加者でも動く形にしたもの。
//
// - 通信も保存も知らない。外の世界は EngineHost 越しに使う（Cloudflare では Durable Object が、試験では偽物が受け持つ）。
// - 待ち時間は「いまの段（step）と、次に進む時刻」として持つ。途中で止まっても、保存した状態から続きができる
//   （await で待たない。サーバーの入れ替えで処理が消えても、抽選が止まらないようにするため）。
// - 画面に配るメッセージは protocol.ts の Msg のまま。全員宛ての部分と、本人宛ての部分（人の番号 → 上書きする項目）に分けて出す。
// - リハーサル用に、仮想の参加者（bot）も入れられる

export interface Outbound {
  at: number // この時刻（サーバーの時計）に画面へ渡す
  to: 'all' | 'players' | 'crew' | 'host' // all: 参加者と大画面と主催。crew: 大画面と主催
  msg: Msg | null // 全員宛ての部分（null なら、本人宛てだけ）
  personal?: Map<number, Record<string, unknown>> // 人の番号 → 本人宛ての部分
}

export interface EngineHost {
  now(): number
  // 次に onAlarm を呼んでほしい時刻（null なら、もう呼ばなくてよい）
  setAlarm(at: number | null): void
  emit(out: Outbound): void
  // 外から推測できない文字列（シードに使う）
  secret(): string
}

// 参加者の操作が要るイベントの前に出す、説明の画面。司会が説明し終えて「スタート」を押すまで待つ。
// 自動進行のときは auto で進み、押し忘れても max で進む
const BRIEF = { auto: 10000, max: 60000 }
// 緊急クエスト「モグラ撃退」の時間割（ms）。maxScore は 1 人が叩ける数の上限（届いた数はこの範囲に丸める）
const QUEST = { intro: 3600, play: 10000, grace: 1500, result: 7000, maxScore: QUEST_MAX_SCORE }
const LAST_ONE = { dropAt: 6500, durationMs: 11000 }
const MAX_MOLES = 5
// 景品の「受け取る／上位チャレンジ」の選択を待つ長さの上限（スマホの側は、開封のあと 10 秒で「受け取る」になる）
const CHOICE_MAX = 40000
// 当たった人のスマホは、景品の発表（prizeTime）を受け取ったらすぐ「見ました」（prizeSeen）を送る。
// 発表が画面に出てから、この時間たっても届かない人（眠っている・つながっていないスマホ）は、選ぶのを待たずに「受け取る」扱いにする。
// ふつうは 1 秒もかからずに届く。通信の遅れと、受け口（Room）がまとめて渡すまでの 50ms を見込んで、長めにとる
const SEEN_MS = 5000
const DC_ENTRY_S = 30
const OUTCOME: readonly PersonalOutcome[] = ['none', 'hit', 'reach', 'bingo']
const COLOR_RANK: Record<BallColor, number> = { white: 0, red: 1, gold: 2, rainbow: 3 }

type Choice = 'receive' | 'challenge'

type Step =
  | { k: 'idle' } // 主催の「次へ」を待っている
  | { k: 'auto'; until: number } // 自動進行の、次の抽選までの間
  | { k: 'finalBall'; until: number; n: number }
  | { k: 'spin'; until: number; n: number; final: boolean; resultMs: number }
  | { k: 'result'; until: number; final: boolean; bingoIdx: number[]; challengeIdx: number[] }
  | { k: 'lastOneBrief'; until: number; entries: PrizeEntry[]; final: boolean }
  // seen: 発表を見たと知らせてきた当選者（prizeSeen）。この変更の前に保存した状態にはない（そのときは、今までどおり全員を待つ）
  | { k: 'lastOne'; until: number; entries: PrizeEntry[]; chose: [number, Choice][]; seen?: number[] }
  // seenBy: 「見ました」を待つ締め切り（それまでは、まだ届いていない人も待つ）。end: 選ぶのを待つ締め切り
  | { k: 'choice'; until: number; entries: PrizeEntry[]; chose: [number, Choice][]; seen?: number[]; seenBy?: number; end?: number }
  | { k: 'deal'; until: number }
  | { k: 'wild'; until: number }
  | { k: 'questBrief'; until: number; quest: QuestData }
  | { k: 'questPlay'; until: number; tick: number; t0: number; quest: QuestData }
  | { k: 'questGrace'; until: number; quest: QuestData }
  | { k: 'questResult'; until: number }
  | { k: 'dcEntry'; until: number; tick: number; t0: number; bots: number[] }
  | { k: 'dcSpin'; until: number }
  | { k: 'dcHold'; until: number }

interface QuestData {
  ratio: number // やられる割合（景品のペースのために先に決める）
  aim: [number, number][] // 本当に狙われた人 → 狙われたマス
  cell: number[] // 人の番号 → スマホに見せる、ボスモグラが狙うマス
  label: string[]
  scores: number[] // 人の番号 → 叩いた数（まだ届いていなければ -1）
  waiting: number // まだ数が届いていない本物の参加者
  botTotal: number
}

export interface EngineDump {
  v: 1
  settings: LiveSettings
  game: GameDump // players は空（参加者の表は別に保存する）
  stock: StockDump
  rng: number[]
  pace: number[]
  phase: Phase
  auto: boolean
  step: Step
  target: number
  dcPool: Prize[]
  prizeOf: [number, Prize, ResultRow['how']][]
  pending: [number, Prize][]
  balls: [number, number][]
  entrants: number[]
  lastEventAt: number
  moles: number
  wilds: number
  rev: number
  styles: MachineStyle[]
  pendingEvent: 'wild' | 'mole' | null
  deckHash: string
  roster: number
}

// 参加者の表の 1 行（保存用）
export interface Seat {
  name: string
  cardNo: number
  bot: boolean
}

export class Engine {
  game!: Game
  settings!: LiveSettings
  phase: Phase = 'reception'
  deckHash = ''
  // 配り直し（reset）のたびに増える。保存する側が「参加者の表を丸ごと書き直す」合図に使う
  roster = 0

  private rng!: Rng
  private paceRng!: Rng
  private stock!: PrizeStock
  private step: Step = { k: 'idle' }
  private auto = false
  private target = 0
  private dcPool: Prize[] = []
  private readonly prizeOf = new Map<number, { prize: Prize; how: ResultRow['how'] }>()
  private readonly pending = new Map<number, Prize>()
  private readonly balls = new Map<number, number>()
  private readonly entrants = new Set<number>()
  private readonly bots = new Set<number>()
  private lastEventAt = -10
  private moles = 0
  private wilds = 0
  private rev = 0
  private styles: MachineStyle[] = []
  private pendingEvent: 'wild' | 'mole' | null = null

  // 保存しないもの（止まって消えても困らない）
  private t = 0 // いま処理している出来事の時刻
  private connected = 0
  private readonly questLive = new Map<string, number>() // 受け口ごとの、叩いている途中の数の合計
  private joinedDue: number | null = null
  private hostDue: number | null = null
  private lastHost = ''
  private lastStep = ''
  private totalsKey = ''
  private totalsCache: Totals | null = null

  private constructor(
    private readonly host: EngineHost,
    private readonly lead: number,
  ) {}

  // ---- 作る・戻す・保存する -------------------------------------------------

  static async create(host: EngineHost, lead: number, settings: LiveSettings): Promise<Engine> {
    const e = new Engine(host, lead)
    await e.deal(settings, [])
    return e
  }

  static restore(host: EngineHost, lead: number, d: EngineDump, seats: readonly Seat[]): Engine {
    const e = new Engine(host, lead)
    e.settings = d.settings
    e.game = restoreGame({ ...d.game, players: seats.map((s) => ({ name: s.name, cardNo: s.cardNo })) })
    seats.forEach((s, i) => s.bot && e.bots.add(i))
    e.stock = PrizeStock.load(d.stock)
    e.rng = Rng.restore(d.rng)
    e.paceRng = Rng.restore(d.pace)
    e.phase = d.phase
    e.auto = d.auto
    e.step = d.step
    e.target = d.target
    e.dcPool = d.dcPool
    for (const [i, prize, how] of d.prizeOf) e.prizeOf.set(i, { prize, how })
    for (const [i, p] of d.pending) e.pending.set(i, p)
    for (const [i, n] of d.balls) e.balls.set(i, n)
    for (const i of d.entrants) e.entrants.add(i)
    e.lastEventAt = d.lastEventAt
    e.moles = d.moles
    e.wilds = d.wilds
    e.rev = d.rev
    e.styles = d.styles
    e.pendingEvent = d.pendingEvent
    e.deckHash = d.deckHash
    e.roster = d.roster
    e.arm()
    return e
  }

  dump(): EngineDump {
    return {
      v: 1,
      settings: this.settings,
      game: { ...dumpGame(this.game), players: [] },
      stock: this.stock.dump(),
      rng: this.rng.state(),
      pace: this.paceRng.state(),
      phase: this.phase,
      auto: this.auto,
      step: this.step,
      target: this.target,
      dcPool: this.dcPool,
      prizeOf: [...this.prizeOf].map(([i, x]) => [i, x.prize, x.how]),
      pending: [...this.pending],
      balls: [...this.balls],
      entrants: [...this.entrants],
      lastEventAt: this.lastEventAt,
      moles: this.moles,
      wilds: this.wilds,
      rev: this.rev,
      styles: this.styles,
      pendingEvent: this.pendingEvent,
      deckHash: this.deckHash,
      roster: this.roster,
    }
  }

  // 参加者の表（from 番から後ろ）
  seats(from = 0): Seat[] {
    return this.game.players.slice(from).map((p) => ({ name: p.name, cardNo: p.cardNo, bot: this.bots.has(p.idx) }))
  }

  // カードと山札と景品を配る（最初と、やり直しのとき）。参加者は、同じ番号のまま座り直す
  private async deal(settings: LiveSettings, seats: readonly Seat[]): Promise<void> {
    const secret = this.host.secret()
    this.settings = settings
    this.game = new Game({ seed: this.host.secret().slice(0, 12), deckSeed: secret, size: 0 }, () => '')
    this.bots.clear()
    seats.forEach((s, i) => {
      this.game.addPlayer(s.name)
      if (s.bot) this.bots.add(i)
    })
    this.rng = new Rng(`${secret}/show`)
    this.paceRng = new Rng(`${secret}/pace`)
    this.stock = new PrizeStock(settings.lower, settings.upper, new Rng(`${secret}/prizes`), settings.prizeNames)
    this.dcPool = doubleChancePrizes(settings.dc, settings.prizeNames?.DC)
    for (const m of [this.prizeOf, this.pending, this.balls]) m.clear()
    this.entrants.clear()
    this.questLive.clear()
    this.phase = 'reception'
    this.step = { k: 'idle' }
    this.target = 0
    this.lastEventAt = -10
    this.moles = 0
    this.wilds = 0
    this.rev++
    this.styles = []
    this.pendingEvent = null
    this.roster++
    this.deckHash = await commitHash(this.game.deck, this.stock.manifest(), `${secret}/salt`)
  }

  // ---- 外から呼ぶ入口 -------------------------------------------------------
  // どの入口も、終わったら保存する側が dump() を保存する（progress と presence は保存しなくてよい）

  // 参加する。表示名は、呼ぶ側で整えてから渡す。入れないときは、理由（人に見せる文）を返す
  join(name: string, bot = false): { idx: number; cardNo: number } | { error: string } {
    this.t = this.host.now()
    if (this.phase !== 'reception' && this.phase !== 'playing') return { error: 'このゲームは、もう参加を締め切りました' }
    if (this.game.size >= MAX_PLAYERS) return { error: '満員です。これ以上は参加できません' }
    const p = this.game.addPlayer(name)
    if (!p) return { error: 'ゲームが終わりに近いため、いまからは参加できません' }
    if (bot) this.bots.add(p.idx)
    // 参加の人数は、まとめて 1 秒に 1 回だけ配る（1 人ごとに全員へ配ると、人数の 2 乗の通信になる）
    this.joinedDue ??= this.t + 1000
    this.hostDue ??= this.t + 1000
    this.arm()
    return { idx: p.idx, cardNo: p.cardNo }
  }

  // つないだ（つなぎ直した）端末に渡す、いまの状態。idx が null なら、大画面・主催用
  snapshot(idx: number | null): MsgOf<'snapshot'> {
    const g = this.game
    const p = idx === null ? null : g.players[idx]
    const prize = p ? (this.prizeOf.get(p.idx)?.prize ?? this.pending.get(p.idx) ?? null) : null
    const live: LiveState = {
      count: g.size,
      mask: p?.mask ?? 0,
      filled: p?.filled ?? 0,
      wild: p?.wild ?? 0,
      rank: p && p.bingoDraw !== null ? g.winners.indexOf(p.idx) + 1 : 0,
      prize: prize ? { name: prize.name, rarity: prize.id >= 1000 ? null : prize.rarity } : null,
      challenge: p?.challenge ? { cells: p.challenge.cells, mask: p.challenge.mask, target: p.challenge.target } : null,
      dcEntered: p ? this.entrants.has(p.idx) : false,
      dcLeftMs: this.step.k === 'dcEntry' ? Math.max(0, this.step.t0 + DC_ENTRY_S * 1000 - this.host.now()) : 0,
      phase: this.phase,
    }
    return {
      type: 'snapshot',
      seed: g.seed,
      size: g.size,
      me: p ? { idx: p.idx, cardNo: p.cardNo, name: p.name } : { idx: -1, cardNo: 0, name: '' },
      drawn: [...g.drawn],
      deckHash: this.deckHash,
      totals: this.totals(),
      live,
    }
  }

  // totp（認証アプリが要るか）は、Engine の外で持っているので、呼ぶ側が足す
  publicState(code: string): Omit<PublicState, 'totp'> {
    return {
      code,
      phase: this.phase,
      players: this.game.size,
      drawn: [...this.game.drawn],
      canJoin: (this.phase === 'reception' || this.phase === 'playing') && this.game.size < MAX_PLAYERS,
    }
  }

  hostState(): MsgOf<'host'> {
    const s = this.step
    return {
      type: 'host',
      phase: this.phase,
      busy: s.k !== 'idle' && s.k !== 'auto',
      hold: s.k === 'questBrief' || s.k === 'lastOneBrief' ? 'スタート ▶' : s.k === 'dcEntry' ? '参加をしめきる ▶' : s.k === 'dcHold' ? '締めくくりへ ▶' : null,
      step: this.stepKey(),
      auto: this.auto,
      players: this.game.size,
      bots: this.bots.size,
      connected: this.connected,
      drawCount: this.game.drawCount,
      deckHash: this.deckHash,
      event: this.pendingEvent,
      settings: this.settings,
    }
  }

  // 進行の位置（主催の画面に host の step として送り、「次へ」に from として付けて返してもらう）。
  // 押したあとで位置が変わっていたら（ほかの主催が先に押した）、その「次へ」は捨てる。
  // 同じ段でも、抽選の回数と、配り直し・イベントの数（rev）で区別する（前の回の「次へ」が、あとから届いても効かないように）。
  // 自動進行の、次の抽選までの間（auto）は、待っている（idle）のと同じに数える（自動進行を切りかえただけで、押した「次へ」を捨てないように）
  private stepKey(): string {
    const k = this.step.k === 'auto' ? 'idle' : this.step.k
    return `${this.phase}:${k}:${this.game.drawCount}:${this.rev}`
  }

  // 当選者の一覧（景品の受け渡しに使う）
  results(): ResultRow[] {
    return [...this.prizeOf].map(([idx, x]) => ({
      name: this.game.players[idx].name,
      cardNo: this.game.players[idx].cardNo,
      rarity: x.how === 'double-chance' && x.prize.id >= 1000 ? null : x.prize.rarity,
      prize: x.prize.name,
      how: x.how,
      bot: this.bots.has(idx),
    }))
  }

  isBot(idx: number): boolean {
    return this.bots.has(idx)
  }

  // 時刻が来た
  onAlarm(): void {
    const now = this.host.now()
    this.t = now
    if (this.joinedDue !== null && this.joinedDue <= now) {
      this.joinedDue = null
      this.send({ type: 'joined', count: this.game.size, meJoined: false })
    }
    if (this.hostDue !== null && this.hostDue <= now) this.hostDue = null
    for (let guard = 0; guard < 64; guard++) {
      const s = this.step
      if ('tick' in s && s.tick <= now && s.tick < s.until) {
        this.t = s.tick
        this.onTick(s)
        continue
      }
      if (!('until' in s) || s.until > now) break
      // 予定の時刻を基準にして、次の時刻を決める（起こされるのが少し遅れても、全体はずれていかない）。
      // 大きく遅れたとき（サーバーが止まっていた）は、いまの時刻から続ける
      this.t = now - s.until <= 1500 ? s.until : now
      this.onDue(s)
    }
    this.done()
  }

  // 主催の操作
  async command(cmd: HostCommand): Promise<void> {
    this.t = this.host.now()
    let resend = false
    switch (cmd.type) {
      case 'next':
        // 押した画面が見ていた位置（from）と、いまの位置が違う: ほかの主催が先に押して、もう進んでいる。
        // この「次へ」は捨てて、いまの状態を主催に送り直す（押した画面が、古い位置のまま取り残されないように）
        if (cmd.from !== undefined && cmd.from !== this.stepKey()) resend = true
        else this.next()
        break
      case 'auto':
        this.auto = cmd.on
        // 入れたときに、待っている説明の画面や次の抽選を進める（受付の締め切りは、主催が自分で押す）
        if (cmd.on && (this.step.k === 'questBrief' || this.step.k === 'lastOneBrief' || (this.step.k === 'idle' && this.phase === 'playing'))) this.next()
        break
      case 'trigger':
        if (this.phase !== 'playing' && this.phase !== 'reception') break
        this.pendingEvent = cmd.kind === 'wild' || cmd.kind === 'mole' ? cmd.kind : null
        break
      case 'bots': {
        if (this.phase !== 'reception') {
          this.notice('仮想の参加者を足せるのは、受付中だけです')
          break
        }
        const nameRng = new Rng(`bots/${this.game.size}`)
        const count = Math.max(0, Math.min(Math.round(cmd.count), MAX_PLAYERS - this.game.size))
        for (let i = 0; i < count; i++) this.join(fakeName(nameRng), true)
        break
      }
      case 'reset': {
        const s = cmd.settings === undefined ? this.settings : cleanSettings(cmd.settings)
        if (!s) {
          this.notice('景品の数が正しくありません。やり直していません')
          break
        }
        await this.deal(s, this.seats())
        this.t = this.host.now()
        const personal = new Map<number, Record<string, unknown>>()
        for (const p of this.game.players) {
          if (this.bots.has(p.idx)) continue
          const snap = this.snapshot(p.idx)
          personal.set(p.idx, { me: snap.me, live: snap.live })
        }
        this.send(this.snapshot(null), personal)
        break
      }
    }
    this.done(resend)
  }

  // 参加者の操作。端末から届く値は信用しない。
  // 何か変わったら true（保存する側は、false なら書かない。同じ操作の連打や、時機の外れた操作で、保存の回数を増やさないように）
  player(idx: number, cmd: PhoneCommand): boolean {
    this.t = this.host.now()
    const p = this.game.players[idx]
    if (!p || this.bots.has(idx)) return false
    const s = this.step
    switch (cmd.type) {
      case 'join':
      case 'questProgress':
        return false
      case 'questScore': {
        if (s.k !== 'questPlay' && s.k !== 'questGrace') return false
        const q = s.quest
        if (q.scores[idx] !== -1) return false // 1 人 1 回だけ（あとから入った人の分は、数えない）
        q.scores[idx] = Number.isFinite(cmd.score) ? Math.min(QUEST.maxScore, Math.max(0, Math.round(cmd.score))) : 0
        q.waiting--
        if (s.k === 'questGrace' && q.waiting <= 0) this.finishQuest(q)
        break
      }
      case 'prizeSeen': {
        // 当たった人のスマホが、景品の発表を受け取った（起きている）。この人の選択は、締め切りまで待つ
        if (s.k !== 'choice' && s.k !== 'lastOne') return false
        if (!s.seen || s.seen.includes(idx) || !s.entries.some((e) => e.idx === idx && e.rarity)) return false
        s.seen.push(idx)
        break
      }
      case 'choice': {
        if (s.k !== 'choice' && s.k !== 'lastOne') return false
        if (cmd.kind !== 'receive' && cmd.kind !== 'challenge') return false
        if (!this.pending.has(idx) || !s.entries.some((e) => e.idx === idx) || s.chose.some(([i]) => i === idx)) return false
        s.chose.push([idx, cmd.kind])
        if (s.k === 'choice' && this.choiceWaiting(s) === 0) this.applyChoices(s.entries, s.chose)
        break
      }
      case 'entry':
        if (s.k !== 'dcEntry' || this.prizeOf.has(idx) || this.entrants.has(idx)) return false
        this.entrants.add(idx) // 人数は、次の 1 秒ごとの知らせでまとめて配る
        break
      default:
        return false
    }
    this.done()
    return true
  }

  // 受け口から届く、叩いている途中の数の合計（大画面の「会場で叩いた数」に使うだけ。保存しなくてよい）
  progress(source: string, total: number): void {
    if (this.step.k !== 'questPlay') return
    if (Number.isFinite(total)) this.questLive.set(source, Math.max(0, Math.round(total)))
  }

  // いまつながっている端末の数（主催の画面に出すだけ。保存しなくてよい）
  presence(connected: number): void {
    if (connected === this.connected) return
    this.connected = connected
    this.hostDue ??= this.host.now() + 1000
    this.arm()
  }

  // ---- 進行 -----------------------------------------------------------------

  // 入口の終わりに呼ぶ: 主催の画面を更新して、次に起こしてもらう時刻を決める。
  // 参加・接続の数だけの変化は 1 秒に 1 回にまとめる（hostDue）。進行の位置が変わったときは、すぐ送る（主催の「次へ」の from が古くならないように）。
  // force: 変わっていなくても送る（捨てた「次へ」を押した画面に、いまの位置を知らせ直す）
  private done(force = false): void {
    if (force || this.hostDue === null || this.stepKey() !== this.lastStep) {
      const state = this.hostState()
      const text = JSON.stringify(state)
      if (force || text !== this.lastHost) {
        this.lastHost = text
        this.lastStep = state.step
        this.host.emit({ at: this.host.now(), to: 'host', msg: state })
      }
    }
    this.arm()
  }

  private arm(): void {
    const s = this.step
    const times = [this.joinedDue, this.hostDue, 'until' in s ? s.until : null, 'tick' in s && s.tick < s.until ? s.tick : null].filter((x): x is number => x !== null)
    this.host.setAlarm(times.length ? Math.min(...times) : null)
  }

  private send(msg: Msg | null, personal?: Map<number, Record<string, unknown>>, to: Outbound['to'] = 'all'): void {
    this.host.emit({ at: this.t + this.lead, to, msg, personal: personal?.size ? personal : undefined })
  }

  private notice(text: string): void {
    this.host.emit({ at: this.host.now(), to: 'host', msg: { type: 'notice', text } })
  }

  private who(idx: number): Who {
    return { name: this.game.players[idx].name, isMe: false, idx }
  }

  // 本物の参加者（仮想でない人）
  private humans(): Player[] {
    return this.bots.size ? this.game.players.filter((p) => !this.bots.has(p.idx)) : this.game.players
  }

  private holdMs(): number {
    return this.auto ? BRIEF.auto : BRIEF.max
  }

  // 主催の「次へ」。ゲーム中は抽選（またはイベント）、終わったらダブルチャンスへ進む
  private next(): void {
    const s = this.step
    if (s.k === 'questBrief' || s.k === 'lastOneBrief' || s.k === 'dcHold' || s.k === 'dcEntry') return this.onDue(s)
    if (s.k !== 'idle' && s.k !== 'auto') return
    if (this.phase === 'done' || this.phase === 'dc-entry' || this.phase === 'dc-spin') return
    if (this.phase === 'over') return this.startDoubleChance()
    const g = this.game
    if (this.phase === 'reception') {
      if (g.size === 0) return this.notice('まだだれも参加していません')
      this.phase = 'playing'
      // 目安は、何もしなかったときの見込みより少し長め（モグラで一気に減る回をならす分）
      this.target = Math.max(16, Math.round(g.estimateDrawsUntil(this.settings.lower, this.paceRng, g.size > 3000 ? 6 : 12) * 1.15))
      // 締め切る前に参加した人数を、最後にもう一度そろえる
      this.joinedDue = null
      this.send({ type: 'joined', count: g.size, meJoined: false })
    }
    this.turn()
  }

  private turn(): void {
    const g = this.game
    if (!g.remaining().length) {
      this.step = { k: 'idle' }
      return
    }
    const ev = this.pendingEvent ? { kind: this.pendingEvent, ratio: 0.35 } : this.pacingEvent()
    this.pendingEvent = null
    if (ev?.kind === 'wild') this.runWild()
    else if (ev) this.startQuest(ev.ratio)
    else this.startDraw()
  }

  // 1 回の進行（抽選・イベント）が終わった
  private endTurn(): void {
    if (this.phase === 'over') {
      this.send({ type: 'gameOver', totals: this.totals(), leftoverUpper: this.stock.upperLeft })
      this.step = { k: 'idle' }
      return
    }
    this.send({ type: 'idle', totals: this.totals() })
    this.step = this.auto && this.phase === 'playing' ? { k: 'auto', until: this.t + 1200 } : { k: 'idle' }
  }

  // 抽選の 1 回が終わった。下位の景品が尽きたら、ゲームは終わり
  private endDraw(): void {
    if (this.stock.lowerLeft === 0 || this.game.remaining().length === 0) this.finish()
    this.endTurn()
  }

  private onDue(s: Step): void {
    switch (s.k) {
      case 'idle':
        return
      case 'auto':
        if (this.auto && this.phase === 'playing') this.turn()
        else this.step = { k: 'idle' }
        return
      case 'finalBall':
        return this.spin(s.n, true)
      case 'spin':
        return this.reveal(s)
      case 'result':
        if (s.bingoIdx.length || s.challengeIdx.length) this.prizePhase(s.bingoIdx, s.challengeIdx, s.final)
        else this.endDraw()
        return
      case 'lastOneBrief':
        return this.prizeTime(s.entries, s.final, true)
      case 'lastOne':
        return this.awaitChoices(s.entries, s.chose, s.seen, true)
      case 'choice':
        // 「見ました」を待つ時間が終わった。見たと知らせてきた人がまだ選んでいれば、選び終わるまで（長くても end まで）待つ
        if (s.end !== undefined && s.until < s.end && this.choiceWaiting(s) > 0) {
          this.step = { ...s, until: s.end }
          return
        }
        return this.applyChoices(s.entries, s.chose)
      case 'deal':
        return this.endDraw()
      case 'wild':
      case 'questResult':
        return this.endTurn()
      case 'questBrief':
        return this.playQuest(s.quest)
      case 'questPlay': {
        const q = s.quest
        // 叩き終わったスマホの数が届くのを待つ（スマホは LEAD の分だけ遅れて動いている）
        if (q.waiting > 0) this.step = { k: 'questGrace', until: this.t + this.lead + QUEST.grace, quest: q }
        else this.finishQuest(q)
        return
      }
      case 'questGrace':
        return this.finishQuest(s.quest)
      case 'dcEntry':
        return this.closeEntry()
      case 'dcSpin':
        this.step = { k: 'dcHold', until: this.t + this.holdMs() }
        return
      case 'dcHold':
        this.send({ type: 'dcEnd' })
        this.phase = 'done'
        this.step = { k: 'idle' }
        return
    }
  }

  private onTick(s: Extract<Step, { tick: number }>): void {
    if (s.k === 'questPlay') {
      const k = Math.min(1, (s.tick - s.t0 - QUEST.intro) / QUEST.play)
      let total = Math.round(s.quest.botTotal * (0.6 * k + 0.4 * k * k)) // 仮想の参加者の分（後半ほどモグラが多い）
      for (const x of this.questLive.values()) total += x
      // 参加者のスマホにも配る（会場の外から参加する人は、大画面の合計が見えないため）
      this.send({ type: 'questProgress', total })
      s.tick += 500
    } else {
      const sec = Math.round((s.tick - s.t0) / 1000)
      // 仮想の参加者の 8 割ほどが、受付の前半にエントリーする
      for (const i of s.bots.slice(0, Math.round(s.bots.length * Math.min(1, sec / 12)))) this.entrants.add(i)
      this.send({ type: 'dcEntrants', count: this.entrants.size })
      s.tick += 1000
    }
  }

  // ---- イベント（全員確定・モグラ撃退） -------------------------------------

  // ペースの調整役。次の 1 球で景品が一気に減る（残りの 1/3 を超える人数が同時に上がる）ときはモグラでリーチの人の一部を止め、
  // 序盤を過ぎても誰も上がらず、目安より長引きそうなときだけ虹玉で全員を 1 マス進める
  private pacingEvent(): { kind: 'wild' | 'mole'; ratio: number } | null {
    const g = this.game
    const d = g.drawCount
    const left = this.stock.lowerLeft
    if (d < 3 || d - this.lastEventAt < 2 || left <= 0) return null
    if (this.wilds < 1 && d >= 5 && g.winners.length === 0) {
      const projected = d + g.estimateDrawsUntil(left, this.paceRng, g.size > 3000 ? 3 : 6)
      if (projected > this.target + 3) return { kind: 'wild', ratio: 0 }
    }
    if (this.moles >= MAX_MOLES || g.reachHolders() === 0) return null
    const next = g.nextInDeck()
    const burst = next === undefined ? 0 : g.preview(next).newBingo
    const cap = Math.max(2, Math.ceil(left / 3))
    if (burst <= cap) return null
    return { kind: 'mole', ratio: Math.min(0.85, Math.max(0.35, 1 - cap / burst)) }
  }

  // 全員確定（虹玉）: まだ上がっていない全員のカードで、マスを 1 つ開ける
  private runWild(): void {
    const g = this.game
    this.lastEventAt = g.drawCount
    this.wilds++
    this.rev++
    const before = g.players.map((p) => p.reach)
    const change = g.applyWild(this.rng)
    const personal = new Map<number, Record<string, unknown>>()
    for (const p of this.humans()) {
      const cell = change.cells.get(p.idx) ?? null
      personal.set(p.idx, { me: { cell, label: cell === null ? '' : labelOf(p.cells[cell]), reachBefore: before[p.idx], reachAfter: p.reach } })
    }
    const durationMs = 11500
    this.send(
      {
        type: 'eventPlay',
        durationMs,
        resultAt: 8200,
        total: g.players.filter((p) => p.bingoDraw === null).length,
        newReach: change.newReach,
        newDouble: change.newDouble,
        me: { cell: null, label: '', reachBefore: 0, reachAfter: 0 },
        totals: this.totals(),
      },
      personal,
    )
    this.step = { k: 'wild', until: this.t + durationMs }
  }

  // 緊急クエスト「モグラ撃退」。狙われるのはリーチの人で、ボスモグラがリーチのマスを狙う。
  // 持っているものを失うのは、自分が挑んだ結果としてだけにする: やられる割合（ratio）は景品のペースのために先に決め、
  // 叩いた数が会場全体の下から ratio の割合に入った人がやられる。
  // スマホには、リーチでない人にもボスモグラを見せる（「狙われていない」と言われたら、叩く理由がなくなるため）。
  // 見せるだけで、リーチでない人のマスは埋めない
  private startQuest(ratio: number): void {
    const g = this.game
    this.lastEventAt = g.drawCount
    this.moles++
    const q: QuestData = { ratio, aim: [], cell: [], label: [], scores: [], waiting: 0, botTotal: 0 }
    for (const p of g.players) {
      const cell = p.bingoDraw === null && p.reach > 0 ? g.aimMole(p, this.rng) : null
      if (cell !== null) {
        q.aim.push([p.idx, cell])
        q.cell.push(cell)
        q.label.push(labelOf(p.cells[cell]))
      } else if (this.bots.has(p.idx)) {
        q.cell.push(-1)
        q.label.push('')
      } else {
        const [c, label] = this.bluffCell(p)
        q.cell.push(c)
        q.label.push(label)
      }
    }
    this.send(
      { type: 'questBrief', kind: 'mole', playMs: QUEST.play, targets: q.aim.length, players: g.size, autoMs: this.auto ? BRIEF.auto : null, me: { target: false, cell: null, label: '' } },
      this.questPersonal(q),
    )
    this.step = { k: 'questBrief', until: this.t + this.holdMs(), quest: q }
  }

  private questPersonal(q: QuestData): Map<number, Record<string, unknown>> {
    const personal = new Map<number, Record<string, unknown>>()
    for (const p of this.humans()) {
      if (q.cell[p.idx] !== undefined) personal.set(p.idx, { me: { target: true, cell: q.cell[p.idx], label: q.label[p.idx] } })
    }
    return personal
  }

  // リーチでない人に見せる、ボスモグラが狙うマス（いま見えているカードの開いたマス。上位チャレンジ中は 3×3 のカード）。
  // まだ 1 つも開いていなければ、真ん中の FREE を狙わせる（誰のカードにも必ず狙うマスがある）
  private bluffCell(p: Player): [number, string] {
    const ch = p.challenge
    const cells = ch ? ch.cells : p.cells
    const mask = ch ? ch.mask : p.mask
    const open = cells.flatMap((n, c) => (n && mask & (1 << c) ? [c] : []))
    if (!open.length) return [ch ? CH_FREE : FREE_CELL, 'FREE']
    const cell = this.rng.pick(open)
    return [cell, labelOf(cells[cell])]
  }

  private playQuest(q: QuestData): void {
    const g = this.game
    this.send(
      { type: 'questStart', kind: 'mole', introMs: QUEST.intro, playMs: QUEST.play, targets: q.aim.length, players: g.size, me: { target: false, cell: null, label: '' } },
      this.questPersonal(q),
    )
    // 仮想の参加者の叩いた数は、先に決める。本物の参加者の数は、叩き終わったスマホから 1 通ずつ届く
    q.scores = g.players.map((p) => (this.bots.has(p.idx) ? this.botScore() : -1))
    q.botTotal = q.scores.reduce((s, x) => s + Math.max(0, x), 0)
    q.waiting = g.size - this.bots.size
    this.questLive.clear()
    this.step = { k: 'questPlay', until: this.t + QUEST.intro + QUEST.play, tick: this.t + QUEST.intro + 500, t0: this.t, quest: q }
  }

  // 仮想の参加者の叩いた数: 見ていない人が 1 割ほど、なんとなく叩く人（3〜12 匹）、熱心な人（18〜30 匹）
  private botScore(): number {
    const r = this.rng.next()
    if (r < 0.12) return 0
    if (r < 0.37) return 3 + this.rng.int(10)
    return 18 + this.rng.int(13)
  }

  private finishQuest(q: QuestData): void {
    const g = this.game
    this.rev++
    // 叩いた数（届かなかった人は -1）。届かなかった本物の参加者（つなぎ直しの途中・眠っていたスマホ・あとから入った人）は、
    // 挑んでいないので、やられる側にも、守れる数（bar）の計算にも入れない（失うのは、自分が挑んだ結果としてだけ）。
    // 仮想の参加者の数は、始めるときに決めてある
    const got = g.players.map((p) => q.scores[p.idx] ?? -1)
    const scores = got.map((x) => Math.max(0, x))
    // 守れる数（bar）は、数が届いた人の叩いた数の下から ratio の割合のところ。狙われた人のうち bar に届かなかった人がやられる
    const sorted = got.filter((x) => x >= 0).sort((a, b) => a - b)
    const bar = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q.ratio * sorted.length))] : 0
    const aim = new Map(q.aim)
    const losers = new Set([...aim.keys()].filter((idx) => got[idx] >= 0 && got[idx] < bar))
    const before = g.players.map((p) => p.reach)
    let lostReach = 0
    for (const idx of losers) if (g.fillByMole(idx, aim.get(idx)!)) lostReach++
    // 順位は、自分より多く叩いた人の数 + 1（数が届かなかった人は数えず、その人にも順位を付けない）
    const more = new Array<number>(QUEST.maxScore + 2).fill(0)
    for (const s of got) if (s >= 0) more[s]++
    for (let s = QUEST.maxScore; s >= 0; s--) more[s] += more[s + 1]
    const personal = new Map<number, Record<string, unknown>>()
    for (const p of this.humans()) {
      const score = scores[p.idx]
      const lost = losers.has(p.idx)
      const rank = got[p.idx] >= 0 ? more[score + 1] + 1 : 0
      personal.set(p.idx, {
        me: { score, target: true, lost, cell: q.cell[p.idx] ?? null, need: lost ? bar - score : 0, rank, reachBefore: before[p.idx], reachAfter: p.reach },
      })
    }
    const top = got
      .map((score, idx) => ({ idx, score }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => ({ ...this.who(x.idx), score: x.score }))
    this.send(
      {
        type: 'questResult',
        kind: 'mole',
        total: scores.reduce((s, x) => s + x, 0),
        targets: aim.size,
        defended: aim.size - losers.size,
        lost: losers.size,
        lostReach,
        top,
        me: { score: 0, target: false, lost: false, cell: null, need: 0, rank: 0, reachBefore: 0, reachAfter: 0 },
        totals: this.totals(),
        resultMs: QUEST.result,
      },
      personal,
    )
    this.questLive.clear()
    this.step = { k: 'questResult', until: this.t + QUEST.result }
  }

  // ---- 抽選 -----------------------------------------------------------------

  private startDraw(): void {
    const g = this.game
    const n = g.nextInDeck()!
    const imp = g.preview(n)
    const lowerLeft = this.stock.lowerLeft
    // この 1 球で下位の景品が尽きるなら、先に知らせる（これは事実の知らせ。期待度の予告ではない）
    if (imp.newBingo > 0 && imp.newBingo >= lowerLeft) {
      this.send({ type: 'finalBall', prizesLeft: lowerLeft, durationMs: 3800 })
      this.step = { k: 'finalBall', until: this.t + 3800, n }
      return
    }
    this.spin(n, false)
  }

  private spin(n: number, final: boolean): void {
    const g = this.game
    const imp = g.preview(n)
    const style = pickStyle(this.styles, () => this.rng.next())
    this.styles = [...this.styles.slice(-3), style]
    const tm = drawTiming(g.size, imp.newBingo > 0 || imp.challengeIdx.length > 0)
    // 期待度（色）はスマホだけ。その番号が、その人のカードにとって何を意味するかで決める。
    // いまのカードで起こりうること（can）の中からだけ選ぶ（カードは本人に見えているので、リーチでない人に金を出すと、うそだと分かる）
    const out = g.outcomes(n)
    const can = g.possible()
    const personal = new Map<number, Record<string, unknown>>()
    for (const p of this.humans()) {
      const c = can[p.idx]
      const tier = personalTier(OUTCOME[out[p.idx]], { hit: (c & CAN.hit) !== 0, reach: (c & CAN.reach) !== 0, bingo: (c & CAN.bingo) !== 0 }, this.rng)
      const mine: PersonalDraw = { tier, waiting: this.waitingOf(p), k: this.rng.int(0x7fffffff) }
      personal.set(p.idx, { personal: mine })
    }
    // 番号は、大画面でも全員のスマホでも同じ瞬間に出る（公開のメッセージで初めて送る。先には送らない）
    this.send({ type: 'drawScheduled', drawNo: g.drawCount + 1, style, revealAt: tm.reveal, beats: venueBeats(tm.reveal), personal: { tier: 0, waiting: [], beats: [] } }, personal)
    this.step = { k: 'spin', until: this.t + tm.reveal, n, final, resultMs: tm.result }
  }

  private reveal(s: Extract<Step, { k: 'spin' }>): void {
    const g = this.game
    const result: Impact = g.apply(s.n)
    this.send({
      type: 'numberRevealed',
      drawNo: g.drawCount,
      n: s.n,
      label: labelOf(s.n),
      hits: result.hits,
      newReach: result.newReach,
      moreReach: result.moreReach,
      newBingo: result.newBingo,
      names: result.bingoIdx.slice(0, 12).map((i) => this.who(i)),
      challengeWins: result.challengeIdx.map((i) => this.who(i)),
      totals: this.totals(),
      resultMs: s.resultMs,
    })
    this.step = { k: 'result', until: this.t + s.resultMs, final: s.final, bingoIdx: result.bingoIdx, challengeIdx: result.challengeIdx }
  }

  private waitingOf(p: Player): string[] {
    const labels = p.bingoDraw === null ? waitingCells(p.mask, p.filled).map((c) => labelOf(p.cells[c])) : []
    const ch = p.challenge
    if (ch) {
      for (const line of CH_LINES) {
        const rest = line & ~ch.mask
        if (popcount(rest) === 1) labels.push(labelOf(ch.cells[31 - Math.clz32(rest)]))
      }
    }
    return labels.length > 1 ? [...new Set(labels)] : labels
  }

  // ---- 景品 -----------------------------------------------------------------

  private prizePhase(bingoIdx: number[], challengeIdx: number[], final: boolean): void {
    const g = this.game
    const entries: PrizeEntry[] = []
    // 選択画面に出す見込みは、この回で 1 回だけ計算する
    const drawsLeft = Math.round(g.estimateDrawsUntil(this.stock.lowerLeft, this.rng, g.size > 3000 ? 4 : 8))
    // この回に挑戦を出した人の分（挑戦中の人の分と合わせて、在庫に取っておく）
    const batch: Holds = { SR: 0, UR: 0, back: 0 }
    // 上位チャレンジの成功者が先（リスクを取った人を優先する）
    for (const idx of this.rng.shuffle([...challengeIdx])) {
      const target = g.players[idx].challenge!.target
      g.endChallenge(idx)
      // 挑戦を出すときに取っておいたので、ふつうは target 以上が残っている。それでもなければ、下のランクでも渡す（成功した人を手ぶらにしない）
      const prize = this.stock.takeAtLeast(target) ?? this.stock.takeAtMost(target)
      entries.push(this.entry(idx, 'challenge', prize, target, final, drawsLeft, batch))
    }
    // 通常のビンゴ。同じ回の当選者の並びは乱数で決める（参加順だと早く参加した人が有利になる）。
    // 下位が足りなければ 1 つ上のランクへ。上まで全部なくなったときだけラストワン争奪で外れる
    let lastOne = false
    for (const idx of this.rng.shuffle([...bingoIdx])) {
      let prize = this.stock.takeLower(this.rng)
      let from: Rarity | null = null
      if (!prize) {
        prize = this.stock.takeAtLeast('SR')
        from = 'R'
      }
      if (!prize) {
        lastOne = true
        this.balls.set(idx, 3)
      }
      entries.push(this.entry(idx, 'normal', prize, from, final, drawsLeft, batch))
    }
    // ラストワン争奪は、同じ回に上がった人がそれぞれスマホでガラポンを回す（結果はくじで、上の並びで決まっている）。
    // 先に説明の画面を出して、司会の「スタート」を待つ
    if (!lastOne) return this.prizeTime(entries, final, false)
    const pool = entries.filter((e) => e.kind === 'normal')
    this.send({
      type: 'lastOneBrief',
      prizes: pool.filter((e) => e.rarity).length,
      entrants: pool.map((e) => this.who(e.idx)),
      meIn: false,
      autoMs: this.auto ? BRIEF.auto : null,
    })
    this.step = { k: 'lastOneBrief', until: this.t + this.holdMs(), entries, final }
  }

  private prizeTime(entries: PrizeEntry[], final: boolean, lastOne: boolean): void {
    this.send({ type: 'prizeTime', entries, lastOne: lastOne ? LAST_ONE : null, final })
    if (lastOne) this.step = { k: 'lastOne', until: this.t + LAST_ONE.durationMs, entries, chose: [], seen: [] }
    else this.awaitChoices(entries, [], [], false)
  }

  // 選ぶのを待っている、本物の当選者の数。待つのは、まだ選んでいない人のうち、発表を見たと知らせてきた人だけ
  // （「見ました」の締め切り seenBy までは、まだ知らせの届いていない人も待つ。seen がない古い状態では、全員を待つ）
  private choiceWaiting(s: Extract<Step, { k: 'choice' }>): number {
    const early = s.seenBy !== undefined && this.t < s.seenBy
    return s.entries.filter((e) => e.rarity && !this.bots.has(e.idx) && !s.chose.some(([i]) => i === e.idx) && (!s.seen || early || s.seen.includes(e.idx))).length
  }

  // 当たった人がスマホでパックを開けて、受け取るか上位チャレンジかを選ぶのを待つ。
  // 眠っている・つながっていないスマホは選べないので、「見ました」が来なかった人は待たない（受け取る扱い）
  private awaitChoices(entries: PrizeEntry[], chose: [number, Choice][], seen: number[] | undefined, afterLastOne: boolean): void {
    if (!entries.some((e) => e.rarity && !this.bots.has(e.idx))) {
      // 本物の当選者がいない: 大画面で発表を見せる分だけ待つ
      this.step = { k: 'choice', until: this.t + (afterLastOne ? 1500 : 3600), entries, chose, seen }
      return
    }
    const end = this.t + CHOICE_MAX + this.lead
    // ラストワン争奪のあとは、発表から 11 秒たっている。起きているスマホからは、もう「見ました」が届いている
    const seenBy = afterLastOne || !seen ? undefined : this.t + this.lead + SEEN_MS
    const s: Extract<Step, { k: 'choice' }> = { k: 'choice', until: seenBy ?? end, entries, chose, seen, seenBy, end }
    this.step = s
    if (afterLastOne && this.choiceWaiting(s) === 0) this.applyChoices(entries, chose)
  }

  // 選択を反映する。挑む人は景品を在庫に戻し、まだ出ていない数字で作った 3×3 のカードをもらう。
  // 時間までに選ばなかった人は、受け取る扱い
  private applyChoices(entries: PrizeEntry[], chose: [number, Choice][]): void {
    const g = this.game
    const picked = new Map(chose)
    const challengers: Who[] = []
    const deals = new Map<number, Record<string, unknown>>()
    for (const e of entries) {
      const prize = this.pending.get(e.idx)
      this.pending.delete(e.idx)
      if (!prize) continue
      const wants = this.bots.has(e.idx) ? this.rng.chance(0.25) : picked.get(e.idx) === 'challenge'
      const ch = wants && e.choice?.allowed ? g.startChallenge(e.idx, e.choice.target, this.rng) : null
      if (!ch) {
        this.prizeOf.set(e.idx, { prize, how: e.kind === 'challenge' ? 'challenge' : 'bingo' })
        continue
      }
      this.stock.giveBack(prize)
      challengers.push(this.who(e.idx))
      if (!this.bots.has(e.idx)) deals.set(e.idx, { type: 'challengeDeal', idx: e.idx, cells: ch.cells, target: ch.target })
    }
    if (deals.size) this.send(null, deals, 'players')
    this.send({ type: 'choices', challengers, totals: this.totals() })
    if (deals.size) this.step = { k: 'deal', until: this.t + 3000 }
    else this.endDraw()
  }

  private entry(idx: number, kind: 'normal' | 'challenge', prize: Prize | null, from: Rarity | null, final: boolean, drawsLeft: number, batch: Holds): PrizeEntry {
    if (prize) this.pending.set(idx, prize)
    const look = packLook(prize?.rarity ?? null, this.rng)
    const up = prize && from && RANKS.indexOf(prize.rarity) > RANKS.indexOf(from)
    return {
      idx,
      name: this.game.players[idx].name,
      isMe: false,
      kind,
      rarity: prize?.rarity ?? null,
      prize: prize?.name ?? null,
      glow: look.glow,
      upgrade: look.upgrade,
      rankUp: up ? { from: from!, to: prize!.rarity } : undefined,
      choice: prize ? this.offer(prize.rarity, final, drawsLeft, batch) : undefined,
    }
  }

  // 受け取るか上位チャレンジかの選択。C・R なら SR を、SR なら UR を狙える（UR は最上位なので選択なし）。
  // 出すのは、挑戦中の人と、この回に先に挑戦を出した人（batch）の分を取っておいても、まだ足りるときだけ
  // （全員が成功しても、全員に景品を渡せるように）。出したら batch に足す
  private offer(rarity: Rarity, final: boolean, drawsLeft: number, batch: Holds): ChoiceOffer | undefined {
    const target: Rarity | null = rarity === 'C' || rarity === 'R' ? 'SR' : rarity === 'SR' ? 'UR' : null
    if (!target) return undefined
    if (final) return { allowed: false, target, reason: '最後の回なので、チャレンジはありません' }
    if (!this.stock.hasAtLeast(target)) return { allowed: false, target, reason: '狙える景品が残っていません' }
    const chance = challengeChance(drawsLeft, this.game.remaining().length)
    if (chance < 0.03) return { allowed: false, target, chance, reason: '終盤なので、もう間に合いません' }
    if (!this.stock.canHold(target, rarity, this.game.holds(batch))) return { allowed: false, target, chance, reason: HELD_REASON }
    addHold(batch, target, rarity)
    return { allowed: true, target, chance }
  }

  // 下位の景品が尽きたらゲームは終わり。決着していない上位チャレンジは失敗になる
  private finish(): void {
    const ended = new Map<number, Record<string, unknown>>()
    for (const idx of this.game.activeChallengers()) {
      this.game.endChallenge(idx)
      if (!this.bots.has(idx)) ended.set(idx, { type: 'challengeEnd', idx })
    }
    if (ended.size) this.send(null, ended, 'players')
    this.phase = 'over'
  }

  // ---- ダブルチャンス（ガラポン） ------------------------------------------

  private startDoubleChance(): void {
    const g = this.game
    this.phase = 'dc-entry'
    this.entrants.clear()
    const eligible = g.players.filter((p) => !this.prizeOf.has(p.idx))
    const personal = new Map<number, Record<string, unknown>>()
    for (const p of eligible) if (!this.bots.has(p.idx)) personal.set(p.idx, { meEligible: true })
    this.send({ type: 'dcEntry', seconds: DC_ENTRY_S, eligible: eligible.length, meEligible: false }, personal)
    // 仮想の参加者の 8 割ほどがエントリーする（そっと閉じた人や見ていない人は入らない）
    const bots = eligible.filter((p) => this.bots.has(p.idx) && this.rng.chance(0.85)).map((p) => p.idx)
    // スマホは LEAD の分だけ遅れて動いているので、締め切りぎわのエントリーが届くまで少し待つ
    const tail = personal.size ? this.lead + 500 : 0
    this.step = { k: 'dcEntry', until: this.t + DC_ENTRY_S * 1000 + tail, tick: this.t + 1000, t0: this.t, bots }
  }

  private closeEntry(): void {
    this.phase = 'dc-spin'
    this.send({ type: 'dcEntrants', count: this.entrants.size })
    // 景品は、ダブルチャンス用と、余った上位。玉の数に比例して当たる（ラストワンで外れた人は 3 個）
    const pool = this.rng.shuffle([
      ...this.stock.takeAllUpper().map((p) => ({ prize: p, color: (p.rarity === 'UR' ? 'rainbow' : 'gold') as BallColor })),
      ...this.dcPool.map((p) => ({ prize: p, color: 'red' as BallColor })),
    ])
    const tickets = this.rng.shuffle([...this.entrants].flatMap((i) => Array<number>(this.balls.get(i) ?? 1).fill(i)))
    const won = new Map<number, { prize: Prize; color: BallColor }>()
    for (const t of tickets) {
      if (won.size >= pool.length) break
      if (!won.has(t)) won.set(t, pool[won.size])
    }
    for (const [i, w] of won) this.prizeOf.set(i, { prize: w.prize, how: 'double-chance' })
    const personal = new Map<number, Record<string, unknown>>()
    for (const i of this.entrants) {
      if (this.bots.has(i)) continue
      const count = this.balls.get(i) ?? 1
      const w = won.get(i)
      const winAt = this.rng.int(count)
      const balls: { color: BallColor; prize?: string }[] = []
      for (let b = 0; b < count; b++) balls.push(w && b === winAt ? { color: w.color, prize: w.prize.name } : { color: 'white' })
      personal.set(i, { balls })
    }
    const winners = [...won]
      .map(([i, w]) => ({ ...this.who(i), color: w.color, prize: w.prize.name }))
      .sort((a, b) => COLOR_RANK[a.color] - COLOR_RANK[b.color]) // 大画面では良い景品ほど最後に出す
    this.send({ type: 'dcSpin', balls: [], winners, entrants: this.entrants.size }, personal)
    this.step = { k: 'dcSpin', until: this.t + 9000 + winners.length * 900 }
  }

  // ---- 集計 -----------------------------------------------------------------

  totals(): Totals {
    const g = this.game
    const key = [g.drawCount, g.size, this.stock.lowerLeft, this.stock.upperLeft, g.challengerCount, g.winners.length, this.phase, this.rev].join('/')
    if (key !== this.totalsKey || !this.totalsCache) {
      const all = g.previewAll()
      this.totalsKey = key
      this.totalsCache = {
        size: g.size,
        reachHolders: g.reachHolders(),
        winners: g.winners.length,
        lowerTotal: this.stock.lowerTotal,
        lowerLeft: this.stock.lowerLeft,
        upperTotal: this.stock.upperTotal,
        upperLeft: this.stock.upperLeft,
        challengers: g.challengerCount,
        remaining: all.length,
        hitsLeft: all.filter((i) => i.newBingo > 0).length,
        drawCount: g.drawCount,
        tampered: false,
        phase: this.phase,
      }
    }
    return this.totalsCache
  }
}
