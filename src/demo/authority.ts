import { LINES, labelOf, popcount, waitingCells } from '../core/card'
import { CH_LINES, Game, challengeChance, type Impact } from '../core/game'
import { fakeName } from '../core/names'
import { PrizeStock, RANKS, commitHash, doubleChancePrizes, packLook, type Prize, type Rarity } from '../core/prizes'
import { Rng } from '../core/rng'
import {
  TIER_NAME,
  allowedTiers,
  classify,
  makePlan,
  personalTier,
  pickTier,
  schedule,
  timing,
  type Context,
  type FactClass,
  type PersonalOutcome,
  type Tier,
} from '../core/show'
import type { BallColor } from '../fx/theme'
import type { LocalHub } from '../net/hub'
import type { ChoiceOffer, Phase, PhoneCommand, PrizeEntry, Totals } from '../net/protocol'
import type { Clock } from './clock'

export interface Settings {
  seed: string
  size: number
  lower: number // 下位（C・R）の数
  upper: number // 上位（SR・UR）の数
  dc: number // ダブルチャンス用の数
}

export type HitKind = 'any' | 'hit' | 'gase' // 段階を指定するとき: 新規ビンゴあり／なし
export type EventKind = 'wild' | 'mole' | 'moleMe' | 'moleReach'

// ペースの調整役のモグラは、1 ゲームにこの回数まで
const MAX_MOLES = 5

const COLOR_RANK: Record<BallColor, number> = { white: 0, red: 1, gold: 2, rainbow: 3 }

// デモの権威。本番ではサーバーが同じ役をする（山札・判定・演出計画・景品の割り当て）。
// 画面はこのクラスを直接見ず、hub に流れるメッセージだけで動く（操作パネルだけは例外）
export class DemoAuthority {
  game!: Game
  settings!: Settings
  deckHash = ''
  auto = false
  busy = false
  phase: Phase = 'reception'
  forcedNumber: number | null = null
  forcedTier: Tier | null = null
  forcedKind: HitKind = 'any'
  onChange: () => void = () => {}

  private rng!: Rng
  private paceRng!: Rng // 進み方の見込みの計算用（演出の乱数の並びを変えないように分ける）
  private target = 0 // 下位の景品が尽きるまでの抽選回数の目安
  private stock!: PrizeStock
  private dcPool: Prize[] = []
  private readonly prizeOf = new Map<number, Prize>() // 受け取った景品
  private readonly pending = new Map<number, Prize>() // 選択待ちの景品
  private readonly balls = new Map<number, number>() // ダブルチャンスの玉の数（ラストワンで外れた人は 3）
  private readonly entrants = new Set<number>()
  private readonly eventsDone = new Set<string>()
  private joined = false
  private botsJoined = 0
  private tampered = false
  private generation = 0
  private lastEventAt = -10
  private moles = 0
  private wilds = 0
  private meStopped = false
  private pendingEvent: EventKind | null = null
  private pushNow: (() => void) | null = null
  private choiceNow: ((kind: 'receive' | 'challenge') => void) | null = null
  private entryClose: (() => void) | null = null

  constructor(
    private readonly hub: LocalHub,
    private readonly clock: Clock,
  ) {}

  async newGame(settings: Settings): Promise<void> {
    const gen = ++this.generation
    this.settings = settings
    this.game = new Game(settings, fakeName)
    this.rng = new Rng(`${settings.seed}/show`)
    this.paceRng = new Rng(`${settings.seed}/pace`)
    this.stock = new PrizeStock(settings.lower, settings.upper, new Rng(`${settings.seed}/prizes`))
    // 目安は、何もしなかったときの見込みより少し長め（モグラで一気に減る回をならす分）
    this.target = Math.max(16, Math.round(this.game.estimateDrawsUntil(settings.lower, this.paceRng, 12) * 1.15))
    this.dcPool = doubleChancePrizes(settings.dc)
    for (const m of [this.prizeOf, this.pending, this.balls]) m.clear()
    this.entrants.clear()
    this.eventsDone.clear()
    this.busy = false
    this.phase = 'reception'
    this.joined = false
    this.botsJoined = 0
    this.tampered = false
    this.forcedNumber = null
    this.forcedTier = null
    this.forcedKind = 'any'
    this.pendingEvent = null
    this.pushNow = null
    this.choiceNow = null
    this.entryClose = null
    this.lastEventAt = -10
    this.moles = 0
    this.wilds = 0
    this.deckHash = await commitHash(this.game.deck, this.stock.manifest(), `${settings.seed}/salt`)
    if (gen !== this.generation) return
    const g = this.game
    this.hub.publish({
      type: 'snapshot',
      seed: settings.seed,
      size: g.size,
      me: { idx: 0, cardNo: g.me.cardNo, name: g.me.name },
      drawn: [],
      deckHash: this.deckHash,
      totals: this.totals(),
    })
    this.onChange()
    // 仮想参加者が受付に来る
    const bots = g.size - 1
    for (let i = 1; i <= 20; i++) {
      await this.clock.wait(100)
      if (gen !== this.generation) return
      this.botsJoined = Math.round((bots * i) / 20)
      this.publishJoined()
    }
  }

  command(cmd: PhoneCommand): void {
    if (cmd.type === 'join') this.join()
    else if (cmd.type === 'stop') this.meStopped = true
    else if (cmd.type === 'choice') this.choiceNow?.(cmd.kind)
    else if (this.phase === 'dc-entry' && !this.entrants.has(0)) {
      this.entrants.add(0)
      this.hub.publish({ type: 'dcEntrants', count: this.entrants.size })
    }
  }

  push(): void {
    this.pushNow?.()
  }

  // 主催の「次へ」。ゲーム中は抽選（またはイベント）、終わったらダブルチャンスへ進む
  async next(): Promise<void> {
    if (!this.game) return
    if (this.phase === 'dc-entry') return this.entryClose?.()
    if (this.busy || this.phase === 'dc-spin' || this.phase === 'done') return
    if (this.phase === 'over') return this.doubleChance()
    const gen = this.generation
    const g = this.game
    if (!g.remaining().length) return
    this.busy = true
    if (!this.joined) this.join()
    this.phase = 'playing'
    this.botsJoined = g.size - 1
    this.onChange()

    const ev = this.pendingEvent ? { kind: this.pendingEvent, ratio: 0.15 } : this.pacingEvent()
    this.pendingEvent = null
    if (ev) await this.runEvent(ev.kind, ev.ratio)
    else await this.draw(gen)
    if (gen !== this.generation) return

    this.busy = false
    // phase は draw() の中の finish() で 'over' に変わりうる（型の絞り込みを外すため Phase として読む）
    if ((this.phase as Phase) === 'over') {
      this.hub.publish({ type: 'gameOver', totals: this.totals(), leftoverUpper: this.stock.upperLeft })
    } else {
      this.hub.publish({ type: 'idle', totals: this.totals() })
    }
    this.onChange()
    if (this.auto && this.phase === 'playing') {
      await this.clock.wait(1200)
      if (gen === this.generation && this.auto) void this.next()
    }
  }

  // ---- イベント（全員確定・モグラ） -----------------------------------------

  // ペースの調整役。次の 1 球で景品が一気に減る（残りの 1/3 を超える人数が同時に上がる）ときはモグラでリーチの人の一部を止め、
  // 序盤を過ぎても誰も上がらず、目安より長引きそうなときだけ虹玉で全員を 1 マス進める（虹玉は進行を大きく速めるため）。
  // 手元で試した結果（1000 人・下位 30）: 同時に上がって景品からあふれる人が平均 4.8 人 → 1.6 人、抽選回数は 22 → 24 回
  private pacingEvent(): { kind: EventKind; ratio: number } | null {
    const g = this.game
    const d = g.drawCount
    const left = this.stock.lowerLeft
    if (d < 3 || d - this.lastEventAt < 2 || left <= 0) return null
    if (this.forcedNumber !== null || this.forcedTier !== null) return null // 操作パネルで指定中は任せる
    if (this.wilds < 1 && d >= 5 && g.winners.length === 0) {
      const projected = d + g.estimateDrawsUntil(left, this.paceRng, 6)
      if (projected > this.target + 3) return { kind: 'wild', ratio: 1 }
    }
    if (this.moles >= MAX_MOLES || g.reachHolders() === 0) return null
    const next = g.nextInDeck()
    const burst = next === undefined ? 0 : g.preview(next).newBingo
    const cap = Math.max(2, Math.ceil(left / 3))
    if (burst <= cap) return null
    // 次の回に上がる人が cap 人ほどに収まるくらいの割合で、リーチの人を止める
    return { kind: 'moleReach', ratio: Math.min(0.85, Math.max(0.35, 1 - cap / burst)) }
  }

  private async runEvent(kind: EventKind, ratio: number): Promise<void> {
    const g = this.game
    const wild = kind === 'wild'
    this.eventsDone.add(wild ? 'wild' : 'mole')
    this.lastEventAt = g.drawCount
    if (wild) this.wilds++
    else this.moles++
    const before = g.me.reach
    const change = wild
      ? g.applyWild(this.rng)
      : kind === 'moleReach'
        ? g.applyMole(this.rng, { ratio, onlyReach: true })
        : g.applyMole(this.rng, { ratio, forceMe: kind === 'moleMe' })
    const cell = change.cells.get(0) ?? null
    const durationMs = wild ? 11500 : 7500
    this.hub.publish({
      type: 'eventPlay',
      kind: wild ? 'wild' : 'mole',
      durationMs,
      resultAt: wild ? 8200 : 4600,
      total: g.players.filter((p) => p.bingoDraw === null).length,
      newReach: change.newReach,
      newDouble: change.newDouble,
      hit: change.cells.size,
      lostReach: change.lostReach,
      me: { cell, label: cell === null ? '' : labelOf(g.me.cells[cell]), reachBefore: before, reachAfter: g.me.reach },
      totals: this.totals(),
    })
    await this.clock.wait(durationMs)
  }

  // ---- 抽選 -----------------------------------------------------------------

  private async draw(gen: number): Promise<void> {
    const g = this.game
    const all = g.previewAll()
    const lowerLeft = this.stock.lowerLeft
    const ctx: Context = { size: g.size, winners: g.winners.length, prizeCount: g.winners.length + lowerLeft }
    const pick = this.choose(all, ctx)
    const imp = pick.imp
    // この 1 球で下位の景品が尽きるなら、先に予告して会場の緊張を最大にする
    const final = imp.newBingo > 0 && imp.newBingo >= lowerLeft
    const tier: Tier = final ? 3 : pick.tier
    if (final) {
      this.hub.publish({ type: 'finalBall', prizesLeft: lowerLeft, durationMs: 3800 })
      await this.clock.wait(3800)
      if (gen !== this.generation) return
    }
    const plan = makePlan(tier, this.rng)
    const t = timing(tier, g.size)
    const personal = { tier: personalTier(this.myOutcome(imp), this.rng), waiting: this.myWaiting() }
    this.forcedNumber = null
    this.forcedTier = null
    const drawNo = g.drawCount + 1
    this.hub.publish({ type: 'drawScheduled', drawNo, tier, plan, timing: t, beats: schedule(plan, t), personal })

    // 溜め: 各自のスマホで手元のスロットが回っている（連打でゲージを溜める）
    this.meStopped = false
    await this.clock.wait(t.charge)
    if (gen !== this.generation) return
    // STOP の受付: 本人に番号を渡す。仮想参加者は、連打した人から順にばらばらに止めていく
    this.hub.publish({ type: 'drawOpen', drawNo, n: imp.n })
    const bots = g.size - 1
    const windowMs = t.deadline - t.charge
    for (let elapsed = 0; elapsed < windowMs; elapsed += 250) {
      await this.clock.wait(Math.min(250, windowMs - elapsed))
      if (gen !== this.generation) return
      const k = Math.min(1, (elapsed + 250) / windowMs)
      this.publishStops(drawNo, Math.round((bots * 0.9 * (1 - Math.exp(-4 * k))) / (1 - Math.exp(-4))))
    }
    this.publishStops(drawNo, bots, true) // 押さなかった人も、締め切りで自動で止まる
    // 大画面の答え合わせ
    await this.clock.wait(t.reveal - t.deadline)
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
      cls: pick.cls,
      hits: result.hits,
      newReach: result.newReach,
      moreReach: result.moreReach,
      newBingo: result.newBingo,
      names,
      challengeWins: result.challengeIdx.map((i) => ({ name: g.players[i].name, isMe: i === 0 })),
      totals: this.totals(),
      resultMs: t.total - t.reveal,
    })
    await this.clock.wait(t.total - t.reveal)
    if (gen !== this.generation) return
    if (result.newBingo > 0 || result.challengeIdx.length > 0) await this.prizePhase(result, final, gen)
    if (gen !== this.generation) return
    if (this.stock.lowerLeft === 0 || g.remaining().length === 0) this.finish()
  }

  // 自分にとっての次の番号の意味（手元のあおりの段階を決める）
  private myOutcome(imp: Impact): PersonalOutcome {
    const me = this.game.me
    if (imp.me.bingo || imp.me.challenge) return 'bingo'
    if (imp.me.reach) return 'reach'
    const hitMain = imp.me.hit && me.bingoDraw === null
    const hitChallenge = me.challenge?.cells.includes(imp.n) ?? false
    return hitMain || hitChallenge ? 'hit' : 'none'
  }

  private myWaiting(): string[] {
    const me = this.game.me
    const labels = me.bingoDraw === null ? waitingCells(me.mask).map((c) => labelOf(me.cells[c])) : []
    const ch = me.challenge
    if (ch) {
      for (const line of CH_LINES) {
        const rest = line & ~ch.mask
        if (popcount(rest) === 1) labels.push(labelOf(ch.cells[31 - Math.clz32(rest)]))
      }
    }
    return [...new Set(labels)]
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

  // ---- 景品 -----------------------------------------------------------------

  private async prizePhase(result: Impact, final: boolean, gen: number): Promise<void> {
    const g = this.game
    const entries: PrizeEntry[] = []
    // 上位チャレンジの成功者が先（リスクを取った人を優先する）
    for (const idx of this.rng.shuffle([...result.challengeIdx])) {
      const target = g.players[idx].challenge!.target
      g.endChallenge(idx)
      entries.push(this.entry(idx, 'challenge', this.stock.takeAtLeast(target), target, final))
    }
    // 通常のビンゴ。同じ回の当選者の並びは乱数で決める（参加順だと早く参加した人が有利になる）。
    // 下位が足りなければ 1 つ上のランクへ。上まで全部なくなったときだけラストワン争奪で外れる
    let lastOne = false
    for (const idx of this.rng.shuffle([...result.bingoIdx])) {
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
      entries.push(this.entry(idx, 'normal', prize, from, final))
    }
    this.hub.publish({ type: 'prizeTime', entries, lastOne, final })

    // 自分が当たっていれば、パックの開封と選択を待つ（スマホから choice が届く）
    const mine = entries.find((e) => e.isMe)
    let myChoice: 'receive' | 'challenge' = 'receive'
    if (mine?.rarity) {
      myChoice = await Promise.race([
        new Promise<'receive' | 'challenge'>((r) => (this.choiceNow = r)),
        this.clock.wait(40000).then(() => 'receive' as const),
      ])
      this.choiceNow = null
    } else {
      await this.clock.wait(lastOne ? 7000 : 3600)
    }
    if (gen !== this.generation) return

    // 選択を反映する。挑む人は景品を在庫に戻し、まだ出ていない数字で作った 3×3 のカードをもらう
    const challengers: { name: string; isMe: boolean }[] = []
    for (const e of entries) {
      const prize = this.pending.get(e.idx)
      this.pending.delete(e.idx)
      if (!prize) continue
      const wants = e.isMe ? myChoice === 'challenge' : this.rng.chance(0.25)
      const ch = wants && e.choice?.allowed ? g.startChallenge(e.idx, e.choice.target, this.rng) : null
      if (!ch) {
        this.prizeOf.set(e.idx, prize)
        continue
      }
      this.stock.giveBack(prize)
      challengers.push({ name: e.name, isMe: e.isMe })
      if (e.isMe) this.hub.publish({ type: 'challengeDeal', idx: 0, cells: ch.cells, target: ch.target })
    }
    this.hub.publish({ type: 'choices', challengers, totals: this.totals() })
    if (challengers.some((c) => c.isMe)) await this.clock.wait(3000)
  }

  private entry(idx: number, kind: 'normal' | 'challenge', prize: Prize | null, from: Rarity | null, final: boolean): PrizeEntry {
    const p = this.game.players[idx]
    if (prize) this.pending.set(idx, prize)
    const look = packLook(prize?.rarity ?? null, this.rng)
    const up = prize && from && RANKS.indexOf(prize.rarity) > RANKS.indexOf(from)
    return {
      idx,
      name: p.name,
      isMe: p.isMe,
      kind,
      rarity: prize?.rarity ?? null,
      prize: prize?.name ?? null,
      glow: look.glow,
      upgrade: look.upgrade,
      rankUp: up ? { from: from!, to: prize!.rarity } : undefined,
      choice: prize ? this.offer(prize.rarity, final) : undefined,
    }
  }

  // 受け取るか上位チャレンジかの選択。C・R なら SR を、SR なら UR を狙える（UR は最上位なので選択なし）
  private offer(rarity: Rarity, final: boolean): ChoiceOffer | undefined {
    const target: Rarity | null = rarity === 'C' || rarity === 'R' ? 'SR' : rarity === 'SR' ? 'UR' : null
    if (!target) return undefined
    if (final) return { allowed: false, target, reason: '最後の回なので、チャレンジはありません' }
    if (!this.stock.hasAtLeast(target)) return { allowed: false, target, reason: '狙える景品が残っていません' }
    const k = Math.round(this.game.estimateDrawsUntil(this.stock.lowerLeft, this.rng))
    const chance = challengeChance(k, this.game.remaining().length)
    if (chance < 0.03) return { allowed: false, target, chance, reason: '終盤なので、もう間に合いません' }
    return { allowed: true, target, chance }
  }

  // 下位の景品が尽きたらゲームは終わり。決着していない上位チャレンジは失敗になる
  private finish(): void {
    for (const idx of this.game.activeChallengers()) {
      this.game.endChallenge(idx)
      if (idx === 0) this.hub.publish({ type: 'challengeEnd', idx })
    }
    this.phase = 'over'
  }

  // ---- ダブルチャンス（ガラポン） ------------------------------------------

  private async doubleChance(): Promise<void> {
    const gen = this.generation
    const g = this.game
    this.busy = true
    this.phase = 'dc-entry'
    this.onChange()
    const eligible = g.players.filter((p) => !this.prizeOf.has(p.idx)).map((p) => p.idx)
    this.entrants.clear()
    this.hub.publish({ type: 'dcEntry', seconds: 30, eligible: eligible.length, meEligible: eligible.includes(0) })
    // 仮想参加者の 8 割ほどが、受付の前半にエントリーする（そっと閉じた人や見ていない人は入らない）
    const bots = eligible.filter((i) => i !== 0 && this.rng.chance(0.85))
    let closed = false
    const close = new Promise<void>((r) => (this.entryClose = () => ((closed = true), r())))
    for (let s = 1; s <= 30 && !closed; s++) {
      await Promise.race([this.clock.wait(1000), close])
      if (gen !== this.generation) return
      const want = Math.round(bots.length * Math.min(1, s / 12))
      for (const i of bots.slice(0, want)) this.entrants.add(i)
      this.hub.publish({ type: 'dcEntrants', count: this.entrants.size })
    }
    this.entryClose = null
    this.phase = 'dc-spin'
    this.onChange()

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
    for (const [i, w] of won) this.prizeOf.set(i, w.prize)

    const myBalls: { color: BallColor; prize?: string }[] = []
    if (this.entrants.has(0)) {
      const count = this.balls.get(0) ?? 1
      const w = won.get(0)
      const winAt = this.rng.int(count)
      for (let i = 0; i < count; i++) myBalls.push(w && i === winAt ? { color: w.color, prize: w.prize.name } : { color: 'white' })
    }
    const winners = [...won]
      .map(([i, w]) => ({ name: g.players[i].name, color: w.color, prize: w.prize.name, isMe: i === 0 }))
      .sort((a, b) => COLOR_RANK[a.color] - COLOR_RANK[b.color]) // 大画面では良い景品ほど最後に出す
    this.hub.publish({ type: 'dcSpin', balls: myBalls, winners, entrants: this.entrants.size })
    await this.clock.wait(9000 + winners.length * 900)
    if (gen !== this.generation) return
    this.hub.publish({ type: 'dcEnd' })
    this.phase = 'done'
    this.busy = false
    this.onChange()
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

  // 次の「次へ」で、全員確定やモグラを起こす
  triggerEvent(kind: EventKind): void {
    if (this.phase !== 'playing' && this.phase !== 'reception') return
    this.pendingEvent = kind
    this.say(kind === 'wild' ? '次の「次へ」で全員確定（虹玉）が起きます' : '次の「次へ」でモグラが出ます')
    this.onChange()
  }

  // 静かに N 回進める。ビンゴが出る回は演出で見せたいので、その手前で止める
  fastForward(k: number): void {
    if (this.busy || this.phase === 'over' || this.phase.startsWith('dc') || this.phase === 'done') return
    const g = this.game
    const numbers: number[] = []
    for (let i = 0; i < k; i++) {
      const n = g.nextInDeck()
      if (n === undefined) break
      const imp = g.preview(n)
      if (imp.newBingo > 0 || imp.challengeIdx.length > 0) {
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
    if (this.busy || this.phase !== 'playing') return this.say('抽選が始まってから使えます（「次へ」を 1 回押してください）')
    const g = this.game
    const me = g.me
    if (me.bingoDraw !== null) return this.say('あなたはもう上がっています')
    const numbers: number[] = []
    for (let guard = 0; guard < 12 && me.reach === 0; guard++) {
      const n = this.numbersForMe().find((x) => {
        const imp = g.preview(x)
        return imp.newBingo === 0 && imp.challengeIdx.length === 0
      })
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
    if (me.challenge) {
      const ch = me.challenge
      const line = CH_LINES.find((l) => popcount(l & ~ch.mask) === 1)
      if (line === undefined) return this.say('チャレンジカードはまだリーチではありません')
      this.forcedNumber = ch.cells[31 - Math.clz32(line & ~ch.mask)]
      this.say(`次は ${labelOf(this.forcedNumber)}（あなたのチャレンジ成功の番号）を出します`)
      return this.onChange()
    }
    if (me.bingoDraw !== null) return this.say('あなたはもう上がっています')
    const cells = waitingCells(me.mask)
    if (!cells.length) return this.say('まだリーチではありません。先に「リーチにする」を押してください')
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

  private join(): void {
    if (this.joined || !this.game) return
    this.joined = true
    this.publishJoined()
  }

  private publishBulk(numbers: number[]): void {
    if (numbers.length) this.hub.publish({ type: 'bulkDrawn', numbers, totals: this.totals() })
    this.onChange()
  }

  private publishStops(drawNo: number, bots: number, all = false): void {
    const total = this.game.size
    this.hub.publish({ type: 'stopCount', drawNo, count: all ? total : bots + (this.meStopped ? 1 : 0), total })
  }

  private publishJoined(): void {
    this.hub.publish({ type: 'joined', count: this.botsJoined + (this.joined ? 1 : 0) })
  }

  private say(text: string): void {
    this.hub.publish({ type: 'notice', text })
  }

  totals(): Totals {
    const g = this.game
    const all = g.previewAll()
    return {
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
      tampered: this.tampered,
      phase: this.phase,
    }
  }
}
