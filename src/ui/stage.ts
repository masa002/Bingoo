import { LETTERS, columnOf } from '../core/card'
import type { Player } from '../core/game'
import { TIER_SHAPE, TIER_WORD, type Beat, type Tier } from '../core/show'
import type { Clock } from '../demo/clock'
import type { LocalHub } from '../net/hub'
import type { Msg, MsgOf, PrizeEntry, Totals } from '../net/protocol'
import { countUp, esc, fit, fmt, h, q, replay } from './dom'
import { GOLD, Particles, RAINBOW, TIER_COLORS } from './particles'
import { sound } from './sound'

// 会場の大画面（1920×1080 で組んで縮小表示する）。音はこの画面だけが鳴らす

export type VenueSource = () => readonly Player[]

const CARD_X = 810
const CARD_Y = 440

const STAGE_HTML = `
<div class="st-bg"></div>
<header class="st-hud">
  <div class="st-logo">BINGOO</div>
  <div class="st-stat"><span>参加</span><b data-k="size">0</b></div>
  <div class="st-stat"><span>リーチ</span><b data-k="reach">0</b></div>
  <div class="st-stat"><span>ビンゴ</span><b data-k="bingo">0</b></div>
  <div class="st-stat"><span>景品 残り</span><b data-k="prizes">0</b></div>
  <div class="st-odds">残り <b data-k="remaining">75</b> 個中　当たり番号 <b data-k="hits">0</b> 個</div>
</header>
<div class="st-hash"></div>
<div class="st-steps">${[1, 2, 3, 4, 5].map((i) => `<div class="st-step"><i>STEP</i><b>${i}</b></div>`).join('')}</div>
<div class="st-machine">
  <div class="st-halo"></div>
  <div class="st-pop">
    <div class="st-ring"></div>
    <div class="st-card">
      <div class="st-face">
        <div class="st-col">?</div>
        <div class="st-num">--</div>
        <div class="st-mark"><span class="st-shape">●</span><span class="st-word"></span></div>
      </div>
      <div class="st-back"><div class="st-back-logo">BINGOO<small>PACK</small></div></div>
    </div>
  </div>
  <div class="st-next">NEXT ▶</div>
</div>
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
<div class="st-telop"></div>
<div class="st-flyers"></div>
<div class="st-cutin"><div class="st-cutin-band"><b></b></div></div>
<div class="st-dim"></div>
<div class="st-crack"></div>
<div class="st-kakutei"><b>確定</b><span>せーの！</span></div>
<div class="st-push">PUSH!</div>
<canvas class="st-fx" width="1920" height="1080"></canvas>
<div class="st-overlay"></div>
<div class="st-watermark">DEMO・仮想参加者</div>
`

const tierColor = (t: Tier): string => (t === 4 ? '#f5c542' : TIER_COLORS[t])

export class StageView {
  private readonly root: HTMLDivElement
  private readonly fx: Particles
  private readonly venue: Venue
  private reelTimer = 0
  private timers: number[] = []
  private cancelBeats: () => void = () => {}
  private drawn = new Set<number>()
  private last = 0
  private prizeEntries: PrizeEntry[] = []

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
      case 'drawScheduled':
        return this.onScheduled(m)
      case 'awaitPush':
        this.$('.st-push').classList.add('on')
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
      case 'packOpened': {
        const e = this.prizeEntries.find((x) => x.idx === m.idx)
        if (e) this.openTile(e)
        return
      }
      case 'prizeSpotlight':
        return this.onSpotlight(m)
      case 'prizeEnd':
        this.hideOverlay()
        return
      case 'idle':
        this.setTotals(m.totals)
        return
      case 'gameOver':
        return this.onGameOver(m.totals)
      case 'notice':
        return
    }
  }

  // ---- 受付・盤面 ----------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.cancelAll()
    this.fx.clear()
    this.drawn = new Set(m.drawn)
    this.last = m.drawn[m.drawn.length - 1] ?? 0
    this.renderBoard()
    this.setTotals(m.totals)
    this.$('.st-hash').textContent = `抽選順と景品の並びのハッシュ ${m.deckHash.slice(0, 16)}…`
    this.resetMachine()
    this.clearResult()
    this.venue.reset(m.size)
    this.root.querySelectorAll('.st-step').forEach((s) => s.classList.remove('on'))
    if (m.phase === 'reception') {
      this.showOverlay(`
        <div class="rcp">
          <h2>受付中</h2>
          <div class="rcp-count"><b>0</b> / ${fmt(m.size)} 人</div>
          <p>右のスマホ枠の「参加する」を押してください</p>
          <p class="muted">主催の「次へ」で受付を締め切り、抽選を始めます</p>
        </div>`)
    } else {
      this.hideOverlay()
    }
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
    set('prizes', `${t.prizesLeft}/${t.prizeCount}`)
    set('remaining', String(t.remaining))
    set('hits', String(t.hitsLeft))
    this.$('.st-hash').classList.toggle('tampered', t.tampered)
  }

  // ---- 抽選の演出 -----------------------------------------------------------

  private onScheduled(m: MsgOf<'drawScheduled'>): void {
    this.hideOverlay()
    this.cancelAll()
    this.fx.speed = this.clock.speed
    this.clearResult()
    this.resetMachine()
    this.root.querySelectorAll('.st-step').forEach((s) => s.classList.remove('on'))
    if (m.tier === 4 && !m.plan.upgrade) this.showBack(true)
    this.cancelBeats = this.clock.run(m.beats, (b) => this.beat(b))
  }

  private beat(b: Beat): void {
    switch (b.kind) {
      case 'appear':
        this.setHeat(b.heat)
        this.$('.st-pop').animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], {
          duration: this.clock.scale(300),
          easing: 'cubic-bezier(.2,1.4,.4,1)',
        })
        sound.tick()
        break
      case 'spin':
        this.startReel(55)
        break
      case 'holdChange':
        this.setHeat(b.heat)
        replay(this.$('.st-ring'), 'pulse')
        sound.holdChange(b.heat)
        break
      case 'step':
        this.lightStep(b.index ?? 0, b.tier ?? 0)
        this.setHeat(b.heat)
        sound.step(b.index ?? 0)
        break
      case 'group':
        this.groupNotice()
        sound.flutter()
        break
      case 'pseudo':
        this.pseudo()
        break
      case 'cutin':
        this.cutin(b.tier ?? 1)
        this.setHeat(b.heat)
        sound.cutin(b.tier ?? 1)
        break
      case 'telop':
        this.telop(b.text ?? '')
        break
      case 'decel':
        this.startReel(150)
        break
      case 'riser':
        sound.riser(this.clock.scale(b.dur ?? 1200) / 1000)
        this.startReel(90)
        break
      case 'sea':
        this.venue.sea()
        break
      case 'heartbeat':
        this.startReel(260)
        sound.heartbeat(96 * this.clock.speed, this.clock.scale(b.dur ?? 1400))
        break
      case 'ma':
        this.stopReel('?', '?')
        this.dim(true)
        sound.silence()
        break
      case 'goldEdge':
        this.showBack(true)
        this.setHeat(3)
        this.fx.rise(160, GOLD, CARD_X - 260, CARD_X + 260, 820)
        sound.goldRise()
        break
      case 'freeze':
        this.stopReel('?', '?')
        this.showBack(true)
        this.setHeat(4)
        this.dim(true)
        sound.freeze()
        break
      case 'crack':
        this.dim(false)
        replay(this.$('.st-crack'), 'on')
        sound.crack()
        break
      case 'kakutei':
        replay(this.$('.st-kakutei'), 'on')
        this.fx.burst(CARD_X, 300, { count: 120, colors: RAINBOW, speed: 7, shape: 'dot', gravity: 0.05 })
        sound.kakutei()
        break
      case 'rainbowPhones':
        this.$('.st-kakutei').classList.remove('on')
        this.venue.rainbow()
        break
      case 'push':
        this.$('.st-push').classList.add('on')
        break
      case 'reveal':
        break // 実際の公開は numberRevealed で行う
    }
  }

  private setHeat(t: Tier): void {
    this.root.dataset.heat = String(t)
    this.$('.st-shape').textContent = TIER_SHAPE[t]
    this.$('.st-word').textContent = TIER_WORD[t]
  }

  private resetMachine(): void {
    this.stopReelTimer()
    this.setHeat(0)
    this.showBack(false)
    this.dim(false)
    this.$('.st-num').textContent = '--'
    this.$('.st-col').textContent = '?'
    for (const sel of ['.st-push', '.st-kakutei', '.st-crack', '.st-telop', '.st-next']) this.$(sel).classList.remove('on')
  }

  private showBack(on: boolean): void {
    this.$('.st-card').classList.toggle('back', on)
  }

  private dim(on: boolean): void {
    this.$('.st-dim').classList.toggle('on', on)
  }

  private startReel(interval: number): void {
    this.stopReelTimer()
    const num = this.$('.st-num')
    const col = this.$('.st-col')
    num.classList.add('spin')
    const pool = Array.from({ length: 75 }, (_, i) => i + 1).filter((n) => !this.drawn.has(n))
    const tick = () => {
      // 回転中の数字は見た目だけ（抽選結果とは関係ない）
      const n = pool[Math.floor(Math.random() * pool.length)]
      num.textContent = String(n)
      col.textContent = LETTERS[columnOf(n)]
    }
    tick()
    this.reelTimer = window.setInterval(tick, this.clock.scale(interval))
  }

  private stopReel(text: string, letter: string): void {
    this.stopReelTimer()
    this.$('.st-num').classList.remove('spin')
    this.$('.st-num').textContent = text
    this.$('.st-col').textContent = letter
  }

  private stopReelTimer(): void {
    if (this.reelTimer) window.clearInterval(this.reelTimer)
    this.reelTimer = 0
  }

  private lightStep(i: number, tier: Tier): void {
    const step = this.root.querySelectorAll<HTMLElement>('.st-step')[i]
    if (!step) return
    step.style.setProperty('--c', tierColor(tier))
    step.classList.add('on')
    step.animate([{ transform: 'scale(1.15)' }, { transform: 'scale(1)' }], { duration: this.clock.scale(260) })
  }

  private groupNotice(): void {
    const box = this.$('.st-flyers')
    for (let i = 0; i < 16; i++) {
      const card = h('div', 'st-flyer')
      card.style.top = `${120 + Math.random() * 640}px`
      box.append(card)
      card
        .animate([{ transform: 'translateX(-200px) rotate(-20deg)' }, { transform: 'translateX(2100px) rotate(25deg)' }], {
          duration: this.clock.scale(700 + Math.random() * 300),
          delay: this.clock.scale(i * 30),
          easing: 'ease-in',
        })
        .finished.then(() => card.remove(), () => card.remove())
    }
  }

  // 疑似連: 止まりかけて「NEXT」で回り直す
  private pseudo(): void {
    this.startReel(170)
    this.later(380, () => {
      this.stopReel('?', '?')
      sound.pseudoStop()
    })
    this.later(560, () => {
      replay(this.$('.st-next'), 'on')
      sound.nextChime()
    })
    this.later(780, () => this.startReel(55))
  }

  private cutin(tier: Tier): void {
    const box = this.$('.st-cutin')
    box.style.setProperty('--c', tierColor(tier))
    box.style.setProperty('--dur', `${this.clock.scale(900)}ms`)
    q(box, 'b').textContent = TIER_WORD[tier] || 'CHANCE'
    replay(box, 'go')
  }

  private telop(text: string): void {
    const el = this.$('.st-telop')
    el.textContent = text
    el.classList.add('on')
    this.later(2200, () => el.classList.remove('on'))
  }

  // ---- 公開と結果 -----------------------------------------------------------

  private onRevealed(m: MsgOf<'numberRevealed'>): void {
    this.cancelBeats()
    sound.silence()
    for (const sel of ['.st-push', '.st-kakutei', '.st-telop']) this.$(sel).classList.remove('on')
    this.dim(false)
    this.stopReel(String(m.n), LETTERS[columnOf(m.n)])
    this.showBack(false)
    this.setHeat(m.tier)
    this.drawn.add(m.n)
    this.last = m.n
    this.$('.st-pop').animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], {
      duration: this.clock.scale(220),
      easing: 'cubic-bezier(.2,1.6,.4,1)',
    })
    replay(this.$('.st-halo'), 'burst')
    this.fx.speed = this.clock.speed
    const colors = m.tier === 4 ? RAINBOW : m.tier === 3 ? GOLD : [TIER_COLORS[m.tier], '#ffffff']
    this.fx.burst(CARD_X, CARD_Y, {
      count: [40, 90, 160, 280, 520][m.tier],
      colors,
      speed: 8 + m.tier * 3,
      shape: m.tier >= 3 ? 'spark' : 'rect',
      gravity: m.tier >= 3 ? 0.12 : 0.25,
    })
    if (m.tier === 4) this.fx.rain(900, RAINBOW)
    sound.impact(m.tier)
    this.venue.reveal(m.n, m.totals.drawCount)
    this.renderBoard()
    this.showResult(m)
    this.setTotals(m.totals)
  }

  private showResult(m: MsgOf<'numberRevealed'>): void {
    this.$('.st-result').classList.add('on')
    this.$('.st-last b').textContent = m.label
    const dur = this.clock.scale(900)
    countUp(this.$('[data-r="hits"]'), m.hits, dur)
    countUp(this.$('[data-r="reach"]'), m.newReach, dur, '+')
    countUp(this.$('[data-r="bingo"]'), m.newBingo, dur)
    this.$('.chip-bingo').classList.toggle('hot', m.newBingo > 0)
    const list = this.$('.st-names')
    list.innerHTML = ''
    m.names.forEach((x, i) => {
      const li = h('li', x.isMe ? 'me' : '', x.isMe ? 'あなた' : esc(x.name))
      li.style.animationDelay = `${this.clock.scale(400 + 150 * i)}ms`
      list.append(li)
    })
    if (m.newBingo > m.names.length) list.append(h('li', 'more', `ほか ${fmt(m.newBingo - m.names.length)} 人`))
    if (m.newBingo > 0) {
      this.later(500, () => {
        sound.fanfare(m.newBingo >= 5)
        this.fx.rain(Math.min(1200, 200 + 60 * m.newBingo), m.tier === 4 ? RAINBOW : GOLD)
      })
    }
  }

  private clearResult(): void {
    this.$('.st-result').classList.remove('on')
    this.$('.st-last b').textContent = '--'
    for (const k of ['hits', 'reach', 'bingo']) this.$(`[data-r="${k}"]`).textContent = '-'
    this.$('.chip-bingo').classList.remove('hot')
    this.$('.st-names').innerHTML = ''
  }

  // ---- 景品ガチャ -----------------------------------------------------------

  private onPrizeTime(m: MsgOf<'prizeTime'>): void {
    this.prizeEntries = m.entries
    const shown = m.entries.slice(0, 8)
    const more = m.entries.length - shown.length
    const title = m.overflow
      ? `ラストワン争奪！<small>残り ${m.left} 個を ${m.entries.length} 人で</small>`
      : `景品ガチャ<small>${m.entries.length} 人が開封</small>`
    this.showOverlay(`
      <div class="pz">
        <h2>${title}</h2>
        <div class="pz-tiles">${shown.map(tileHtml).join('')}${more > 0 ? `<div class="pz-more">ほか ${more} 人</div>` : ''}</div>
        <div class="pz-spot"></div>
      </div>`)
    sound.holdChange(3)
    shown.forEach((e, i) => {
      if (!e.isMe) this.later(800 + i * 320, () => this.openTile(e)) // 自分のパックは自分で開ける
    })
  }

  private openTile(e: PrizeEntry): void {
    const tile = this.root.querySelector<HTMLElement>(`.pz-tile[data-idx="${e.idx}"]`)
    if (!tile || tile.classList.contains('open')) return
    tile.classList.add('open')
    sound.packTear()
    this.later(450, () => {
      tile.classList.add('flip')
      sound.rarity(e.rarity)
      if (e.rarity === 'SR' || e.rarity === 'UR') {
        const { x, y } = this.centerOf(tile)
        this.fx.burst(x, y, { count: e.rarity === 'UR' ? 220 : 120, colors: e.rarity === 'UR' ? RAINBOW : GOLD, speed: 9, shape: 'spark' })
      }
      if (e.upgrade) this.later(700, () => tile.setAttribute('data-edge', 'rainbow'))
    })
  }

  private onSpotlight(m: MsgOf<'prizeSpotlight'>): void {
    m.entries.forEach((e, i) => this.later(i * 4600, () => this.spotlight(e)))
    this.later(m.entries.length * 4600, () => this.root.querySelector('.pz-spot')?.classList.remove('on'))
  }

  // SR・UR は 1 人ずつ全画面で取り上げる
  private spotlight(e: PrizeEntry): void {
    const spot = this.root.querySelector<HTMLElement>('.pz-spot')
    if (!spot) return
    spot.innerHTML = `
      <div class="pz-big" data-edge="${e.edge}">
        <div class="pz-big-name">${esc(e.name)}</div>
        <div class="pz-big-card"><b>${e.rarity}</b><span>${esc(e.prize ?? '')}</span></div>
      </div>`
    spot.classList.add('on')
    const big = q(spot, '.pz-big')
    const reveal = () => {
      big.classList.add('flip')
      sound.rarity(e.rarity)
      this.fx.burst(960, 540, { count: e.rarity === 'UR' ? 420 : 200, colors: e.rarity === 'UR' ? RAINBOW : GOLD, speed: 12, shape: 'spark' })
      if (e.rarity === 'UR') this.fx.rain(600, RAINBOW)
      if (e.upgrade) this.later(700, () => big.setAttribute('data-edge', 'rainbow'))
    }
    if (e.rarity === 'UR') {
      sound.freeze()
      this.later(1000, () => {
        replay(this.$('.st-crack'), 'on')
        sound.crack()
      })
      this.later(1900, reveal)
    } else {
      this.later(700, reveal)
    }
  }

  private onGameOver(t: Totals): void {
    this.setTotals(t)
    this.showOverlay(`
      <div class="fin">
        <h2>全景品が出ました！</h2>
        <p>抽選 ${t.drawCount} 回　／　ビンゴ ${fmt(t.winners)} 人　／　景品 ${t.prizeCount} 個</p>
        <p class="muted">外れた人向けの企画（ダブルチャンス・最遅賞など）は次の版で入れます</p>
        <p class="muted">操作パネルの「新しいゲーム」でもう一度遊べます</p>
      </div>`)
    this.fx.rain(600, RAINBOW)
    sound.fanfare(true)
  }

  // ---- 共通 -----------------------------------------------------------------

  private centerOf(el: HTMLElement): { x: number; y: number } {
    const root = this.root.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const s = root.width / 1920
    return { x: (r.left + r.width / 2 - root.left) / s, y: (r.top + r.height / 2 - root.top) / s }
  }

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
    sound.silence()
  }
}

function tileHtml(e: PrizeEntry): string {
  const edge = e.rarity ? e.edge : 'none'
  return `
    <div class="pz-tile${e.isMe ? ' me' : ''}" data-idx="${e.idx}" data-glow="${e.glow}" data-edge="${edge}">
      <div class="pz-name">${e.isMe ? 'あなた' : esc(e.name)}</div>
      <div class="pz-card"><b>${e.rarity ?? '券'}</b><span>${esc(e.prize ?? 'ダブルチャンス券 2 口')}</span>${e.lastOne ? '<i>ラストワン賞</i>' : ''}</div>
      <div class="pz-pack"><span>BINGOO</span><small>PACK</small></div>
      ${e.isMe ? '<div class="pz-wait">スマホで開封中…</div>' : ''}
    </div>`
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
    this.run(7000)
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
