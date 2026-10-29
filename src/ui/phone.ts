import { FREE_MASK, bingoCells, deriveCard, labelOf, lineState, popcount, waitingCells } from '../core/card'
import { CH_FREE, CH_LINES, challengeBingo } from '../core/game'
import type { Rarity } from '../core/prizes'
import type { Clock } from '../demo/clock'
import { playBingo, playMoleResult, playReach, playWildResult, type AoriOutcome } from '../fx/phone/aori'
import { CardView } from '../fx/phone/card'
import { askEntry, playGarapon } from '../fx/phone/garapon'
import { askChoice, playChallengeResult, playChallengeStart, playPackOpen } from '../fx/phone/prize'
import { HandSpin } from '../fx/phone/spin'
import type { LocalHub } from '../net/hub'
import type { Msg, MsgOf, PhoneCommand, PrizeEntry } from '../net/protocol'
import { esc, fit, fmt, h, q, replay } from './dom'

// 参加者のスマホ（390×844 で組んで縮小表示する）。カード・手元のスロット・景品・ガラポンの演出は fx/ の部品。
// 自分のカードはシードとカード番号から手元で作り、届いた番号で自分で塗る（本番と同じ）。
// 抽選のたびに手元のスロットを回し、STOP で自分の番号を開ける。大画面はそのあとで答え合わせをする

const PHONE_HTML = `
<div class="ph-status"><span class="ph-time">9:41</span><span>●●● 100%</span></div>
<div class="ph-head"><div><b class="ph-name">あなた</b><small class="ph-no"></small></div><div class="ph-count"></div></div>
<div class="ph-chips"><div class="ph-wait"></div></div>
<div class="ph-cardhost"></div>
<div class="ph-latest"><small>最新の番号</small><b>--</b></div>
<div class="ph-sub"><div class="ph-history"></div></div>
<div class="ph-toast"></div>
<div class="ph-overlay"></div>
`

interface MyChallenge {
  cells: number[]
  mask: number
  target: Rarity
  view: CardView
}

// 開けた番号が自分のカードにとって何だったか（手元で計算する）
interface Judge {
  n: number
  outcome: AoriOutcome
  cell: number // 本カードのマス（なければ -1）
  chCell: number // チャレンジカードのマス（なければ -1）
  reachBefore: number
  reachAfter: number
  justWon: boolean
  chWon: boolean
}

export class PhoneView {
  private readonly root: HTMLDivElement
  private readonly card: CardView
  private readonly spin: HandSpin
  private cells: number[] = []
  private mask = FREE_MASK
  private filled = 0
  private wild = 0
  private won = false
  private joined = false
  private rank = 0
  private name = 'あなた'
  private cardNo = 0
  private history: number[] = []
  private stats = { hits: 0, maxReach: 0, nearMiss: 0, won: undefined as string | undefined }
  private challenge: MyChallenge | null = null
  private generation = 0
  // いまの抽選。番号（drawOpen）と大画面の答え合わせ（numberRevealed）を、手元の流れに渡す
  private drawNo = 0
  private spinning = false
  private gotNumber: ((n: number) => void) | null = null
  private gotReveal: ((m: MsgOf<'numberRevealed'>) => void) | null = null
  private celebration: Promise<void> = Promise.resolve() // 当たりの演出が終わるまで（景品パックはその後に出す）

  constructor(
    host: HTMLElement,
    hub: LocalHub,
    private readonly clock: Clock,
    private readonly send: (cmd: PhoneCommand) => void,
  ) {
    // 画面の中身がちょうど 390×844 になるように、枠は外側の要素で描く
    const frame = h('div', 'phone-frame')
    this.root = h('div', 'phone', PHONE_HTML)
    frame.append(this.root)
    host.append(frame)
    fit(frame, 410, 864)
    this.card = new CardView(this.$('.ph-cardhost'), { size: 5, speed: clock.speed })
    this.spin = new HandSpin(this.root, { speed: clock.speed })
    hub.subscribe((m) => this.on(m))
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return q<T>(this.root, selector)
  }

  private get speed(): number {
    return this.clock.speed
  }

  private on(m: Msg): void {
    switch (m.type) {
      case 'snapshot':
        return this.onSnapshot(m)
      case 'joined':
        this.$('.ph-count').textContent = `参加 ${fmt(m.count)}人`
        return
      case 'eventPlay':
        if (!this.joined) this.join()
        return this.onEvent(m)
      case 'drawScheduled':
        if (!this.joined) this.join() // 受付を締め切ったら自動で参加する
        this.syncSpeed()
        void this.playDraw(m)
        return
      case 'drawOpen':
        if (m.drawNo === this.drawNo) {
          this.spin.open(m.n)
          this.gotNumber?.(m.n)
        }
        return
      case 'numberRevealed':
        return this.onRevealed(m)
      case 'bulkDrawn':
        return this.onBulk(m.numbers)
      case 'prizeTime': {
        const mine = m.entries.find((e) => e.isMe)
        if (mine) void this.onMyPrize(mine)
        return
      }
      case 'challengeDeal':
        void this.onChallengeDeal(m)
        return
      case 'challengeEnd':
        void this.onChallengeEnd()
        return
      case 'gameOver':
        this.toast('景品がなくなりました。このあとダブルチャンスです')
        return
      case 'dcEntry':
        void this.onDcEntry(m)
        return
      case 'dcSpin':
        void this.onDcSpin(m)
        return
      default:
        return
    }
  }

  private syncSpeed(): void {
    this.card.setSpeed(this.speed)
    this.spin.setSpeed(this.speed)
    this.challenge?.view.setSpeed(this.speed)
  }

  // ---- 参加とカード ---------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.generation++
    this.spin.cancel()
    this.spinning = false
    this.drawNo = 0
    this.gotNumber = null
    this.gotReveal = null
    this.celebration = Promise.resolve()
    // 前のゲームで残った景品・ガラポンの画面を片付ける
    this.root.querySelectorAll('.fxg, .fxp').forEach((n) => n.remove())
    this.clearChallenge()
    this.name = m.me.name
    this.cardNo = m.me.cardNo
    this.cells = deriveCard(m.seed, m.me.cardNo)
    this.mask = FREE_MASK
    this.filled = 0
    this.wild = 0
    this.won = false
    this.rank = 0
    this.history = []
    this.stats = { hits: 0, maxReach: 0, nearMiss: 0, won: undefined }
    this.joined = false
    this.$('.ph-name').textContent = this.name
    this.$('.ph-no').textContent = `No.${String(this.cardNo).padStart(5, '0')}`
    this.$('.ph-count').textContent = '参加 0人'
    this.$('.ph-latest b').textContent = '--'
    this.syncSpeed()
    this.card.setCells(this.cells)
    this.renderCard()
    this.renderHistory()
    this.overlay(`
      <div class="ph-join">
        <div class="ph-logo">BINGOO</div>
        <p>社内ビンゴ大会へようこそ</p>
        <button class="ph-join-btn">参加する</button>
        <small>デモでは、あなた以外の ${fmt(m.size - 1)} 人は仮想の参加者です</small>
      </div>`)
    q(this.root, '.ph-join-btn').addEventListener('click', () => this.join())
  }

  private join(): void {
    if (this.joined) return
    this.joined = true
    this.send({ type: 'join' })
    this.closeOverlay()
    void this.card.deal()
  }

  private renderCard(): void {
    const bits = (x: number) => [...Array(25).keys()].filter((i) => x & (1 << i))
    this.card.setMarks(this.mask, {
      waiting: this.won ? [] : waitingCells(this.mask),
      line: bingoCells(this.mask),
      filled: bits(this.filled),
      wild: bits(this.wild & this.mask),
    })
    this.renderChip()
  }

  // カードの上の帯: リーチの「あと〇〇」、上がったら順位、上位チャレンジ中はそのリーチ
  private renderChip(): void {
    const el = this.$('.ph-wait')
    const lines = lineState(this.mask).reach
    const ch = this.challenge
    if (ch) {
      const rest = challengeWaiting(ch.mask).map((c) => labelOf(ch.cells[c]))
      el.className = rest.length ? 'ph-wait on chal' : 'ph-wait chal'
      el.textContent = `上位チャレンジ（${ch.target} を狙う）${rest.length ? `　あと ${rest.join('・')}` : ''}`
    } else if (this.won) {
      el.className = 'ph-wait done'
      el.textContent = this.rank ? `BINGO！ 第 ${this.rank} 位` : 'BINGO！'
    } else if (lines) {
      el.className = 'ph-wait on'
      const kind = lines >= 3 ? 'トリプルリーチ' : lines === 2 ? 'ダブルリーチ' : 'リーチ'
      el.textContent = `${kind}　あと ${this.waitingLabels().join('・')}`
    } else {
      el.className = 'ph-wait'
      el.textContent = ''
    }
  }

  private waitingLabels(): string[] {
    return waitingCells(this.mask).map((c) => labelOf(this.cells[c]))
  }

  private renderHistory(): void {
    this.$('.ph-history').innerHTML = this.history
      .slice(-12)
      .reverse()
      .map((n) => `<span class="${this.cells.includes(n) ? 'mine' : ''}">${labelOf(n)}</span>`)
      .join('')
  }

  // ---- イベント（全員確定・モグラ）の自分の結果 -----------------------------

  private onEvent(m: MsgOf<'eventPlay'>): void {
    const gen = this.generation
    window.setTimeout(async () => {
      if (gen !== this.generation) return
      const { cell, label, reachBefore, reachAfter } = m.me
      if (m.kind === 'wild') {
        if (cell === null) return
        await this.card.wildOpen(cell)
        this.mask |= 1 << cell
        this.wild |= 1 << cell
        this.filled &= ~(1 << cell)
        this.stats.maxReach = Math.max(this.stats.maxReach, reachAfter)
        this.renderCard()
        await playWildResult(this.root, { label, newReach: reachAfter > reachBefore, speed: this.speed })
      } else if (!this.won) {
        if (cell !== null) {
          await this.card.moleFill(cell)
          this.mask &= ~(1 << cell)
          this.wild &= ~(1 << cell)
          this.filled |= 1 << cell
          this.renderCard()
        }
        await playMoleResult(this.root, { hit: cell !== null, lostReach: reachAfter < reachBefore, label, speed: this.speed })
      }
    }, this.clock.scale(m.resultAt))
  }

  // ---- 抽選（手元のスロット → STOP → 自分のカードに反映 → 大画面の答え合わせ） ----

  private async playDraw(m: MsgOf<'drawScheduled'>): Promise<void> {
    const gen = this.generation
    const drawNo = m.drawNo
    const live = () => gen === this.generation && drawNo === this.drawNo
    this.drawNo = drawNo
    const number = new Promise<number>((r) => (this.gotNumber = r))
    const reveal = new Promise<MsgOf<'numberRevealed'>>((r) => (this.gotReveal = r))
    let done = () => {}
    this.celebration = new Promise<void>((r) => (done = r))
    try {
      const drawn = new Set(this.history)
      this.spinning = true
      this.spin.start({
        tier: m.personal.tier,
        waiting: m.personal.waiting,
        pool: Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !drawn.has(n)),
        minChargeMs: m.timing.charge,
        deadlineMs: m.timing.deadline,
      })
      const stop = await this.spin.stopped()
      this.spinning = false
      if (!live()) return
      if (stop.by === 'tap') this.send({ type: 'stop', drawNo })
      const n = await number
      if (!live()) return
      const j = this.judge(n)
      // 最新の番号と履歴は、スロットの本体の下に先に出しておく（本体が引っ込むと見える）
      this.$('.ph-latest b').textContent = labelOf(n)
      replay(this.$('.ph-latest'), 'pop')
      this.history.push(n)
      this.renderHistory()
      await this.spin.resolve({ outcome: j.outcome, label: labelOf(n) })
      if (!live()) return
      await this.applyNumber(j)
      if (!j.justWon) return
      // 順位は、大画面の答え合わせ（同じ回に何人上がったか）が届いてから出す
      const r = await reveal
      if (gen !== this.generation) return
      this.rank = r.totals.winners - r.newBingo + 1
      this.renderChip()
      await playBingo(this.root, { rank: this.rank, speed: this.speed })
    } finally {
      done()
    }
  }

  private judge(n: number): Judge {
    const before = lineState(this.mask)
    const cell = this.won ? -1 : this.cells.indexOf(n)
    const after = cell >= 0 ? lineState(this.mask | (1 << cell)) : before
    const justWon = cell >= 0 && after.bingo > 0
    const ch = this.challenge
    const chCell = ch ? ch.cells.indexOf(n) : -1
    const chWon = !!ch && chCell >= 0 && challengeBingo(ch.mask | (1 << chCell))
    let outcome: AoriOutcome = 'none'
    if (justWon || chWon) outcome = 'bingo'
    else if (cell >= 0 && after.reach > before.reach) outcome = after.reach >= 2 ? 'double' : 'reach'
    else if (cell >= 0 || chCell >= 0) outcome = 'hit'
    return { n, outcome, cell, chCell, reachBefore: before.reach, reachAfter: after.reach, justWon, chWon }
  }

  // 開けた番号を、自分のカードに押す
  private async applyNumber(j: Judge): Promise<void> {
    const gen = this.generation
    if (j.outcome === 'none' && !this.won && j.reachBefore > 0) this.stats.nearMiss++
    if (j.cell >= 0) {
      this.mask |= 1 << j.cell
      this.filled &= ~(1 << j.cell)
      this.stats.hits++
      this.stats.maxReach = Math.max(this.stats.maxReach, j.reachAfter)
      if (j.justWon) this.won = true
      await this.card.stamp(j.cell)
      if (gen !== this.generation) return
      this.renderCard()
      if (j.justWon) {
        await this.card.celebrateLine(bingoCells(this.mask))
      } else if (j.reachAfter > j.reachBefore) {
        await playReach(this.root, { lines: j.reachAfter, waiting: this.waitingLabels(), speed: this.speed })
      }
    }
    const ch = this.challenge
    if (ch && j.chCell >= 0) {
      ch.mask |= 1 << j.chCell
      this.stats.hits++
      await ch.view.stamp(j.chCell)
      if (gen !== this.generation) return
      this.renderChallenge()
      if (j.chWon) await ch.view.celebrateLine(challengeLineCells(ch.mask))
    }
  }

  // 大画面の答え合わせ。STOP しないまま締め切られていたら、ここで止める
  private onRevealed(m: MsgOf<'numberRevealed'>): void {
    if (m.drawNo !== this.drawNo) return
    this.gotNumber?.(m.n)
    if (this.spinning) this.spin.forceStop()
    this.gotReveal?.(m)
  }

  private onBulk(numbers: number[]): void {
    let mine = 0
    for (const n of numbers) {
      this.history.push(n)
      const cell = this.cells.indexOf(n)
      if (cell >= 0 && !this.won) {
        this.mask |= 1 << cell
        this.filled &= ~(1 << cell)
        mine++
      }
      const ch = this.challenge
      const c = ch ? ch.cells.indexOf(n) : -1
      if (ch && c >= 0) ch.mask |= 1 << c
    }
    this.stats.hits += mine
    this.stats.maxReach = Math.max(this.stats.maxReach, lineState(this.mask).reach)
    this.renderCard()
    this.renderChallenge()
    this.renderHistory()
    this.$('.ph-latest b').textContent = labelOf(numbers[numbers.length - 1])
    this.toast(`早送り: ${numbers.length} 個（あなたのカードに ${mine} 個）`)
  }

  // ---- 景品と上位チャレンジ -------------------------------------------------

  private async onMyPrize(e: PrizeEntry): Promise<void> {
    const gen = this.generation
    await this.celebration
    if (gen !== this.generation) return
    if (e.kind === 'challenge') {
      this.clearChallenge()
      await playChallengeResult(this.root, { speed: this.speed, success: true, rarity: e.rarity ?? undefined, prize: e.prize ?? undefined })
    } else {
      await playPackOpen(this.root, {
        speed: this.speed,
        rarity: e.rarity,
        prize: e.prize ?? 'ダブルチャンス券（ガラポン 3 回）',
        glow: e.glow,
        upgrade: e.upgrade,
        rankUp: e.rankUp,
      })
    }
    if (gen !== this.generation || !e.rarity) return
    let kind: 'receive' | 'challenge' = 'receive'
    if (e.choice) {
      kind = await askChoice(this.root, {
        speed: this.speed,
        rarity: e.rarity,
        prize: e.prize ?? '',
        seconds: 10,
        challenge: e.choice,
      })
    }
    if (gen !== this.generation) return
    if (kind === 'receive') {
      this.stats.won = e.prize ?? undefined
      this.toast(`景品: ${e.prize}（${e.rarity}）`)
    }
    this.send({ type: 'choice', kind })
  }

  // 上位チャレンジの 3×3 カードは、上がった本カードの代わりに同じ場所へ大きく置く
  private async onChallengeDeal(m: MsgOf<'challengeDeal'>): Promise<void> {
    const gen = this.generation
    await playChallengeStart(this.root, { speed: this.speed, target: m.target })
    if (gen !== this.generation) return
    this.clearChallenge()
    const host = this.$('.ph-cardhost')
    host.classList.add('challenge')
    const view = new CardView(host, { size: 3, speed: this.speed, title: `CHALLENGE ${m.target}` })
    this.challenge = { cells: m.cells, mask: 1 << CH_FREE, target: m.target, view }
    view.setCells(m.cells)
    this.renderChallenge()
    await view.deal()
  }

  private async onChallengeEnd(): Promise<void> {
    if (!this.challenge) return
    this.clearChallenge()
    await playChallengeResult(this.root, { speed: this.speed, success: false })
  }

  private renderChallenge(): void {
    const ch = this.challenge
    if (!ch) return
    ch.view.setMarks(ch.mask, { waiting: challengeWaiting(ch.mask), line: challengeLineCells(ch.mask) })
    this.renderChip()
  }

  private clearChallenge(): void {
    if (!this.challenge) return
    this.challenge.view.destroy()
    this.challenge = null
    this.$('.ph-cardhost').classList.remove('challenge')
    this.renderChip()
  }

  // ---- ダブルチャンス -------------------------------------------------------

  private async onDcEntry(m: MsgOf<'dcEntry'>): Promise<void> {
    if (!m.meEligible) {
      this.toast('あなたは景品を獲得済みです。ダブルチャンスは見守りましょう')
      return
    }
    const entered = await askEntry(this.root, { speed: this.speed, seconds: m.seconds })
    if (entered) this.send({ type: 'entry' })
  }

  private async onDcSpin(m: MsgOf<'dcSpin'>): Promise<void> {
    if (m.balls.length) {
      const win = m.balls.find((b) => b.color !== 'white')
      await playGarapon(this.root, { speed: this.speed, balls: m.balls, stats: { ...this.stats, won: win?.prize ?? this.stats.won } })
      return
    }
    // エントリーしないまま締め切られたときは、残っているエントリー画面を閉じてから結果を出す
    this.root.querySelectorAll('.fxg').forEach((n) => n.remove())
    this.overlay(`
      <div class="ph-result">
        <h3>おつかれさまでした</h3>
        <ul>
          <li>カードに出た番号<b>${this.stats.hits} 個</b></li>
          <li>最大のリーチ<b>${this.stats.maxReach} 本</b></li>
          <li>「あと 1 つ」で外れた回数<b>${this.stats.nearMiss} 回</b></li>
        </ul>
        <p class="ph-result-main">${this.stats.won ? `景品: ${esc(this.stats.won)}` : this.won ? `ビンゴ 第 ${this.rank} 位` : 'またの機会に！'}</p>
      </div>`)
  }

  // ---- 共通 -----------------------------------------------------------------

  private overlay(html: string): void {
    const ov = this.$('.ph-overlay')
    ov.innerHTML = html
    ov.classList.add('on')
  }

  private closeOverlay(): void {
    this.$('.ph-overlay').classList.remove('on')
  }

  private toast(text: string): void {
    const el = this.$('.ph-toast')
    el.textContent = text
    replay(el, 'on')
  }
}

function challengeWaiting(mask: number): number[] {
  return [...new Set(CH_LINES.filter((l) => popcount(l & ~mask) === 1).map((l) => 31 - Math.clz32(l & ~mask)))]
}

function challengeLineCells(mask: number): number[] {
  let all = 0
  for (const line of CH_LINES) if ((mask & line) === line) all |= line
  return [...Array(9).keys()].filter((i) => all & (1 << i))
}
