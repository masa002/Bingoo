import { FREE_CELL, LINES, labelOf, popcount, waitingCells } from '../core/card'
import { CH_FREE, CH_LINES, Game, challengeChance, type Impact } from '../core/game'
import { fakeName } from '../core/names'
import { HELD_REASON, PrizeStock, RANKS, addHold, commitHash, doubleChancePrizes, packLook, type Holds, type Prize, type Rarity } from '../core/prizes'
import { Rng } from '../core/rng'
import {
  TIER_NAME,
  allowedPersonal,
  drawTiming,
  personalBeats,
  personalTier,
  pickStyle,
  venueBeats,
  type MachineStyle,
  type PersonalOutcome,
  type Possible,
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

export type EventKind = 'wild' | 'mole' | 'moleMe'

// ペースの調整役のモグラ（緊急クエスト）は、1 ゲームにこの回数まで
const MAX_MOLES = 5
// 参加者の操作が要るイベントの前に出す、説明の画面。司会が説明し終えて「スタート」を押すまで待つ
// （いきなり始めると、何をすればいいか分からないうちに終わってしまう）。自動進行のときは auto で進み、押し忘れても max で進む
const BRIEF = { auto: 10000, max: 60000 } // 説明が出そろうまで約 3 秒かかるので、読む時間を 7 秒ほど残す
// 緊急クエスト「モグラ撃退」の時間割（ms）。説明 → 3・2・1（intro）→ 叩く時間 → 結果（スマホの結果は、やられた人で約 6.3 秒かかる）。
// maxScore は 1 人が叩ける数の上限（10 秒で出るモグラは約 31 匹。届いた数はこの範囲に丸める）
const QUEST = { intro: 3600, play: 10000, grace: 800, result: 7000, maxScore: 40 }
// ラストワン争奪のガラポン。dropAt で全員のスマホの玉が出て、大画面が当たりを発表する
const LAST_ONE = { dropAt: 6500, durationMs: 11000 }

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
  forcedTier: Tier | null = null // 自分のスマホの段階の指定（操作パネル）
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
  private tierNote = '' // スマホの色の指定を通せなかったときの知らせ
  private styles: MachineStyle[] = [] // 最近の抽選機の型（同じ型を 3 回続けない）
  private questScore: ((score: number) => void) | null = null
  private pendingEvent: EventKind | null = null
  private gate: (() => void) | null = null // 説明の画面などで、司会の合図を待っている
  holdLabel = '' // 待っている間の、主催のボタンの名前
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
    this.pendingEvent = null
    this.gate = null
    this.choiceNow = null
    this.entryClose = null
    this.lastEventAt = -10
    this.moles = 0
    this.wilds = 0
    this.styles = []
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
    else if (cmd.type === 'questScore') {
      // 端末から届く数は信用しない（数でなければ 0、範囲の外は丸める）
      const score = Number.isFinite(cmd.score) ? Math.min(QUEST.maxScore, Math.max(0, Math.round(cmd.score))) : 0
      this.questScore?.(score)
    }
    else if (cmd.type === 'choice') this.choiceNow?.(cmd.kind)
    // prizeSeen（景品の発表を見た）は本番のサーバーが使う知らせ。デモでは、自分の選択はいつも待つので、何もしない
    else if (cmd.type === 'entry' && this.phase === 'dc-entry' && !this.entrants.has(0)) {
      this.entrants.add(0)
      this.hub.publish({ type: 'dcEntrants', count: this.entrants.size })
    }
  }

  // 説明の画面を出していて、司会の「スタート」を待っている
  get holding(): boolean {
    return this.gate !== null
  }

  // デモの操作で抽選順を変えた（主催コンソールに出す）
  get isTampered(): boolean {
    return this.tampered
  }

  private async hold(label = 'スタート ▶'): Promise<void> {
    const pressed = new Promise<void>((r) => (this.gate = r))
    this.holdLabel = label
    this.onChange()
    await Promise.race([pressed, this.clock.wait(this.auto ? BRIEF.auto : BRIEF.max)])
    this.gate = null
    this.onChange()
  }

  // 主催の「次へ」。ゲーム中は抽選（またはイベント）、終わったらダブルチャンスへ進む
  async next(): Promise<void> {
    if (!this.game) return
    if (this.gate) return this.gate() // 説明の画面からの「スタート」
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

    const ev = this.pendingEvent ? { kind: this.pendingEvent, ratio: 0.35 } : this.pacingEvent()
    this.pendingEvent = null
    if (ev?.kind === 'wild') await this.runWild()
    else if (ev) await this.runQuest(ev.ratio, ev.kind === 'moleMe', gen)
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

  // ---- イベント（全員確定・モグラ撃退） -------------------------------------

  // ペースの調整役。次の 1 球で景品が一気に減る（残りの 1/3 を超える人数が同時に上がる）ときはモグラでリーチの人の一部を止め、
  // 序盤を過ぎても誰も上がらず、目安より長引きそうなときだけ虹玉で全員を 1 マス進める（虹玉は進行を大きく速めるため）。
  // 手元で試した結果（1000 人・下位 30）: 同時に上がって景品からあふれる人が平均 4.8 人 → 1.6 人、抽選回数は 22 → 24 回
  private pacingEvent(): { kind: EventKind; ratio: number } | null {
    const g = this.game
    const d = g.drawCount
    const left = this.stock.lowerLeft
    if (d < 3 || d - this.lastEventAt < 2 || left <= 0) return null
    if (this.forcedNumber !== null) return null // 操作パネルで番号を指定中は任せる
    if (this.wilds < 1 && d >= 5 && g.winners.length === 0) {
      const projected = d + g.estimateDrawsUntil(left, this.paceRng, 6)
      if (projected > this.target + 3) return { kind: 'wild', ratio: 0 } // 虹玉は ratio を使わない
    }
    if (this.moles >= MAX_MOLES || g.reachHolders() === 0) return null
    const next = g.nextInDeck()
    const burst = next === undefined ? 0 : g.preview(next).newBingo
    const cap = Math.max(2, Math.ceil(left / 3))
    if (burst <= cap) return null
    // 次の回に上がる人が cap 人ほどに収まるくらいの割合で、リーチの人を止める
    return { kind: 'mole', ratio: Math.min(0.85, Math.max(0.35, 1 - cap / burst)) }
  }

  // 全員確定（虹玉）: まだ上がっていない全員のカードで、マスを 1 つ開ける
  private async runWild(): Promise<void> {
    const g = this.game
    this.eventsDone.add('wild')
    this.lastEventAt = g.drawCount
    this.wilds++
    const before = g.me.reach
    const change = g.applyWild(this.rng)
    const cell = change.cells.get(0) ?? null
    const durationMs = 11500
    this.hub.publish({
      type: 'eventPlay',
      durationMs,
      resultAt: 8200,
      total: g.players.filter((p) => p.bingoDraw === null).length,
      newReach: change.newReach,
      newDouble: change.newDouble,
      me: { cell, label: cell === null ? '' : labelOf(g.me.cells[cell]), reachBefore: before, reachAfter: g.me.reach },
      totals: this.totals(),
    })
    await this.clock.wait(durationMs)
  }

  // 緊急クエスト「モグラ撃退」。狙われるのはリーチの人で、ボスモグラがリーチのマスを狙う。
  // 持っているものを失うのは、自分が挑んだ結果としてだけにする: やられる割合（ratio）は景品のペースのために先に決め、
  // 叩いた数が会場全体の下から ratio の割合に入った人がやられる。だから「あと何匹で守れた」は本当の数字になる。
  // forceMe（操作パネル）のときは、リーチでなくても自分を本当に狙わせる（開いたマスがあれば）。
  // スマホには、リーチでない人にもボスモグラを見せる（「狙われていない」と言われたら、叩く理由がなくなるため）。
  // 見せるだけで、リーチでない人のマスは埋めない
  private async runQuest(ratio: number, forceMe: boolean, gen: number): Promise<void> {
    const g = this.game
    this.eventsDone.add('mole')
    this.lastEventAt = g.drawCount
    this.moles++
    const aim = new Map<number, number>() // 本当に狙われた人（叩いた数が下位ならマスを埋められる） → 狙われたマス
    for (const p of g.players) {
      if (p.bingoDraw !== null || (p.reach === 0 && !(forceMe && p.isMe))) continue
      const cell = g.aimMole(p, this.rng)
      if (cell !== null) aim.set(p.idx, cell)
    }
    // 本番では、リーチでない人に見せるマスは、各自のスマホが自分のカードから選べばよい
    const mine0 = aim.has(0) ? { cell: aim.get(0)!, label: labelOf(g.me.cells[aim.get(0)!]) } : this.bluffCell()
    // 先に説明の画面を出して、司会の「スタート」を待つ
    this.hub.publish({
      type: 'questBrief',
      kind: 'mole',
      playMs: QUEST.play,
      targets: aim.size,
      players: g.size,
      autoMs: this.auto ? BRIEF.auto : null,
      me: { target: true, cell: mine0.cell, label: mine0.label },
    })
    await this.hold()
    if (gen !== this.generation) return
    this.hub.publish({
      type: 'questStart',
      kind: 'mole',
      introMs: QUEST.intro,
      playMs: QUEST.play,
      targets: aim.size,
      players: g.size,
      me: { target: true, cell: mine0.cell, label: mine0.label },
    })
    // 仮想参加者の叩いた数（本番では、各スマホが叩き終わったときに 1 回送る）
    const scores = new Map<number, number>()
    for (const p of g.players) if (!p.isMe) scores.set(p.idx, this.botScore())
    let botTotal = 0
    for (const s of scores.values()) botTotal += s
    const mine = new Promise<number>((r) => (this.questScore = r))
    // 叩く時間の終わりは、始まったときの速度で決める（スマホと大画面も同じ決め方。途中で速度を変えても、先に締め切らない）
    const playEnd = this.clock.wait(QUEST.intro + QUEST.play)
    const ticks = Array.from({ length: QUEST.play / 500 }, (_, i) => ({ at: QUEST.intro + (i + 1) * 500, k: (i + 1) / (QUEST.play / 500) }))
    const stopTicks = this.clock.run(ticks, (b) => {
      if (gen !== this.generation) return
      this.hub.publish({ type: 'questProgress', total: Math.round(botTotal * (0.6 * b.k + 0.4 * b.k * b.k)) }) // 後半ほどモグラが多い
    })
    await playEnd
    stopTicks()
    if (gen !== this.generation) return
    // 自分の数が届かなかった（画面が裏に回っていた、など）ときは null。挑んでいないので、
    // やられる側にも、守れる数（bar）の計算にも入れない（失うのは、自分が挑んだ結果としてだけ。本番と同じ）
    const myScore = await Promise.race([mine, this.clock.wait(QUEST.grace).then(() => null)])
    this.questScore = null
    if (gen !== this.generation) return
    if (myScore !== null) scores.set(0, myScore)

    // 守れる数（bar）は、会場全体の叩いた数の下から ratio の割合のところ。狙われた人のうち bar に届かなかった人がやられる。
    // 狙われた人が 1 人でも自分の叩いた数で決まり、狙われた人が多ければ、やられるのはほぼ ratio の割合になる
    const sorted = [...scores.values()].sort((a, b) => a - b)
    const bar = sorted[Math.min(sorted.length - 1, Math.floor(ratio * sorted.length))]
    const losers = new Set([...aim.keys()].filter((idx) => scores.has(idx) && scores.get(idx)! < bar))
    const before = g.me.reach
    let lostReach = 0
    for (const idx of losers) if (g.fillByMole(idx, aim.get(idx)!)) lostReach++
    const need = myScore !== null && losers.has(0) ? bar - myScore : 0
    let rank = myScore === null ? 0 : 1 // 数が届かなかったときは、順位を付けない
    if (myScore !== null) for (const s of scores.values()) if (s > myScore) rank++
    const top = [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([idx, score]) => ({ name: g.players[idx].name, score, isMe: idx === 0 }))
    this.hub.publish({
      type: 'questResult',
      kind: 'mole',
      total: botTotal + (myScore ?? 0),
      targets: aim.size,
      defended: aim.size - losers.size,
      lost: losers.size,
      lostReach,
      top,
      me: { score: myScore ?? 0, target: true, lost: losers.has(0), cell: mine0.cell, need, rank, reachBefore: before, reachAfter: g.me.reach },
      totals: this.totals(),
      resultMs: QUEST.result,
    })
    await this.clock.wait(QUEST.result)
  }

  // リーチでない自分に見せる、ボスモグラが狙うマス（いま見えているカードの開いたマス。上位チャレンジ中は 3×3 のカード）。
  // まだ 1 つも開いていなければ、真ん中の FREE を狙わせる（誰のカードにも必ず狙うマスがある）
  private bluffCell(): { cell: number; label: string } {
    const me = this.game.me
    const ch = me.challenge
    const cells = ch ? ch.cells : me.cells
    const mask = ch ? ch.mask : me.mask
    const open = cells.flatMap((n, c) => (n && mask & (1 << c) ? [c] : []))
    if (!open.length) return { cell: ch ? CH_FREE : FREE_CELL, label: 'FREE' }
    const cell = this.rng.pick(open)
    return { cell, label: labelOf(cells[cell]) }
  }

  // 仮想参加者の叩いた数: 見ていない人が 1 割ほど、なんとなく叩く人（3〜12 匹）、熱心な人（18〜30 匹）。
  // スマホのもぐら叩きは 10 秒で約 31 匹出て、熱心に叩くと 19〜32 匹、なんとなくだと 3〜13 匹になる
  private botScore(): number {
    const r = this.rng.next()
    if (r < 0.12) return 0
    if (r < 0.37) return 3 + this.rng.int(10)
    return 18 + this.rng.int(13)
  }

  // ---- 抽選 -----------------------------------------------------------------

  private async draw(gen: number): Promise<void> {
    const g = this.game
    const all = g.previewAll()
    const lowerLeft = this.stock.lowerLeft
    const deckNext = g.nextInDeck()!
    const imp = all.find((i) => i.n === (this.forcedNumber ?? deckNext))!
    if (imp.n !== deckNext) this.tampered = true
    // この 1 球で下位の景品が尽きるなら、先に知らせる（これは事実の知らせ。期待度の予告ではない）
    const final = imp.newBingo > 0 && imp.newBingo >= lowerLeft
    if (final) {
      this.hub.publish({ type: 'finalBall', prizesLeft: lowerLeft, durationMs: 3800 })
      await this.clock.wait(3800)
      if (gen !== this.generation) return
    }
    const style = pickStyle(this.styles, () => this.rng.next())
    this.styles = [...this.styles.slice(-3), style]
    const t = drawTiming(g.size, imp.newBingo > 0 || imp.challengeIdx.length > 0)
    // 期待度（色）はスマホだけ。大画面は、どの回も同じ調子で回して番号を出す
    const tier = this.myTier(imp, all)
    const personal = { tier, waiting: this.myWaiting(), beats: personalBeats(tier, t.reveal, this.rng) }
    this.forcedNumber = null
    this.forcedTier = null
    const drawNo = g.drawCount + 1
    // 番号は、大画面でも全員のスマホでも同じ瞬間に出る（スマホに先に渡さない）
    this.hub.publish({ type: 'drawScheduled', drawNo, style, revealAt: t.reveal, beats: venueBeats(t.reveal), personal })
    // 操作パネルへの知らせは、抽選が始まってから出す（始まるときに、前の知らせを消しているため）
    if (this.tierNote) this.say(this.tierNote)
    this.tierNote = ''
    await this.clock.wait(t.reveal)
    if (gen !== this.generation) return

    const result = g.apply(imp.n)
    const names = result.bingoIdx.slice(0, 12).map((i) => ({ name: g.players[i].name, isMe: g.players[i].isMe }))
    if (result.me.bingo && !names.some((x) => x.isMe)) names[names.length - 1] = { name: g.me.name, isMe: true }
    this.hub.publish({
      type: 'numberRevealed',
      drawNo,
      n: imp.n,
      label: labelOf(imp.n),
      hits: result.hits,
      newReach: result.newReach,
      moreReach: result.moreReach,
      newBingo: result.newBingo,
      names,
      challengeWins: result.challengeIdx.map((i) => ({ name: g.players[i].name, isMe: i === 0 })),
      totals: this.totals(),
      resultMs: t.result,
    })
    await this.clock.wait(t.result)
    if (gen !== this.generation) return
    if (result.newBingo > 0 || result.challengeIdx.length > 0) await this.prizePhase(result, final, gen)
    if (gen !== this.generation) return
    if (this.stock.lowerLeft === 0 || g.remaining().length === 0) this.finish()
  }

  // 自分のスマホに出す段階。いまのカードで起こりうること（can）の中からだけ選ぶ
  // （カードは本人に見えているので、リーチでない人に金を出すと、うそだと分かる）
  private myTier(imp: Impact, all: Impact[]): Tier {
    const outs = new Set(all.map((i) => this.myOutcome(i)))
    const can: Possible = { hit: outs.has('hit') || outs.has('reach') || outs.has('bingo'), reach: outs.has('reach'), bingo: outs.has('bingo') }
    const outcome = this.myOutcome(imp)
    const wanted = this.forcedTier
    if (wanted !== null) {
      // 操作パネルの指定も、うそにならないときだけ通す（虹は、本当にビンゴになる番号のときだけ）
      if (allowedPersonal(can).includes(wanted) && (wanted !== 4 || outcome === 'bingo')) return wanted
      const why =
        wanted === 4
          ? 'あなたがビンゴになる番号のときだけです（「次でビンゴ」と一緒に使ってください）'
          : wanted === 3
            ? 'あなたがリーチのときだけです（「リーチにする」のあとで使ってください）'
            : 'いまのあなたのカードでは出せません'
      this.tierNote = `スマホの${TIER_NAME[wanted]}は、${why}。自動で選びました`
    }
    return personalTier(outcome, can, this.rng)
  }

  // 自分にとっての次の番号の意味
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
    const labels = me.bingoDraw === null ? waitingCells(me.mask, me.filled).map((c) => labelOf(me.cells[c])) : []
    const ch = me.challenge
    if (ch) {
      for (const line of CH_LINES) {
        const rest = line & ~ch.mask
        if (popcount(rest) === 1) labels.push(labelOf(ch.cells[31 - Math.clz32(rest)]))
      }
    }
    return [...new Set(labels)]
  }

  // ---- 景品 -----------------------------------------------------------------

  private async prizePhase(result: Impact, final: boolean, gen: number): Promise<void> {
    const g = this.game
    const entries: PrizeEntry[] = []
    // この回に挑戦を出した人の分（挑戦中の人の分と合わせて、在庫に取っておく）
    const batch: Holds = { SR: 0, UR: 0, back: 0 }
    // 上位チャレンジの成功者が先（リスクを取った人を優先する）
    for (const idx of this.rng.shuffle([...result.challengeIdx])) {
      const target = g.players[idx].challenge!.target
      g.endChallenge(idx)
      // 挑戦を出すときに取っておいたので、ふつうは target 以上が残っている。それでもなければ、下のランクでも渡す（成功した人を手ぶらにしない）
      const prize = this.stock.takeAtLeast(target) ?? this.stock.takeAtMost(target)
      entries.push(this.entry(idx, 'challenge', prize, target, final, batch))
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
      entries.push(this.entry(idx, 'normal', prize, from, final, batch))
    }
    // 自分が当たっていれば、パックの開封と選択を待つ（スマホから choice が届く）。
    // チャレンジ成功の人はラストワン争奪の演出中に選び終えることもあるので、配る前から受け取れるようにしておく
    const mine = entries.find((e) => e.isMe)
    const choice = mine?.rarity ? new Promise<'receive' | 'challenge'>((r) => (this.choiceNow = r)) : null
    // ラストワン争奪は、同じ回に上がった人がそれぞれスマホでガラポンを回す（結果はくじで、上の並びで決まっている）。
    // 先に説明の画面を出して、司会の「スタート」を待つ
    if (lastOne) {
      const pool = entries.filter((e) => e.kind === 'normal')
      this.hub.publish({
        type: 'lastOneBrief',
        prizes: pool.filter((e) => e.rarity).length,
        entrants: pool.map((e) => ({ name: e.name, isMe: e.isMe })),
        meIn: pool.some((e) => e.isMe),
        autoMs: this.auto ? BRIEF.auto : null,
      })
      await this.hold()
      if (gen !== this.generation) return
    }
    this.hub.publish({ type: 'prizeTime', entries, lastOne: lastOne ? LAST_ONE : null, final })
    if (lastOne) {
      await this.clock.wait(LAST_ONE.durationMs)
      if (gen !== this.generation) return
    }

    let myChoice: 'receive' | 'challenge' = 'receive'
    if (choice) {
      myChoice = await Promise.race([choice, this.clock.wait(40000).then(() => 'receive' as const)])
      this.choiceNow = null
    } else {
      await this.clock.wait(lastOne ? 1500 : 3600)
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

  private entry(idx: number, kind: 'normal' | 'challenge', prize: Prize | null, from: Rarity | null, final: boolean, batch: Holds): PrizeEntry {
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
      choice: prize ? this.offer(prize.rarity, final, batch) : undefined,
    }
  }

  // 受け取るか上位チャレンジかの選択。C・R なら SR を、SR なら UR を狙える（UR は最上位なので選択なし）。
  // 出すのは、挑戦中の人と、この回に先に挑戦を出した人（batch）の分を取っておいても、まだ足りるときだけ
  // （全員が成功しても、全員に景品を渡せるように）。出したら batch に足す
  private offer(rarity: Rarity, final: boolean, batch: Holds): ChoiceOffer | undefined {
    const target: Rarity | null = rarity === 'C' || rarity === 'R' ? 'SR' : rarity === 'SR' ? 'UR' : null
    if (!target) return undefined
    if (final) return { allowed: false, target, reason: '最後の回なので、チャレンジはありません' }
    if (!this.stock.hasAtLeast(target)) return { allowed: false, target, reason: '狙える景品が残っていません' }
    const k = Math.round(this.game.estimateDrawsUntil(this.stock.lowerLeft, this.rng))
    const chance = challengeChance(k, this.game.remaining().length)
    if (chance < 0.03) return { allowed: false, target, chance, reason: '終盤なので、もう間に合いません' }
    if (!this.stock.canHold(target, rarity, this.game.holds(batch))) return { allowed: false, target, chance, reason: HELD_REASON }
    addHold(batch, target, rarity)
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
    // 当選者の一覧は、司会が読み上げ終わるまで出しておく（締めくくりは、主催の合図で）
    await this.hold('締めくくりへ ▶')
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

  // 次の抽選で、自分のスマホに出す段階を指定する
  setForcedTier(t: Tier | null): void {
    this.forcedTier = t
    this.onChange()
  }

  // 次の「次へ」で、全員確定やモグラを起こす
  triggerEvent(kind: EventKind): void {
    if (this.phase !== 'playing' && this.phase !== 'reception') return
    this.pendingEvent = kind
    this.say(kind === 'wild' ? '次の「次へ」で全員確定（虹玉）が起きます' : '次の「次へ」で緊急クエスト「モグラ撃退」が起きます')
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
    const cells = waitingCells(me.mask, me.filled)
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
      if (have >= 5 || line & me.filled) continue // モグラに埋められたマスを含むラインは、もうそろわない
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

  private publishJoined(): void {
    this.hub.publish({ type: 'joined', count: this.botsJoined + (this.joined ? 1 : 0), meJoined: this.joined })
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
