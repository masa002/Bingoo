import { FREE_CELL, FREE_MASK, LETTERS, bingoCells, deriveCard, labelOf, lineState, maskOf, waitingCells } from '../core/card'
import { TIER_SHAPE, TIER_WORD, type Tier } from '../core/show'
import type { Clock } from '../demo/clock'
import type { LocalHub } from '../net/hub'
import type { Msg, MsgOf, PrizeEntry } from '../net/protocol'
import { esc, fit, fmt, h, q, replay } from './dom'
import { GOLD, Particles, RAINBOW } from './particles'

// 参加者のスマホ（390×844 で組んで縮小表示する）。
// 自分のカードはシードとカード番号から手元で作り、届いた番号で自分で塗る（本番と同じ）。
// 本番の方針どおり、スマホは音を出さない

export type PhoneCommand = { type: 'join' } | { type: 'openPack' }

const PHONE_HTML = `
<div class="ph-glow"></div>
<div class="ph-status"><span class="ph-time">9:41</span><span>●●● 100%</span></div>
<div class="ph-tier" data-heat="-1"><span class="ph-shape"></span><span class="ph-word">待機中</span></div>
<div class="ph-head"><div><b class="ph-name">あなた</b><small class="ph-no"></small></div><div class="ph-count"></div></div>
<div class="ph-chips"><div class="ph-wait"></div><div class="ph-notice"></div></div>
<div class="ph-card">
  <div class="ph-letters">${LETTERS.map((l) => `<span>${l}</span>`).join('')}</div>
  <div class="ph-grid"></div>
</div>
<div class="ph-latest"><small>最新の番号</small><b>--</b></div>
<div class="ph-history"></div>
<div class="ph-toast"></div>
<canvas class="ph-fx" width="390" height="844"></canvas>
<div class="ph-overlay"></div>
`

const BPM = [0, 72, 96, 120, 140]

export class PhoneView {
  private readonly root: HTMLDivElement
  private readonly fx: Particles
  private cells: number[] = []
  private mask = FREE_MASK
  private won = false
  private joined = false
  private rank = 0
  private name = 'あなた'
  private cardNo = 0
  private history: number[] = []
  private stats = { hits: 0, maxReach: 0, nearMiss: 0 }
  private timers: number[] = []
  private intervals: number[] = []
  private cancelBeats: () => void = () => {}
  private pulse: Animation | null = null
  private myPrize: PrizeEntry | null = null
  private packOpened = false
  private bingoDoneAt = 0 // ビンゴの演出が終わる時刻（パックはその後に出す）

  constructor(
    host: HTMLElement,
    hub: LocalHub,
    private readonly clock: Clock,
    private readonly send: (cmd: PhoneCommand) => void,
  ) {
    this.root = h('div', 'phone', PHONE_HTML)
    host.append(this.root)
    fit(this.root, 390, 844)
    this.fx = new Particles(this.$<HTMLCanvasElement>('.ph-fx'), 600)
    hub.subscribe((m) => this.on(m))
  }

  private $<T extends HTMLElement = HTMLElement>(selector: string): T {
    return q<T>(this.root, selector)
  }

  private on(m: Msg): void {
    switch (m.type) {
      case 'snapshot':
        return this.onSnapshot(m)
      case 'joined':
        this.$('.ph-count').textContent = `参加 ${fmt(m.count)}人`
        return
      case 'drawScheduled':
        if (!this.joined) this.join() // 受付を締め切ったら自動で参加する
        return this.onScheduled(m)
      case 'awaitPush':
        this.$('.ph-word').textContent = 'PUSH 待ち…'
        return
      case 'numberRevealed':
        return this.onRevealed(m)
      case 'bulkDrawn':
        return this.onBulk(m.numbers)
      case 'prizeTime': {
        const mine = m.entries.find((e) => e.isMe)
        if (mine) {
          this.myPrize = mine
          this.packOpened = false
          const wait = Math.max(this.clock.scale(500), this.bingoDoneAt - performance.now())
          this.timers.push(window.setTimeout(() => this.showPack(mine), wait))
        }
        return
      }
      case 'packOpened':
        if (this.myPrize && m.idx === this.myPrize.idx) this.openPack(false)
        return
      case 'prizeEnd':
        if (this.myPrize) this.closePack()
        return
      case 'gameOver':
        this.later(1200, () => this.showResult())
        return
      case 'idle':
      case 'prizeSpotlight':
      case 'notice':
        return
    }
  }

  // ---- 参加とカード ---------------------------------------------------------

  private onSnapshot(m: MsgOf<'snapshot'>): void {
    this.cancelAll()
    this.fx.clear()
    this.name = m.me.name
    this.cardNo = m.me.cardNo
    this.cells = deriveCard(m.seed, m.me.cardNo)
    this.mask = maskOf(this.cells, m.drawn)
    this.won = lineState(this.mask).bingo > 0
    this.rank = 0
    this.history = [...m.drawn]
    this.stats = { hits: 0, maxReach: 0, nearMiss: 0 }
    this.myPrize = null
    this.joined = false
    this.$('.ph-name').textContent = this.name
    this.$('.ph-no').textContent = `No.${String(this.cardNo).padStart(5, '0')}`
    this.$('.ph-count').textContent = `参加 0人`
    this.$('.ph-latest b').textContent = '--'
    this.setTier(-1, '待機中')
    this.renderGrid()
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
    this.root.querySelectorAll<HTMLElement>('.ph-cell').forEach((cell, i) => {
      cell.animate([{ transform: 'rotateY(90deg)', opacity: 0 }, { transform: 'rotateY(0)', opacity: 1 }], {
        duration: this.clock.scale(260),
        delay: this.clock.scale(i * 25),
        fill: 'backwards',
      })
    })
  }

  private renderGrid(): void {
    const waiting = new Set(this.won ? [] : waitingCells(this.mask))
    const line = new Set(bingoCells(this.mask))
    this.$('.ph-grid').innerHTML = this.cells
      .map((n, i) => {
        const cls = ['ph-cell']
        if (i === FREE_CELL) cls.push('free')
        if (this.mask & (1 << i)) cls.push('on')
        if (waiting.has(i)) cls.push('wait')
        if (line.has(i)) cls.push('line')
        return `<div class="${cls.join(' ')}" data-cell="${i}"><span>${i === FREE_CELL ? 'FREE' : n}</span></div>`
      })
      .join('')
    this.renderWait()
  }

  private renderWait(): void {
    const el = this.$('.ph-wait')
    if (this.won) {
      el.className = 'ph-wait done'
      el.textContent = `BINGO！ 第 ${this.rank || '-'} 位`
      return
    }
    const lines = lineState(this.mask).reach
    const cells = waitingCells(this.mask)
    if (!lines) {
      el.className = 'ph-wait'
      el.textContent = ''
      return
    }
    el.className = 'ph-wait on'
    const kind = lines >= 3 ? 'トリプルリーチ' : lines === 2 ? 'ダブルリーチ' : 'リーチ'
    el.textContent = `${kind}　あと ${cells.map((c) => labelOf(this.cells[c])).join('・')}`
  }

  private renderHistory(): void {
    this.$('.ph-history').innerHTML = this.history
      .slice(-12)
      .reverse()
      .map((n) => `<span class="${this.cells.includes(n) ? 'mine' : ''}">${labelOf(n)}</span>`)
      .join('')
  }

  private setTier(heat: number, word?: string): void {
    const el = this.$('.ph-tier')
    el.dataset.heat = String(heat)
    this.$('.ph-shape').textContent = heat >= 0 ? TIER_SHAPE[heat as Tier] : ''
    this.$('.ph-word').textContent = word ?? (heat <= 0 ? '抽選中' : TIER_WORD[heat as Tier])
  }

  // ---- 抽選中 ---------------------------------------------------------------

  private onScheduled(m: MsgOf<'drawScheduled'>): void {
    this.cancelAll()
    this.glow(null)
    this.$('.ph-notice').className = 'ph-notice'
    this.setTier(0)
    const inReach = !this.won && lineState(this.mask).reach > 0
    const heatKinds = new Set(['appear', 'holdChange', 'step', 'cutin', 'goldEdge', 'freeze', 'crack'])
    let heat = 0
    this.cancelBeats = this.clock.run(m.beats, (b) => {
      if (heatKinds.has(b.kind)) {
        this.setTier(b.heat)
        if (inReach && b.heat !== heat) this.heartbeat(b.heat)
        heat = b.heat
      }
      if (b.kind === 'sea' && inReach) this.glow('sea') // リーチの海: リーチの人のスマホだけ光る
      if (b.kind === 'rainbowPhones') this.glow('rainbow') // 確定: 全台が虹色
      if (b.kind === 'push') this.$('.ph-word').textContent = 'PUSH 待ち…'
    })
    if (m.notice !== 'none') {
      this.later(m.timing.reveal - 2000, () => this.notice('chance'))
      if (m.notice === 'kakutei') this.later(m.timing.reveal - 1000, () => this.notice('kakutei'))
    }
  }

  // リーチの人は「あと B12」が鼓動する。段階が上がるほど速くなる
  private heartbeat(heat: number): void {
    this.stopPulse()
    const bpm = BPM[heat] ?? 0
    if (!bpm) return
    this.pulse = this.$('.ph-wait').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], {
      duration: this.clock.scale(60000 / bpm),
      iterations: Infinity,
    })
  }

  private stopPulse(): void {
    this.pulse?.cancel()
    this.pulse = null
  }

  private notice(kind: 'chance' | 'kakutei'): void {
    const el = this.$('.ph-notice')
    el.textContent = kind === 'chance' ? 'チャンス' : '確定'
    el.className = `ph-notice ${kind}`
    replay(el, 'pop')
  }

  private glow(kind: 'sea' | 'rainbow' | 'hit' | null, ms = 0): void {
    const el = this.$('.ph-glow')
    el.className = kind ? `ph-glow ${kind}` : 'ph-glow'
    if (kind && ms) this.later(ms, () => (el.className = 'ph-glow'))
  }

  // ---- 公開 -----------------------------------------------------------------

  private onRevealed(m: MsgOf<'numberRevealed'>): void {
    this.cancelBeats()
    this.stopPulse()
    this.$('.ph-notice').className = 'ph-notice'
    this.setTier(-1, `${m.label} が出ました`)
    this.$('.ph-latest b').textContent = m.label
    replay(this.$('.ph-latest'), 'pop')
    this.history.push(m.n)
    this.renderHistory()

    const before = lineState(this.mask)
    const cell = this.cells.indexOf(m.n)
    if (cell < 0) {
      if (!this.won && before.reach > 0) this.stats.nearMiss++
      this.glow(null)
      return
    }
    this.mask |= 1 << cell
    this.stats.hits++
    const after = lineState(this.mask)
    const justWon = !this.won && after.bingo > 0
    if (justWon) {
      this.won = true
      this.rank = m.totals.winners - m.newBingo + 1
    }
    this.renderGrid()
    replay(this.$(`[data-cell="${cell}"]`), 'stamp')
    if (justWon) {
      this.bingoDoneAt = performance.now() + this.clock.scale(3900)
      this.glow('rainbow', 5000)
      this.later(300, () => this.bingoSequence())
    } else {
      this.glow('hit', 700)
      if (!this.won && after.reach > before.reach) {
        this.stats.maxReach = Math.max(this.stats.maxReach, after.reach)
        this.later(300, () => this.banner(after.reach >= 2 ? 'ダブルリーチ！' : 'リーチ！'))
      }
    }
  }

  private onBulk(numbers: number[]): void {
    let mine = 0
    for (const n of numbers) {
      this.history.push(n)
      const cell = this.cells.indexOf(n)
      if (cell >= 0) {
        this.mask |= 1 << cell
        mine++
      }
    }
    this.stats.hits += mine
    this.stats.maxReach = Math.max(this.stats.maxReach, lineState(this.mask).reach)
    this.renderGrid()
    this.renderHistory()
    this.$('.ph-latest b').textContent = labelOf(numbers[numbers.length - 1])
    this.toast(`早送り: ${numbers.length} 個（あなたのカードに ${mine} 個）`)
  }

  private banner(text: string): void {
    const el = h('div', 'ph-banner', text)
    this.root.append(el)
    el.animate(
      [
        { transform: 'translateY(-50%) scale(.6)', opacity: 0 },
        { transform: 'translateY(-50%) scale(1.05)', opacity: 1, offset: 0.2 },
        { transform: 'translateY(-50%) scale(1)', opacity: 1, offset: 0.8 },
        { transform: 'translateY(-50%) scale(1)', opacity: 0 },
      ],
      { duration: this.clock.scale(1400) },
    ).finished.then(() => el.remove(), () => el.remove())
  }

  private bingoSequence(): void {
    this.overlay(`
      <div class="ph-bingo">
        <div class="ph-bingo-letters">${'BINGO'
          .split('')
          .map((c, i) => `<span style="animation-delay:${this.clock.scale(800 + 150 * i)}ms">${c}</span>`)
          .join('')}</div>
        <p class="ph-rank" style="animation-delay:${this.clock.scale(1800)}ms">第 ${this.rank} 位</p>
      </div>`)
    this.fx.speed = this.clock.speed
    this.later(1800, () => this.fx.burst(195, 380, { count: 150, colors: RAINBOW, speed: 9 }))
    // 景品パックがあるときは、開封のあとで証明画面を出す
    this.later(3600, () => {
      if (!this.myPrize) this.proof()
    })
  }

  // 係員に見せる証明画面。動く時計と変わるコードで、スクリーンショットの使い回しを防ぐ
  private proof(): void {
    const line = new Set(bingoCells(this.mask))
    const mini = this.cells
      .map((n, i) => `<i class="${line.has(i) ? 'line' : this.mask & (1 << i) ? 'on' : ''}">${i === FREE_CELL ? '★' : n}</i>`)
      .join('')
    this.overlay(`
      <div class="ph-proof">
        <div class="ph-holo"></div>
        <h3>BINGO 証明</h3>
        <p class="ph-proof-name">${esc(this.name)} <small>No.${String(this.cardNo).padStart(5, '0')}</small></p>
        <p class="ph-proof-rank">第 ${this.rank} 位</p>
        <div class="ph-mini">${mini}</div>
        <p class="ph-proof-clock"></p>
        <p class="ph-proof-code">照合コード <b></b></p>
        <p class="ph-proof-note">係員にこの画面を見せてください</p>
        <button class="ph-close">カードに戻る</button>
      </div>`)
    const clockEl = this.$('.ph-proof-clock')
    const codeEl = this.$('.ph-proof-code b')
    const tick = () => {
      const now = new Date()
      clockEl.textContent = now.toLocaleTimeString('ja-JP')
      // デモでは 30 秒ごとに変わる番号を手元で作る（本番はサーバーが発行する）
      codeEl.textContent = String(1000 + ((Math.floor(now.getTime() / 30000) * 7919 + this.cardNo) % 9000))
    }
    tick()
    this.intervals.push(window.setInterval(tick, 1000))
    q(this.root, '.ph-close').addEventListener('click', () => this.closeOverlay())
  }

  // ---- 景品パック -----------------------------------------------------------

  private showPack(e: PrizeEntry): void {
    const edge = e.rarity ? e.edge : 'none'
    this.overlay(`
      <div class="ph-pack" data-glow="${e.glow}">
        <h3>景品パック</h3>
        <div class="ph-packbox">
          <div class="ph-prizecard" data-edge="${edge}"><b>${e.rarity ?? '券'}</b><span>${esc(e.prize ?? 'ダブルチャンス券 2 口')}</span>${e.lastOne ? '<i>ラストワン賞</i>' : ''}</div>
          <div class="ph-packart"><b>BINGOO</b><small>PACK</small><i class="ph-tear"></i></div>
        </div>
        <p class="ph-hint">横にスワイプ、またはタップ 3 回で開封</p>
        <p class="ph-auto">あと <b>10</b> 秒で自動で開きます</p>
        <p class="ph-code"></p>
      </div>`)
    const box = this.$('.ph-packbox')
    let startX: number | null = null
    let taps = 0
    box.addEventListener('pointerdown', (ev) => (startX = ev.clientX))
    box.addEventListener('pointermove', (ev) => {
      if (startX !== null && Math.abs(ev.clientX - startX) > 60) this.openPack(true)
    })
    box.addEventListener('pointerup', () => {
      startX = null
      if (++taps >= 3) this.openPack(true)
    })
    let left = 10
    const id = window.setInterval(() => {
      left--
      const b = this.root.querySelector('.ph-auto b')
      if (b) b.textContent = String(Math.max(0, left))
      if (left <= 0) window.clearInterval(id)
    }, this.clock.scale(1000))
    this.intervals.push(id)
  }

  // 自分で開けたときは権威に伝える。10 秒たって権威が開けたときは表示だけ
  private openPack(byMe: boolean): void {
    const e = this.myPrize
    if (!e || this.packOpened) return
    this.packOpened = true
    if (byMe) this.send({ type: 'openPack' })
    const pack = this.root.querySelector<HTMLElement>('.ph-pack')
    if (!pack) return
    pack.classList.add('open')
    this.root.querySelector('.ph-hint')?.remove()
    this.root.querySelector('.ph-auto')?.remove()
    const wait = { C: 500, R: 900, SR: 1800, UR: 3200 }[e.rarity ?? 'C']
    if (e.rarity === 'UR') this.later(900, () => pack.classList.add('freeze'))
    this.later(wait, () => {
      pack.classList.remove('freeze')
      pack.classList.add('flip')
      this.fx.speed = this.clock.speed
      if (e.rarity === 'SR' || e.rarity === 'UR') {
        this.fx.burst(195, 420, { count: e.rarity === 'UR' ? 260 : 140, colors: e.rarity === 'UR' ? RAINBOW : GOLD, speed: 8, shape: 'spark' })
      }
      if (e.upgrade) this.later(700, () => this.root.querySelector('.ph-prizecard')?.setAttribute('data-edge', 'rainbow'))
      const code = this.root.querySelector('.ph-code')
      if (code) code.innerHTML = e.prize ? `受け取りコード <b>${e.code}</b>` : '最後のダブルチャンス抽選に参加できます'
    })
  }

  private closePack(): void {
    const e = this.myPrize
    this.myPrize = null
    if (!e) return
    this.toast(e.prize ? `景品: ${e.prize}（受け取りコード ${e.code}）` : 'ダブルチャンス券 2 口を獲得')
    if (this.won) this.proof()
    else this.closeOverlay()
  }

  private showResult(): void {
    this.overlay(`
      <div class="ph-result">
        <h3>あなたの結果</h3>
        <ul>
          <li>カードに出た番号<b>${this.stats.hits} 個</b></li>
          <li>最大のリーチ<b>${this.stats.maxReach} 本</b></li>
          <li>「あと 1 つ」で外れた回数<b>${this.stats.nearMiss} 回</b></li>
        </ul>
        <p class="ph-result-main">${this.won ? `ビンゴ 第 ${this.rank} 位` : '今回はビンゴならず…'}</p>
        <p class="muted">外れた人向けのダブルチャンスは次の版で入れます</p>
      </div>`)
  }

  // ---- 共通 -----------------------------------------------------------------

  private overlay(html: string): void {
    this.intervals.forEach((t) => window.clearInterval(t))
    this.intervals = []
    const ov = this.$('.ph-overlay')
    ov.innerHTML = html
    ov.classList.add('on')
  }

  private closeOverlay(): void {
    this.intervals.forEach((t) => window.clearInterval(t))
    this.intervals = []
    this.$('.ph-overlay').classList.remove('on')
  }

  private toast(text: string): void {
    const el = this.$('.ph-toast')
    el.textContent = text
    replay(el, 'on')
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, this.clock.scale(ms)))
  }

  private cancelAll(): void {
    this.cancelBeats()
    this.stopPulse()
    this.timers.forEach((t) => window.clearTimeout(t))
    this.timers = []
  }
}
