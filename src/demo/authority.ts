import { LINES, labelOf, popcount, waitingCells } from '../core/card'
import { Game, type Impact } from '../core/game'
import { fakeName } from '../core/names'
import { commitHash, makePrizes, packLook, type Prize } from '../core/prizes'
import { Rng } from '../core/rng'
import {
  TIER_NAME,
  allowedTiers,
  classify,
  makePlan,
  personalNotice,
  pickTier,
  schedule,
  timing,
  type Context,
  type FactClass,
  type Tier,
} from '../core/show'
import type { LocalHub } from '../net/hub'
import type { PrizeEntry, Totals } from '../net/protocol'
import type { Clock } from './clock'

export interface Settings {
  seed: string
  size: number
  prizeCount: number
}

export type HitKind = 'any' | 'hit' | 'gase' // 段階を指定するとき: 新規ビンゴあり／なし

// デモの権威。本番ではサーバーが同じ役をする（山札・判定・演出計画・景品の割り当て）。
// 画面はこのクラスを直接見ず、hub に流れるメッセージだけで動く（操作パネルだけは例外）
export class DemoAuthority {
  game!: Game
  settings!: Settings
  deckHash = ''
  auto = false
  busy = false
  over = false
  forcedNumber: number | null = null
  forcedTier: Tier | null = null
  forcedKind: HitKind = 'any'
  onChange: () => void = () => {}

  private rng!: Rng
  private prizes: Prize[] = []
  private prizeCursor = 0
  private joined = false
  private botsJoined = 0
  private tampered = false
  private generation = 0
  private pushNow: (() => void) | null = null
  private packNow: (() => void) | null = null

  constructor(
    private readonly hub: LocalHub,
    private readonly clock: Clock,
  ) {}

  async newGame(settings: Settings): Promise<void> {
    const gen = ++this.generation
    this.settings = settings
    this.game = new Game(settings, fakeName)
    this.rng = new Rng(`${settings.seed}/show`)
    this.prizes = makePrizes(settings.prizeCount, new Rng(`${settings.seed}/prizes`))
    this.prizeCursor = 0
    this.busy = false
    this.over = false
    this.joined = false
    this.botsJoined = 0
    this.tampered = false
    this.forcedNumber = null
    this.forcedTier = null
    this.forcedKind = 'any'
    this.pushNow = null
    this.packNow = null
    this.deckHash = await commitHash(this.game.deck, this.prizes, `${settings.seed}/salt`)
    if (gen !== this.generation) return
    this.publishSnapshot('reception')
    this.onChange()
    // 仮想参加者が受付に来る
    const bots = this.game.size - 1
    for (let i = 1; i <= 20; i++) {
      await this.clock.wait(100)
      if (gen !== this.generation) return
      this.botsJoined = Math.round((bots * i) / 20)
      this.publishJoined()
    }
  }

  join(): void {
    if (this.joined || !this.game) return
    this.joined = true
    this.publishJoined()
  }

  push(): void {
    this.pushNow?.()
  }

  openPack(): void {
    this.packNow?.()
  }

  async next(): Promise<void> {
    if (this.busy || this.over || !this.game) return
    const gen = this.generation
    const g = this.game
    if (g.remaining().length === 0) return
    this.busy = true
    if (!this.joined) this.join()
    this.botsJoined = g.size - 1
    this.onChange()

    const all = g.previewAll()
    const ctx: Context = { size: g.size, winners: g.winners.length, prizeCount: this.prizes.length }
    const { imp, cls, tier } = this.choose(all, ctx)
    const plan = makePlan(tier, this.rng)
    const t = timing(tier, g.size)
    const meReach = g.me.bingoDraw === null ? g.me.reach : 0
    const notice = personalNotice(imp, meReach, this.rng)
    this.forcedNumber = null
    this.forcedTier = null
    const drawNo = g.drawCount + 1
    this.hub.publish({ type: 'drawScheduled', drawNo, tier, plan, timing: t, beats: schedule(plan, t), notice })

    await this.clock.wait(t.reveal)
    if (gen !== this.generation) return
    if (t.push) {
      this.hub.publish({ type: 'awaitPush', drawNo, ms: 3000 })
      await Promise.race([new Promise<void>((r) => (this.pushNow = r)), this.clock.wait(3000)])
      this.pushNow = null
      if (gen !== this.generation) return
    }

    const result = g.apply(imp.n)
    const names = result.bingoIdx.slice(0, 12).map((i) => ({ name: g.players[i].name, isMe: g.players[i].isMe }))
    if (result.me.bingo && !names.some((x) => x.isMe)) names[names.length - 1] = { name: g.me.name, isMe: true }
    this.hub.publish({
      type: 'numberRevealed',
      drawNo,
      n: imp.n,
      label: labelOf(imp.n),
      tier,
      cls,
      hits: result.hits,
      newReach: result.newReach,
      moreReach: result.moreReach,
      newBingo: result.newBingo,
      names,
      totals: this.totals(),
      resultMs: t.total - t.reveal,
    })
    await this.clock.wait(t.total - t.reveal)
    if (gen !== this.generation) return
    if (result.newBingo > 0) await this.prizePhase(result.bingoIdx, gen)
    if (gen !== this.generation) return

    this.busy = false
    if (this.prizeCursor >= this.prizes.length || g.remaining().length === 0) {
      this.over = true
      this.hub.publish({ type: 'gameOver', totals: this.totals() })
    } else {
      this.hub.publish({ type: 'idle', totals: this.totals() })
    }
    this.onChange()
    if (this.auto && !this.over) {
      await this.clock.wait(1200)
      if (gen === this.generation && this.auto) void this.next()
    }
  }

  // 次の番号と段階を決める。段階を指定された場合も、その段階を正直に出せる番号だけを使う
  private choose(all: Impact[], ctx: Context): { imp: Impact; cls: FactClass; tier: Tier } {
    const g = this.game
    const byN = new Map(all.map((i) => [i.n, i]))
    const classOf = (imp: Impact) => classify(imp, all, ctx)
    const deckNext = g.nextInDeck()!
    let imp = byN.get(this.forcedNumber ?? deckNext)!
    const wanted = this.forcedTier
    if (wanted !== null) {
      const fits = (i: Impact) =>
        allowedTiers(classOf(i)).includes(wanted) &&
        (this.forcedKind === 'any' || (this.forcedKind === 'hit') === i.newBingo > 0)
      if (!fits(imp)) {
        const alt = g.remaining().map((n) => byN.get(n)!).find(fits)
        if (!alt) {
          this.say(`いまの盤面では${TIER_NAME[wanted]}を出せる番号がありません。自動で選びます`)
        } else {
          if (this.forcedNumber !== null) this.say(`指定の番号では${TIER_NAME[wanted]}を出せないので、${labelOf(alt.n)} にしました`)
          imp = alt
        }
      }
      if (fits(imp)) {
        if (imp.n !== deckNext) this.tampered = true
        return { imp, cls: classOf(imp), tier: wanted }
      }
    }
    if (imp.n !== deckNext) this.tampered = true
    const cls = classOf(imp)
    return { imp, cls, tier: pickTier(cls, this.rng) }
  }

  private async prizePhase(newWinners: number[], gen: number): Promise<void> {
    const g = this.game
    const left = this.prizes.length - this.prizeCursor
    if (left <= 0) return
    // 同じ回の当選者の並びは乱数で決める（参加順だと早く参加した人が有利になる）
    const order = this.rng.shuffle([...newWinners])
    const entries: PrizeEntry[] = order.map((idx, i) => {
      const p = g.players[idx]
      const prize = i < left ? this.prizes[this.prizeCursor + i] : null
      const look = prize ? packLook(prize.rarity, this.rng) : { glow: 'white' as const, edge: 'silver' as const, upgrade: false }
      return {
        idx,
        name: p.name,
        isMe: p.isMe,
        rarity: prize?.rarity ?? null,
        prize: prize?.name ?? null,
        glow: look.glow,
        edge: look.edge,
        upgrade: look.upgrade,
        lastOne: prize !== null && this.prizeCursor + i === this.prizes.length - 1,
        code: String(1000 + this.rng.int(9000)),
      }
    })
    this.prizeCursor += Math.min(left, order.length)
    this.hub.publish({ type: 'prizeTime', entries, overflow: order.length > left, left })
    await this.clock.wait(3600)
    if (gen !== this.generation) return

    const mine = entries.find((e) => e.isMe)
    if (mine) {
      // 自分のパックは自分で開ける（10 秒たったら自動で開く）
      await Promise.race([new Promise<void>((r) => (this.packNow = r)), this.clock.wait(10000)])
      this.packNow = null
      if (gen !== this.generation) return
      this.hub.publish({ type: 'packOpened', idx: mine.idx })
      await this.clock.wait(mine.rarity === 'UR' ? 5200 : mine.rarity === 'SR' ? 3200 : 2000)
      if (gen !== this.generation) return
    }
    const spot = entries.filter((e) => !e.isMe && (e.rarity === 'SR' || e.rarity === 'UR')).slice(0, 4)
    if (spot.length) {
      this.hub.publish({ type: 'prizeSpotlight', entries: spot })
      await this.clock.wait(spot.length * 4600 + 400)
      if (gen !== this.generation) return
    }
    this.hub.publish({ type: 'prizeEnd' })
    await this.clock.wait(500)
  }

  // ---- 操作パネル（デモ専用）から使う --------------------------------------

  setForcedNumber(n: number | null): void {
    this.forcedNumber = n
    this.onChange()
  }

  setForcedTier(t: Tier | null, kind: HitKind): void {
    this.forcedTier = t
    this.forcedKind = kind
    this.onChange()
  }

  // 静かに N 回進める。ビンゴが出る回は演出で見せたいので、その手前で止める
  fastForward(k: number): void {
    if (this.busy || this.over) return
    const g = this.game
    const numbers: number[] = []
    for (let i = 0; i < k; i++) {
      const n = g.nextInDeck()
      if (n === undefined) break
      if (g.preview(n).newBingo > 0) {
        this.say('次の番号でビンゴが出るので、その手前で止めました')
        break
      }
      g.apply(n)
      numbers.push(n)
    }
    this.publishBulk(numbers)
  }

  meHitNext(): void {
    const g = this.game
    const n = g.me.cells.find((x) => x && !g.isDrawn(x))
    if (n) {
      this.forcedNumber = n
      this.say(`次は ${labelOf(n)}（あなたのカードにある番号）を出します`)
    }
    this.onChange()
  }

  // 自分のカードで一番そろっているラインの番号を、静かに出してリーチにする
  meToReach(): void {
    if (this.busy || this.over) return
    const g = this.game
    const me = g.me
    if (me.bingoDraw !== null) return this.say('あなたはもう上がっています')
    const numbers: number[] = []
    for (let guard = 0; guard < 12 && me.reach === 0; guard++) {
      const n = this.numbersForMe().find((x) => g.preview(x).newBingo === 0)
      if (n === undefined) break
      g.apply(n)
      numbers.push(n)
    }
    if (numbers.length) this.tampered = true
    if (me.reach === 0) this.say('ほかの人がビンゴになる番号しか残っていないため、リーチまで進められませんでした')
    this.publishBulk(numbers)
  }

  meBingoNext(): void {
    const me = this.game.me
    if (me.bingoDraw !== null) return this.say('あなたはもう上がっています')
    const cells = waitingCells(me.mask)
    if (!cells.length) return this.say('まだリーチではありません。先に「自分をリーチに」を押してください')
    this.forcedNumber = me.cells[cells[0]]
    this.say(`次は ${labelOf(this.forcedNumber)}（あなたのビンゴ番号）を出します`)
    this.onChange()
  }

  private numbersForMe(): number[] {
    const g = this.game
    const me = g.me
    const scored: { n: number; score: number }[] = []
    for (const line of LINES) {
      const have = popcount(me.mask & line)
      if (have >= 5) continue
      for (let cell = 0; cell < 25; cell++) {
        if (line & (1 << cell) && !(me.mask & (1 << cell))) scored.push({ n: me.cells[cell], score: have })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return [...new Set(scored.map((s) => s.n))].filter((n) => !g.isDrawn(n))
  }

  previewAll(): Impact[] {
    return this.game ? this.game.previewAll() : []
  }

  // ---- 配信 ---------------------------------------------------------------

  private publishBulk(numbers: number[]): void {
    if (numbers.length) this.hub.publish({ type: 'bulkDrawn', numbers, totals: this.totals() })
    this.onChange()
  }

  private publishSnapshot(phase: 'reception' | 'playing' | 'over'): void {
    const g = this.game
    this.hub.publish({
      type: 'snapshot',
      seed: this.settings.seed,
      size: g.size,
      prizeCount: this.prizes.length,
      me: { idx: 0, cardNo: g.me.cardNo, name: g.me.name },
      drawn: [...g.drawn],
      deckHash: this.deckHash,
      totals: this.totals(),
      phase,
    })
  }

  private publishJoined(): void {
    this.hub.publish({ type: 'joined', count: this.botsJoined + (this.joined ? 1 : 0) })
  }

  private say(text: string): void {
    this.hub.publish({ type: 'notice', text })
  }

  private totals(): Totals {
    const g = this.game
    const all = g.previewAll()
    return {
      size: g.size,
      reachHolders: g.reachHolders(),
      winners: g.winners.length,
      prizeCount: this.prizes.length,
      prizesLeft: this.prizes.length - this.prizeCursor,
      remaining: all.length,
      hitsLeft: all.filter((i) => i.newBingo > 0).length,
      drawCount: g.drawCount,
      tampered: this.tampered,
    }
  }
}
