import { FREE_MASK, bingoCells, deriveCard, labelOf, lineState, popcount, waitingCells } from '../core/card'
import { CH_FREE, CH_LINES, challengeBingo } from '../core/game'
import type { Rarity } from '../core/prizes'
import type { Clock } from '../demo/clock'
import { Aori, playBingo, playMoleResult, playReach, playWildResult, type AoriOutcome } from '../fx/phone/aori'
import { CardView } from '../fx/phone/card'
import { askEntry, playGarapon } from '../fx/phone/garapon'
import { askChoice, playChallengeResult, playChallengeStart, playPackOpen } from '../fx/phone/prize'
import type { LocalHub } from '../net/hub'
import type { Msg, MsgOf, PhoneCommand, PrizeEntry } from '../net/protocol'
import { esc, fit, fmt, h, q, replay } from './dom'

// 参加者のスマホ（390×844 で組んで縮小表示する）。カード・あおり・景品・ガラポンの演出は fx/ の部品。
// 自分のカードはシードとカード番号から手元で作り、届いた番号で自分で塗る（本番と同じ）

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

export class PhoneView {
  private readonly root: HTMLDivElement
  private readonly card: CardView
  private readonly aori: Aori
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
  private busyUntil = 0 // ビンゴなどの演出が終わる時刻（景品パックはその後に出す）
  private generation = 0

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
    this.aori = new Aori(this.root, { speed: clock.speed })
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
        this.aori.start({ tier: m.personal.tier, revealIn: m.timing.reveal, waiting: m.personal.waiting })
        return
      case 'awaitPush':
        this.aori.awaitPush()
        return
      case 'numberRevealed':
        void this.onRevealed(m)
        return
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
    this.aori.setSpeed(this.speed)
    this.challenge?.view.setSpeed(this.speed)
  }

  // ---- 参加とカード ---------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.generation++
    this.aori.cancel()
    // 前のゲームで残った景品・ガラポンの画面を片付ける
    this.root.querySelectorAll('.fxg, .fxp').forEach((n) => n.remove())
    this.challenge?.view.destroy()
    this.challenge = null
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
    this.busyUntil = 0
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
    const el = this.$('.ph-wait')
    const lines = lineState(this.mask).reach
    if (this.won) {
      el.className = 'ph-wait done'
      el.textContent = `BINGO！ 第 ${this.rank || '-'} 位`
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
    if (this.challenge) return
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

  // ---- 公開 -----------------------------------------------------------------

  private async onRevealed(m: MsgOf<'numberRevealed'>): Promise<void> {
    const gen = this.generation
    this.$('.ph-latest b').textContent = m.label
    replay(this.$('.ph-latest'), 'pop')
    this.history.push(m.n)
    this.renderHistory()

    // 自分のカードにとっての結果を、手元で計算する
    const before = lineState(this.mask)
    const cell = this.won ? -1 : this.cells.indexOf(m.n)
    const after = cell >= 0 ? lineState(this.mask | (1 << cell)) : before
    const justWon = cell >= 0 && after.bingo > 0
    const ch = this.challenge
    const chCell = ch ? ch.cells.indexOf(m.n) : -1
    const chWon = !!ch && chCell >= 0 && challengeBingo(ch.mask | (1 << chCell))
    let outcome: AoriOutcome = 'none'
    if (justWon || chWon) outcome = 'bingo'
    else if (cell >= 0 && after.reach > before.reach) outcome = after.reach >= 2 ? 'double' : 'reach'
    else if (cell >= 0 || chCell >= 0) outcome = 'hit'
    if (justWon) {
      this.rank = m.totals.winners - m.newBingo + 1
      // あおりの成功 → スタンプ → ラインの光 → BINGO の文字（×1 で約 7 秒）が終わってから景品パックを出す
      this.busyUntil = performance.now() + this.clock.scale(7600)
    }
    if (chWon) this.busyUntil = performance.now() + this.clock.scale(3000)
    if (outcome === 'none' && !this.won && before.reach > 0) this.stats.nearMiss++

    await this.aori.resolve({ outcome, label: m.label, rank: justWon ? this.rank : undefined })
    if (gen !== this.generation) return

    if (cell >= 0) {
      this.mask |= 1 << cell
      this.filled &= ~(1 << cell)
      this.stats.hits++
      this.stats.maxReach = Math.max(this.stats.maxReach, after.reach)
      if (justWon) this.won = true
      await this.card.stamp(cell)
      this.renderCard()
      if (justWon) {
        await this.card.celebrateLine(bingoCells(this.mask))
        await playBingo(this.root, { rank: this.rank, speed: this.speed })
      } else if (after.reach > before.reach) {
        await playReach(this.root, { lines: after.reach, waiting: this.waitingLabels(), speed: this.speed })
      }
    }
    if (ch && chCell >= 0) {
      ch.mask |= 1 << chCell
      this.stats.hits++
      await ch.view.stamp(chCell)
      this.renderChallenge()
      if (chWon) await ch.view.celebrateLine(challengeLineCells(ch.mask))
    }
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
    const wait = this.busyUntil - performance.now()
    if (wait > 0) await new Promise((r) => window.setTimeout(r, wait))
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

  private async onChallengeDeal(m: MsgOf<'challengeDeal'>): Promise<void> {
    const gen = this.generation
    await playChallengeStart(this.root, { speed: this.speed, target: m.target })
    if (gen !== this.generation) return
    this.clearChallenge()
    const sub = this.$('.ph-sub')
    sub.classList.add('challenge')
    sub.replaceChildren()
    const view = new CardView(sub, { size: 3, speed: this.speed })
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
    const waiting = CH_LINES.filter((l) => popcount(l & ~ch.mask) === 1).map((l) => 31 - Math.clz32(l & ~ch.mask))
    ch.view.setMarks(ch.mask, { waiting: [...new Set(waiting)], line: challengeLineCells(ch.mask) })
  }

  private clearChallenge(): void {
    if (!this.challenge) return
    this.challenge.view.destroy()
    this.challenge = null
    const sub = this.$('.ph-sub')
    sub.classList.remove('challenge')
    sub.innerHTML = '<div class="ph-history"></div>'
    this.renderHistory()
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

function challengeLineCells(mask: number): number[] {
  let all = 0
  for (const line of CH_LINES) if ((mask & line) === line) all |= line
  return [...Array(9).keys()].filter((i) => all & (1 << i))
}
