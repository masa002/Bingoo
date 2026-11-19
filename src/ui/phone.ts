import { FREE_MASK, bingoCells, deriveCard, labelOf, lineState, popcount, waitingCells } from '../core/card'
import { CH_FREE, CH_LINES, challengeBingo } from '../core/game'
import { MY_TIER_WORD, TIER_QUIET } from '../core/show'
import type { Rarity } from '../core/prizes'
import type { Clock } from '../demo/clock'
import { playBingo, playReach, playWildResult, type AoriOutcome } from '../fx/phone/aori'
import { CardView } from '../fx/phone/card'
import { askEntry, playFinalResult, playGarapon } from '../fx/phone/garapon'
import { openLastOneBrief, playLastOneGarapon } from '../fx/phone/lastone'
import { askChoice, playChallengeResult, playChallengeStart, playPackOpen } from '../fx/phone/prize'
import { MoleQuest } from '../fx/phone/quest'
import { HandSpin } from '../fx/phone/spin'
import { RARITY_NAME, type BallColor } from '../fx/theme'
import type { LocalHub } from '../net/hub'
import type { Msg, MsgOf, PhoneCommand, PrizeEntry } from '../net/protocol'
import { esc, fit, fmt, h, q, replay, tierGuide } from './dom'

// 参加者のスマホ（390×844 で組んで縮小表示する）。カード・手元の抽選演出・緊急クエスト・景品・ガラポンの演出は fx/ の部品。
// 自分のカードはシードとカード番号から手元で作り、届いた番号で自分で塗る（本番と同じ）。
// 抽選は大画面と同じ拍で溜め、番号は大画面と同時に開く。熱さだけを自分のカードに合わせる

const PHONE_HTML = `
<div class="ph-status"><span class="ph-time">9:41</span><span>●●● 100%</span></div>
<div class="ph-head"><div><b class="ph-name">あなた</b><small class="ph-no"></small></div><div class="ph-count"></div></div>
<button class="ph-help" aria-label="色の見方"><i>？</i></button>
<div class="ph-chips"><div class="ph-wait"></div></div>
<div class="ph-cardhost"></div>
<div class="ph-rule"></div>
<div class="ph-latest"><small>最新の番号</small><b>--</b></div>
<div class="ph-sub"><div class="ph-history"></div></div>
<div class="ph-note"></div>
<div class="ph-prize"></div>
<div class="ph-toast"></div>
<div class="ph-overlay"></div>
`

// 演出の見方（色 → 自分のカードに何が起きそうか）。参加の画面と、右上の「？」で出す
const GUIDE_HTML = `
<div class="ph-guide">
  <h4>色の見方</h4>
  <p>次の番号が <b>あなたのカード</b>にありそうなほど、青 → 緑 → 赤 → 金に変わります（なかった、もあります）。</p>
  <ol class="tier-guide">${tierGuide(MY_TIER_WORD, TIER_QUIET)}</ol>
  <p>色は <b>あなただけ</b>のもの。となりの人とは違います。虹が出たら、ビンゴ確定！</p>
</div>`

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
  private readonly quest: MoleQuest
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
  private drawNo = 0 // いまの抽選
  private celebration: Promise<void> = Promise.resolve() // 当たりの演出が終わるまで（景品パックはその後に出す）
  private lastOneBrief: { close(): void } | null = null
  private lastOneOn = false // ラストワン争奪の説明の画面を出してよい間（ガラポンが始まったら出さない）
  private noteTimer = 0
  private dcEnded: Promise<void> = Promise.resolve() // 大画面の締めくくり（スマホの最後の結果は、これに合わせて出す）
  private dcEndNow: (() => void) | null = null
  private dcEligible = true

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
    // デモでは大画面と同じ PC から鳴るので、手元の演出は自分だけの音にする（本番のスマホは 'all'）
    this.spin = new HandSpin(this.root, { speed: clock.speed, sound: 'personal' })
    this.quest = new MoleQuest(this.root, { speed: clock.speed, sound: 'personal' })
    this.$('.ph-help').addEventListener('click', () => this.showGuide())
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
        return this.onScheduled(m)
      case 'numberRevealed':
        void this.onRevealed(m)
        return
      case 'questBrief':
        if (!this.joined) this.join(false)
        this.syncSpeed()
        // モグラは、いま見えているカード（上位チャレンジ中は 3×3）のマスから顔を出す
        this.quest.brief(this.challenge?.view ?? this.card, { playMs: m.playMs, target: m.me.target, cell: m.me.cell, label: m.me.label, autoMs: m.autoMs })
        return
      case 'questStart':
        if (!this.joined) this.join(false)
        void this.onQuestStart(m)
        return
      case 'lastOneBrief':
        void this.onLastOneBrief(m)
        return
      case 'questResult':
        void this.onQuestResult(m)
        return
      case 'bulkDrawn':
        return this.onBulk(m.numbers)
      case 'prizeTime': {
        this.closeLastOneBrief()
        const mine = m.entries.find((e) => e.isMe)
        if (mine) void this.onMyPrize(mine, m.lastOne ? { ...m.lastOne, entries: m.entries } : null)
        return
      }
      case 'challengeDeal':
        void this.onChallengeDeal(m)
        return
      case 'challengeEnd':
        void this.onChallengeEnd()
        return
      case 'gameOver':
        // 節目の知らせは、見逃しても分かるように画面に残す
        this.setNote('景品がぜんぶ出ました。このあとはダブルチャンス！')
        return
      case 'dcEntry':
        void this.onDcEntry(m)
        return
      case 'dcSpin':
        this.dcEnded = new Promise((r) => (this.dcEndNow = r))
        void this.onDcSpin(m)
        return
      case 'dcEnd':
        this.dcEndNow?.()
        return
      default:
        return
    }
  }

  private syncSpeed(): void {
    this.card.setSpeed(this.speed)
    this.spin.setSpeed(this.speed)
    this.quest.setSpeed(this.speed)
    this.challenge?.view.setSpeed(this.speed)
  }

  // ---- 参加とカード ---------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.generation++
    this.spin.cancel()
    this.quest.cancel()
    this.closeLastOneBrief()
    this.drawNo = 0
    this.celebration = Promise.resolve()
    // 前のゲームで残った景品・ガラポンの画面を片付ける
    this.root.querySelectorAll('.fxg, .fxp, .fxlp').forEach((n) => n.remove())
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
    this.setNote('')
    this.setPrize(null, null)
    this.dcEnded = Promise.resolve()
    this.dcEndNow = null
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
        <p>ビンゴ大会へようこそ！</p>
        <button class="ph-join-btn">参加する</button>
        <small>このデモでは、あなた以外の ${fmt(m.size - 1)} 人はコンピューターです</small>
        ${GUIDE_HTML}
      </div>`)
    q(this.root, '.ph-join-btn').addEventListener('click', () => this.join())
  }

  // 演出の見方は、参加したあとも右上の「？」から見返せる
  private showGuide(): void {
    if (!this.joined || this.$('.ph-overlay').classList.contains('on')) return
    this.overlay(`
      <div class="ph-join">
        ${GUIDE_HTML}
        <button class="ph-join-btn ph-close">閉じる</button>
      </div>`)
    q(this.root, '.ph-close').addEventListener('click', () => this.closeOverlay())
  }

  // 見逃すと困る知らせ（景品がなくなった、など）は、トーストではなく画面に残す。ms を渡すと、その時間で消す
  private setNote(text: string, ms?: number): void {
    window.clearTimeout(this.noteTimer)
    const el = this.$('.ph-note')
    el.textContent = text
    el.classList.toggle('on', text !== '')
    if (text && ms !== undefined) this.noteTimer = window.setTimeout(() => this.setNote(''), this.clock.scale(ms))
  }

  // 受け取った景品は、画面に出したままにする（会場で引き換えるときに見せられるように）
  private setPrize(prize: string | null, rarity: Rarity | null): void {
    const el = this.$('.ph-prize')
    el.classList.toggle('on', prize !== null)
    el.innerHTML = prize === null ? '' : `<small>あなたの景品</small><div>${rarity ? `<i data-r="${rarity}">${rarity}<em>${RARITY_NAME[rarity]}</em></i>` : ''}<b>${esc(prize)}</b></div>`
  }

  // deal を false にすると、カードを配る動きを省く（すぐにカードのマスの位置を測る演出が続くとき）
  private join(deal = true): void {
    if (this.joined) return
    this.joined = true
    this.send({ type: 'join' })
    this.closeOverlay()
    if (deal) void this.card.deal()
  }

  private renderCard(): void {
    const bits = (x: number) => [...Array(25).keys()].filter((i) => x & (1 << i))
    this.card.setMarks(this.mask, {
      waiting: this.won ? [] : waitingCells(this.mask, this.filled),
      line: bingoCells(this.mask),
      filled: bits(this.filled),
      wild: bits(this.wild & this.mask),
    })
    this.renderChip()
  }

  // カードの上の帯: リーチの「あと〇〇」、上がったら順位、上位チャレンジ中はそのリーチ
  private renderChip(): void {
    const el = this.$('.ph-wait')
    const lines = lineState(this.mask, this.filled).reach
    const ch = this.challenge
    if (ch) {
      const rest = challengeWaiting(ch.mask).map((c) => labelOf(ch.cells[c]))
      el.className = rest.length ? 'ph-wait on chal' : 'ph-wait chal'
      el.textContent = `上位チャレンジ中（${ch.target} ねらい）${rest.length ? `　あと ${rest.join('・')}` : ''}`
    } else if (this.won) {
      el.className = 'ph-wait done'
      el.textContent = this.rank ? `ビンゴ！ 第 ${this.rank} 位` : 'ビンゴ！'
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
    return waitingCells(this.mask, this.filled).map((c) => labelOf(this.cells[c]))
  }

  private renderHistory(): void {
    this.$('.ph-history').innerHTML = this.history
      .slice(-12)
      .reverse()
      .map((n) => `<span class="${this.cells.includes(n) ? 'mine' : ''}">${labelOf(n)}</span>`)
      .join('')
  }

  // ---- 全員確定（虹玉）の自分の結果 ------------------------------------------

  private onEvent(m: MsgOf<'eventPlay'>): void {
    const gen = this.generation
    window.setTimeout(async () => {
      const { cell, label, reachBefore, reachAfter } = m.me
      if (gen !== this.generation) return
      if (cell === null) {
        // 大画面は「全員に当たり」と言っているので、何も起きない人には理由を出す
        if (this.won) this.setNote('あなたは、もうビンゴ済み。マスがあくのは、まだビンゴしていない人のカードです', m.durationMs - m.resultAt + 2500)
        return
      }
      await this.card.wildOpen(cell)
      this.mask |= 1 << cell
      this.wild |= 1 << cell
      this.filled &= ~(1 << cell)
      this.stats.maxReach = Math.max(this.stats.maxReach, reachAfter)
      this.renderCard()
      await playWildResult(this.root, { label, newReach: reachAfter > reachBefore, speed: this.speed })
    }, this.clock.scale(m.resultAt))
  }

  // ---- 緊急クエスト「モグラ撃退」 ---------------------------------------------
  // 狙われた人は自分のリーチのマスを守るために叩く。やられるのは、叩いた数が会場の下位に入った人

  private async onQuestStart(m: MsgOf<'questStart'>): Promise<void> {
    const gen = this.generation
    this.syncSpeed()
    // モグラは、いま見えているカード（上位チャレンジ中は 3×3）のマスから顔を出す
    const card = this.challenge?.view ?? this.card
    const score = await this.quest.play(card, { introMs: m.introMs, playMs: m.playMs, target: m.me.target, cell: m.me.cell, label: m.me.label })
    if (gen === this.generation) this.send({ type: 'questScore', score })
  }

  private async onQuestResult(m: MsgOf<'questResult'>): Promise<void> {
    const gen = this.generation
    const me = m.me
    this.quest.setSpeed(this.speed) // 結果は、いまの速度で見せる（権威の待ち時間とそろえる）
    await this.quest.result({ score: me.score, lost: me.lost, need: me.need, total: m.total, rank: me.rank, players: m.totals.size })
    if (gen !== this.generation || !me.lost || me.cell === null) return
    this.mask &= ~(1 << me.cell)
    this.wild &= ~(1 << me.cell)
    this.filled |= 1 << me.cell
    this.renderCard()
  }

  // ---- 抽選（自分の段階で溜め、番号は大画面と同時に出る） ----------------------

  private onScheduled(m: MsgOf<'drawScheduled'>): void {
    const drawn = new Set(this.history)
    this.drawNo = m.drawNo
    this.spin.start({
      tier: m.personal.tier,
      waiting: m.personal.waiting,
      pool: Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !drawn.has(n)),
      beats: m.personal.beats,
      revealAt: m.revealAt,
      venueBeats: m.beats, // 番号が見える瞬間を、大画面の抽選機に合わせる
      venueVariant: m.style,
    })
  }

  // 大画面の公開と同時に手元でも番号に着地させ、自分のカードに押す
  private async onRevealed(m: MsgOf<'numberRevealed'>): Promise<void> {
    if (m.drawNo !== this.drawNo) return
    const gen = this.generation
    let done = () => {}
    this.celebration = new Promise<void>((r) => (done = r))
    try {
      const j = this.judge(m.n)
      if (j.justWon) this.rank = m.totals.winners - m.newBingo + 1
      // 最新の番号と履歴は、手元の演出の下に先に出しておく（演出が引っ込むと見える）
      this.$('.ph-latest b').textContent = m.label
      replay(this.$('.ph-latest'), 'pop')
      this.history.push(m.n)
      this.renderHistory()
      await this.spin.reveal(m.n)
      if (gen !== this.generation) return
      await this.spin.resolve({ outcome: j.outcome, label: m.label })
      if (gen !== this.generation) return
      await this.applyNumber(j)
      if (gen !== this.generation || !j.justWon) return
      await playBingo(this.root, { rank: this.rank, speed: this.speed })
    } finally {
      done()
    }
  }

  private judge(n: number): Judge {
    const before = lineState(this.mask, this.filled)
    const cell = this.won ? -1 : this.cells.indexOf(n)
    const after = cell >= 0 ? lineState(this.mask | (1 << cell), this.filled) : before
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
    this.stats.maxReach = Math.max(this.stats.maxReach, lineState(this.mask, this.filled).reach)
    this.renderCard()
    this.renderChallenge()
    this.renderHistory()
    this.$('.ph-latest b').textContent = labelOf(numbers[numbers.length - 1])
    this.toast(`早送り: ${numbers.length} 個出ました（カードにあったのは ${mine} 個）`)
  }

  // ---- ラストワン争奪の説明 ---------------------------------------------------

  // 争奪に入る人には、ビンゴの演出が終わってから説明の画面を出す。入らない人には、ひと言だけ知らせる
  private async onLastOneBrief(m: MsgOf<'lastOneBrief'>): Promise<void> {
    if (!m.meIn) {
      this.toast(`景品が足りない！ 同時にビンゴした ${fmt(m.entrants.length)} 人が、ガラポンで勝負します`)
      return
    }
    const gen = this.generation
    this.lastOneOn = true
    await this.celebration
    if (gen !== this.generation || !this.lastOneOn) return
    this.lastOneBrief = openLastOneBrief(this.root, { speed: this.speed, prizes: m.prizes, contestants: m.entrants.length, autoMs: m.autoMs })
  }

  private closeLastOneBrief(): void {
    this.lastOneOn = false
    this.lastOneBrief?.close()
    this.lastOneBrief = null
  }

  // ---- 景品と上位チャレンジ -------------------------------------------------

  private async onMyPrize(e: PrizeEntry, lastOne: { dropAt: number; durationMs: number; entries: PrizeEntry[] } | null): Promise<void> {
    const gen = this.generation
    if (lastOne && e.kind === 'normal') {
      // ラストワン争奪: 大画面の発表と同時に玉が出るので、当たりの演出の終わりを待たずに始める
      const pool = lastOne.entries.filter((x) => x.kind === 'normal')
      await playLastOneGarapon(this.root, {
        speed: this.speed,
        dropAt: lastOne.dropAt,
        durationMs: lastOne.durationMs,
        color: ballColor(e.rarity),
        prize: e.prize ?? undefined,
        contestants: pool.length,
        prizes: pool.filter((x) => x.rarity).length,
      })
      // 外れ（運がなかった・ダブルチャンスの玉 3 個）は、ガラポンの画面で伝え終わっている
      if (gen !== this.generation || !e.rarity) return
    } else {
      await this.celebration
      if (gen !== this.generation) return
    }
    if (e.kind === 'challenge') {
      this.clearChallenge()
      await playChallengeResult(this.root, { speed: this.speed, success: true, rarity: e.rarity ?? undefined, prize: e.prize ?? undefined })
    } else {
      await playPackOpen(this.root, {
        speed: this.speed,
        rarity: e.rarity,
        prize: e.prize ?? '',
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
      this.setPrize(e.prize, e.rarity)
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
    // 条件は、挑んでいる間ずっと見えるようにする
    this.$('.ph-rule').textContent = `1 列そろえば ${m.target} の景品！ 景品がなくなるまでにそろわないと、景品なし`
    this.setPrize(null, null)
    const view = new CardView(host, { size: 3, speed: this.speed, title: `上位チャレンジ ${m.target}` })
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
    this.$('.ph-rule').textContent = ''
    this.renderChip()
  }

  // ---- ダブルチャンス -------------------------------------------------------

  private async onDcEntry(m: MsgOf<'dcEntry'>): Promise<void> {
    this.dcEligible = m.meEligible
    if (!m.meEligible) {
      this.setNote('あなたは、もう景品をもらっています。ダブルチャンスは、大画面で見ていてね')
      return
    }
    const entered = await askEntry(this.root, { speed: this.speed, seconds: m.seconds })
    if (entered) this.send({ type: 'entry' })
  }

  private async onDcSpin(m: MsgOf<'dcSpin'>): Promise<void> {
    const gen = this.generation
    this.setNote('')
    // 最後の結果の画面は、大画面の締めくくりと同時に出す（大画面が当選者を発表している間に、先に終わらせない）
    if (m.balls.length) {
      const win = m.balls.find((b) => b.color !== 'white')
      await playGarapon(this.root, { speed: this.speed, balls: m.balls, stats: { ...this.finalStats(), won: win?.prize ?? this.stats.won }, outro: this.dcEnded })
      return
    }
    // エントリーしないまま締め切られたときは、残っているエントリー画面を閉じて、大画面の発表を待つ
    this.root.querySelectorAll('.fxg').forEach((n) => n.remove())
    this.setNote('いま大画面で、ダブルチャンスの当たりを発表中！')
    await this.dcEnded
    if (gen !== this.generation) return
    this.setNote('')
    // 締めの音は、景品を獲得済みの人のときは大画面が鳴らしている（デモでは同じ PC から鳴るので、重ねない）
    await playFinalResult(this.root, { speed: this.speed, stats: this.finalStats(), sound: this.dcEligible })
  }

  private finalStats() {
    return { ...this.stats, rank: this.won && this.rank ? this.rank : undefined }
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

// ラストワン争奪のガラポンの玉の色（外れは白）
function ballColor(rarity: Rarity | null): BallColor {
  if (rarity === 'UR') return 'rainbow'
  if (rarity === 'SR') return 'gold'
  return rarity ? 'red' : 'white'
}

function challengeWaiting(mask: number): number[] {
  return [...new Set(CH_LINES.filter((l) => popcount(l & ~mask) === 1).map((l) => 31 - Math.clz32(l & ~mask)))]
}

function challengeLineCells(mask: number): number[] {
  let all = 0
  for (const line of CH_LINES) if ((mask & line) === line) all |= line
  return [...Array(9).keys()].filter((i) => all & (1 << i))
}
