import { bgm, engine, sfx, type BgmScene } from '../audio'
import { LETTERS } from '../core/card'
import type { Player } from '../core/game'
import type { Clock } from '../demo/clock'
import { Particles, RAINBOW } from '../fx/particles'
import { DoubleChanceStage } from '../fx/stage/doublechance'
import { DrawMachine } from '../fx/stage/draw'
import { playAllKakutei, playFinalBall, playLastOne, playMole } from '../fx/stage/events'
import type { LocalHub } from '../net/hub'
import type { Msg, MsgOf, PrizeEntry, Totals } from '../net/protocol'
import { countUp, esc, fit, fmt, h, q } from './dom'

// 会場の大画面（1920×1080 で組んで縮小表示する）。抽選機・イベント・ダブルチャンスの演出は fx/ の部品で、
// この画面は HUD・結果・会場ビュー・番号の盤と、メッセージから部品への振り分けを受け持つ。音（PA）はこの画面だけが鳴らす

export type VenueSource = () => readonly Player[]

const STAGE_HTML = `
<header class="st-hud">
  <div class="st-logo">BINGOO</div>
  <div class="st-stat"><span>参加</span><b data-k="size">0</b></div>
  <div class="st-stat"><span>リーチ</span><b data-k="reach">0</b></div>
  <div class="st-stat"><span>ビンゴ</span><b data-k="bingo">0</b></div>
  <div class="st-stat"><span>景品 残り</span><b data-k="lower">0</b></div>
  <div class="st-stat st-upper"><span>上位</span><b data-k="upper">0</b></div>
  <div class="st-stat st-chal"><span>チャレンジ中</span><b data-k="chal">0</b></div>
  <div class="st-odds">残り <b data-k="remaining">75</b> 個中　当たり番号 <b data-k="hits">0</b> 個</div>
</header>
<div class="st-hash"></div>
<section class="st-result">
  <div class="st-last"><small>今回の番号</small><b>--</b></div>
  <div class="st-chips">
    <div class="chip"><span>ヒット</span><b data-r="hits">-</b></div>
    <div class="chip"><span>新規リーチ</span><b data-r="reach">-</b></div>
    <div class="chip chip-bingo"><span>新規ビンゴ</span><b data-r="bingo">-</b></div>
  </div>
  <ol class="st-names"></ol>
</section>
<section class="st-venue"><canvas width="610" height="236"></canvas><span class="st-venue-label">会場ビュー</span></section>
<div class="st-board"></div>
<canvas class="st-fx" width="1920" height="1080"></canvas>
<div class="st-overlay"></div>
<div class="st-watermark">DEMO・仮想参加者</div>
`

export class StageView {
  private readonly root: HTMLDivElement
  private readonly fx: Particles
  private readonly venue: Venue
  private readonly machine: DrawMachine
  private dc: DoubleChanceStage | null = null
  private timers: number[] = []
  private cancelBeats: () => void = () => {}
  private drawn = new Set<number>()
  private last = 0
  private scene: BgmScene = 'reception'
  private firstBingo = false

  constructor(
    host: HTMLElement,
    hub: LocalHub,
    private readonly clock: Clock,
    venueSource: VenueSource,
  ) {
    this.root = h('div', 'stage', STAGE_HTML)
    host.append(this.root)
    fit(this.root, 1920, 1080)
    this.fx = new Particles(this.$<HTMLCanvasElement>('.st-fx'))
    this.venue = new Venue(this.$<HTMLCanvasElement>('.st-venue canvas'), this.$('.st-venue-label'), venueSource)
    this.machine = new DrawMachine(this.root, { speed: clock.speed })
    this.buildBoard()
    hub.subscribe((m) => this.on(m))
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return q<T>(this.root, selector)
  }

  private on(m: Msg): void {
    switch (m.type) {
      case 'snapshot':
        return this.onSnapshot(m)
      case 'joined': {
        const count = this.root.querySelector('.rcp-count b')
        if (count) count.textContent = fmt(m.count)
        return
      }
      case 'eventPlay':
        return this.onEvent(m)
      case 'finalBall':
        this.hideOverlay()
        this.setScene('final')
        void playFinalBall(this.root, { speed: this.clock.speed, prizesLeft: m.prizesLeft })
        return
      case 'drawScheduled':
        return this.onScheduled(m)
      case 'awaitPush':
        this.machine.awaitPush()
        return
      case 'numberRevealed':
        return this.onRevealed(m)
      case 'bulkDrawn':
        m.numbers.forEach((n) => this.drawn.add(n))
        this.last = m.numbers[m.numbers.length - 1]
        this.renderBoard()
        this.setTotals(m.totals)
        this.venue.refresh()
        return
      case 'prizeTime':
        return this.onPrizeTime(m)
      case 'choices':
        this.setTotals(m.totals)
        if (m.challengers.length) this.addNames(m.challengers.map((c) => ({ ...c, label: '上位チャレンジへ' })), 'chal')
        return
      case 'idle':
        this.setTotals(m.totals)
        return
      case 'gameOver':
        return this.onGameOver(m)
      case 'dcEntry':
        return this.onDcEntry(m)
      case 'dcEntrants':
        this.dc?.setEntrants(m.count)
        return
      case 'dcSpin':
        return this.onDcSpin(m)
      case 'dcEnd':
        void this.dc?.finish()
        this.later(6000, () => bgm.stop(3000))
        return
      case 'challengeDeal':
      case 'challengeEnd':
      case 'notice':
        return
    }
  }

  // ---- 受付・盤面 ----------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.cancelAll()
    this.resetSound()
    this.fx.clear()
    this.dc?.destroy()
    this.dc = null
    this.firstBingo = false
    this.machine.setSpeed(this.clock.speed)
    this.machine.reset()
    this.drawn = new Set(m.drawn)
    this.last = 0
    this.renderBoard()
    this.setTotals(m.totals)
    this.$('.st-hash').textContent = `抽選順と景品の並びのハッシュ ${m.deckHash.slice(0, 16)}…`
    this.clearResult()
    this.venue.reset(m.size)
    this.scene = 'reception'
    bgm.play('reception')
    this.showOverlay(`
      <div class="rcp">
        <h2>受付中</h2>
        <div class="rcp-count"><b>0</b> / ${fmt(m.size)} 人</div>
        <p>右のスマホ枠の「参加する」を押してください</p>
        <p class="muted">主催の「次へ」で受付を締め切り、抽選を始めます</p>
      </div>`)
  }

  private buildBoard(): void {
    this.$('.st-board').innerHTML = LETTERS.map(
      (letter, r) =>
        `<div class="st-row"><div class="st-letter">${letter}</div>${Array.from({ length: 15 }, (_, i) => {
          const n = r * 15 + i + 1
          return `<div class="st-cell" data-n="${n}">${n}</div>`
        }).join('')}</div>`,
    ).join('')
  }

  private renderBoard(): void {
    this.root.querySelectorAll<HTMLElement>('.st-cell').forEach((cell) => {
      const n = Number(cell.dataset.n)
      cell.classList.toggle('on', this.drawn.has(n))
      cell.classList.toggle('last', n === this.last)
    })
  }

  private setTotals(t: Totals): void {
    const set = (k: string, v: string) => {
      this.$(`[data-k="${k}"]`).textContent = v
    }
    set('size', fmt(t.size))
    set('reach', fmt(t.reachHolders))
    set('bingo', fmt(t.winners))
    set('lower', `${t.lowerLeft}/${t.lowerTotal}`)
    set('upper', `${t.upperLeft}/${t.upperTotal}`)
    set('chal', fmt(t.challengers))
    set('remaining', String(t.remaining))
    set('hits', String(t.hitsLeft))
    this.$('.st-hash').classList.toggle('tampered', t.tampered)
    // BGM は会場の局面で切り替える（序盤 → リーチ期 → ビンゴ期 → オーラス）
    if (t.phase === 'playing') {
      if (t.lowerLeft <= 3 && t.winners > 0) this.setScene('final')
      else if (t.winners > 0) this.setScene('bingo')
      else if (t.reachHolders >= t.size * 0.05) this.setScene('reach')
      else this.setScene('early')
    }
  }

  private setScene(scene: BgmScene): void {
    const order: BgmScene[] = ['reception', 'early', 'reach', 'bingo', 'final', 'cooldown']
    if (order.indexOf(scene) < order.indexOf(this.scene)) return // 局面は戻さない
    this.scene = scene
    bgm.play(scene)
  }

  // ---- イベント -------------------------------------------------------------

  private onEvent(m: MsgOf<'eventPlay'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.clearResult()
    const o = { speed: this.clock.speed, total: m.total }
    if (m.kind === 'wild') {
      void playAllKakutei(this.root, { ...o, newReach: m.newReach, newDouble: m.newDouble })
      this.later(m.resultAt - 2500, () => this.venue.rainbow())
    } else {
      void playMole(this.root, { ...o, hit: m.hit, lostReach: m.lostReach })
    }
    this.later(m.resultAt, () => {
      this.setTotals(m.totals)
      this.venue.refresh()
    })
  }

  // ---- 抽選 -----------------------------------------------------------------

  private onScheduled(m: MsgOf<'drawScheduled'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.clearResult()
    this.setScene('early')
    this.machine.setSpeed(this.clock.speed)
    this.machine.reset()
    this.machine.setPool(Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !this.drawn.has(n)))
    this.machine.start(m.beats, m.plan)
    // 会場ビュー（デモ専用）は、赤以上の溜めでリーチの人のスマホが光る様子を見せる
    this.cancelBeats = this.clock.run(
      m.beats.filter((b) => b.kind === 'sea'),
      () => this.venue.sea(),
    )
  }

  private onRevealed(m: MsgOf<'numberRevealed'>): void {
    this.cancelBeats()
    void this.machine.reveal(m.n, m.tier)
    this.drawn.add(m.n)
    this.last = m.n
    this.venue.reveal(m.n, m.totals.drawCount)
    this.renderBoard()
    this.setTotals(m.totals)
    this.$('.st-result').classList.add('on')
    this.$('.st-last b').textContent = m.label
    const dur = this.clock.scale(900)
    countUp(this.$('[data-r="hits"]'), m.hits, dur)
    countUp(this.$('[data-r="reach"]'), m.newReach, dur, '+')
    countUp(this.$('[data-r="bingo"]'), m.newBingo, dur)
    this.$('.chip-bingo').classList.toggle('hot', m.newBingo > 0)
    const list = this.$('.st-names')
    list.innerHTML = ''
    this.addNames(m.challengeWins.map((x) => ({ ...x, label: '上位チャレンジ成功' })), 'chal')
    this.addNames(m.names, '')
    if (m.newBingo > m.names.length) list.append(h('li', 'more', `ほか ${fmt(m.newBingo - m.names.length)} 人`))
    const wins = m.newBingo + m.challengeWins.length
    if (wins > 0) {
      this.later(600, () => {
        sfx.fanfare(wins >= 10 ? 'big' : wins >= 3 ? 'medium' : 'small')
        this.fx.speed = this.clock.speed
        this.fx.rain(Math.min(1000, 160 + 60 * wins), RAINBOW)
      })
      if (!this.firstBingo) {
        this.firstBingo = true
        this.setScene('bingo')
      }
    }
  }

  private addNames(names: { name: string; isMe: boolean; label?: string }[], cls: string): void {
    const list = this.$('.st-names')
    names.forEach((x, i) => {
      const li = h('li', [cls, x.isMe ? 'me' : ''].join(' ').trim(), `${x.isMe ? 'あなた' : esc(x.name)}${x.label ? `<small>${x.label}</small>` : ''}`)
      li.style.animationDelay = `${this.clock.scale(400 + 150 * i)}ms`
      list.append(li)
    })
  }

  private clearResult(): void {
    this.$('.st-result').classList.remove('on')
    this.$('.st-last b').textContent = '--'
    for (const k of ['hits', 'reach', 'bingo']) this.$(`[data-r="${k}"]`).textContent = '-'
    this.$('.chip-bingo').classList.remove('hot')
    this.$('.st-names').innerHTML = ''
  }

  // ---- 景品（当たった瞬間はスマホで見せる。大画面は名前と結果だけ） --------

  private onPrizeTime(m: MsgOf<'prizeTime'>): void {
    const list = this.$('.st-names')
    list.innerHTML = ''
    const label = (e: PrizeEntry) =>
      e.rarity === null
        ? 'ラストワン争奪で外れ'
        : `【${e.rarity}】${e.rankUp ? 'ランクアップ' : ''}${e.kind === 'challenge' ? 'チャレンジ成功' : ''}`
    this.addNames(
      m.entries.slice(0, 12).map((e) => ({ name: e.name, isMe: e.isMe, label: label(e) })),
      '',
    )
    if (m.entries.length > 12) list.append(h('li', 'more', `ほか ${fmt(m.entries.length - 12)} 人`))
    if (m.lastOne) {
      const pool = m.entries.filter((e) => e.kind === 'normal')
      void playLastOne(this.root, {
        speed: this.clock.speed,
        prizes: pool.filter((e) => e.rarity).length,
        entrants: pool.map((e) => ({ name: e.name, isMe: e.isMe, win: e.rarity !== null })),
      })
    }
  }

  private onGameOver(m: MsgOf<'gameOver'>): void {
    this.setTotals(m.totals)
    this.showOverlay(`
      <div class="fin">
        <h2>景品がなくなりました！</h2>
        <p>抽選 ${m.totals.drawCount} 回　／　ビンゴ ${fmt(m.totals.winners)} 人</p>
        <p class="muted">${m.leftoverUpper ? `残った上位 ${m.leftoverUpper} 個は、ダブルチャンスに回ります。` : ''}主催の「次へ」でダブルチャンスへ</p>
      </div>`)
    sfx.fanfare('big')
    this.fx.rain(500, RAINBOW)
  }

  // ---- ダブルチャンス -------------------------------------------------------

  private onDcEntry(m: MsgOf<'dcEntry'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.setScene('cooldown')
    this.dc?.destroy()
    // デモでは同じ PC から鳴るので、自分がガラポンを回すときは音をスマホ側に任せる（本番は大画面が鳴らす）
    this.dc = new DoubleChanceStage(this.root, { speed: this.clock.speed, sound: !m.meEligible })
    this.dc.entry(m.seconds)
  }

  private onDcSpin(m: MsgOf<'dcSpin'>): void {
    const dc = this.dc
    if (!dc) return
    dc.setEntrants(m.entrants)
    dc.spin()
    m.winners.forEach((w, i) => this.later(5000 + i * 900, () => dc.addWinner(w)))
  }

  // ---- 共通 -----------------------------------------------------------------

  private showOverlay(html: string): void {
    const ov = this.$('.st-overlay')
    ov.innerHTML = html
    ov.classList.add('on')
  }

  private hideOverlay(): void {
    this.$('.st-overlay').classList.remove('on')
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, this.clock.scale(ms)))
  }

  private cancelAll(): void {
    this.cancelBeats()
    this.timers.forEach((t) => window.clearTimeout(t))
    this.timers = []
  }

  // 新しいゲームで抽選の途中から抜けたとき、伸ばしていた音と下げていた BGM を戻す
  private resetSound(): void {
    sfx.silence()
    engine.duckBgm(1)
  }
}

// 会場ビュー: 仮想参加者全員のスマホを点で並べる（デモ専用。一人では見られない「会場が光る」様子を見る窓）
class Venue {
  private readonly ctx: CanvasRenderingContext2D
  private mode: 'idle' | 'sea' | 'rainbow' = 'idle'
  private flashN = 0
  private flashDraw = 0
  private flashUntil = 0
  private spotUntil = 0
  private until = 0
  private raf = 0

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly label: HTMLElement,
    private readonly source: VenueSource,
  ) {
    this.ctx = canvas.getContext('2d')!
  }

  reset(size: number): void {
    const step = Math.max(1, Math.ceil(size / 1000))
    this.label.textContent = `会場ビュー（仮想 ${fmt(size)} 台${step > 1 ? `・1/${step} を表示` : ''}）`
    this.mode = 'idle'
    this.flashN = 0
    this.refresh()
  }

  sea(): void {
    this.mode = 'sea'
    this.run(5000)
  }

  rainbow(): void {
    this.mode = 'rainbow'
    this.run(5000)
  }

  reveal(n: number, drawNo: number): void {
    this.mode = 'idle'
    this.flashN = n
    this.flashDraw = drawNo
    this.flashUntil = performance.now() + 1500
    this.spotUntil = performance.now() + 5000
    this.run(5100)
  }

  refresh(): void {
    this.draw(performance.now())
  }

  private run(ms: number): void {
    this.until = Math.max(this.until, performance.now() + ms)
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.loop(t))
  }

  private loop(t: number): void {
    this.draw(t)
    if (t < this.until) {
      this.raf = requestAnimationFrame((tt) => this.loop(tt))
    } else {
      this.raf = 0
      this.mode = 'idle'
      this.draw(t)
    }
  }

  private draw(t: number): void {
    const players = this.source()
    const { ctx, canvas } = this
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    if (!players.length) return
    const step = Math.max(1, Math.ceil(players.length / 1000))
    const count = Math.ceil(players.length / step)
    const cols = Math.ceil(Math.sqrt((count * W) / H))
    const rows = Math.ceil(count / cols)
    const pitch = Math.min(W / cols, H / rows)
    const dot = Math.max(2, pitch * 0.7)
    const ox = (W - cols * pitch) / 2
    const oy = (H - rows * pitch) / 2
    const flash = t < this.flashUntil ? (this.flashUntil - t) / 1500 : 0
    const spot = t < this.spotUntil
    let k = 0
    for (let i = 0; i < players.length; i += step, k++) {
      const p = players[i]
      let color = '#1c2445'
      if (this.mode === 'rainbow') {
        color = `hsl(${(t / 11 + k * 7) % 360} 90% 62%)` // 明るさは一定のまま、色だけゆっくり回す
      } else if (spot && p.bingoDraw === this.flashDraw) {
        color = `hsl(${(t / 6 + k * 13) % 360} 95% 65%)` // 今回ビンゴの人を虹色に（係員が見つける目印にもなる）
      } else if (flash > 0 && p.cells.includes(this.flashN)) {
        color = `rgba(245, 197, 66, ${0.35 + 0.65 * flash})`
      } else if (p.challenge) {
        color = '#b98cff'
      } else if (p.bingoDraw !== null) {
        color = '#8a6d1d'
      } else if (p.reach > 0) {
        color = this.mode === 'sea' ? `rgba(255, 90, 60, ${0.6 + 0.4 * Math.sin(t / 159)})` : '#5c2a20'
      }
      const x = ox + (k % cols) * pitch + (pitch - dot) / 2
      const y = oy + Math.floor(k / cols) * pitch + (pitch - dot) / 2
      ctx.fillStyle = color
      ctx.fillRect(x, y, dot, dot)
      if (p.isMe) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 2
        ctx.strokeRect(x - 2, y - 2, dot + 4, dot + 4)
      }
    }
  }
}
