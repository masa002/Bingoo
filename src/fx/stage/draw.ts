import './draw.css'
import { bgm, sfx } from '../../audio'
import type { Beat, BeatKind, Plan } from '../../core/show'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion, replay } from '../runtime'
import { GOLD, TIER_COLOR, TIER_SHAPE, TIER_WORD, type Tier } from '../theme'

// 大画面の抽選機（1920×1080 の大画面に重ねて使う）。
// 通常の抽選は 青・緑・赤・金 の 4 段階（会場全体の熱）。虹（全員確定）は events.ts の別イベント。
//
// 使い方:
//   const m = new DrawMachine(stageRoot)
//   m.setPool(まだ出ていない番号)
//   m.start(beats, plan)        // core/show.ts の schedule() が作った拍の列どおりに溜める
//   m.awaitPush()               // 金のとき、MC の PUSH を待つ表示
//   await m.reveal(23, tier)    // 番号を見せる（着地・バースト）
//   m.reset()                   // 次の抽選の前に戻す（めくった札は捨て札として飛んでいく）
//
// 見た目:
//   - カードはトレカ（オリパ）風。段階の色の金属の縁とホロの光沢。裏は紺地に金の箔押しで、goldEdge では全面が金の箔になる。
//   - 回し方の型を plan と乱数で毎回選ぶ（同じ型は 3 回続けない。熱い回ほどカードめくり型が出やすい）:
//       reel  スロットリール型: 縦に流れるリール。速さに応じてモーションブラーをかける
//       stack カードめくり型: 山札の一番上を弾き飛ばして、下の札をめくる
//       flap  パタパタ型: 駅の発車標のような反転フラップ
//   - 登場のしかた・カットインの向きと角度・放射光の本数と向き・群予告の向きも毎回変える。
//
// 配置（大画面の座標）: STEP の列 x 52〜300、カード 400×560（中心 810, 440）、テロップ y 726〜786、PUSH は中心 (810, 748)。
// z-index: 背景の光 1〜2、STEP 4、減光 8、カードまわり 10、群予告 13、テロップ 14、PUSH 16、カットイン 18、粒子 60。
// 根（.fxd）は z-index も transform も持たないので、子は host の重なりの中にそのまま並ぶ。

export type DrawVariant = 'reel' | 'stack' | 'flap'
export const DRAW_VARIANTS: readonly DrawVariant[] = ['reel', 'stack', 'flap']

export interface DrawMachineOptions {
  speed?: number
  variant?: DrawVariant // 回し方の型を固定する（ギャラリーなど）。省略すると plan と乱数で毎回選ぶ
  reducedMotion?: boolean // 動きを減らした表示にする。省略すると OS の設定（prefers-reduced-motion）に従う
}

const CX = 810 // カードの中心（大画面の座標）
const CY = 440
const ROW = 200 // リールの 1 コマの高さ
const STEP_X = 189 // STEP の札の中心 x
const stepY = (i: number): number => 236 + (4 - i) * 102 // STEP 1 が下、STEP 5 が上

// リールのコマ: 1〜75 = 番号、0 = 空白、-1 = ？、-2 = 回る前の「--」
type Code = number
const BLANK = 0
const Q = -1
const DASH = -2

const LIGHT: Readonly<Record<Tier, string>> = { 0: '#93c5fd', 1: '#86efac', 2: '#fca5a5', 3: '#fff4cc', 4: '#ffffff' }
const ALL = Array.from({ length: 75 }, (_, i) => i + 1)
// 次の拍までの持ち時間を測るときに数えない拍（重ねて出すもの・会場ビュー用）
const PASSIVE: ReadonlySet<BeatKind> = new Set<BeatKind>(['telop', 'sea', 'holdChange'])

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
const pickOne = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]
// 虹（4）は通常の抽選では来ない。来たら金として扱う
const tierOf = (t: number): Tier => clamp(Math.round(t), 0, 3) as Tier

function codeHtml(c: Code): string {
  if (c === Q) return '<span class="fxd-q">?</span>'
  if (c === DASH) return '<span class="fxd-dash">--</span>'
  if (c <= 0) return ''
  return `<span class="fxd-l">${'BINGO'[Math.floor((c - 1) / 15)] ?? ''}</span><span class="fxd-n">${c}</span>`
}

// 鼓動の心電図（600×60）。QRS の山を、鼓動の音と同じ時刻に置く
function ecgPath(beats: number, period: number, dur: number): string {
  const y = 40
  const wave: readonly (readonly [number, number])[] = [
    [-34, 0], [-28, -4], [-22, 0], [-6, 0], [-2, 6], [4, -34], [10, 13], [15, 0], [34, 0], [42, -8], [50, 0],
  ]
  const out = [`M0 ${y}`]
  for (let k = 0; k < beats; k++) {
    // 最後の山の後ろまで 600 に収まるように、少しだけ詰める
    const x = ((k * period + 70) / (dur + 120)) * 600
    for (const [dx, dy] of wave) out.push(`L${(x + dx).toFixed(1)} ${y + dy}`)
  }
  out.push(`L600 ${y}`)
  return out.join(' ')
}

// ---- リールの動き -----------------------------------------------------------

interface Tween {
  p0: number
  v0: number
  p1: number
  T: number
  t: number
  done: () => void
}

// リールの位置（コマ単位）と速さ（コマ / 演出上の ms）。3 つの型が同じ動きを別の見た目で描く。
// 止めるときは 3 次エルミート曲線で、今の速さからなめらかに減速して目標のコマにぴたりと止める
class Strip {
  pos = 0
  v = 0
  private goal = 0
  private ease = 200
  private tw: Tween | null = null
  private readonly codes = new Map<number, Code>()

  constructor(private readonly pick: () => Code) {}

  get index(): number {
    return Math.floor(this.pos + 1e-9)
  }

  // i 番目のコマ。決まっていなければ候補から引いて覚えておく（同じコマは何度見ても同じ番号）
  code(i: number): Code {
    let c = this.codes.get(i)
    if (c === undefined) {
      c = this.pick()
      this.codes.set(i, c)
      if (this.codes.size > 80) {
        const lo = this.index - 6
        for (const k of this.codes.keys()) if (k < lo) this.codes.delete(k)
      }
    }
    return c
  }

  set(i: number, c: Code): void {
    this.codes.set(i, c)
  }

  // 一定の速さに向かう（ease は追いつくまでの時定数 ms）
  run(v: number, ease = 200): void {
    this.finish()
    this.goal = v
    this.ease = Math.max(16, ease)
  }

  // 減速して c のコマで止まる。止まった瞬間に解決する。
  // minD は最低限進めるコマ数（止める先のコマがまだ見えていない距離にする）。around は止めたコマの上下に置くコマ
  stopOn(c: Code, T: number, minD: number, around: Code | null = null): Promise<void> {
    this.finish()
    const p0 = this.pos
    const v0 = this.v
    // 一定の減速なら v0·T/2 進む。それ以上の整数のコマにする（エルミートが行き過ぎない条件 D ≥ v0·T/3 も満たす）
    const p1 = Math.ceil(p0 + Math.max(minD, (v0 * T) / 2) - 1e-6)
    this.set(p1, c)
    if (around !== null) {
      this.set(p1 + 1, around)
      // 手前のコマは、まだ見えていないときだけ差し替える（いま見えている札が急に変わらないように）
      if (p1 - 1 > p0 + 1.4) this.set(p1 - 1, around)
    }
    this.goal = 0
    return new Promise((done) => {
      this.tw = { p0, v0, p1, T: Math.max(16, T), t: 0, done }
    })
  }

  // 止めた状態で c を見せる（見えていない先のコマへ飛ぶ）
  jumpTo(c: Code, around: Code | null = BLANK): void {
    this.halt()
    const p = this.index + 4
    this.pos = p
    this.set(p, c)
    if (around !== null) {
      this.set(p - 1, around)
      this.set(p + 1, around)
    }
  }

  // dt（演出上の ms）だけ進める。戻り値は中央を跨いだコマの数
  update(dt: number): number {
    const before = this.index
    const tw = this.tw
    if (tw) {
      tw.t += dt
      const s = Math.min(1, tw.t / tw.T)
      const s2 = s * s
      const s3 = s2 * s
      const vt = tw.v0 * tw.T
      const d = tw.p1 - tw.p0
      this.pos = tw.p0 + vt * (s - 2 * s2 + s3) + d * (3 * s2 - 2 * s3)
      this.v = Math.max(0, (vt * (1 - 4 * s + 3 * s2) + d * (6 * s - 6 * s2)) / tw.T)
      if (s >= 1) {
        this.pos = tw.p1
        this.v = 0
        this.tw = null
        tw.done()
      }
    } else if (this.goal > 0 || this.v > 0) {
      this.v += (this.goal - this.v) * (1 - Math.exp(-dt / this.ease))
      if (this.goal === 0 && this.v < 1e-4) this.v = 0
      this.pos += this.v * dt
    }
    return this.index - before
  }

  // 減速の途中で打ち切る（待っている側には解決を返す）
  finish(): void {
    const tw = this.tw
    this.tw = null
    tw?.done()
  }

  halt(): void {
    this.finish()
    this.goal = 0
    this.v = 0
    this.pos = Math.round(this.pos)
  }
}

// ---- 回し方の型 -------------------------------------------------------------

interface AnimOpts {
  delay?: number
  easing?: string
  fill?: FillMode
  composite?: CompositeOperation
  real?: boolean // 長さを速度で縮めない（光過敏の上限を守るものに使う）
}

interface ViewCtx {
  anim(node: Element, frames: Keyframe[], ms: number, o?: AnimOpts): Animation | null
  flick(c: Code, v: number): void
}

interface SpinView {
  readonly kind: DrawVariant
  readonly root: HTMLElement // カードの窓の中に入る
  readonly rate: number // 全速（コマ / ms）
  readonly minStop: number // 止めるときに最低限進めるコマ数
  render(s: Strip): void // 毎フレーム
  cross(to: Code, v: number): void // 中央のコマが替わった
  sync(s: Strip): void // 今の位置の表示に即座に合わせる
  land(): void // 止まった瞬間のがたつき
  lockDelay(): number // 止まってから「着地」に見えるまでの演出上の ms
}

// スロットリール型: 5 コマを縦に並べて、上から下へ流す。中央の 1 コマが主役で、上下は胴の丸みで縮めて暗くする
class ReelView implements SpinView {
  readonly kind = 'reel' as const
  readonly root = el('div', 'fxd-reel')
  readonly rate = 0.018
  readonly minStop = 1.5 // 上下 1.4 コマまでは窓から見えるので、それより先で止める番号を差し込む
  private readonly rows: { node: HTMLElement; i: number; c: Code }[] = []
  private blur = -1

  constructor(private readonly ctx: ViewCtx) {
    for (let k = 0; k < 5; k++) {
      const node = el('div', 'fxd-row')
      this.root.append(node)
      this.rows.push({ node, i: Number.NaN, c: Number.NaN })
    }
  }

  render(s: Strip): void {
    const base = s.index
    const center = Math.round(s.pos)
    const stretch = 1 + Math.min(0.3, s.v * 14) // 速いほど縦に伸ばす（ブラーと合わせて流れて見える）
    for (let j = -2; j <= 2; j++) {
      const i = base + j
      const row = this.rows[((i % 5) + 5) % 5]
      const c = s.code(i)
      if (row.i !== i || row.c !== c) {
        row.i = i
        row.c = c
        row.node.innerHTML = codeHtml(c)
        row.node.classList.toggle('is-q', c === Q)
      }
      const off = i - s.pos // 正 = まだ上にある（これから下りてくる）
      const k = Math.min(1, Math.abs(off) / 1.4)
      row.node.style.transform = `translate3d(0,${(-off * ROW).toFixed(1)}px,0) scaleY(${((1 - 0.32 * k * k) * stretch).toFixed(3)})`
      row.node.style.opacity = (1 - 0.62 * k).toFixed(3)
      row.node.classList.toggle('is-c', i === center)
    }
    const v = s.v * 1000
    const blur = v > 14 ? 3 : v > 8 ? 2 : v > 4 ? 1 : 0
    if (blur !== this.blur) {
      this.blur = blur
      this.root.dataset.blur = String(blur)
    }
  }

  cross(): void {}

  sync(s: Strip): void {
    this.render(s)
  }

  land(): void {
    // 止まった瞬間に、リールが少しだけ行き過ぎて戻る（揺れではなく、機械のがたつき程度にとどめる）
    this.ctx.anim(this.root, [{ transform: 'translateY(8px)' }, { transform: 'translateY(-3px)', offset: 0.45 }, { transform: 'translateY(0)' }], 220, {
      easing: 'ease-out',
    })
  }

  lockDelay(): number {
    return 0
  }
}

// カードめくり型: 窓には一番上の札の番号だけを出す。コマが替わるたびに、前の札を弾き飛ばす（飛ぶ札は抽選機が出す）
class StackView implements SpinView {
  readonly kind = 'stack' as const
  readonly root = el('div', 'fxd-stack')
  readonly rate = 0.011
  readonly minStop = 1
  private shown: Code = Number.NaN

  constructor(private readonly ctx: ViewCtx) {}

  private show(c: Code): void {
    this.shown = c
    this.root.innerHTML = codeHtml(c)
    this.root.classList.toggle('is-q', c === Q)
  }

  render(s: Strip): void {
    const c = s.code(s.index)
    if (c !== this.shown) this.show(c)
  }

  cross(to: Code, v: number): void {
    const from = this.shown
    this.show(to)
    if (!Number.isNaN(from)) this.ctx.flick(from, v)
  }

  sync(s: Strip): void {
    this.show(s.code(s.index))
  }

  land(): void {
    this.ctx.anim(this.root, [{ transform: 'scale(1.14)' }, { transform: 'scale(1)' }], 260, { easing: 'cubic-bezier(.2,1.5,.4,1)' })
  }

  lockDelay(): number {
    return 110 // 弾いた札がどいて、下の番号が見えるまで
  }
}

// パタパタ型: 上半分が手前に倒れ、新しい下半分が落ちてくる。めくる速さはリールの速さで決める
class FlapView implements SpinView {
  readonly kind = 'flap' as const
  readonly root = el(
    'div',
    'fxd-flap',
    '<div class="fxd-fl top"><div></div></div><div class="fxd-fl bot"><div></div></div><div class="fxd-fl ftop"><div></div></div><div class="fxd-fl fbot"><div></div></div><i class="fxd-hinge"></i>',
  )
  readonly rate = 0.0135
  readonly minStop = 1
  private readonly halves: HTMLElement[]
  private shown: Code = DASH
  private last = 120
  private running: Animation[] = []

  constructor(private readonly ctx: ViewCtx) {
    this.halves = [...this.root.querySelectorAll<HTMLElement>('.fxd-fl')]
  }

  private put(k: number, c: Code): void {
    ;(this.halves[k].firstElementChild as HTMLElement).innerHTML = codeHtml(c)
  }

  private settle(): void {
    for (const a of this.running) a.cancel()
    this.running = []
    this.put(0, this.shown)
    this.put(1, this.shown)
    this.halves[2].style.visibility = 'hidden'
    this.halves[3].style.visibility = 'hidden'
    this.root.classList.toggle('is-q', this.shown === Q)
  }

  render(): void {}

  cross(to: Code, v: number): void {
    const from = this.shown
    this.settle()
    this.shown = to
    const d = clamp(0.95 / Math.max(v, 1e-4), 70, 240)
    this.last = d
    this.put(0, to)
    this.put(1, from)
    this.put(2, from)
    this.put(3, to)
    this.halves[2].style.visibility = 'visible'
    this.halves[3].style.visibility = 'visible'
    const a = this.ctx.anim(this.halves[2], [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(-90deg)' }], d / 2, {
      easing: 'cubic-bezier(.55,0,1,.7)',
      fill: 'forwards',
    })
    const b = this.ctx.anim(this.halves[3], [{ transform: 'rotateX(90deg)' }, { transform: 'rotateX(0deg)' }], d / 2, {
      delay: d / 2,
      easing: 'cubic-bezier(0,.3,.45,1)',
      fill: 'both',
    })
    if (!a || !b) return this.settle()
    this.running = [a, b]
    b.onfinish = () => this.settle()
  }

  sync(s: Strip): void {
    this.shown = s.code(s.index)
    this.settle()
  }

  land(): void {
    this.ctx.anim(this.root, [{ transform: 'translateY(6px)' }, { transform: 'translateY(0)' }], 180, { easing: 'ease-out' })
  }

  lockDelay(): number {
    return this.last // 最後の 1 枚が落ちきるまで
  }
}

// ---- 抽選機 -----------------------------------------------------------------

const HTML = `
<div class="fxd-aura"></div>
<div class="fxd-rays"></div>
<div class="fxd-steps"><div class="fxd-gauge"></div>${[0, 1, 2, 3, 4]
  .map((i) => `<div class="fxd-step" style="top:${(4 - i) * 102}px;width:${[196, 204, 212, 222, 236][i]}px"><i>STEP</i><b>${i + 1}</b><em></em></div>`)
  .join('')}</div>
<div class="fxd-dim"></div>
<div class="fxd-stage">
  <div class="fxd-glow"></div>
  <div class="fxd-halo"></div>
  <div class="fxd-rings"></div>
  <div class="fxd-under u2"></div>
  <div class="fxd-under u1"></div>
  <div class="fxd-pop"><div class="fxd-tilt"><div class="fxd-card">
    <div class="fxd-side fxd-face">
      <div class="fxd-art"></div>
      <div class="fxd-top"><b>BINGOO</b><i class="fxd-mark">●</i></div>
      <div class="fxd-win"></div>
      <div class="fxd-badge"><i>●</i><b></b></div>
      <div class="fxd-holo"></div>
      <div class="fxd-glare"></div>
    </div>
    <div class="fxd-side fxd-back">
      <div class="fxd-lattice"></div>
      <div class="fxd-emblem"><i>★</i></div>
      <div class="fxd-logo">BINGOO<small>PREMIUM PACK</small></div>
      <div class="fxd-backq">?</div>
      <div class="fxd-sheen"></div>
      <div class="fxd-glare"></div>
    </div>
  </div></div></div>
  <div class="fxd-flyers"></div>
  <div class="fxd-ghosts"></div>
  <svg class="fxd-ecg" viewBox="0 0 600 60" preserveAspectRatio="none"><path class="base"></path><path class="line" pathLength="1"></path></svg>
  <div class="fxd-next"><b>NEXT</b><i>▶</i><em></em></div>
</div>
<div class="fxd-flock"></div>
<div class="fxd-telop"><b></b></div>
<div class="fxd-push"><span></span><b>PUSH!</b></div>
<div class="fxd-cut"><div class="fxd-cut-rot">
  <div class="fxd-cut-band"><i></i><i></i><i></i><div class="fxd-cut-txt"><em></em><span class="fxd-cut-word"><b class="o"></b><b class="f"></b></span><em></em></div></div>
  <div class="fxd-cut-slash"></div>
</div></div>
<canvas class="fxd-fx" width="1920" height="1080"></canvas>`

export class DrawMachine {
  readonly el: HTMLElement
  private speed: number
  private tl: Timeline
  private readonly fx: Particles
  private readonly strip: Strip
  private readonly ctx: ViewCtx
  private readonly views: Partial<Record<DrawVariant, SpinView>> = {}
  private view: SpinView
  private readonly forced: DrawVariant | undefined
  private readonly rmOption: boolean | undefined
  private rm = false
  private readonly history: DrawVariant[] = []
  private pool: number[] = []
  private lastPick = 0

  private readonly stage: HTMLElement
  private readonly stepsEl: HTMLElement
  private readonly plates: HTMLElement[]
  private readonly rays: HTMLElement
  private readonly dim: HTMLElement
  private readonly pop: HTMLElement
  private readonly tiltEl: HTMLElement
  private readonly card: HTMLElement
  private readonly face: HTMLElement
  private readonly back: HTMLElement
  private readonly backQ: HTMLElement
  private readonly win: HTMLElement
  private readonly holo: HTMLElement
  private readonly glares: HTMLElement[]
  private readonly mark: HTMLElement
  private readonly badge: HTMLElement
  private readonly halo: HTMLElement
  private readonly rings: HTMLElement
  private readonly flyers: HTMLElement
  private readonly ghosts: HTMLElement
  private readonly ecg: SVGSVGElement
  private readonly next: HTMLElement
  private readonly flockEl: HTMLElement
  private readonly telopEl: HTMLElement
  private readonly pushEl: HTMLElement
  private readonly cut: HTMLElement
  private readonly cutRot: HTMLElement
  private readonly cutBand: HTMLElement
  private readonly cutTxt: HTMLElement
  private readonly cutSlash: HTMLElement

  private heat: Tier = 0
  private isBack = true // カードが裏（待機中・金の箔）を向いている
  private angle = 180 // カードの Y 回転（裏返すたびに 180 足す）
  private appeared = false
  private pushOn = false
  private ducked = false // bgm.duck(true) したまま
  private holding = false // ライザー・鼓動の音を伸ばしている
  private dir = 1 // この回の向き（カットイン・登場・群予告）
  private flickSide = 1
  private raf = 0
  private last = 0
  private dead = false
  private readonly anims = new Set<Animation>()
  private readonly solos = new Map<Element, Animation>()
  private readonly gates = new Map<string, number>()

  constructor(host: HTMLElement, o: DrawMachineOptions = {}) {
    this.speed = o.speed && o.speed > 0 ? o.speed : 1
    this.tl = new Timeline(this.speed)
    this.forced = o.variant
    this.rmOption = o.reducedMotion
    this.el = el('div', 'fxd', HTML)
    host.append(this.el)
    this.stage = this.$('.fxd-stage')
    this.stepsEl = this.$('.fxd-steps')
    this.plates = [...this.el.querySelectorAll<HTMLElement>('.fxd-step')]
    this.rays = this.$('.fxd-rays')
    this.dim = this.$('.fxd-dim')
    this.pop = this.$('.fxd-pop')
    this.tiltEl = this.$('.fxd-tilt')
    this.card = this.$('.fxd-card')
    this.face = this.$('.fxd-face')
    this.back = this.$('.fxd-back')
    this.backQ = this.$('.fxd-backq')
    this.win = this.$('.fxd-win')
    this.holo = this.$('.fxd-holo')
    this.glares = [...this.el.querySelectorAll<HTMLElement>('.fxd-glare')]
    this.mark = this.$('.fxd-mark')
    this.badge = this.$('.fxd-badge')
    this.halo = this.$('.fxd-halo')
    this.rings = this.$('.fxd-rings')
    this.flyers = this.$('.fxd-flyers')
    this.ghosts = this.$('.fxd-ghosts')
    this.ecg = this.$<SVGSVGElement>('.fxd-ecg')
    this.next = this.$('.fxd-next')
    this.flockEl = this.$('.fxd-flock')
    this.telopEl = this.$('.fxd-telop')
    this.pushEl = this.$('.fxd-push')
    this.cut = this.$('.fxd-cut')
    this.cutRot = this.$('.fxd-cut-rot')
    this.cutBand = this.$('.fxd-cut-band')
    this.cutTxt = this.$('.fxd-cut-txt')
    this.cutSlash = this.$('.fxd-cut-slash')
    this.fx = new Particles(this.$<HTMLCanvasElement>('.fxd-fx'))
    this.fx.speed = this.speed
    this.strip = new Strip(() => this.pick())
    this.ctx = {
      anim: (node, frames, ms, opts) => this.anim(node, frames, ms, opts),
      flick: (c, v) => this.flick(c, v),
    }
    this.view = this.views[this.forced ?? 'reel'] = this.make(this.forced ?? 'reel')
    this.applyMotion()
    this.clear()
    this.mount(this.view.kind)
  }

  // ---- 公開の API -------------------------------------------------------------

  setSpeed(speed: number): void {
    if (!(speed > 0)) return
    this.speed = speed
    this.tl.speed = speed
    this.fx.speed = speed
  }

  // リールに流す候補（まだ出ていない番号）。回っている数字は見た目だけで、結果とは関係ない
  setPool(numbers: readonly number[]): void {
    this.pool = numbers.filter((n) => Number.isInteger(n) && n >= 1 && n <= 75)
  }

  start(beats: readonly Beat[], plan: Plan): void {
    if (this.dead) return
    this.retire()
    this.clear()
    this.applyMotion()
    this.mount(this.choose(plan))
    this.dir = Math.random() < 0.5 ? 1 : -1
    this.rays.style.setProperty('--ray', `${360 / pickOne([12, 16, 20, 24])}deg`)
    this.rays.classList.toggle('rev', Math.random() < 0.5)
    this.el.dataset.phase = 'run'
    // 拍ごとに「次の拍までの持ち時間」を渡す（詰めて並んだ回でも、部品が次の拍にかぶらないように縮める）
    const list = [...beats].sort((a, b) => a.at - b.at)
    list.forEach((b, i) => {
      let slot = 1200
      for (let j = i + 1; j < list.length; j++) {
        if (!PASSIVE.has(list[j].kind)) {
          slot = list[j].at - b.at
          break
        }
      }
      this.tl.at(b.at, () => this.beat(b, slot))
    })
  }

  awaitPush(): void {
    if (this.dead) return
    if (!this.appeared) this.appear()
    this.showPush()
  }

  // 番号の着地。止まり方は今の状態（回っている・「？」で止まっている・金の箔で裏）で変わる
  async reveal(n: number, tier: Tier): Promise<void> {
    if (this.dead) return
    const t = tierOf(tier)
    this.tl.cancel()
    const tl = (this.tl = new Timeline(this.speed))
    this.el.dataset.phase = 'land'
    if (this.holding) {
      sfx.silence()
      this.holding = false
    }
    if (this.pushOn) this.pressPush()
    this.pushOn = false
    for (const node of [this.telopEl, this.ecg, this.dim]) node.classList.remove('on')
    this.el.classList.remove('is-rise', 'is-ma')
    this.back.classList.remove('has-q')
    this.setHeat(t, true)
    this.appeared = true
    if (this.isBack || this.rm) {
      // 裏（金の箔・待機中）からは、めくって見せる。金は一瞬ためてから
      this.strip.jumpTo(n)
      this.view.sync(this.strip)
      if (t >= 3 && this.isBack && !this.rm) {
        // ぐっと縮めてから、めくりながら弾ける
        this.anim(
          this.pop,
          [{ transform: 'scale(1)' }, { transform: 'scale(.9)', offset: 0.35 }, { transform: 'scale(1.05)', offset: 0.75 }, { transform: 'scale(1)' }],
          340,
          { composite: 'add', easing: 'ease-in-out' },
        )
        await tl.wait(120)
        if (tl.cancelled) return
      }
      this.flipTo(false, t >= 3 ? 420 : 340)
      await tl.wait(this.rm ? 0 : t >= 3 ? 220 : 180)
    } else {
      const moving = this.strip.v > 0.0015
      const T = moving ? clamp(260 + this.strip.v * 14000, 300, 520) : 280
      await this.stopOn(n, T, this.view.minStop)
      if (tl.cancelled) return
      const d = this.view.lockDelay()
      if (d > 0) await tl.wait(d)
    }
    if (tl.cancelled) return
    this.impact(t)
    await tl.wait([360, 480, 640, 820][t])
    if (tl.cancelled) return
    if (this.ducked) {
      bgm.duck(false)
      this.ducked = false
    }
    this.el.dataset.phase = 'done'
  }

  // 次の抽選の前の状態（裏向きの札が待っている）に戻す。表の札が出ていれば、捨て札として飛ばす
  reset(): void {
    if (this.dead) return
    this.retire()
    this.clear()
    this.applyMotion()
  }

  destroy(): void {
    if (this.dead) return
    this.clear()
    this.dead = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.fx.clear()
    this.el.remove()
  }

  // ---- 拍 -------------------------------------------------------------------

  private beat(b: Beat, slot: number): void {
    if (b.kind === 'sea' || b.kind === 'reveal') return // 会場ビュー用・公開の予定時刻の目印
    if (!this.appeared) this.appear()
    // 色は戻さない（テロップの拍などは、前の色のまま来ることがある）
    this.setHeat(Math.max(this.heat, tierOf(b.heat)) as Tier)
    const tier = tierOf(b.tier ?? b.heat)
    switch (b.kind) {
      case 'appear':
        return
      case 'spin':
        return this.spin()
      case 'holdChange':
        return this.holdChange(tier)
      case 'step':
        return this.step(b.index ?? 0, tier)
      case 'group':
        return this.flock(slot)
      case 'pseudo':
        return void this.pseudo(b.index ?? 0, slot)
      case 'cutin':
        return this.cutin(tier, slot)
      case 'telop':
        return this.telop(b.text ?? '')
      case 'decel':
        return this.decel(slot)
      case 'riser':
        return this.riser(b.dur ?? 1200)
      case 'heartbeat':
        return this.heartbeat(b.dur ?? 1400)
      case 'ma':
        return this.ma(b.dur ?? 700)
      case 'goldEdge':
        return this.goldEdge()
      case 'freeze':
        // 虹の拍は通常の抽選では来ない。来たら金と同じに扱う（金の箔 → 間）
        this.goldEdge()
        return this.ma(slot)
      case 'push':
        return this.showPush()
      case 'crack':
      case 'kakutei':
      case 'rainbowPhones':
        return
    }
  }

  // 登場: 待機中の裏の札をめくって表にする。入り方は 3 通りから選ぶ
  private appear(): void {
    this.appeared = true
    this.strip.jumpTo(DASH)
    this.view.sync(this.strip)
    const d = this.dir
    const from = pickOne([
      `translate3d(${-d * 520}px,90px,0) rotate(${-d * 16}deg) scale(.8)`, // 山札から配る
      'translate3d(0,-300px,0) rotate(0deg) scale(1.06)', // 上から落とす
      'translate3d(0,0,0) rotate(0deg) scale(.35)', // その場でせり出す
    ])
    this.anim(
      this.pop,
      [
        { transform: from },
        { transform: 'translate3d(0,6px,0) rotate(0deg) scale(1.02)', offset: 0.72 },
        { transform: 'translate3d(0,0,0) rotate(0deg) scale(1)' },
      ],
      440,
      { easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    this.flipTo(false, 440)
    this.glare()
    sfx.tick()
  }

  private spin(): void {
    if (this.rm) {
      // 動きを減らす設定では回さず、「？」で待つ
      this.strip.jumpTo(Q)
      this.view.sync(this.strip)
      return
    }
    this.strip.run(this.view.rate, 150)
  }

  // 保留変化: 枠の色が上がり、札の帯が弾む
  private holdChange(t: Tier): void {
    sfx.holdChange(t)
    this.anim(this.badge, [{ transform: 'translateX(-50%) scale(1.7)' }, { transform: 'translateX(-50%) scale(1)' }], 360, {
      easing: 'cubic-bezier(.2,1.5,.4,1)',
    })
    this.punch(0.04)
    this.ring(470, 0, 5)
    this.burst(CX, CY + 222, 30, t, 6)
  }

  // ステップアップ: 下から 1 段ずつ点く。段が上がるほど、札の跳ね・火花・カードの揺れを大きくする
  private step(i: number, t: Tier): void {
    const k = clamp(i, 0, 4)
    const plate = this.plates[k]
    sfx.step(k, t)
    plate.style.setProperty('--c', TIER_COLOR[t])
    plate.style.setProperty('--sd', `${Math.round(this.tl.ms(560))}ms`)
    plate.classList.add('on')
    plate.classList.toggle('hot', t >= 3)
    const em = plate.querySelector('em')
    if (em) em.textContent = TIER_SHAPE[t]
    replay(plate, 'sweep')
    this.stepsEl.style.setProperty('--fill', String((k + 1) / 5))
    const s = 1.3 + k * 0.1
    this.anim(
      plate,
      [
        { transform: `skewX(-10deg) scale(${s}) rotateX(80deg)` },
        { transform: 'skewX(-10deg) scale(.95) rotateX(0deg)', offset: 0.6 },
        { transform: 'skewX(-10deg) scale(1)' },
      ],
      300 + k * 30,
      { easing: 'cubic-bezier(.2,1.2,.4,1)' },
    )
    this.burst(STEP_X, stepY(k), 16 + k * 12, t, 5 + k * 1.6)
    this.punch(0.02 + k * 0.012)
    if (k >= 2) this.glare()
    if (k >= 3) this.ring(440 + 60 * (k - 3), 0, 4 + k)
    if (k >= 4 && !this.rm) this.fx.rise(40, this.colors(t), STEP_X - 110, STEP_X + 110, stepY(k) + 20)
  }

  // 疑似連: 減速して「？」で止まりかけ → 「NEXT」 → 回り直す。回数が増えるほど派手に
  private async pseudo(i: number, slot: number): Promise<void> {
    const tl = this.tl
    const d = clamp(slot, 380, 1100)
    if (this.rm) {
      this.strip.jumpTo(Q)
      this.view.sync(this.strip)
    } else if (!this.isBack) {
      await this.stopQ(d * 0.34)
      if (tl.cancelled) return
    }
    sfx.pseudoStop()
    await tl.wait(d * 0.14)
    if (tl.cancelled) return
    this.showNext(i, d * 0.52)
    sfx.nextChime()
    this.punch(0.05 + 0.02 * i)
    this.burst(CX, CY + 150, 24 + 16 * i, this.heat, 7 + i)
    if (i >= 1) this.ring(420 + 50 * i, 0, 4)
    await tl.wait(d * 0.18)
    if (tl.cancelled || this.rm || this.isBack) return
    this.strip.run(this.view.rate * (1.1 + 0.1 * i), 90)
  }

  private showNext(i: number, d: number): void {
    this.next.dataset.i = String(Math.min(2, i))
    const em = this.next.querySelector('em')
    if (em) em.textContent = `×${i + 2}`
    this.next.classList.add('on')
    this.solo(
      this.next,
      [
        { transform: 'translate(-50%,-50%) scale(.3) rotate(-10deg)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(1.18) rotate(2deg)', opacity: 1, offset: 0.28 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.42 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.8 },
        { transform: 'translate(-50%,-90%) scale(1.04)', opacity: 0 },
      ],
      d,
      'ease-out',
    )
    this.tl.at(d, () => this.next.classList.remove('on'))
  }

  // カットイン: 斜めの帯が走り抜ける（緑 CHANCE、赤 激アツ、金 BINGO CHANCE）
  private cutin(t: Tier, slot: number): void {
    const word = TIER_WORD[t] || TIER_WORD[1]
    const d = clamp(slot, 560, 980)
    const dir = this.dir
    const ang = pickOne([-9, -7, 7, 9])
    sfx.cutin(t)
    this.cut.dataset.t = String(Math.max(1, t))
    for (const b of this.cutTxt.querySelectorAll('b')) b.textContent = word
    for (const em of this.cutTxt.querySelectorAll('em')) em.textContent = TIER_SHAPE[Math.max(1, t) as Tier]
    this.cutRot.style.transform = `rotate(${ang}deg)`
    this.cut.classList.add('on')
    // 終わりの形を保つ（帯を隠す前に、帯が真ん中へ戻って見えないように）
    this.solo(
      this.cutBand,
      [
        { transform: `translateX(${-112 * dir}%)`, easing: 'cubic-bezier(.12,.9,.25,1)' },
        { transform: 'translateX(0%)', offset: 0.22 },
        { transform: `translateX(${3 * dir}%)`, offset: 0.78, easing: 'cubic-bezier(.6,0,.9,.5)' },
        { transform: `translateX(${112 * dir}%)` },
      ],
      d,
    )
    this.solo(
      this.cutTxt,
      [
        { transform: 'scale(1.8)', opacity: 0 },
        { transform: 'scale(1.8)', opacity: 0, offset: 0.12, easing: 'ease-out' },
        { transform: 'scale(.94)', opacity: 1, offset: 0.3 },
        { transform: 'scale(1)', opacity: 1, offset: 0.4 },
        { transform: `scale(1.04) translateX(${2 * dir}%)`, opacity: 1, offset: 0.8 },
        { transform: `scale(1.04) translateX(${12 * dir}%) skewX(${-16 * dir}deg)`, opacity: 0 },
      ],
      d,
    )
    this.solo(
      this.cutSlash,
      [
        { transform: `translateX(${-100 * dir}%) scaleY(.4)`, opacity: 0 },
        { opacity: 1, offset: 0.06 },
        { transform: `translateX(${100 * dir}%) scaleY(1)`, opacity: 0, offset: 0.3 },
        { transform: `translateX(${100 * dir}%) scaleY(1)`, opacity: 0 },
      ],
      d,
    )
    this.cutBand.querySelectorAll('i').forEach((line, k) => {
      this.anim(line, [{ transform: `translateX(${-140 * dir}%)` }, { transform: `translateX(${140 * dir}%)` }], d * rand(0.28, 0.42), {
        delay: d * (0.12 + 0.17 * k),
        easing: 'linear',
        fill: 'backwards',
      })
    })
    const tl = this.tl
    tl.at(d * 0.24, () => {
      this.punch(0.05)
      if (t >= 2) {
        const tan = Math.tan((ang * Math.PI) / 180)
        for (const x of [430, 810, 1190]) this.burst(x, CY + tan * (x - 960), 18 + 10 * t, t, 9)
      }
    })
    tl.at(d, () => this.cut.classList.remove('on'))
  }

  // 群予告: 裏向きのカードの群れが、奥行きをつけて画面を横切る
  private flock(slot: number): void {
    sfx.flutter()
    if (this.rm) return this.telop('カードの群れが横切った！')
    const d = clamp(slot + 250, 700, 1150)
    const n = 14 + this.heat * 4
    const dir = -this.dir
    for (let k = 0; k < n; k++) {
      const z = rand(0.55, 1.35)
      const c = el('div', z < 0.8 ? 'fxd-fc far' : 'fxd-fc')
      c.style.zIndex = String(Math.round(z * 10))
      this.flockEl.append(c)
      const y0 = rand(110, 740)
      const y1 = y0 + rand(-170, 110)
      const x0 = dir > 0 ? -220 : 2140
      const x1 = dir > 0 ? 2140 : -220
      const r0 = rand(-40, 40)
      const r1 = r0 + dir * rand(120, 300)
      const a = this.anim(
        c,
        [
          { transform: `translate3d(${x0}px,${y0}px,0) rotate(${r0}deg) scale(${z})` },
          { transform: `translate3d(${(x0 + x1) / 2}px,${(y0 + y1) / 2 + rand(-90, 90)}px,0) rotate(${(r0 + r1) / 2}deg) scale(${z})` },
          { transform: `translate3d(${x1}px,${y1}px,0) rotate(${r1}deg) scale(${z})` },
        ],
        (d * rand(0.8, 1.05)) / Math.sqrt(z),
        { delay: (k * d * 0.32) / n, easing: 'cubic-bezier(.3,.15,.7,.85)', fill: 'backwards' },
      )
      if (a) a.onfinish = () => c.remove()
      else c.remove()
    }
    this.tl.at(d * 0.35, () => this.punch(0.03))
  }

  // テロップ: 下の帯に 1 文字ずつ出る。「！」「？」を含むものは強めに
  private telop(text: string): void {
    sfx.telop()
    const strong = /[!！?？]/.test(text)
    const step = 40
    this.telopEl.classList.toggle('strong', strong)
    this.telopEl.style.setProperty('--cd', `${Math.round(this.tl.ms(300))}ms`)
    const chars = [...text]
      .map((ch, i) => `<span style="animation-delay:${Math.round(this.tl.ms(i * step))}ms">${ch === ' ' ? '&nbsp;' : escapeHtml(ch)}</span>`)
      .join('')
    this.telopEl.firstElementChild!.innerHTML = `<i>${TIER_SHAPE[this.heat]}</i>${chars}`
    this.telopEl.classList.add('on')
    this.tl.at(text.length * step + 1700, () => this.telopEl.classList.remove('on'))
  }

  // 減速（青）: 公開に向けてリールがゆっくりになる
  private decel(slot: number): void {
    if (this.rm || this.isBack) return
    this.strip.run(0.0034, Math.max(60, slot / 2.6))
  }

  // ライザー: 音が上がり続ける間、光・ホロ・立ち上る粒子を強め、リールも速める
  private riser(dur: number): void {
    sfx.riser(this.tl.ms(dur) / 1000)
    this.holding = true
    this.el.style.setProperty('--rise', `${Math.round(this.tl.ms(dur))}ms`)
    this.el.classList.add('is-rise')
    if (this.rm) return
    if (!this.isBack) this.strip.run(this.view.rate * 1.3, dur / 2.5)
    const colors = this.heat >= 3 ? GOLD : this.colors(this.heat)
    for (let at = 0; at < dur; at += 130) {
      const k = at / dur
      this.tl.at(at, () => this.fx.rise(Math.round(3 + 11 * k), colors, CX - 230, CX + 230, CY + 300))
    }
  }

  // 鼓動（赤）: リールが 1 コマずつ見える速さまで落ち、心電図と一緒にカードが脈打つ
  private heartbeat(dur: number): void {
    const period = 625 // 96 bpm
    sfx.heartbeat(96 * this.speed, this.tl.ms(dur))
    this.holding = true
    if (!this.rm && !this.isBack) this.strip.run(0.0042, 260)
    const n = Math.max(1, Math.ceil((dur - 80) / period))
    this.ecg.querySelector('.base')?.setAttribute('d', ecgPath(n, period, dur))
    this.ecg.querySelector('.line')?.setAttribute('d', ecgPath(n, period, dur))
    this.ecg.style.setProperty('--ed', `${Math.round(this.tl.ms(dur))}ms`)
    this.ecg.classList.remove('run')
    void this.ecg.getBoundingClientRect()
    this.ecg.classList.add('on', 'run')
    for (let k = 0; k < n; k++) this.tl.at(k * period + 70, () => this.pulse())
  }

  private pulse(): void {
    // 速度を上げても、脈打つのは実時間で 0.38 秒に 1 回まで
    if (!this.gate('pulse', 380)) return
    this.anim(
      this.pop,
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.05)', offset: 0.16 },
        { transform: 'scale(.995)', offset: 0.42 },
        { transform: 'scale(1.03)', offset: 0.6 },
        { transform: 'scale(1)' },
      ],
      460,
      { composite: 'add', easing: 'ease-out' },
    )
  }

  // 間（ま）: 音を落とし、周りを 20% 暗くして、リールを「？」で止める。何も動かない時間を作る
  private ma(dur: number): void {
    if (this.holding) {
      sfx.silence()
      this.holding = false
    }
    sfx.ma()
    if (!this.ducked) {
      bgm.duck(true)
      this.ducked = true
    }
    this.el.classList.remove('is-rise')
    this.el.classList.add('is-ma')
    this.dim.classList.add('on')
    this.ecg.classList.remove('on')
    if (this.isBack) {
      // 金の箔の上に「？」を型押しする
      this.back.classList.add('has-q')
      this.anim(this.backQ, [{ transform: 'scale(1.5)', opacity: 0 }, { transform: 'scale(.96)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], 320, {
        easing: 'ease-out',
      })
    } else if (this.rm) {
      this.strip.jumpTo(Q)
      this.view.sync(this.strip)
    } else {
      void this.stopQ(clamp(dur * 0.4, 160, 320))
    }
  }

  // 金の縁: 枠が金になり、カードが裏返って全面が金の箔になる。金の粒子が立ち上る
  private goldEdge(): void {
    this.setHeat(3)
    this.back.classList.add('is-gold')
    sfx.goldRise()
    if (!this.isBack) this.flipTo(true, 560)
    else this.glare()
    this.punch(0.05)
    if (this.rm) return
    this.fx.rise(150, GOLD, CX - 260, CX + 260, CY + 290)
    this.tl.at(380, () => this.fx.rise(90, GOLD, CX - 200, CX + 200, CY + 290))
  }

  // PUSH 待ち: 1 秒に 1 回のゆっくりした脈動（速度を上げても速くしない）。待つ間は金の粒が静かに立ち上る
  private showPush(): void {
    if (this.pushOn || this.dead) return
    this.pushOn = true
    this.pushEl.style.setProperty('--pp', `${Math.max(1000, Math.round(this.tl.ms(1000)))}ms`)
    this.pushEl.classList.add('on')
    this.anim(
      this.pushEl,
      [
        { transform: 'translate(-50%,-50%) scale(.4)' },
        { transform: 'translate(-50%,-50%) scale(1.12)', offset: 0.7 },
        { transform: 'translate(-50%,-50%) scale(1)' },
      ],
      380,
      { easing: 'cubic-bezier(.2,1.3,.4,1)' },
    )
    sfx.pushReady()
    if (this.rm) return
    const tl = this.tl
    const glitter = (): void => {
      if (tl.cancelled || !this.pushOn) return
      this.fx.rise(6, GOLD, CX - 210, CX + 210, CY + 270)
      tl.at(420, glitter)
    }
    glitter()
  }

  // PUSH が押された: ぐっと沈んでから、はじけて消える
  private pressPush(): void {
    this.solo(
      this.pushEl,
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: 'translate(-50%,-50%) scale(.86)', opacity: 1, offset: 0.3 },
        { transform: 'translate(-50%,-50%) scale(1.35)', opacity: 0 },
      ],
      260,
      'ease-out',
    )
    this.tl.at(260, () => this.pushEl.classList.remove('on'))
  }

  // ---- 着地 -----------------------------------------------------------------

  // 番号が止まった瞬間。段階に応じて、弾み・衝撃の輪・光（中央の 1/3 以下）・粒子を重ねる。金は揺れと金の紙吹雪
  private impact(t: Tier): void {
    sfx.impact(t)
    this.el.classList.add('is-done')
    this.view.land()
    this.glare()
    if (this.rm) return
    const big = [0.07, 0.1, 0.14, 0.18][t]
    this.anim(
      this.pop,
      [{ transform: 'scale(1)' }, { transform: `scale(${1 + big})`, offset: 0.25 }, { transform: `scale(${1 - big * 0.22})`, offset: 0.55 }, { transform: 'scale(1)' }],
      420 + t * 60,
      { composite: 'add', easing: 'ease-out' },
    )
    this.flash(t)
    this.ring([460, 540, 620, 700][t], 0, 6 + t)
    if (t >= 2) this.ring([380, 440, 520, 600][t], 130, 4)
    this.fx.burst(CX, CY - 30, {
      count: [40, 90, 150, 220][t],
      colors: this.colors(t),
      speed: 7 + t * 2.4,
      shape: t >= 2 ? 'spark' : pickOne(['rect', 'dot'] as const),
      gravity: t >= 2 ? 0.12 : 0.24,
      life: 60 + 10 * t,
    })
    if (t >= 2) this.fx.burst(CX, CY - 30, { count: 50 + 40 * (t - 2), colors: ['#ffffff', LIGHT[t]], speed: 4, shape: 'dot', gravity: 0.03, life: 80, size: 5 })
    if (t >= 3) {
      this.shake()
      this.fx.burst(CX, CY - 30, { count: 160, colors: GOLD, speed: 15, shape: 'spark', gravity: 0.08, life: 90 })
      this.fx.rain(240, GOLD)
      this.tl.at(520, () => this.fx.rain(160, GOLD))
      this.rays.classList.add('boost')
      this.tl.at(1800, () => this.rays.classList.remove('boost'))
    }
  }

  // 着地の光。中央の 1/3 以下の楕円で、立ち上がりは実時間で 160ms 以上
  private flash(t: Tier): void {
    const w = [560, 640, 740, 820][t]
    const h = Math.round(w * 0.86)
    this.halo.style.cssText = `width:${w}px;height:${h}px;margin:${-h / 2}px 0 0 ${-w / 2}px`
    const rise = Math.max(160, this.tl.ms(180))
    const total = Math.max(rise + 520, this.tl.ms(1100))
    this.anim(
      this.halo,
      [
        { opacity: 0, transform: 'scale(.55)' },
        { opacity: 1, transform: 'scale(1)', offset: rise / total },
        { opacity: 0, transform: 'scale(1.12)' },
      ],
      total,
      { real: true, easing: 'ease-out' },
    )
  }

  // 揺れは金だけ。8px 以内・実時間で 300ms 以内
  private shake(): void {
    const pts = [[0, 0], [-7, 3], [6, -4], [-5, 2], [3, -2], [-1, 1], [0, 0]]
    const frames = pts.map(([x, y]) => ({ transform: `translate(${x}px,${y}px)` }))
    const d = Math.min(280, this.tl.ms(260))
    for (const node of [this.stage, this.stepsEl]) this.anim(node, frames, d, { composite: 'add', real: true })
  }

  // ---- 部品 -----------------------------------------------------------------

  private make(kind: DrawVariant): SpinView {
    return kind === 'stack' ? new StackView(this.ctx) : kind === 'flap' ? new FlapView(this.ctx) : new ReelView(this.ctx)
  }

  private mount(kind: DrawVariant): void {
    const view = (this.views[kind] ??= this.make(kind))
    this.view = view
    this.el.dataset.variant = kind
    this.win.replaceChildren(view.root)
    this.strip.jumpTo(DASH)
    view.sync(this.strip)
  }

  // 型を選ぶ。熱い回ほどカードめくり型、静かな回ほどパタパタ型が出やすい。同じ型は 3 回続けない
  private choose(plan: Plan): DrawVariant {
    if (this.forced) return this.forced
    const shown = plan.upgrade || plan.tier >= 3 ? 3 : plan.tier
    const w: Record<DrawVariant, number> = {
      reel: [4, 4, 3, 3][shown],
      stack: [3, 3, 4, 5][shown],
      flap: [3, 3, 2, 2][shown],
    }
    const recent = this.history.slice(-2)
    if (recent.length === 2 && recent[0] === recent[1]) w[recent[0]] = 0
    let r = Math.random() * DRAW_VARIANTS.reduce((s, k) => s + w[k], 0)
    let kind: DrawVariant = 'reel'
    for (const k of DRAW_VARIANTS) {
      r -= w[k]
      if (r < 0) {
        kind = k
        break
      }
    }
    this.history.push(kind)
    if (this.history.length > 4) this.history.shift()
    return kind
  }

  private pick(): Code {
    const pool = this.pool.length ? this.pool : ALL
    let n = pool[Math.floor(Math.random() * pool.length)]
    if (n === this.lastPick && pool.length > 1) n = pool[(pool.indexOf(n) + 1) % pool.length]
    this.lastPick = n
    return n
  }

  private stopOn(c: Code, T: number, minD: number, around: Code | null = null): Promise<void> {
    if (this.rm || !this.raf) {
      this.strip.jumpTo(c, around)
      this.view.sync(this.strip)
      return Promise.resolve()
    }
    return this.strip.stopOn(c, T, minD, around)
  }

  // 「？」で止める。上（次に来るコマ）は空白にしておく（公開のとき、そこを通って番号が下りてくる）
  private stopQ(T: number): Promise<void> {
    return this.stopOn(Q, T, this.view.minStop, BLANK)
  }

  // カードめくり型: 一番上の札を弾き飛ばす（左右交互に、少しずつ角度を変える）
  private flick(c: Code, v: number): void {
    if (this.rm) return
    const fast = v * 1000 > 7
    const f = el('div', fast ? 'fxd-flick is-blur' : 'fxd-flick', `<div class="fxd-flick-art"></div><div class="fxd-flick-row">${codeHtml(c)}</div>`)
    this.flyers.append(f)
    while (this.flyers.childElementCount > 6) this.flyers.firstElementChild?.remove()
    const side = (this.flickSide = -this.flickSide)
    const dx = side * rand(420, 600)
    const dy = -rand(120, 300)
    const rot = side * rand(18, 40)
    const a = this.anim(
      f,
      [
        { transform: 'translate3d(0,0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate3d(${dx * 0.3}px,${dy * 0.55}px,60px) rotate(${rot * 0.35}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate3d(${dx}px,${dy}px,120px) rotate(${rot}deg)`, opacity: 0 },
      ],
      fast ? 280 : 400,
      { easing: 'cubic-bezier(.3,.5,.5,1)' },
    )
    if (a) a.onfinish = () => f.remove()
    else f.remove()
  }

  // 表の札を捨て札として飛ばす（reset のあとすぐ start しても止まらないように、追跡しない）
  private retire(): void {
    if (this.isBack || !this.appeared || this.rm) return
    const face = this.face.cloneNode(true) as HTMLElement
    face.querySelectorAll('.go').forEach((node) => node.classList.remove('go'))
    const g = el('div', 'fxd-ghost')
    g.append(face)
    this.ghosts.append(g)
    const d = Math.random() < 0.5 ? 1 : -1
    const a = g.animate(
      [
        { transform: 'translate3d(0,0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate3d(${d * 120}px,-40px,0) rotate(${d * 6}deg)`, opacity: 1, offset: 0.25 },
        { transform: `translate3d(${d * 640}px,260px,0) rotate(${d * 34}deg) scale(.8)`, opacity: 0 },
      ],
      { duration: this.tl.ms(500), easing: 'cubic-bezier(.4,0,.75,.6)' },
    )
    const done = (): void => g.remove()
    a.onfinish = done
    a.oncancel = done
  }

  private ring(size: number, delay = 0, width = 6): void {
    if (this.rm) return
    const r = el('div', 'fxd-ring')
    r.style.cssText = `width:${size}px;height:${size}px;margin:${-size / 2}px 0 0 ${-size / 2}px;border-width:${width}px`
    this.rings.append(r)
    const a = this.anim(r, [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(.38)', opacity: 0.9, offset: 0.08 }, { transform: 'scale(1)', opacity: 0 }], 600, {
      delay,
      easing: 'cubic-bezier(.15,.75,.3,1)',
      fill: 'backwards',
    })
    if (a) a.onfinish = () => r.remove()
    else r.remove()
  }

  private punch(k: number): void {
    this.anim(this.pop, [{ transform: 'scale(1)' }, { transform: `scale(${1 + k})`, offset: 0.3 }, { transform: 'scale(1)' }], 240, {
      composite: 'add',
      easing: 'ease-out',
    })
  }

  // カードの表面を光の帯が横切る（点滅にならないよう、実時間で 0.42 秒に 1 回まで）
  private glare(): void {
    if (this.rm || !this.gate('glare', 420)) return
    for (const g of this.glares) {
      g.style.setProperty('--gd', `${Math.round(Math.max(380, this.tl.ms(650)))}ms`)
      replay(g, 'go')
    }
  }

  private burst(x: number, y: number, count: number, t: Tier, speed: number): void {
    if (this.rm) return
    this.fx.burst(x, y, { count, colors: this.colors(t), speed, shape: 'spark', gravity: 0.1, life: 42 })
  }

  private colors(t: Tier): string[] {
    return [TIER_COLOR[t], LIGHT[t], '#ffffff']
  }

  private setHeat(t: Tier, force = false): void {
    if (t === this.heat && !force) return
    const up = t > this.heat
    this.heat = t
    this.el.dataset.heat = String(t)
    this.mark.textContent = TIER_SHAPE[t]
    this.badge.innerHTML = `<i>${TIER_SHAPE[t]}</i><b>${TIER_WORD[t]}</b>`
    if (up && this.el.dataset.phase === 'run') this.glare()
  }

  private flipTo(back: boolean, ms: number): void {
    if (back === this.isBack) return
    const from = this.angle
    this.angle += 180
    this.isBack = back
    this.card.style.transform = `rotateY(${this.angle}deg)`
    this.anim(this.card, [{ transform: `rotateY(${from}deg)` }, { transform: `rotateY(${this.angle}deg)` }], ms, {
      easing: 'cubic-bezier(.35,1.3,.55,1)',
    })
  }

  // 前の抽選の名残を消して、裏向きの札が待つ状態にする（演出はすべて止める）
  private clear(): void {
    this.tl.cancel()
    this.tl = new Timeline(this.speed)
    this.strip.halt()
    for (const a of [...this.anims]) a.cancel()
    this.anims.clear()
    this.solos.clear()
    if (this.holding) {
      sfx.silence()
      this.holding = false
    }
    if (this.ducked) {
      bgm.duck(false)
      this.ducked = false
    }
    this.flockEl.replaceChildren()
    this.flyers.replaceChildren()
    this.rings.replaceChildren()
    for (const node of [this.telopEl, this.pushEl, this.cut, this.next, this.dim, this.ecg]) node.classList.remove('on')
    this.el.classList.remove('is-rise', 'is-ma', 'is-done')
    this.rays.classList.remove('boost')
    this.back.classList.remove('is-gold', 'has-q')
    for (const plate of this.plates) {
      plate.classList.remove('on', 'hot', 'sweep')
      const em = plate.querySelector('em')
      if (em) em.textContent = ''
    }
    this.stepsEl.style.setProperty('--fill', '0')
    this.angle = 180
    this.isBack = true
    this.card.style.transform = 'rotateY(180deg)'
    this.pushOn = false
    this.appeared = false
    this.el.dataset.phase = 'idle'
    this.setHeat(0, true)
    this.view.sync(this.strip)
  }

  private applyMotion(): void {
    this.rm = this.rmOption ?? prefersReducedMotion()
    this.el.classList.toggle('is-rm', this.rm)
    if (this.rm) {
      if (this.raf) cancelAnimationFrame(this.raf)
      this.raf = 0
      this.tiltEl.style.transform = ''
      this.holo.style.transform = ''
    } else if (!this.raf && !this.dead) {
      this.last = 0
      this.raf = requestAnimationFrame(this.frame)
    }
  }

  // 毎フレーム: リールを進めて描き、カードをゆっくり傾ける（ホロの光が傾きに合わせて流れる）
  private readonly frame = (now: number): void => {
    if (this.dead || this.rm) {
      this.raf = 0
      return
    }
    const dt = Math.min(64, Math.max(0, now - (this.last || now))) * this.speed
    this.last = now
    const crossed = this.strip.update(dt)
    if (!this.isBack) {
      if (crossed > 0) {
        this.view.cross(this.strip.code(this.strip.index), this.strip.v)
        if (this.gate('tick', 46)) sfx.tick()
      }
      this.view.render(this.strip)
    }
    const s = now / 1000
    const ry = Math.sin(s * 0.83) * 6 + Math.sin(s * 2.1) * 1.1
    const rx = Math.sin(s * 0.61 + 1.3) * 3.2
    this.tiltEl.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`
    this.holo.style.transform = `translate3d(${(ry * 2.2).toFixed(1)}%,${(rx * 2.6).toFixed(1)}%,0)`
    this.raf = requestAnimationFrame(this.frame)
  }

  // WAAPI のアニメーション。長さは tl.ms で決め（real のときは実時間のまま）、reset でまとめて止められるよう覚えておく
  private anim(node: Element, frames: Keyframe[], ms: number, o: AnimOpts = {}): Animation | null {
    if (this.rm || this.dead) return null
    const scale = (x: number): number => (o.real ? x : this.tl.ms(x))
    const a = node.animate(frames, {
      duration: Math.max(1, scale(ms)),
      delay: o.delay ? scale(o.delay) : 0,
      easing: o.easing ?? 'linear',
      fill: o.fill ?? 'none',
      composite: o.composite ?? 'replace',
    })
    this.anims.add(a)
    const drop = (): void => {
      this.anims.delete(a)
    }
    a.addEventListener('cancel', drop)
    if (o.fill !== 'forwards' && o.fill !== 'both') a.addEventListener('finish', drop)
    return a
  }

  // 終わったあとも最後の形を保つアニメーション（同じ要素の前のものは止める）
  private solo(node: Element, frames: Keyframe[], ms: number, easing = 'linear'): void {
    this.solos.get(node)?.cancel()
    const a = this.anim(node, frames, ms, { easing, fill: 'forwards' })
    if (a) this.solos.set(node, a)
  }

  // 同じ光や音が、実時間で ms より短い間隔で続かないようにする
  private gate(key: string, ms: number): boolean {
    const now = performance.now()
    if (now - (this.gates.get(key) ?? -1e9) < ms) return false
    this.gates.set(key, now)
    return true
  }

  private $<T extends Element = HTMLElement>(selector: string): T {
    const node = this.el.querySelector<T>(selector)
    if (!node) throw new Error(`抽選機の要素が見つかりません: ${selector}`)
    return node
  }
}
