import './card.css'
import { sfx } from '../../audio'
import { GOLD, RAINBOW } from '../theme'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'

// スマホのビンゴカード（5×5 の本カードと、上位チャレンジの 3×3 カード）。
// 状態は setMarks でそのまま描き、変化の瞬間は stamp / wildOpen / moleFill などの演出で見せる。
// マスの位置は「行×size＋列」。中央は FREE（cells の値は 0）。
//
//   const card = new CardView(slot, { size: 5 })   // 横幅いっぱい（最大 362px で中央寄せ。390px の画面なら左右 14px）
//   card.setCells(cells)
//   card.setMarks(mask, { waiting: [7] })
//   await card.deal()
//   await card.stamp(7)
//
// 演出の途中のマスは setMarks で上書きせず、演出が終わったときに最新の状態で描き直す。
// 下の小さな部品（play / settle / shake / sparkBurst / ring / boxIn / MOLE_SVG）は aori.ts でも使う

export interface CardMarks {
  waiting?: readonly number[] // リーチで、あと 1 つのマス
  line?: readonly number[] // そろったラインのマス
  filled?: readonly number[] // モグラに埋められたマス（番号は出ているのに閉じている）
  wild?: readonly number[] // 全員確定（虹玉）で開いたマス
}

const LETTERS = ['B', 'I', 'N', 'G', 'O'] as const
const INK = ['#ff4f8b', '#e3206e', '#ff86ad'] as const
const SOIL = ['#6e4a2a', '#4a2f19', '#93693f', '#2f1d0e'] as const

// 裏から表へめくる（1 枚ずつ遠近を付ける）
const FLIP: Keyframe[] = [
  { transform: 'perspective(420px) rotateY(180deg) scale(0.92)' },
  { transform: 'perspective(420px) rotateY(-12deg) scale(1.04)', offset: 0.7 },
  { transform: 'perspective(420px) rotateY(0deg) scale(1)' },
]

// ---- 演出の小さな部品 --------------------------------------------------------

export interface PlayOptions {
  delay?: number
  easing?: string
  fill?: FillMode
  composite?: CompositeOperation
  min?: number // 実時間での最短の長さ（ms）。速度を上げても、光の立ち上がりなどを速くしすぎないため
}

// Web Animations を Timeline の速度で再生する。終わるか取り消されたら解決する
export function play(node: Element, frames: Keyframe[], ms: number, tl: Timeline, o: PlayOptions = {}): Promise<void> {
  if (tl.cancelled) return Promise.resolve()
  const a = node.animate(frames, {
    duration: Math.max(1, tl.ms(ms), o.min ?? 0),
    delay: tl.ms(o.delay ?? 0),
    easing: o.easing ?? 'ease-out',
    fill: o.fill ?? 'none',
    composite: o.composite ?? 'replace',
  })
  return a.finished.then(
    () => undefined,
    () => undefined,
  )
}

// 今の見た目のままアニメーションを片付ける（fill で残っていた値をインラインの style に移す）
export function settle(node: Element): void {
  for (const a of node.getAnimations()) {
    try {
      a.commitStyles()
    } catch {
      // 表示されていない要素では移せないので、そのまま止める
    }
    a.cancel()
  }
}

// 揺れ（金と虹のときだけ使う）。8px 以内、実時間で 300ms 以内に収める
export function shake(node: Element, tl: Timeline, px = 6, ms = 260): void {
  if (tl.cancelled || prefersReducedMotion()) return
  const a = Math.min(8, px)
  node.animate(
    [
      { transform: 'translate(0px, 0px)' },
      { transform: `translate(${-a}px, ${a * 0.4}px)` },
      { transform: `translate(${a * 0.8}px, ${-a * 0.3}px)` },
      { transform: `translate(${-a * 0.5}px, ${a * 0.2}px)` },
      { transform: `translate(${a * 0.25}px, 0px)` },
      { transform: 'translate(0px, 0px)' },
    ],
    { duration: Math.min(300, tl.ms(ms)), easing: 'ease-out', composite: 'add' },
  )
}

export interface SparkOptions {
  count?: number
  colors?: readonly string[]
  dist?: number // 飛ぶ距離（px）
  size?: number
  ms?: number
  shape?: 'diamond' | 'dot' | 'star' // star は ✦ の文字
  up?: number // 上向きの偏り（0〜1）
}

// 小さな火花を (x, y) から散らす。layer は position が relative か absolute の要素
export function sparkBurst(layer: HTMLElement, x: number, y: number, tl: Timeline, o: SparkOptions = {}): void {
  if (tl.cancelled || prefersReducedMotion()) return
  const n = o.count ?? 10
  const colors = o.colors ?? GOLD
  const shape = o.shape ?? 'diamond'
  for (let i = 0; i < n; i++) {
    const color = colors[i % colors.length]
    const size = (o.size ?? 7) * (0.6 + Math.random() * 0.8)
    const s = el('i', `fxc-spark is-${shape}`, shape === 'star' ? '✦' : '')
    s.style.left = `${x}px`
    s.style.top = `${y}px`
    if (shape === 'star') {
      s.style.color = color
      s.style.fontSize = `${size * 1.8}px`
    } else {
      s.style.width = s.style.height = `${size}px`
      s.style.background = color
    }
    layer.append(s)
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.8
    const d = (o.dist ?? 40) * (0.55 + Math.random() * 0.7)
    const dx = Math.cos(ang) * d
    const dy = Math.sin(ang) * d - (o.up ?? 0) * d
    const spin = (Math.random() - 0.5) * 300
    void play(
      s,
      [
        { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(0.3) rotate(0deg)', opacity: 1 },
        { transform: `translate(-50%, -50%) translate(${dx * 0.8}px, ${dy * 0.8}px) scale(1) rotate(${spin * 0.6}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(-50%, -50%) translate(${dx}px, ${dy + 10}px) scale(0.2) rotate(${spin}deg)`, opacity: 0 },
      ],
      (o.ms ?? 600) * (0.8 + Math.random() * 0.4),
      tl,
      { easing: 'cubic-bezier(.2,.7,.3,1)' },
    ).then(() => s.remove())
  }
}

// 広がって消える輪
export function ring(layer: HTMLElement, x: number, y: number, d: number, color: string, tl: Timeline, ms = 460): void {
  if (tl.cancelled || prefersReducedMotion()) return
  const r = el('i', 'fxc-ring')
  r.style.cssText = `left:${x - d / 2}px;top:${y - d / 2}px;width:${d}px;height:${d}px;color:${color}`
  layer.append(r)
  void play(r, [{ transform: 'scale(0.5)', opacity: 0.95 }, { transform: 'scale(1.55)', opacity: 0 }], ms, tl, {
    easing: 'cubic-bezier(.2,.8,.3,1)',
  }).then(() => r.remove())
}

// node の位置と大きさを、ref の中の座標（縮小表示の前の px）で返す
export function boxIn(node: Element, ref: HTMLElement): { x: number; y: number; w: number; h: number } {
  const r = node.getBoundingClientRect()
  const b = ref.getBoundingClientRect()
  const k = b.width / (ref.offsetWidth || b.width || 1) || 1
  return { x: (r.left - b.left) / k, y: (r.top - b.top) / k, w: r.width / k, h: r.height / k }
}

// モグラ（ヘルメットをかぶったいたずら者）。viewBox は 100×90
export const MOLE_SVG = `<svg viewBox="0 0 100 90" aria-hidden="true">
  <path d="M14 92 C14 38 30 18 50 18 C70 18 86 38 86 92 Z" fill="#6b4a2f"/>
  <path d="M24 30 C26 6 74 6 76 30 Z" fill="#f5c542"/>
  <rect x="19" y="27" width="62" height="5" rx="2.5" fill="#d9a520"/>
  <circle cx="50" cy="15" r="5" fill="#fff4cc" stroke="#d9a520" stroke-width="2"/>
  <path d="M33 37 L42 39.5 M67 37 L58 39.5" stroke="#2a1a0c" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="38" cy="45" r="3.6" fill="#140c06"/><circle cx="62" cy="45" r="3.6" fill="#140c06"/>
  <circle cx="39.2" cy="43.8" r="1.2" fill="#fff"/><circle cx="63.2" cy="43.8" r="1.2" fill="#fff"/>
  <ellipse cx="50" cy="61" rx="17" ry="12" fill="#c99a6e"/>
  <ellipse cx="50" cy="54" rx="7" ry="5" fill="#ff8fab"/>
  <ellipse cx="30" cy="57" rx="5" ry="3.5" fill="#ff8fab" opacity=".5"/><ellipse cx="70" cy="57" rx="5" ry="3.5" fill="#ff8fab" opacity=".5"/>
  <path d="M43 63 Q50 70 57 63" stroke="#5a3a20" stroke-width="2" fill="none" stroke-linecap="round"/>
  <ellipse cx="22" cy="80" rx="13" ry="9" fill="#e9b48f"/><ellipse cx="78" cy="80" rx="13" ry="9" fill="#e9b48f"/>
  <path d="M14 76v6M19 74v7M24 74v7M76 74v7M81 74v7M86 76v6" stroke="#fff4e6" stroke-width="2" stroke-linecap="round"/>
</svg>`

// size×size のカードのライン（横・縦・斜め）
function linesOf(n: number): number[][] {
  const r = [...Array(n).keys()]
  return [
    ...r.map((row) => r.map((c) => row * n + c)),
    ...r.map((c) => r.map((row) => row * n + c)),
    r.map((i) => i * n + i),
    r.map((i) => i * n + (n - 1 - i)),
  ]
}

// ---- カード ------------------------------------------------------------------

export class CardView {
  readonly el: HTMLElement
  private readonly tl: Timeline
  private readonly size: 5 | 3
  private readonly title: string
  private readonly head: HTMLElement
  private readonly grid: HTMLElement
  private readonly fx: HTMLElement
  private cells: number[] = []
  private nodes: HTMLElement[] = []
  private mask = 0
  private marks = { waiting: new Set<number>(), line: new Set<number>(), filled: new Set<number>(), wild: new Set<number>() }
  private readonly busy = new Set<number>() // 演出の途中のマス（setMarks で上書きしない）

  // title は 3×3 の見出し（既定は CHALLENGE）
  constructor(host: HTMLElement, o: { size: 5 | 3; speed?: number; title?: string }) {
    this.size = o.size
    this.title = o.title ?? 'CHALLENGE'
    this.el = el('div', 'fxc')
    this.el.dataset.size = String(o.size)
    const head =
      o.size === 5
        ? `<div class="fxc-head">${LETTERS.map((l) => `<span>${l}</span>`).join('')}</div>`
        : `<div class="fxc-title"><i>✦</i><b>${escapeHtml(this.title)}</b><i>✦</i></div>`
    this.el.innerHTML = `<div class="fxc-body">${head}<div class="fxc-grid"></div></div><div class="fxc-fx"></div>`
    this.head = this.el.querySelector<HTMLElement>('.fxc-head, .fxc-title')!
    this.grid = this.el.querySelector<HTMLElement>('.fxc-grid')!
    this.fx = this.el.querySelector<HTMLElement>('.fxc-fx')!
    host.append(this.el)
    this.tl = new Timeline(o.speed ?? 1)
    this.applySpeed()
  }

  setSpeed(speed: number): void {
    this.tl.speed = speed
    this.applySpeed()
  }

  // くり返す演出も速度に合わせて縮めるが、脈動は 1 秒に約 1 回まで、虹の色回りは 10 秒に 1 周までに抑える
  private applySpeed(): void {
    const s = this.tl.speed
    this.el.style.setProperty('--fxc-wait-ms', `${Math.round(Math.max(900, 1800 / s))}ms`)
    this.el.style.setProperty('--fxc-hue-ms', `${Math.round(Math.max(10000, 12000 / s))}ms`)
    this.el.style.setProperty('--fxc-gold-ms', `${Math.round(Math.max(3000, 6000 / s))}ms`)
  }

  setCells(cells: readonly number[]): void {
    const n = this.size * this.size
    this.cells = Array.from({ length: n }, (_, i) => cells[i] ?? 0)
    this.busy.clear()
    this.nodes = this.cells.map((num, i) => {
      const free = num === 0
      const node = el(
        'div',
        free ? 'fxc-cell is-free' : 'fxc-cell',
        `<div class="fxc-face"><i class="fxc-ink"></i><i class="fxc-soil"></i><b class="fxc-num">${free ? 'FREE' : num}</b><i class="fxc-frame"></i></div><div class="fxc-back"></div>`,
      )
      node.dataset.i = String(i)
      return node
    })
    this.grid.replaceChildren(...this.nodes)
    this.render()
  }

  setMarks(mask: number, marks: CardMarks = {}): void {
    this.mask = mask
    this.marks = {
      waiting: new Set(marks.waiting ?? []),
      line: new Set(marks.line ?? []),
      filled: new Set(marks.filled ?? []),
      wild: new Set(marks.wild ?? []),
    }
    this.render()
  }

  private render(): void {
    for (let i = 0; i < this.nodes.length; i++) this.apply(i)
  }

  // 1 マスの見た目を状態に合わせる（演出の途中のマスは触らない。ほかの層が付けたクラスも残す）
  private apply(i: number): void {
    const node = this.nodes[i]
    if (!node || this.busy.has(i)) return
    const free = this.cells[i] === 0
    const wild = !free && this.marks.wild.has(i)
    const filled = !free && !wild && this.marks.filled.has(i)
    const on = free || wild || (!filled && (this.mask & (1 << i)) !== 0)
    const c = node.classList
    c.toggle('is-on', on)
    c.toggle('is-wild', wild)
    c.toggle('is-filled', filled)
    c.toggle('is-wait', !on && this.marks.waiting.has(i))
    c.toggle('is-line', on && this.marks.line.has(i))
  }

  private lock(i: number): HTMLElement {
    this.busy.add(i)
    const node = this.nodes[i]
    node.classList.add('is-anim')
    return node
  }

  private unlock(i: number): void {
    this.busy.delete(i)
    this.nodes[i]?.classList.remove('is-anim', 'is-stamping')
    this.apply(i)
  }

  // マスの中心（カードの中の座標）
  private center(i: number): { x: number; y: number; w: number } {
    const b = boxIn(this.nodes[i], this.el)
    return { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w }
  }

  private part(i: number, selector: string): HTMLElement {
    return this.nodes[i].querySelector<HTMLElement>(selector)!
  }

  // ---- 番号が当たって穴が開く: ゴム印が押されて、インクが弾ける -----------------

  async stamp(cell: number): Promise<void> {
    const node = this.nodes[cell]
    if (!node) return
    const tl = this.tl
    this.mask |= 1 << cell
    this.marks.filled.delete(cell)
    this.marks.waiting.delete(cell)
    const ink = this.part(cell, '.fxc-ink')
    if (prefersReducedMotion()) {
      sfx.stamp()
      this.apply(cell)
      await play(ink, [{ opacity: 0 }, { opacity: 1 }], 240, tl)
      return
    }
    this.lock(cell)
    node.classList.remove('is-wait', 'is-filled', 'is-wild', 'is-line')
    node.classList.add('is-on', 'is-stamping')
    const { x, y, w } = this.center(cell)
    const d = w * 0.92
    const head = el('i', 'fxc-stamper')
    head.style.cssText = `left:${x - d / 2}px;top:${y - d / 2}px;width:${d}px;height:${d}px`
    this.fx.append(head)
    void play(
      head,
      [
        { transform: 'translateY(-38px) scale(1.75)', opacity: 0 },
        { transform: 'translateY(-4px) scale(1.06)', opacity: 1, offset: 0.42 },
        { transform: 'translateY(0px) scale(0.94)', opacity: 1, offset: 0.52 },
        { transform: 'translateY(-6px) scale(1.02)', opacity: 0.9, offset: 0.7 },
        { transform: 'translateY(-34px) scale(1.3)', opacity: 0 },
      ],
      380,
      tl,
      { easing: 'cubic-bezier(.45,0,.55,1)' },
    ).then(() => head.remove())
    await tl.wait(195)
    if (tl.cancelled) return
    // 押した瞬間: インクが付いて、マスが沈んでから弾む
    sfx.stamp()
    node.classList.remove('is-stamping')
    void play(
      ink,
      [
        { transform: 'scale(1.4)', opacity: 0 },
        { transform: 'scale(0.88)', opacity: 1, offset: 0.4 },
        { transform: 'scale(1.05)', opacity: 1, offset: 0.72 },
        { transform: 'scale(1)', opacity: 1 },
      ],
      380,
      tl,
    )
    void play(
      node,
      [
        { transform: 'scale(1)' },
        { transform: 'scale(0.86, 0.82)', offset: 0.22 },
        { transform: 'scale(1.12)', offset: 0.55 },
        { transform: 'scale(0.97)', offset: 0.8 },
        { transform: 'scale(1)' },
      ],
      440,
      tl,
    )
    void play(this.part(cell, '.fxc-num'), [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], 320, tl, {
      easing: 'cubic-bezier(.2,1.6,.4,1)',
    })
    sparkBurst(this.fx, x, y, tl, { count: 8, colors: INK, dist: w * 0.62, size: 6, ms: 440, shape: 'dot' })
    ring(this.fx, x, y, w * 0.86, '#ff6a9e', tl)
    await tl.wait(460)
    this.unlock(cell)
  }

  // ---- 虹玉で開く: 虹の光の柱が降りて、虹玉が落ちてきて穴が開く ---------------

  async wildOpen(cell: number): Promise<void> {
    const node = this.nodes[cell]
    if (!node) return
    const tl = this.tl
    this.mask |= 1 << cell
    this.marks.wild.add(cell)
    this.marks.filled.delete(cell)
    this.marks.waiting.delete(cell)
    const ink = this.part(cell, '.fxc-ink')
    if (prefersReducedMotion()) {
      sfx.wildOpen()
      this.apply(cell)
      await play(ink, [{ opacity: 0 }, { opacity: 1 }], 300, tl)
      return
    }
    this.lock(cell)
    node.classList.remove('is-on', 'is-wild', 'is-filled', 'is-wait', 'is-line')
    const { x, y, w } = this.center(cell)
    const top = -90 // カードの上から降りてくる
    const bw = w * 0.86
    const beam = el('i', 'fxc-beam')
    beam.style.cssText = `left:${x - bw / 2}px;top:${top}px;width:${bw}px;height:${y - top}px`
    this.fx.append(beam)
    void play(beam, [{ transform: 'scaleY(0)', opacity: 0 }, { transform: 'scaleY(1)', opacity: 1 }], 280, tl, {
      easing: 'cubic-bezier(.5,0,.8,.6)',
      fill: 'forwards',
    })
    const od = Math.max(20, w * 0.42)
    const orb = el('i', 'fxc-orb')
    orb.style.cssText = `left:${x - od / 2}px;top:${top - od / 2}px;width:${od}px;height:${od}px`
    this.fx.append(orb)
    void play(
      orb,
      [
        { transform: 'translateY(0px) scale(0.5)', opacity: 0 },
        { transform: `translateY(${(y - top) * 0.15}px) scale(1)`, opacity: 1, offset: 0.25 },
        { transform: `translateY(${y - top}px) scale(0.85)`, opacity: 1 },
      ],
      460,
      tl,
      { delay: 100, easing: 'cubic-bezier(.6,0,.9,.5)', fill: 'forwards' },
    )
    await tl.wait(560)
    orb.remove()
    if (tl.cancelled) return
    // 着地: 虹の穴が回りながら開く
    sfx.wildOpen()
    node.classList.add('is-on', 'is-wild')
    void play(
      ink,
      [
        { transform: 'scale(0) rotate(-120deg)', opacity: 0 },
        { transform: 'scale(1.25) rotate(12deg)', opacity: 1, offset: 0.55 },
        { transform: 'scale(1) rotate(0deg)', opacity: 1 },
      ],
      480,
      tl,
      { easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    void play(node, [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.35 }, { transform: 'scale(1)' }], 420, tl)
    ring(this.fx, x, y, w * 1.05, '#ffffff', tl, 560)
    sparkBurst(this.fx, x, y, tl, { count: 12, colors: RAINBOW, dist: w * 0.95, size: 8, ms: 700, shape: 'star' })
    shake(this.el, tl, 3, 200)
    void play(beam, [{ opacity: 1 }, { opacity: 0 }], 520, tl, { fill: 'forwards' }).then(() => beam.remove())
    await tl.wait(600)
    this.unlock(cell)
  }

  // ---- モグラが穴を埋める: 下から顔を出し、土を投げ込んで、ぺたぺたして引っ込む ----

  async moleFill(cell: number): Promise<void> {
    const node = this.nodes[cell]
    if (!node) return
    const tl = this.tl
    this.mask &= ~(1 << cell)
    this.marks.filled.add(cell)
    this.marks.wild.delete(cell)
    this.marks.line.delete(cell)
    const soil = this.part(cell, '.fxc-soil')
    const ink = this.part(cell, '.fxc-ink')
    if (prefersReducedMotion()) {
      sfx.moleFill()
      this.apply(cell)
      await play(soil, [{ opacity: 0 }, { opacity: 1 }], 300, tl)
      return
    }
    this.lock(cell)
    node.classList.remove('is-wait', 'is-line', 'is-filled', 'is-wild')
    node.classList.add('is-on')
    const face = this.part(cell, '.fxc-face')
    const pit = el('i', 'fxc-pit')
    const burrow = el('div', 'fxc-burrow', `<div class="fxc-mole">${MOLE_SVG}</div>`)
    face.append(pit, burrow)
    const mole = burrow.firstElementChild as HTMLElement
    const { x, y, w } = this.center(cell)

    // 1. 地面がもこもこして、穴があく
    void play(
      node,
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.03, 0.97)', offset: 0.25 },
        { transform: 'scale(0.98, 1.02)', offset: 0.5 },
        { transform: 'scale(1.02, 0.98)', offset: 0.75 },
        { transform: 'scale(1)' },
      ],
      300,
      tl,
    )
    void play(pit, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], 220, tl, { fill: 'forwards' })
    sparkBurst(this.fx, x, y + w * 0.3, tl, { count: 6, colors: SOIL, dist: w * 0.4, size: 5, ms: 420, shape: 'dot', up: 0.8 })
    await tl.wait(220)

    // 2. モグラが顔を出す
    void play(
      mole,
      [
        { transform: 'translateY(105%)', easing: 'cubic-bezier(.2,.9,.3,1.2)' },
        { transform: 'translateY(4%)', offset: 0.7 },
        { transform: 'translateY(10%)' },
      ],
      320,
      tl,
      { fill: 'forwards' },
    )
    await tl.wait(380)

    // 3. きょろきょろ
    void play(
      mole.firstElementChild!,
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-12deg)', offset: 0.3 }, { transform: 'rotate(10deg)', offset: 0.7 }, { transform: 'rotate(0deg)' }],
      400,
      tl,
    )
    await tl.wait(420)

    // 4. 土を投げ込む
    for (let k = 0; k < 7; k++) {
      const c = el('i', 'fxc-clod')
      const s = w * (0.1 + Math.random() * 0.08)
      c.style.cssText = `left:${x - s / 2}px;top:${y + w * 0.1 - s / 2}px;width:${s}px;height:${s}px;background:${SOIL[k % SOIL.length]}`
      this.fx.append(c)
      const tx = (Math.random() - 0.5) * w * 0.7
      const ty = (Math.random() - 0.5) * w * 0.5
      void play(
        c,
        [
          { transform: 'translate(0px, 0px) scale(0.6)', opacity: 1 },
          { transform: `translate(${tx * 0.5}px, ${-w * 0.55}px) scale(1.1)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${tx}px, ${ty}px) scale(1)`, opacity: 1 },
        ],
        300 + k * 18,
        tl,
        { delay: k * 26, easing: 'cubic-bezier(.3,.1,.6,1)' },
      ).then(() => c.remove())
    }
    await tl.wait(260)
    if (tl.cancelled) return
    sfx.moleFill()
    node.classList.remove('is-on')
    node.classList.add('is-filled')
    void play(soil, [{ clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)' }], 260, tl, { easing: 'cubic-bezier(.3,.7,.4,1)' })
    void play(ink, [{ opacity: 1 }, { opacity: 0 }], 260, tl)
    const z = el('i', 'fxc-onoma', 'ザッ')
    z.style.cssText = `left:${x + w * 0.32}px;top:${y - w * 0.5}px`
    this.fx.append(z)
    void play(
      z,
      [
        { transform: 'translate(-50%, -50%) scale(0.4) rotate(-10deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.1) rotate(-10deg)', opacity: 1, offset: 0.3 },
        { transform: 'translate(-50%, -70%) scale(1) rotate(-10deg)', opacity: 0 },
      ],
      620,
      tl,
    ).then(() => z.remove())

    // 5. ぺたぺた（押し固める）
    void play(
      mole,
      [
        { transform: 'translateY(10%)' },
        { transform: 'translateY(18%) scale(1.06, 0.92)', offset: 0.25 },
        { transform: 'translateY(10%)', offset: 0.5 },
        { transform: 'translateY(18%) scale(1.06, 0.92)', offset: 0.75 },
        { transform: 'translateY(10%)' },
      ],
      400,
      tl,
      { fill: 'forwards' },
    )
    await tl.wait(440)

    // 6. 引っ込む
    void play(mole, [{ transform: 'translateY(10%)' }, { transform: 'translateY(0%)', offset: 0.25 }, { transform: 'translateY(105%)' }], 320, tl, {
      easing: 'ease-in',
      fill: 'forwards',
    })
    void play(pit, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0)', opacity: 0 }], 260, tl, { delay: 200, fill: 'forwards' })
    await tl.wait(480)
    pit.remove()
    burrow.remove()
    void play(node, [{ transform: 'scale(1)' }, { transform: 'scale(1.06, 0.94)', offset: 0.4 }, { transform: 'scale(1)' }], 260, tl)
    this.unlock(cell)
  }

  // ---- そろったラインに光が走る ---------------------------------------------

  async celebrateLine(cells: readonly number[]): Promise<void> {
    const tl = this.tl
    const set = new Set(cells.filter((i) => i >= 0 && i < this.nodes.length))
    if (!set.size) return
    for (const i of set) this.marks.line.add(i)
    if (prefersReducedMotion()) {
      this.render()
      return
    }
    // 先に setMarks で金になっていても、いったん戻して、光が通ったマスから金にする
    const held = [...set].filter((i) => !this.busy.has(i))
    for (const i of held) {
      this.busy.add(i)
      this.nodes[i].classList.remove('is-line')
    }
    // 渡されたマスに含まれるラインごとに走らせる（ラインにならないときは番号順に）
    const full = linesOf(this.size).filter((line) => line.every((i) => set.has(i)))
    const runs = full.length ? full : [[...set].sort((a, b) => a - b)]
    const RUN = 460
    const GAP = 280
    runs.forEach((line, k) => tl.at(k * GAP, () => this.runLine(line, RUN)))
    await tl.wait((runs.length - 1) * GAP + RUN + 60)
    for (const i of held) this.busy.delete(i)
    if (tl.cancelled) return
    this.render()
    // 走りきったら、カードの縁が金に光る（金なので少し揺らす）
    void play(
      this.el,
      [
        { boxShadow: '0 0 0 rgba(245,197,66,0)' },
        { boxShadow: '0 0 36px rgba(245,197,66,0.85)', offset: 0.3 },
        { boxShadow: '0 0 0 rgba(245,197,66,0)' },
      ],
      800,
      tl,
    )
    shake(this.el, tl, 4, 220)
    await tl.wait(500)
    this.render()
  }

  private runLine(line: readonly number[], ms: number): void {
    const tl = this.tl
    const a = this.center(line[0])
    const b = this.center(line[line.length - 1])
    const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
    const track = el('div', 'fxc-track', '<i class="fxc-trail"></i><i class="fxc-comet"></i>')
    track.style.cssText = `left:${a.x}px;top:${a.y}px;width:${len}px;transform:rotate(${Math.atan2(b.y - a.y, b.x - a.x)}rad)`
    this.fx.append(track)
    const trail = track.firstElementChild!
    const comet = track.lastElementChild!
    void play(trail, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], ms, tl, { easing: 'linear', fill: 'forwards' }).then(() =>
      play(trail, [{ opacity: 1 }, { opacity: 0 }], 380, tl, { fill: 'forwards' }),
    )
    void play(
      comet,
      [
        { transform: 'translate(-50%, -50%) translateX(0px) scale(1)', opacity: 1 },
        { transform: `translate(-50%, -50%) translateX(${len}px) scale(1.3)`, opacity: 1 },
      ],
      ms,
      tl,
      { easing: 'linear', fill: 'forwards' },
    ).then(() =>
      play(
        comet,
        [
          { transform: `translate(-50%, -50%) translateX(${len}px) scale(1.3)`, opacity: 1 },
          { transform: `translate(-50%, -50%) translateX(${len}px) scale(2.4)`, opacity: 0 },
        ],
        240,
        tl,
        { fill: 'forwards' },
      ),
    )
    line.forEach((i, j) => tl.at((ms * j) / Math.max(1, line.length - 1), () => this.lineHit(i)))
    tl.at(ms + 420, () => track.remove())
  }

  private lineHit(i: number): void {
    const node = this.nodes[i]
    if (!node) return
    const tl = this.tl
    node.classList.add('is-line', 'is-pop')
    const shine = el('i', 'fxc-shine')
    shine.style.setProperty('--fxc-shine-run', `${Math.round(tl.ms(480))}ms`)
    this.part(i, '.fxc-face').append(shine)
    void play(node, [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.35 }, { transform: 'scale(1)' }], 340, tl, {
      easing: 'cubic-bezier(.2,.8,.3,1)',
    }).then(() => node.classList.remove('is-pop'))
    tl.at(520, () => shine.remove())
    const { x, y, w } = this.center(i)
    sparkBurst(this.fx, x, y, tl, { count: 6, colors: GOLD, dist: w * 0.75, size: 7, ms: 560, shape: 'star' })
  }

  // ---- 配る: カードが置かれ、マスが 1 枚ずつめくれる --------------------------

  async deal(): Promise<void> {
    const tl = this.tl
    if (prefersReducedMotion()) {
      if (this.size === 3) sfx.challengeDeal()
      await play(this.el, [{ opacity: 0 }, { opacity: 1 }], 300, tl)
      return
    }
    if (this.size === 3) return this.dealChallenge()
    this.el.classList.add('is-dealing')
    void play(
      this.el,
      [
        { opacity: 0, transform: 'translateY(28px) scale(0.96)' },
        { opacity: 1, transform: 'translateY(-3px) scale(1.005)', offset: 0.7 },
        { opacity: 1, transform: 'none' },
      ],
      420,
      tl,
      { easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    this.head.querySelectorAll('span').forEach((s, i) => {
      void play(
        s,
        [
          { opacity: 0, transform: 'translateY(-16px) scale(0.5)' },
          { opacity: 1, transform: 'translateY(2px) scale(1.12)', offset: 0.65 },
          { opacity: 1, transform: 'none' },
        ],
        320,
        tl,
        { delay: 140 + i * 60, fill: 'backwards' },
      )
    })
    // 左上から右下へ、斜めの波でめくる
    let last = 0
    this.nodes.forEach((node, i) => {
      const delay = 260 + (Math.floor(i / this.size) + (i % this.size)) * 48
      last = Math.max(last, delay)
      void play(node, FLIP, 320, tl, { delay, fill: 'backwards', easing: 'cubic-bezier(.3,.5,.3,1)' })
    })
    await tl.wait(last + 360)
    this.el.classList.remove('is-dealing')
    if (tl.cancelled) return
    this.freePop(false)
    await tl.wait(140)
    this.gloss(620)
    await tl.wait(560)
  }

  // 3×3 のチャレンジカード: 金のカードが回りながら飛んできて、表紙が外れ、マスが渦の順にめくれる
  private async dealChallenge(): Promise<void> {
    const tl = this.tl
    sfx.challengeDeal()
    this.el.classList.add('is-dealing')
    const cover = el(
      'div',
      'fxc-cover',
      `<div><em>✦</em><b>${escapeHtml(this.title)}</b><small>上位チャレンジ</small></div><i class="fxc-cover-sheen"></i>`,
    )
    this.el.append(cover)
    // 裏向きのマスは、めくる順番が来るまで裏のまま待つ（fill: backwards）
    const ORDER = [0, 1, 2, 5, 8, 7, 6, 3]
    const FLIP0 = 1450
    const STEP = 120
    ORDER.forEach((i, k) => {
      const node = this.nodes[i]
      if (!node) return
      void play(node, FLIP, 360, tl, { delay: FLIP0 + k * STEP, fill: 'backwards', easing: 'cubic-bezier(.3,.5,.3,1)' })
      tl.at(FLIP0 + k * STEP + 200, () => {
        sfx.tick()
        const { x, y, w } = this.center(i)
        sparkBurst(this.fx, x, y, tl, { count: 5, colors: GOLD, dist: w * 0.6, size: 6, ms: 480 })
      })
    })
    const mid = this.cells.indexOf(0)
    const MID_AT = FLIP0 + ORDER.length * STEP + 160
    if (this.nodes[mid]) void play(this.nodes[mid], FLIP, 420, tl, { delay: MID_AT, fill: 'backwards', easing: 'cubic-bezier(.3,.5,.3,1)' })

    // 1. 飛んでくる
    void play(
      this.el,
      [
        { opacity: 0, transform: 'translateY(60px) scale(0.55) rotate(-14deg)' },
        { opacity: 1, transform: 'translateY(-8px) scale(1.05) rotate(2deg)', offset: 0.72 },
        { opacity: 1, transform: 'none' },
      ],
      560,
      tl,
      { easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    await tl.wait(560)
    if (tl.cancelled) return
    // 2. 着地: 金なので少し揺らし、四隅から火花、縁が光る
    shake(this.el, tl, 5, 240)
    const W = this.el.offsetWidth
    const H = this.el.offsetHeight
    for (const [cx, cy] of [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ]) {
      sparkBurst(this.fx, cx, cy, tl, { count: 7, colors: GOLD, dist: 60, size: 8, ms: 700 })
    }
    void play(
      this.el,
      [
        { boxShadow: '0 0 0 rgba(245,197,66,0)' },
        { boxShadow: '0 0 46px rgba(245,197,66,0.8)', offset: 0.3 },
        { boxShadow: '0 0 0 rgba(245,197,66,0)' },
      ],
      900,
      tl,
    )
    await tl.wait(200)
    // 3. 表紙に光が走る
    void play(
      cover.querySelector('.fxc-cover-sheen')!,
      [{ transform: 'translateX(-130%) skewX(-18deg)' }, { transform: 'translateX(330%) skewX(-18deg)' }],
      520,
      tl,
      { easing: 'cubic-bezier(.4,0,.2,1)' },
    )
    await tl.wait(480)
    // 4. 表紙が浮き上がって消え、裏向きのマスが見える
    void play(cover, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-30px) scale(1.04)' }], 320, tl, {
      easing: 'ease-in',
      fill: 'forwards',
    }).then(() => cover.remove())
    await tl.wait(MID_AT + 200 - 1240)
    if (tl.cancelled) return cover.remove()
    // 5. 真ん中の FREE に金の星
    this.freePop(true)
    shake(this.el, tl, 4, 200)
    await tl.wait(420)
    this.el.classList.remove('is-dealing')
    this.gloss(700)
    await tl.wait(700)
  }

  private freePop(big: boolean): void {
    const tl = this.tl
    const i = this.cells.indexOf(0)
    if (!this.nodes[i]) return
    const ms = big ? 460 : 340
    void play(
      this.part(i, '.fxc-ink'),
      [{ transform: 'scale(1.8)', opacity: 0 }, { transform: 'scale(0.9)', opacity: 1, offset: 0.55 }, { transform: 'scale(1)', opacity: 1 }],
      ms,
      tl,
      { easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    void play(
      this.part(i, '.fxc-num'),
      [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1.15)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }],
      ms,
      tl,
    )
    const { x, y, w } = this.center(i)
    sparkBurst(this.fx, x, y, tl, {
      count: big ? 14 : 8,
      colors: GOLD,
      dist: w * (big ? 1.1 : 0.8),
      size: big ? 10 : 7,
      ms: big ? 800 : 560,
      shape: 'star',
    })
    if (big) ring(this.fx, x, y, w * 1.1, '#ffe08a', tl, 640)
  }

  // カード全体を光沢がなでる
  private gloss(ms: number): void {
    const g = el('i', 'fxc-gloss', '<i></i>')
    this.el.append(g)
    void play(g.firstElementChild!, [{ transform: 'translateX(-120%) skewX(-16deg)' }, { transform: 'translateX(320%) skewX(-16deg)' }], ms, this.tl, {
      easing: 'cubic-bezier(.4,0,.2,1)',
    }).then(() => g.remove())
  }

  destroy(): void {
    this.tl.cancel()
    this.el.remove()
  }
}
