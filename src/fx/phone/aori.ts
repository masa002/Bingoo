import { sfx } from '../../audio'
import { Particles } from '../particles'
import { GOLD, RAINBOW, TIER_SHAPE, TIER_WORD, type Tier } from '../theme'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { MOLE_SVG, boxIn, play, ring, settle, shake, sparkBurst } from './card'
import './aori.css' // card.css より後に読み込む（カードのマスを照らす規則を上書きするため）

// スマホの手元のあおり（390×844 のスマホ画面に重ねる層）。
// 段階は「次の番号が自分のカードにとって何を意味するか」で決まる（サーバーが決めて本人にだけ送る）:
//   0 青 = 静か（何もしないに近い）、1 緑・2 赤・3 金 = あおる（ガセあり）、4 虹 = 自分のビンゴ確定（100%）。
// 番号が出たら resolve で結果を渡す。あおったのに外れたら失敗演出（確変失敗のような）で終える。
//
//   const a = new Aori(phoneScreen)
//   a.start({ tier: 2, revealIn: 5600, waiting: ['B12'] })   // 大画面の公開までの ms に合わせて溜める
//   a.awaitPush()                                            // 大画面が PUSH 待ちに入った
//   await a.resolve({ outcome: 'reach', label: 'B12' })
//
// 層は host 全体（inset 0、z-index 10）。カードは透けて見える。赤以上では画面を少し暗くし、
// 同じ host の中にある CardView の「あと 1 つ」のマス（.fxc-cell.is-wait）にスポットライトを当てて脈動させる。
// 位置は CSS 変数で変えられる（既定は ui/phone.ts の並びに合わせた値）:
//   --fxa-bar-top（上部のバー、34px。名前の行に重なる）、--fxa-emblem-top（段階の文字の定位置、500px。カードの下）、
//   --fxa-chip-bottom（あと〇〇、下から 70px）、--fxa-center（叩きつける位置＝カードの中心、37%）

export type AoriOutcome = 'none' | 'hit' | 'reach' | 'double' | 'bingo'

const BAR_WORD = ['抽選中', TIER_WORD[1], TIER_WORD[2], TIER_WORD[3], TIER_WORD[4]] as const
// 途中の高まりの音を鳴らす位置（公開までの割合）
const PULSES: readonly (readonly number[])[] = [[], [0.5], [0.42, 0.64, 0.84], [0.36, 0.56, 0.74, 0.9], [0.55, 0.82]]
const HEART: Readonly<Record<Tier, readonly [number, number]>> = { 0: [0, 0], 1: [0, 0], 2: [76, 116], 3: [84, 128], 4: [0, 0] }
const COLORS: Readonly<Record<Tier, readonly string[]>> = {
  0: ['#3b82f6', '#9cc3ff', '#ffffff'],
  1: ['#22c55e', '#5aff8c', '#eafff0'],
  2: ['#ef4444', '#ffb03a', '#fff2a8', '#ffffff'],
  3: GOLD,
  4: RAINBOW,
}
const HERO_TEXT: Readonly<Record<Exclude<AoriOutcome, 'none'>, string>> = {
  hit: 'ヒット！',
  reach: 'あたり！',
  double: 'あたり！！',
  bingo: '大あたり！！',
}
const OUT_POWER: Readonly<Record<AoriOutcome, number>> = { none: 0, hit: 0, reach: 1, double: 2, bingo: 3 }
const FAIL_TEXT: Readonly<Record<1 | 2 | 3, string>> = { 1: 'ざんねん…', 2: '惜しい！', 3: '失敗…' }

// 砕けるときのかけら（段階の文字の箱を % で分けた多角形。すき間なく敷き詰める）
const SHARDS: readonly (readonly [number, number])[][] = [
  [[0, 0], [38, 0], [30, 45], [0, 60]],
  [[38, 0], [70, 0], [55, 40], [30, 45]],
  [[70, 0], [100, 0], [100, 35], [55, 40]],
  [[0, 60], [30, 45], [42, 100], [0, 100]],
  [[30, 45], [55, 40], [68, 70], [42, 100]],
  [[55, 40], [100, 35], [100, 75], [68, 70]],
  [[68, 70], [100, 75], [100, 100], [42, 100]],
]

// 縁取りした大きな文字
export function txt(text: string, cls = ''): string {
  return `<span class="fxa-txt ${cls}"><i>${text}</i><b>${text}</b></span>`
}

function emblemHtml(t: Tier): string {
  if (t === 3) return txt('BINGO') + txt('CHANCE')
  if (t === 4) return `${txt('確定')}<small>あなたのビンゴ確定！</small>`
  return txt(`${TIER_SHAPE[t]}${TIER_WORD[t]}`)
}

export class Aori {
  readonly el: HTMLElement
  private tl: Timeline
  private speed: number
  private tier: Tier | null = null
  private gen = 0 // start / cancel ごとに増やす（古い resolve が新しいあおりを消さないように）
  private px: Particles | null = null
  private lit: HTMLElement[] = []
  private dimLevel = 0

  constructor(host: HTMLElement, o: { speed?: number } = {}) {
    this.el = el('div', 'fxa')
    host.append(this.el)
    this.speed = o.speed ?? 1
    this.tl = new Timeline(this.speed)
    this.applyLoops()
  }

  setSpeed(speed: number): void {
    this.speed = speed
    this.tl.speed = speed
    if (this.px) this.px.speed = speed
    this.applyLoops()
  }

  // くり返しの動きの長さ。速度を上げても、回転は 10 秒に 1 周、明滅は 1 秒に約 1 回より速くしない
  private applyLoops(): void {
    const s = this.speed
    const set = (name: string, ms: number, min: number) => this.el.style.setProperty(name, `${Math.round(Math.max(min, ms / s))}ms`)
    set('--fxa-spin-ms', 20000, 10000)
    set('--fxa-hue-ms', 12000, 10000)
    set('--fxa-breathe-ms', 2400, 1000)
    set('--fxa-push-ms', 1600, 1000)
  }

  private $(selector: string): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(selector)
  }

  start(o: { tier: Tier; revealIn: number; waiting: readonly string[] }): void {
    this.reset()
    const tl = this.tl
    const t = o.tier
    const R = Math.max(1000, o.revealIn)
    const still = prefersReducedMotion()
    this.tier = t
    this.el.dataset.tier = String(t)
    const waits = o.waiting.map(escapeHtml).join('・')
    this.el.innerHTML = `
      <canvas class="fxa-dim"></canvas>
      ${t >= 1 ? '<i class="fxa-edge"></i>' : ''}
      ${t === 4 ? '<i class="fxa-wash"></i><div class="fxa-rays"><i></i></div>' : ''}
      <canvas class="fxa-px"></canvas>
      <div class="fxa-bar"><span class="fxa-shape">${TIER_SHAPE[t]}</span><b class="fxa-word">${BAR_WORD[t]}</b>${
        t === 1 && waits ? `<small class="fxa-bar-wait">あと ${waits}</small>` : ''
      }<i class="fxa-meter"><i></i></i></div>
      ${t >= 1 ? `<div class="fxa-emblem">${emblemHtml(t)}</div>` : ''}
      ${t >= 2 && waits ? `<div class="fxa-chip"><small>あと</small><b>${waits}</b></div>` : ''}
      <i class="fxa-flash"></i>`
    const W = this.el.clientWidth || 390
    const H = this.el.clientHeight || 844
    for (const c of this.el.querySelectorAll('canvas')) {
      c.width = W
      c.height = H
    }
    this.px = new Particles(this.el.querySelector<HTMLCanvasElement>('.fxa-px')!, 700)
    this.px.speed = this.speed

    // バー: 段階の色になり、公開までのメーターが伸びる
    const bar = this.$('.fxa-bar')!
    void play(bar, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], 240, tl)
    void play(this.$('.fxa-meter i')!, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], R, tl, { easing: 'linear', fill: 'forwards' })
    if (t === 0) return // 青: 静か。バーだけ

    void play(this.$('.fxa-edge')!, [{ opacity: 0, offset: 0 }], 500, tl)
    for (const f of PULSES[t]) tl.at(R * f, () => sfx.aoriPulse(t))
    if (t >= 2) {
      tl.at(80, () => {
        this.light(t)
        this.dimOn(tl, t === 2 ? 0.42 : 0.48)
      })
    }
    if (t === 4) this.kakutei(tl, R, still)
    else this.cutIn(tl, t, R, still)
    if (still) return
    if (t === 2 || t === 3) {
      // 鼓動は公開の少し前まで。最後は「間（ま）」で止める
      void this.heartbeat(tl, t, R * 0.28, R - 650)
      tl.at(R - 650, () => this.ma(tl))
    }
    if (t === 3) void this.dust(tl, GOLD, 900, 650)
    if (t === 4) void this.dust(tl, RAINBOW, Math.min(1400, Math.max(450, R * 0.18)) + 300, 700)
  }

  // 中央に叩きつけて、バーの下の定位置へ移る（緑・赤・金）
  private cutIn(tl: Timeline, t: Tier, R: number, still: boolean): void {
    const em = this.$('.fxa-emblem')
    if (!em) return
    const at = Math.min(900, Math.max(250, R * 0.12))
    tl.at(at + 150, () => {
      sfx.aoriStart(t)
      if (t === 3) shake(this.el.parentElement ?? this.el, tl, 5, 240)
      const b = boxIn(em, this.el)
      this.px?.burst(b.x + b.w / 2, this.centerY(), { count: [0, 24, 40, 70, 0][t], colors: COLORS[t], speed: 7, shape: 'spark', life: 40 })
    })
    if (still) {
      void play(em, [{ opacity: 0 }, { opacity: 1 }], 300, tl, { delay: at, fill: 'backwards' })
      return
    }
    this.slam(tl, em, at, t === 1 ? 600 : 850, 2)
  }

  // 段階の文字を中央で叩きつけ、hold のあいだ見せてから定位置へ移す
  private slam(tl: Timeline, em: HTMLElement, at: number, hold: number, big: number): void {
    const b = boxIn(em, this.el)
    const dy = this.centerY() - (b.y + b.h / 2)
    // 叩きつけるときの大きさは、画面の幅に収まるまで（縁取りの分の余白を残す）
    const wide = Math.max(1, ...[...em.querySelectorAll('.fxa-txt')].map((n) => boxIn(n, this.el).w))
    const scale = Math.max(1, Math.min(big, ((this.el.clientWidth || 390) - 44) / wide))
    const total = 260 + hold + 420
    const o1 = 260 / total
    const o2 = (260 + hold) / total
    const at0 = `translateY(${dy}px)`
    void play(
      em,
      [
        { transform: `${at0} scale(${scale * 1.6})`, opacity: 0, offset: 0, easing: 'cubic-bezier(.2,.9,.3,1)' },
        { transform: `${at0} scale(${scale * 0.92})`, opacity: 1, offset: o1 * 0.6 },
        { transform: `${at0} scale(${scale * 1.03})`, opacity: 1, offset: o1 * 0.85 },
        { transform: `${at0} scale(${scale})`, opacity: 1, offset: o1 },
        { transform: `${at0} scale(${scale})`, opacity: 1, offset: o2, easing: 'cubic-bezier(.5,0,.2,1)' },
        { transform: 'translateY(0px) scale(1)', opacity: 1, offset: 1 },
      ],
      total,
      tl,
      { delay: at, fill: 'backwards', easing: 'linear' },
    )
  }

  // 虹: 静止 → ヒビ → 「確定」。虹の背景がゆっくり回る
  private kakutei(tl: Timeline, R: number, still: boolean): void {
    const at = Math.min(1400, Math.max(450, R * 0.18))
    const em = this.$('.fxa-emblem')!
    const wash = this.$('.fxa-wash')!
    const rays = this.$('.fxa-rays')!
    if (still) {
      tl.at(at, () => sfx.aoriStart(4))
      void play(em, [{ opacity: 0 }, { opacity: 1 }], 300, tl, { delay: at, fill: 'backwards' })
      return
    }
    wash.style.opacity = '0'
    rays.style.opacity = '0'
    this.crack(tl, at)
    tl.at(at, () => {
      sfx.aoriStart(4)
      wash.style.opacity = ''
      rays.style.opacity = ''
      // 全面の光はここの 1 回だけ（明るさの変化は 20% 以下、ゆっくり立ち上げる）
      void play(wash, [{ opacity: 0, offset: 0 }], 600, tl, { min: 300 })
      void play(rays, [{ opacity: 0, transform: 'scale(0.4)', offset: 0 }], 700, tl, { easing: 'cubic-bezier(.2,.8,.3,1)' })
      shake(this.el.parentElement ?? this.el, tl, 7, 280)
      this.px?.burst((this.el.clientWidth || 390) / 2, this.centerY(), { count: 160, colors: RAINBOW, speed: 10, shape: 'spark', life: 60 })
    })
    this.slam(tl, em, at - 120, 1700, 2.2)
  }

  // 画面を横切るヒビ（虹の前ぶれ）
  private crack(tl: Timeline, until: number): void {
    const W = this.el.clientWidth || 390
    const H = this.el.clientHeight || 844
    const y = this.centerY()
    let d = `M -10 ${y}`
    for (let x = 30; x < W + 40; x += 40) d += ` L ${x} ${y + (Math.random() - 0.5) * 44}`
    const b1 = `M ${W * 0.3} ${y} l 22 -38 l 10 -30`
    const b2 = `M ${W * 0.68} ${y} l -18 40 l 14 34`
    const svg = el('div', '', `<svg class="fxa-crack" viewBox="0 0 ${W} ${H}"><path pathLength="1" d="${d}"/><path pathLength="1" d="${b1}"/><path pathLength="1" d="${b2}"/></svg>`)
    const node = svg.firstElementChild!
    this.el.append(node)
    node.querySelectorAll('path').forEach((p, i) => {
      void play(p, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], until * (i ? 0.3 : 0.55), tl, {
        delay: until * (i ? 0.55 : 0.2),
        fill: 'both',
        easing: 'cubic-bezier(.5,0,.3,1)',
      })
    })
    tl.at(until, () => {
      void play(node, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.25)' }], 320, tl, { fill: 'forwards' }).then(() =>
        node.remove(),
      )
    })
  }

  // 暗くして、あと 1 つのマスだけスポットライトで抜く
  private dimOn(tl: Timeline, level: number): void {
    const c = this.el.querySelector<HTMLCanvasElement>('.fxa-dim')
    if (!c) return
    const ctx = c.getContext('2d')!
    const W = c.width
    const H = c.height
    ctx.clearRect(0, 0, W, H)
    const g = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.15, W / 2, H * 0.45, H * 0.75)
    g.addColorStop(0, 'rgba(2, 4, 12, 0.75)')
    g.addColorStop(1, 'rgba(2, 4, 12, 1)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'destination-out'
    for (const cell of this.lit) {
      const b = boxIn(cell, this.el)
      const x = b.x + b.w / 2
      const y = b.y + b.h / 2
      const r = b.w * 0.75
      const h = ctx.createRadialGradient(x, y, r * 0.55, x, y, r * 1.6)
      h.addColorStop(0, 'rgba(0, 0, 0, 1)')
      h.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = h
      ctx.fillRect(x - r * 2, y - r * 2, r * 4, r * 4)
    }
    ctx.globalCompositeOperation = 'source-over'
    this.dimLevel = level
    c.style.opacity = String(level)
    void play(c, [{ opacity: 0, offset: 0 }], 600, tl, { min: 200 })
  }

  // 同じ画面のカードの「あと 1 つ」のマスを照らす
  private light(t: Tier): void {
    this.unlight()
    const root = this.el.parentElement
    this.lit = root ? [...root.querySelectorAll<HTMLElement>('.fxc-cell.is-wait')] : []
    for (const c of this.lit) c.classList.add('fxa-lit', `fxa-lit-${t}`)
  }

  private unlight(): void {
    for (const c of this.lit) c.classList.remove('fxa-lit', 'fxa-lit-2', 'fxa-lit-3', 'fxa-lit-4')
    this.lit = []
  }

  // 鼓動: だんだん速くなる。明滅は 1 秒に約 2 回まで（実時間で 460ms より短くしない）
  private async heartbeat(tl: Timeline, t: Tier, from: number, until: number): Promise<void> {
    const [b0, b1] = HEART[t]
    if (!b0) return
    await tl.wait(from)
    let at = from
    while (!tl.cancelled && at < until) {
      const k = (at - from) / Math.max(1, until - from)
      const period = Math.max(60000 / (b0 + (b1 - b0) * k), 460 * tl.speed)
      this.beat(tl, period)
      await tl.wait(period)
      at += period
    }
  }

  // 1 拍: 段階の文字と「あと〇〇」がドクンと弾み、照らしたマスが光る
  private beat(tl: Timeline, period: number): void {
    const d = period * 0.7
    const thump: Keyframe[] = [
      { transform: 'scale(1)' },
      { transform: 'scale(1.08)', offset: 0.14 },
      { transform: 'scale(1)', offset: 0.3 },
      { transform: 'scale(1.04)', offset: 0.42 },
      { transform: 'scale(1)', offset: 0.6 },
      { transform: 'scale(1)' },
    ]
    for (const n of [this.$('.fxa-emblem'), this.$('.fxa-chip')]) if (n) void play(n, thump, d, tl, { composite: 'add' })
    for (const c of this.lit) {
      void play(c, thump, d, tl, { composite: 'add' })
      void play(
        c,
        [
          { filter: 'drop-shadow(0 0 0px rgba(255,215,94,0))' },
          { filter: 'drop-shadow(0 0 10px rgba(255,215,94,0.95))', offset: 0.15 },
          { filter: 'drop-shadow(0 0 2px rgba(255,215,94,0.3))' },
        ],
        d,
        tl,
      )
    }
    const dim = this.$('.fxa-dim')
    if (dim && this.dimLevel) {
      void play(dim, [{ opacity: this.dimLevel }, { opacity: this.dimLevel + 0.07, offset: 0.15 }, { opacity: this.dimLevel }], d, tl)
    }
  }

  // 間（ま）: 鼓動が止まり、少し暗くなって、文字がわずかに迫ってくる
  private ma(tl: Timeline): void {
    const dim = this.$('.fxa-dim')
    if (dim && this.dimLevel) {
      this.dimLevel += 0.08
      void play(dim, [{ opacity: this.dimLevel }], 500, tl, { fill: 'forwards' })
    }
    const em = this.$('.fxa-emblem')
    if (em) void play(em, [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }], 600, tl, { composite: 'add', fill: 'forwards' })
  }

  // 下から粒子が立ち上る（金・虹）。resolve か cancel まで続ける
  private async dust(tl: Timeline, colors: readonly string[], from: number, every: number): Promise<void> {
    await tl.wait(from)
    const W = this.el.clientWidth || 390
    const H = this.el.clientHeight || 844
    while (!tl.cancelled) {
      this.px?.rise(9, colors, 16, W - 16, H - 30)
      await tl.wait(every)
    }
  }

  private centerY(): number {
    const H = this.el.clientHeight || 844
    const v = getComputedStyle(this.el).getPropertyValue('--fxa-center').trim()
    return v.endsWith('%') ? (H * parseFloat(v)) / 100 : v.endsWith('px') ? parseFloat(v) : H * 0.37
  }

  awaitPush(): void {
    if (this.tier === null) return
    const tl = this.tl
    this.el.classList.add('is-push')
    const word = this.$('.fxa-word')
    if (word) word.textContent = 'PUSH 待ち…'
    this.$('.fxa-meter i')
      ?.getAnimations()
      .forEach((a) => a.finish())
    if (prefersReducedMotion()) return
    // ゆっくりした鼓動で待つ
    void (async () => {
      while (!tl.cancelled) {
        await tl.wait(Math.max(1200, 700 * tl.speed))
        if (!tl.cancelled) this.beat(tl, 1200)
      }
    })()
  }

  // 番号が出た。外れなら失敗演出（青・虹は静かに消える）、当たりなら「当たった！」の瞬間まで見せる
  async resolve(o: { outcome: AoriOutcome; label: string; rank?: number }): Promise<void> {
    const t = this.tier
    if (t === null) return
    // 溜めの演出を止めて、結果の演出に切り替える
    this.tl.cancel()
    const tl = (this.tl = new Timeline(this.speed))
    const gen = this.gen
    const still = prefersReducedMotion()
    this.el.classList.remove('is-push')
    const word = this.$('.fxa-word')
    if (word) word.textContent = o.outcome === 'none' ? o.label : `${o.label}！`
    this.$('.fxa-meter i')
      ?.getAnimations()
      .forEach((a) => a.finish())
    if (o.outcome === 'none') {
      if (t >= 1 && t <= 3) await this.fail(tl, t as 1 | 2 | 3, o.label, still)
      else await this.fadeAll(tl, 220)
    } else {
      await this.success(tl, t, o.outcome, o.label, still)
    }
    // 途中で start / cancel されたら、新しいほうを消さない
    if (this.gen === gen) this.reset()
  }

  private async success(tl: Timeline, t: Tier, outcome: Exclude<AoriOutcome, 'none'>, label: string, still: boolean): Promise<void> {
    const power = Math.min(4, Math.max(t, OUT_POWER[outcome]))
    const colors = COLORS[t]
    const W = this.el.clientWidth || 390
    const cy = this.centerY()
    if (t >= 1) sfx.aoriSuccess(t)
    this.el.classList.add('is-win')
    // 段階の文字がはじけて、暗さが引く
    const em = this.$('.fxa-emblem')
    if (em) {
      settle(em)
      const b = boxIn(em, this.el)
      void play(
        em,
        [
          { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
          { transform: 'scale(1.3)', opacity: 1, filter: 'brightness(1.5)', offset: 0.3 },
          { transform: 'scale(1.8)', opacity: 0, filter: 'brightness(1.8)' },
        ],
        480,
        tl,
        { fill: 'forwards' },
      )
      if (!still) this.px?.burst(b.x + b.w / 2, b.y + b.h / 2, { count: 24 + power * 16, colors, speed: 7, shape: 'spark', life: 45 })
    }
    for (const sel of ['.fxa-dim', '.fxa-chip', '.fxa-edge']) {
      const n = this.$(sel)
      if (!n) continue
      settle(n)
      void play(n, [{ opacity: 0 }], 420, tl, { fill: 'forwards' })
    }
    this.unlight()
    // 全面のやわらかい光は赤・金だけ（虹は始まりで使った。ビンゴはこのあと playBingo が使う）。20% 以下で、ゆっくり立ち上げる
    if (!still && (t === 2 || t === 3) && outcome !== 'bingo') {
      void play(this.$('.fxa-flash')!, [{ opacity: 0 }, { opacity: 0.16, offset: 0.2 }, { opacity: 0 }], 700, tl, { min: 600 })
    }
    // 当たりの番号を中央に叩きつける
    const hero = el('div', 'fxa-hero', `${txt(escapeHtml(label))}<span class="fxa-hero-text">${HERO_TEXT[outcome]}</span>`)
    hero.dataset.tier = String(t)
    hero.dataset.power = String(power)
    this.el.append(hero)
    if (still) {
      await tl.wait(1000)
      if (!tl.cancelled) await this.fadeAll(tl, 260)
      return
    }
    void play(
      hero,
      [
        { transform: 'translate(-50%, -50%) scale(2.4)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(0.92)', opacity: 1, offset: 0.55 },
        { transform: 'translate(-50%, -50%) scale(1.04)', opacity: 1, offset: 0.8 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      ],
      340,
      tl,
      { delay: 60, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    await tl.wait(250)
    if (tl.cancelled) return
    if (t >= 3) shake(this.el.parentElement ?? this.el, tl, t === 4 ? 7 : 5, 260)
    this.px?.burst(W / 2, cy, {
      count: [24, 50, 90, 140, 200][power],
      colors,
      speed: 6 + power,
      shape: power >= 3 ? 'rect' : 'spark',
      life: 60 + power * 10,
    })
    if (power >= 2) sparkBurst(this.el, W / 2, cy, tl, { count: 10, colors, dist: 150, size: 12, ms: 800, shape: 'star' })
    await tl.wait(480 + 120 * power)
    if (tl.cancelled) return
    // カードへ吸い込まれるように小さくなって消える（このあと組み込み側がスタンプを押す）
    void play(
      hero,
      [
        { transform: 'translate(-50%, -50%) translateY(0px) scale(1)', opacity: 1 },
        { transform: 'translate(-50%, -50%) translateY(70px) scale(0.45)', opacity: 0 },
      ],
      300,
      tl,
      { fill: 'forwards', easing: 'ease-in' },
    )
    await this.fadeAll(tl, 320)
  }

  // 確変失敗のように: 光がしぼみ、段階の文字が砕けて、ちょっと情けない文字が落ちてくる
  private async fail(tl: Timeline, t: 1 | 2 | 3, label: string, still: boolean): Promise<void> {
    sfx.aoriFail()
    this.el.classList.add('is-fail')
    this.px?.clear()
    this.unlight()
    for (const sel of ['.fxa-edge', '.fxa-chip', '.fxa-dim']) {
      const n = this.$(sel)
      if (!n) continue
      settle(n)
      void play(n, [{ opacity: 0 }], 520, tl, { fill: 'forwards' })
    }
    const em = this.$('.fxa-emblem')
    if (em && !still) {
      settle(em)
      void play(
        em,
        [
          { transform: 'scale(1, 1) translateY(0px)', filter: 'grayscale(0) brightness(1)' },
          { transform: 'scale(1.1, 0.9) translateY(0px)', filter: 'grayscale(0.3) brightness(1)', offset: 0.2 },
          { transform: 'scale(0.78, 0.74) translateY(6px)', filter: 'grayscale(1) brightness(0.7)' },
        ],
        460,
        tl,
        { fill: 'forwards', easing: 'cubic-bezier(.3,.6,.4,1)' },
      )
      const b = boxIn(em, this.el)
      this.onoma('プシュ～', b.x + b.w * 0.8, b.y + b.h * 0.2, tl)
    }
    await tl.wait(still ? 150 : 480)
    if (tl.cancelled) return
    if (em) {
      if (still) em.style.opacity = '0'
      else this.shatter(tl, em)
    }
    const msg = el('div', 'fxa-fail', `<b>${FAIL_TEXT[t]}</b><small>出たのは ${escapeHtml(label)}</small><i class="fxa-sweat"></i>`)
    this.el.append(msg)
    if (still) {
      await tl.wait(1200)
      if (!tl.cancelled) await this.fadeAll(tl, 300)
      return
    }
    // ドスンと落ちてきて、しょんぼり傾く
    void play(
      msg,
      [
        { transform: 'translate(-50%, -50%) translateY(-70px) rotate(0deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) translateY(8px) rotate(0deg)', opacity: 1, offset: 0.3 },
        { transform: 'translate(-50%, -50%) translateY(-4px) rotate(0deg)', opacity: 1, offset: 0.42 },
        { transform: 'translate(-50%, -50%) translateY(0px) rotate(0deg)', opacity: 1, offset: 0.55 },
        { transform: 'translate(-50%, -50%) translateY(6px) rotate(-7deg)', opacity: 1 },
      ],
      1100,
      tl,
      { fill: 'forwards', easing: 'ease-out' },
    )
    void play(
      msg.querySelector('.fxa-sweat')!,
      [
        { transform: 'rotate(45deg) translate(0px, 0px)', opacity: 0 },
        { transform: 'rotate(45deg) translate(0px, 0px)', opacity: 1, offset: 0.3 },
        { transform: 'rotate(45deg) translate(9px, 9px)', opacity: 0 },
      ],
      900,
      tl,
      { delay: 500, fill: 'backwards' },
    )
    await tl.wait(1350)
    if (!tl.cancelled) await this.fadeAll(tl, 320)
  }

  // 段階の文字を、かけらに分けて落とす
  private shatter(tl: Timeline, em: HTMLElement): void {
    settle(em)
    const t = em.style.transform
    const base = t && t !== 'none' ? t : ''
    const b = boxIn(em, this.el)
    for (const poly of SHARDS) {
      const s = em.cloneNode(true) as HTMLElement
      s.classList.add('fxa-shard')
      s.style.clipPath = `polygon(${poly.map(([x, y]) => `${x}% ${y}%`).join(', ')})`
      this.el.append(s)
      const cx = poly.reduce((a, [x]) => a + x, 0) / poly.length
      const dx = (cx - 50) * 1.8 + (Math.random() - 0.5) * 30
      const dy = 140 + Math.random() * 170
      const rot = (Math.random() - 0.5) * 90
      void play(
        s,
        [
          { transform: `${base} translate(0px, 0px) rotate(0deg)`, opacity: 1 },
          { transform: `${base} translate(${dx * 0.35}px, ${-16 - Math.random() * 18}px) rotate(${rot * 0.3}deg)`, opacity: 1, offset: 0.22 },
          { transform: `${base} translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 0 },
        ],
        900,
        tl,
        { fill: 'forwards', easing: 'cubic-bezier(.35,.1,.7,1)' },
      ).then(() => s.remove())
    }
    em.style.visibility = 'hidden'
    sparkBurst(this.el, b.x + b.w / 2, b.y + b.h / 2, tl, { count: 12, colors: ['#9aa3b8', '#c7cdd9', '#6b7390'], dist: 90, size: 6, ms: 700 })
  }

  // 擬音（「プシュ～」など）
  private onoma(text: string, x: number, y: number, tl: Timeline): void {
    const z = el('i', 'fxa-onoma', text)
    z.style.left = `${x}px`
    z.style.top = `${y}px`
    this.el.append(z)
    void play(
      z,
      [
        { transform: 'translate(-50%, -50%) scale(0.5) rotate(-8deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.05) rotate(-8deg)', opacity: 1, offset: 0.25 },
        { transform: 'translate(-30%, -90%) scale(1) rotate(-8deg)', opacity: 0 },
      ],
      800,
      tl,
    ).then(() => z.remove())
  }

  private async fadeAll(tl: Timeline, ms: number): Promise<void> {
    await play(this.el, [{ opacity: 1 }, { opacity: 0 }], ms, tl, { fill: 'forwards' })
  }

  // 何もしていない状態に戻す
  private reset(): void {
    this.gen++
    this.tl.cancel()
    this.tl = new Timeline(this.speed)
    this.unlight()
    this.px?.clear()
    this.px = null
    this.el.getAnimations().forEach((a) => a.cancel())
    this.el.replaceChildren()
    this.el.className = 'fxa'
    delete this.el.dataset.tier
    this.tier = null
    this.dimLevel = 0
  }

  cancel(): void {
    this.reset()
  }

  destroy(): void {
    this.reset()
    this.el.remove()
  }
}

// ---- 単発の演出（スマホ画面に重ねて、終わったら消える。z-index 22） ----------------

interface Shot {
  tl: Timeline
  layer: HTMLElement
  still: boolean
}

function shot(host: HTMLElement, cls: string, speed: number | undefined, html: string): Shot {
  const layer = el('div', `fxo ${cls}`, html)
  host.append(layer)
  return { tl: new Timeline(speed ?? 1), layer, still: prefersReducedMotion() }
}

function particlesIn(layer: HTMLElement, speed: number): Particles {
  const c = el('canvas', 'fxo-canvas')
  c.width = layer.clientWidth || 390
  c.height = layer.clientHeight || 844
  layer.append(c)
  const p = new Particles(c, 900)
  p.speed = speed
  return p
}

async function finish(s: Shot, ms = 260): Promise<void> {
  await play(s.layer, [{ opacity: 1 }, { opacity: 0 }], ms, s.tl, { fill: 'forwards' })
  s.layer.remove()
}

// 動きを減らす設定のとき: フェードで出して、同じくらいの長さだけ見せて消す
async function stillShow(s: Shot, hold: number): Promise<void> {
  await play(s.layer, [{ opacity: 0 }, { opacity: 1 }], 220, s.tl)
  await s.tl.wait(hold)
  return finish(s)
}

const POP: Keyframe[] = [
  { transform: 'scale(0.3)', opacity: 0 },
  { transform: 'scale(1.15)', opacity: 1, offset: 0.6 },
  { transform: 'scale(1)', opacity: 1 },
]

const SLAM: Keyframe[] = [
  { transform: 'scale(2.2)', opacity: 0 },
  { transform: 'scale(0.92)', opacity: 1, offset: 0.6 },
  { transform: 'scale(1)', opacity: 1 },
]

// 「リーチ！」（2 本以上なら「ダブルリーチ！」）と、あと 1 つの番号を大きく出す
export async function playReach(host: HTMLElement, o: { lines: number; waiting: readonly string[]; speed?: number }): Promise<void> {
  const double = o.lines >= 2
  const word = double ? 'ダブルリーチ！' : 'リーチ！'
  const s = shot(
    host,
    'fxo-reach',
    o.speed,
    `<div class="fxo-band"></div>
    <div class="fxo-reach-word">${[...word].map((c) => txt(c)).join('')}</div>
    ${o.waiting.length ? `<div class="fxo-reach-wait"><small>あと</small>${o.waiting.map((w) => `<b>${escapeHtml(w)}</b>`).join('')}</div>` : ''}
    ${o.lines >= 3 ? `<div class="fxo-reach-count">${o.lines} ライン同時！</div>` : ''}`,
  )
  const { tl, layer } = s
  layer.dataset.kind = double ? 'double' : 'single'
  if (s.still) {
    sfx.reach(o.lines)
    return stillShow(s, 1600)
  }
  const band = layer.querySelector<HTMLElement>('.fxo-band')!
  const letters = [...layer.querySelectorAll<HTMLElement>('.fxo-reach-word > .fxa-txt')]
  const pops = [...layer.querySelectorAll<HTMLElement>('.fxo-reach-wait small, .fxo-reach-wait b, .fxo-reach-count')]
  // 帯が左から差し込み、文字が 1 つずつ叩きつけられる
  void play(band, [{ transform: 'translateX(-110%) rotate(-7deg) scaleY(0.3)' }, { transform: 'translateX(0%) rotate(-7deg) scaleY(1)' }], 280, tl, {
    easing: 'cubic-bezier(.2,.8,.3,1)',
    fill: 'backwards',
  })
  letters.forEach((n, i) => {
    void play(
      n,
      [
        { transform: 'translateY(-60px) scale(2.2)', opacity: 0 },
        { transform: 'translateY(4px) scale(0.92)', opacity: 1, offset: 0.6 },
        { transform: 'translateY(0px) scale(1)', opacity: 1 },
      ],
      300,
      tl,
      { delay: 180 + i * 55, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
  })
  tl.at(220, () => sfx.reach(o.lines))
  const landed = 180 + (letters.length - 1) * 55 + 200
  tl.at(landed, () => {
    const W = layer.clientWidth || 390
    const y = (layer.clientHeight || 844) * 0.38
    const colors = double ? GOLD : ['#ffffff', '#ffe08a', '#ff7a3d']
    sparkBurst(layer, W / 2, y, tl, { count: double ? 18 : 12, colors, dist: 170, size: 10, ms: 700, shape: 'star' })
    if (double) shake(host, tl, 5, 240) // 金の帯のときだけ揺らす
  })
  pops.forEach((n, i) => void play(n, POP, 320, tl, { delay: landed + 80 + i * 90, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' }))
  await tl.wait(landed + 1350)
  // 帯ごと右へ抜ける
  void play(band, [{ transform: 'translateX(0%) rotate(-7deg)' }, { transform: 'translateX(110%) rotate(-7deg)' }], 300, tl, {
    easing: 'cubic-bezier(.5,0,.8,.5)',
    fill: 'forwards',
  })
  void play(layer.querySelector('.fxo-reach-word')!, [{ opacity: 1 }, { opacity: 0 }], 260, tl, { fill: 'forwards' })
  await tl.wait(160)
  return finish(s, 240)
}

const BALL = ['#ff5a5a', '#ffb84d', '#3ccf6e', '#3aa8ff', '#a85aff'] as const

// B・I・N・G・O の玉が落ちてきてそろい、「第 rank 位」と虹の紙吹雪
export async function playBingo(host: HTMLElement, o: { rank: number; speed?: number }): Promise<void> {
  const s = shot(
    host,
    'fxo-bingo',
    o.speed,
    `<i class="fxo-dim"></i>
    <div class="fxo-rays"><i></i></div>
    <div class="fxo-balls">${[...'BINGO'].map((c, i) => `<span class="fxo-ball" style="--c:${BALL[i]}"><b>${c}</b></span>`).join('')}</div>
    ${o.rank > 0 ? `<div class="fxo-rank">${txt(`第 ${o.rank} 位`)}</div>` : ''}
    <i class="fxo-flash"></i>`,
  )
  const { tl, layer } = s
  if (s.still) {
    sfx.bingo()
    return stillShow(s, 2800)
  }
  const px = particlesIn(layer, tl.speed)
  const W = layer.clientWidth || 390
  const rays = layer.querySelector<HTMLElement>('.fxo-rays')!
  rays.style.opacity = '0'
  void play(layer.querySelector('.fxo-dim')!, [{ opacity: 0 }, { opacity: 1 }], 300, tl)
  // 玉が 1 つずつ落ちて、つぶれて弾む
  const balls = [...layer.querySelectorAll<HTMLElement>('.fxo-ball')]
  const FIRST = 220
  const STEP = 150
  const DROP = 460
  balls.forEach((b, i) => {
    void play(
      b,
      [
        { transform: 'translateY(-560px) scale(0.9, 1.15)', offset: 0, easing: 'cubic-bezier(.55,0,1,.45)' },
        { transform: 'translateY(0px) scale(1.15, 0.82)', offset: 0.62, easing: 'ease-out' },
        { transform: 'translateY(-26px) scale(0.95, 1.06)', offset: 0.8, easing: 'ease-in' },
        { transform: 'translateY(0px) scale(1, 1)', offset: 1 },
      ],
      DROP,
      tl,
      { delay: FIRST + i * STEP, fill: 'backwards', easing: 'linear' },
    )
    tl.at(FIRST + i * STEP + DROP * 0.62, () => {
      const bb = boxIn(b, layer)
      px.burst(bb.x + bb.w / 2, bb.y + bb.h, { count: 14, colors: [BALL[i], '#ffffff'], speed: 5, shape: 'spark', life: 30 })
    })
  })
  await tl.wait(FIRST + (balls.length - 1) * STEP + DROP * 0.62)
  // そろった瞬間: 全面のやわらかい光（1 回だけ）、後光、紙吹雪
  sfx.bingo()
  void play(layer.querySelector('.fxo-flash')!, [{ opacity: 0 }, { opacity: 0.16, offset: 0.2 }, { opacity: 0 }], 700, tl, { min: 600 })
  rays.style.opacity = ''
  void play(rays, [{ opacity: 0, transform: 'scale(0.3)', offset: 0 }], 700, tl, { easing: 'cubic-bezier(.2,.8,.3,1)' })
  shake(host, tl, 6, 260)
  const row = boxIn(layer.querySelector('.fxo-balls')!, layer)
  px.burst(W / 2, row.y + row.h / 2, { count: 160, colors: RAINBOW, speed: 10 })
  px.rain(90, RAINBOW)
  balls.forEach((b, i) => {
    void play(b, [{ transform: 'translateY(0px)' }, { transform: 'translateY(-18px)', offset: 0.4 }, { transform: 'translateY(0px)' }], 360, tl, {
      delay: 200 + i * 70,
    })
  })
  const rank = layer.querySelector<HTMLElement>('.fxo-rank')
  if (rank) {
    void play(rank, SLAM, 360, tl, { delay: 380, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' })
    tl.at(560, () => {
      const rb = boxIn(rank, layer)
      sparkBurst(layer, W / 2, rb.y + rb.h / 2, tl, { count: 14, colors: GOLD, dist: 160, size: 11, ms: 800, shape: 'star' })
    })
  }
  await tl.wait(2500)
  return finish(s, 420)
}

// モグラの結果: hit なら「埋められた…」（lostReach ならリーチが消えた）、そうでなければ「セーフ！」
export async function playMoleResult(host: HTMLElement, o: { hit: boolean; lostReach: boolean; label?: string; speed?: number }): Promise<void> {
  const label = o.label ? escapeHtml(o.label) : ''
  const body = o.hit
    ? `<b class="fxo-mole-main">穴を埋められた…</b>
      ${label ? `<small class="fxo-mole-sub">${label} が土の中へ…</small>` : ''}
      ${o.lostReach ? '<div class="fxo-mole-lost"><span class="fxo-mole-chip">リーチ<i class="fxo-strike"></i></span><span>が消えた…</span></div>' : ''}`
    : '<b class="fxo-mole-main is-safe"><i>✓</i>セーフ！</b><small class="fxo-mole-sub">モグラはよそへ行った</small>'
  const s = shot(
    host,
    'fxo-mole',
    o.speed,
    `<i class="fxo-dim"></i>
    <div class="fxo-mole-box">
      <div class="fxo-mole-hole"><i class="fxo-mole-pit"></i><div class="fxo-mole-clip"><div class="fxo-mole-pop">${MOLE_SVG}</div></div><span class="fxo-say">${o.hit ? 'ｹｹｹ…' : 'ちぇっ'}</span></div>
      ${body}
    </div>`,
  )
  const { tl, layer } = s
  if (s.still) {
    if (o.hit) sfx.moleFill()
    else sfx.moleSafe()
    return stillShow(s, o.hit ? (o.lostReach ? 2200 : 1800) : 1300)
  }
  const px = particlesIn(layer, tl.speed)
  const pit = layer.querySelector<HTMLElement>('.fxo-mole-pit')!
  const mole = layer.querySelector<HTMLElement>('.fxo-mole-pop')!
  const face = mole.firstElementChild!
  const say = layer.querySelector<HTMLElement>('.fxo-say')!
  const main = layer.querySelector<HTMLElement>('.fxo-mole-main')!
  const sub = layer.querySelector<HTMLElement>('.fxo-mole-sub')
  void play(layer.querySelector('.fxo-dim')!, [{ opacity: 0 }, { opacity: 1 }], 300, tl)
  void play(
    layer.querySelector('.fxo-mole-box')!,
    [
      { transform: 'translateY(40px) scale(0.9)', opacity: 0 },
      { transform: 'translateY(0px) scale(1)', opacity: 1 },
    ],
    280,
    tl,
    { easing: 'cubic-bezier(.2,.8,.3,1)' },
  )
  void play(pit, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], 220, tl, { delay: 150, fill: 'backwards' })
  // モグラが穴から顔を出す
  void play(
    mole,
    [
      { transform: 'translateY(105%)', easing: 'cubic-bezier(.2,.9,.3,1.2)' },
      { transform: 'translateY(2%)', offset: 0.7 },
      { transform: 'translateY(8%)' },
    ],
    340,
    tl,
    { delay: 320, fill: 'both' },
  )
  tl.at(420, () => {
    const b = boxIn(pit, layer)
    px.burst(b.x + b.w / 2, b.y + b.h / 2, { count: 26, colors: ['#6e4a2a', '#93693f', '#4a2f19'], speed: 6, shape: 'rect', life: 40, size: 7 })
  })
  if (o.hit) {
    tl.at(460, () => sfx.moleFill())
    void play(
      main,
      [
        { transform: 'translateY(-30px)', opacity: 0 },
        { transform: 'translateY(4px)', opacity: 1, offset: 0.6 },
        { transform: 'translateY(0px)', opacity: 1 },
      ],
      340,
      tl,
      { delay: 520, fill: 'backwards' },
    )
    // しめしめ顔で揺れて笑う
    void play(
      face,
      [
        { transform: 'rotate(0deg)' },
        { transform: 'rotate(-10deg)', offset: 0.25 },
        { transform: 'rotate(10deg)', offset: 0.5 },
        { transform: 'rotate(-6deg)', offset: 0.75 },
        { transform: 'rotate(0deg)' },
      ],
      700,
      tl,
      { delay: 760 },
    )
    void play(say, POP, 300, tl, { delay: 800, fill: 'both' })
    if (sub) void play(sub, [{ opacity: 0 }, { opacity: 1 }], 300, tl, { delay: 900, fill: 'backwards' })
    let end = 2300
    if (o.lostReach) {
      // 「リーチ」の札に線が引かれ、色が抜けて傾く
      const lost = layer.querySelector<HTMLElement>('.fxo-mole-lost')!
      const chip = layer.querySelector<HTMLElement>('.fxo-mole-chip')!
      void play(lost, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0px)' }], 300, tl, { delay: 1150, fill: 'backwards' })
      void play(layer.querySelector('.fxo-strike')!, [{ transform: 'rotate(-12deg) scaleX(0)' }, { transform: 'rotate(-12deg) scaleX(1)' }], 260, tl, {
        delay: 1500,
        fill: 'forwards',
      })
      void play(
        chip,
        [
          { filter: 'grayscale(0) brightness(1)', transform: 'rotate(0deg) translateY(0px)' },
          { filter: 'grayscale(1) brightness(0.8)', transform: 'rotate(-8deg) translateY(4px)' },
        ],
        400,
        tl,
        { delay: 1700, fill: 'forwards' },
      )
      end = 2900
    }
    await tl.wait(end)
    void play(mole, [{ transform: 'translateY(8%)' }, { transform: 'translateY(105%)' }], 280, tl, { fill: 'forwards', easing: 'ease-in' })
  } else {
    // きょろきょろして……セーフ。モグラは残念そうに引っ込む
    void play(
      face,
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-14deg)', offset: 0.3 }, { transform: 'rotate(12deg)', offset: 0.7 }, { transform: 'rotate(0deg)' }],
      420,
      tl,
      { delay: 560 },
    )
    void play(main, SLAM, 320, tl, { delay: 960, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' })
    tl.at(1000, () => {
      sfx.moleSafe()
      const b = boxIn(main, layer)
      sparkBurst(layer, b.x + b.w / 2, b.y + b.h / 2, tl, { count: 12, colors: ['#22c55e', '#5aff8c', '#ffffff'], dist: 120, size: 9, ms: 700, shape: 'star' })
    })
    if (sub) void play(sub, [{ opacity: 0 }, { opacity: 1 }], 300, tl, { delay: 1250, fill: 'backwards' })
    void play(say, POP, 300, tl, { delay: 1250, fill: 'both' })
    void play(mole, [{ transform: 'translateY(8%)' }, { transform: 'translateY(105%)' }], 300, tl, { delay: 1500, fill: 'forwards', easing: 'ease-in' })
    await tl.wait(2100)
  }
  return finish(s, 300)
}

// 全員確定（虹玉）で自分のマスが開いた。label は開いた番号、newReach はそれでリーチになったか
export async function playWildResult(host: HTMLElement, o: { label: string; newReach: boolean; speed?: number }): Promise<void> {
  const s = shot(
    host,
    'fxo-wild',
    o.speed,
    `<i class="fxo-dim"></i>
    <div class="fxo-wild-orb"><i></i></div>
    <div class="fxo-wild-text">${txt('虹玉！', 'is-rainbow')}<p><b>${escapeHtml(o.label)}</b> が開いた！</p></div>
    ${o.newReach ? `<div class="fxo-wild-reach">${txt('リーチ！')}</div>` : ''}`,
  )
  const { tl, layer } = s
  if (s.still) {
    if (o.newReach) sfx.reach(1)
    return stillShow(s, o.newReach ? 2200 : 1700)
  }
  const px = particlesIn(layer, tl.speed)
  const orb = layer.querySelector<HTMLElement>('.fxo-wild-orb')!
  void play(layer.querySelector('.fxo-dim')!, [{ opacity: 0 }, { opacity: 1 }], 300, tl)
  // 虹玉が上から降りてきて、着地で虹の輪と火花
  void play(
    orb,
    [
      { transform: 'translateY(-420px) scale(0.6)', opacity: 0, easing: 'cubic-bezier(.5,0,.9,.6)' },
      { transform: 'translateY(0px) scale(1.12, 0.9)', opacity: 1, offset: 0.75, easing: 'ease-out' },
      { transform: 'translateY(0px) scale(1)', opacity: 1 },
    ],
    560,
    tl,
    { fill: 'backwards' },
  )
  await tl.wait(420)
  const ob = boxIn(orb, layer)
  const cx = ob.x + ob.w / 2
  const cy = ob.y + ob.h / 2
  ring(layer, cx, cy, 200, '#ffffff', tl, 700)
  px.burst(cx, cy, { count: 120, colors: RAINBOW, speed: 9, shape: 'spark', life: 50 })
  shake(host, tl, 4, 220)
  void play(layer.querySelector('.fxo-wild-text .fxa-txt')!, SLAM, 360, tl, { delay: 120, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' })
  void play(layer.querySelector('.fxo-wild-text p')!, POP, 320, tl, { delay: 380, fill: 'backwards' })
  if (o.newReach) {
    const reach = layer.querySelector<HTMLElement>('.fxo-wild-reach')!
    void play(
      reach,
      [
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(2.4)', opacity: 0 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(0.92)', opacity: 1, offset: 0.6 },
        { transform: 'translate(-50%, -50%) rotate(-8deg) scale(1)', opacity: 1 },
      ],
      320,
      tl,
      { delay: 900, fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    tl.at(1000, () => {
      sfx.reach(1)
      const b = boxIn(reach, layer)
      sparkBurst(layer, b.x + b.w / 2, b.y + b.h / 2, tl, { count: 12, colors: ['#ffffff', '#ffe08a', '#ff7a3d'], dist: 130, size: 10, ms: 700, shape: 'star' })
    })
  }
  await tl.wait(o.newReach ? 2300 : 1800)
  return finish(s, 320)
}
