import './doublechance.css'
import { sfx, type GaraponVoice } from '../../audio'
import { GaraponMachine, BALL_INFO, ballHtml } from '../phone/garapon'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { GOLD, type BallColor } from '../theme'

// ダブルチャンス（ガラポン）の大画面（1920×1080 全体に重ねる）。熱を冷ます締めくくりなので、落ち着いた見せ方にする。
//
// 使い方:
//   const s = new DoubleChanceStage(stageRoot)
//   s.entry(30)              // エントリー受付（残り秒数を出す）
//   s.setEntrants(812)       // エントリーした人数（増えるたびに呼ぶ）
//   s.spin()                 // 全員がスマホでガラポンを回している
//   s.addWinner({...})       // 当たった人を 1 人ずつ出す（続けて呼んでも、間をあけて 1 人ずつ並べる）
//   await s.finish()         // おつかれさまでした（この画面は destroy() まで残る）
//
// 抽選器の絵はスマホと同じもの（phone/garapon.ts の GaraponMachine）を大きく描く

type Phase = 'entry' | 'spin' | 'winners' | 'fin'

const RING_C = 2 * Math.PI * 170 // 残り時間の輪の長さ
const MAX_ROWS = 8 // 当選者を一度に並べる行数（超えたら古い行から畳む。自分の行は残す）
const ROW_GAP = 900 // 当選者を 1 人ずつ出す間隔（演出上の ms）
// 大きな絵なので、回転はゆっくり（1 秒に 0.1 回転以下）
const CRUISE: Readonly<Record<Phase, number>> = { entry: 0, spin: 0.1, winners: 0.06, fin: 0 }
// 回している音の文字だけにする（「カラン」など当たりを思わせる言葉は、結果と関係なく出さない）
const POP_WORDS = ['ガラガラ', 'ガラッ', 'ゴロゴロ', 'ガラガラ…', 'ガラッ']

export interface DoubleChanceWinner {
  name: string
  color: BallColor
  prize: string
  isMe: boolean
}

export class DoubleChanceStage {
  readonly el: HTMLElement
  private readonly tl: Timeline
  private readonly sound: boolean
  private readonly reduced = prefersReducedMotion()
  private readonly machine: GaraponMachine
  private readonly fx: Particles | null = null
  private voice: GaraponVoice | null = null
  private phase: Phase | null = null
  private left = 0 // エントリーの残り（演出上の ms）
  private total = 0
  private shownSec = -1
  private entrants = 0
  private shownEntrants = 0
  private popAcc = 0
  private popN = 0
  private winners = 0
  private folded = 0
  private queue: Promise<void> = Promise.resolve()
  private lastVoice = -1
  private dead = false

  constructor(host: HTMLElement, o: { speed?: number; sound?: boolean } = {}) {
    this.tl = new Timeline(o.speed ?? 1)
    this.sound = o.sound ?? true
    this.el = el(
      'div',
      'fxdc',
      `<div class="fxdc-mwrap"></div>
      <div class="fxdc-pops"></div>
      <header class="fxdc-head">
        <div class="fxdc-kicker">DOUBLE CHANCE</div>
        <div class="fxdc-title">ダブルチャンス</div>
        <div class="fxdc-sub"></div>
      </header>
      <section class="fxdc-entry">
        <div class="fxdc-count">
          <svg viewBox="0 0 360 360" aria-hidden="true">
            <circle class="bg" cx="180" cy="180" r="170"/>
            <circle class="fg" cx="180" cy="180" r="170" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="0"/>
          </svg>
          <div class="fxdc-count-num"><b>0</b><small>秒</small></div>
        </div>
        <div class="fxdc-entrants"><span>エントリー</span><b data-k="entrants">0</b><span>人</span></div>
        <p class="fxdc-howto">スマホの「エントリー」ボタンを押してください</p>
      </section>
      <div class="fxdc-spin">スマホを連打して、玉を出そう<small>参加<b data-k="entrants">0</b>人</small></div>
      <section class="fxdc-win">
        <div class="fxdc-win-head"><b>当選者</b><span><b class="fxdc-win-n">0</b>人</span></div>
        <div class="fxdc-more"></div>
        <ol class="fxdc-list"></ol>
      </section>
      <div class="fxdc-fin"><b>おつかれさまでした</b><small>ご参加ありがとうございました</small></div>`,
    )
    this.setSpeedVar()
    host.append(this.el)

    this.machine = new GaraponMachine({ size: 640 })
    this.machine.friction = 0.6
    this.$('.fxdc-mwrap').append(this.machine.el)
    this.machine.onFrame = this.onFrame
    this.machine.onGone = () => this.shutdown()
    this.machine.start()

    if (!this.reduced) {
      const canvas = el('canvas', 'fxdc-fx')
      canvas.width = 1920
      canvas.height = 1080
      this.el.append(canvas)
      this.fx = new Particles(canvas, 800)
      this.fx.speed = this.tl.speed
    }
  }

  setSpeed(speed: number): void {
    this.tl.speed = speed
    this.setSpeedVar()
    if (this.fx) this.fx.speed = speed
  }

  // エントリー受付。残り秒数を数え、0 になったら「受付終了」にする（次の spin() を待つ）
  entry(seconds: number): void {
    this.setPhase('entry', 'エントリー受付中')
    this.total = Math.max(0, seconds) * 1000
    this.left = this.total
    this.shownSec = -1
    this.$('.fxdc-count').classList.remove('soon', 'closed')
  }

  setEntrants(n: number): void {
    const add = n - this.entrants
    this.entrants = Math.max(0, n)
    // 人が増えたら、受付の数字のあたりから小さな灯りを少しだけ上げる（間引く）
    if (add > 0 && this.fx && this.phase === 'entry' && Math.random() < 0.5) {
      this.fx.rise(Math.min(3, add), ['#ffd9a0', '#f5c542', '#ffe9c7'], 1180, 1580, 900)
    }
  }

  // 全員がスマホでガラポンを回している。大きなガラポンがゆっくり回る
  spin(): void {
    this.setPhase('spin', '全員でガラポンを回しています')
    if (this.sound && !this.voice) {
      this.voice = sfx.garaponStart()
      this.lastVoice = -1
    }
  }

  // 当たった人を 1 人ずつ、落ち着いて並べる（続けて呼ばれても ROW_GAP ずつ間をあける）
  addWinner(o: DoubleChanceWinner): void {
    this.queue = this.queue.then(() => this.showWinner(o))
  }

  // おつかれさまでした。並べ終わるのを待ってから出す
  async finish(): Promise<void> {
    await this.queue
    if (this.dead) return
    this.setPhase('fin', '')
    this.stopVoice()
    this.machine.friction = 0.5
    if (this.sound) sfx.outro()
    await this.tl.wait(600)
    if (this.dead) return
    this.fx?.rise(40, ['#ffd9a0', '#ffe9c7', '#c9d6ff', '#9fb4ff'], 200, 1720, 1040)
    await this.tl.wait(2600)
  }

  destroy(): void {
    this.shutdown()
    this.machine.destroy()
    this.el.remove()
  }

  // ---- 内部 ----

  private $(selector: string): HTMLElement {
    return this.el.querySelector<HTMLElement>(selector)!
  }

  private setSpeedVar(): void {
    this.el.style.setProperty('--fxdc-k', String(this.tl.ms(1)))
  }

  private setPhase(phase: Phase, sub: string): void {
    if (this.dead) return
    this.phase = phase
    this.el.dataset.phase = phase
    this.machine.cruise = CRUISE[phase]
    if (sub) this.$('.fxdc-sub').textContent = sub
  }

  private shutdown(): void {
    if (this.dead) return
    this.dead = true
    this.tl.cancel()
    this.stopVoice()
    this.fx?.clear()
  }

  private stopVoice(): void {
    this.voice?.stop()
    this.voice = null
  }

  private async showWinner(o: DoubleChanceWinner): Promise<void> {
    if (this.dead) return
    if (this.phase !== 'winners' && this.phase !== 'fin') {
      // 最初の 1 人で、抽選器を左に寄せて、右に当選者の欄を出す
      this.setPhase('winners', '当選者の発表')
      this.stopVoice()
      await this.tl.wait(900)
      if (this.dead) return
    }
    const info = BALL_INFO[o.color]
    const list = this.$('.fxdc-list')
    const row = el(
      'li',
      `fxdc-row${o.isMe ? ' me' : ''}`,
      `${ballHtml(o.color)}
      <span class="fxdc-who">${o.isMe ? '<i>あなた</i>' : ''}${o.isMe && o.name === 'あなた' ? '' : escapeHtml(o.name)}</span>
      <span class="fxdc-prize"><span>${info.shape} ${info.short}</span>${escapeHtml(o.prize)}</span>`,
    )
    row.dataset.color = o.color
    list.append(row)
    this.fold(list)
    void row.offsetWidth
    row.classList.add('on')
    this.winners++
    this.$('.fxdc-win-n').textContent = String(this.winners)
    if (this.sound) sfx.telop()
    if (o.isMe && this.fx) {
      // 自分の行は、玉のところに金の小さな粒をそっと添える（画面の縮小表示を打ち消して座標にする）
      const r = this.el.getBoundingClientRect()
      const b = row.getBoundingClientRect()
      const s = r.width / 1920 || 1
      const y = Math.min(1040, (b.top + b.height / 2 - r.top) / s)
      this.fx.burst(926, y, { count: 26, colors: GOLD, speed: 4, size: 6, life: 60, shape: 'dot', gravity: 0.05 })
    }
    await this.tl.wait(ROW_GAP)
  }

  // 行が多すぎたら、古い行から畳む（自分の行は残す）
  private fold(list: HTMLElement): void {
    const rows = [...list.querySelectorAll<HTMLElement>('.fxdc-row:not(.leaving)')]
    if (rows.length <= MAX_ROWS) return
    const old = rows.find((r) => !r.classList.contains('me'))
    if (!old) return
    old.classList.add('leaving')
    this.folded++
    this.$('.fxdc-more').textContent = `ほか ${this.folded} 人`
    this.tl.at(550, () => old.remove())
    if (this.reduced) old.remove()
  }

  private readonly onFrame = (dt: number): void => {
    const ms = dt * 1000 * this.tl.speed
    // エントリーの残り秒数と輪
    if (this.phase === 'entry') {
      this.left = Math.max(0, this.left - ms)
      const sec = Math.ceil(this.left / 1000)
      if (sec !== this.shownSec) {
        this.shownSec = sec
        const count = this.$('.fxdc-count')
        const num = count.querySelector<HTMLElement>('.fxdc-count-num')!
        if (sec > 0) {
          num.innerHTML = `<b>${sec}</b><small>秒</small>`
          count.classList.toggle('soon', sec <= 5)
          if (this.sound && sec <= 5) sfx.countdown(sec)
        } else {
          num.innerHTML = '<b>受付終了</b>'
          count.classList.add('closed')
          this.$('.fxdc-sub').textContent = 'エントリーを締め切りました'
        }
      }
      const ring = this.el.querySelector('.fxdc-count .fg')
      const frac = this.total > 0 ? this.left / this.total : 0
      ring?.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(1))
    }
    // 人数はなめらかに数え上げる
    if (this.shownEntrants !== this.entrants) {
      const d = this.entrants - this.shownEntrants
      this.shownEntrants = Math.abs(d) < 1 ? this.entrants : this.shownEntrants + d * Math.min(1, dt * 6)
      const text = Math.round(this.shownEntrants).toLocaleString('ja-JP')
      this.el.querySelectorAll('[data-k="entrants"]').forEach((n) => (n.textContent = text))
    }
    // 音を回転に合わせる
    const m = this.machine
    if (this.voice && Math.abs(m.rps - this.lastVoice) > 0.02) {
      this.lastVoice = m.rps
      this.voice.setSpeed(m.rps)
    }
    // 回している間は、会場のあちこちから「ガラガラ」が聞こえてくる（実時間で 1 秒に 1.4 回まで）
    if (this.phase === 'spin' && !this.reduced) {
      this.popAcc += dt
      if (this.popAcc > 0.7) {
        this.popAcc = 0
        this.pop()
      }
    }
  }

  private pop(): void {
    const n = this.popN++
    const side = n % 2 ? 1 : -1
    const word = el('div', 'fxdc-pop', POP_WORDS[n % POP_WORDS.length])
    word.style.left = `${960 + side * (400 + Math.random() * 260)}px`
    word.style.top = `${330 + Math.random() * 480}px`
    word.style.setProperty('--r', `${side * (4 + Math.random() * 8)}deg`)
    this.$('.fxdc-pops').append(word)
    this.tl.at(1700, () => word.remove())
  }
}
