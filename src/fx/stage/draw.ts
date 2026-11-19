import './draw.css'
import { sfx } from '../../audio'
import { pickStyle, type Beat } from '../../core/show'
import { FLIP_EASING, MACHINE, flapMs, flipPlan, reelRun, slotOf, stopMs, type ReelRun } from '../landing'
import { Particles } from '../particles'
import { Timeline, el, prefersReducedMotion, replay } from '../runtime'
import { GOLD, type MachineStyle, type Tier } from '../theme'

// 大画面の抽選機（1920×1080 の大画面に重ねて使う）。
// どの回も同じ調子で「回る → ゆっくりになる → 番号が出る → 結果の言葉」だけを見せる。
// 期待度（色・目盛り・予告）は出さない（期待度を出すのはスマホだけ。会場と自分の 2 本を出すと、同じ回に色が食い違う）。
// 回っている間は中立の色（濃紺と白）。色がつくのは着地のあとだけで、それは予告ではなく結果の表示:
//   power 0 何もなし / 1 リーチが増えた（白い光が少し強い）/ 2 ビンゴが出た（金の光と粒子はここだけ）
//
// 使い方:
//   const m = new DrawMachine(stageRoot)
//   m.setPool(まだ出ていない番号)
//   m.start(beats, style)       // beats は core/show.ts の venueBeats(reveal)。style は権威が決めた型
//   await m.reveal(23, { onLand, result: 'ビンゴ 1 人！', power: 2 })   // 番号を見せる。onLand は番号が見えた瞬間
//   m.reset()                   // 次の抽選の前に戻す（めくった札は捨て札として飛んでいく）
//
// 見た目:
//   - カードはトレカ（オリパ）風。銀と濃紺の金属の縁とホロの光沢。裏は紺地に金の箔押し。
//   - 回し方の型は毎回変わる（権威が core/show.ts の pickStyle で決めて、スマホにも同じ型を配る。渡されなければここで選ぶ）:
//       reel  スロットリール型: 縦に流れるリール。速さに応じてモーションブラーをかける
//       stack カードめくり型: 山札の一番上を弾き飛ばして、下の札をめくる
//       flap  パタパタ型: 駅の発車標のような反転フラップ
//   - 登場のしかた・放射光の本数と向きも毎回変える。
//   - リールの動かし方と着地の時刻の数字は fx/landing.ts にある（スマホの手元の演出と同じ数字を使い、番号が見える瞬間をそろえる。
//     大画面は、いつも段階 0 の動き）。
//
// 配置（大画面の座標）: 抽選機の領域（x 40〜1240、y 90〜790）の真ん中にカードを置く。
//   カードは 400×560 で組み、領域ごと 1.15 倍に広げる（見た目は 460×644、中心 640, 440）。
// z-index: 背景の光 1〜2、カードまわり 10、粒子 60。
// 根（.fxd）は z-index も transform も持たないので、子は host の重なりの中にそのまま並ぶ。

export interface DrawMachineOptions {
  speed?: number
  variant?: MachineStyle // 回し方の型を固定する（ギャラリーなど）。省略すると start に渡された型（なければ pickStyle）
  reducedMotion?: boolean // 動きを減らした表示にする。省略すると OS の設定（prefers-reduced-motion）に従う
}

export interface RevealOptions {
  onLand?: () => void // 番号が見えた瞬間（着地）に 1 回呼ぶ。脇の欄・盤は、これを待ってから番号を出す
  result?: string // 着地のあと、カードの帯をこの言葉に替える（「ビンゴ 3 人！」「リーチ +12 人」「ビンゴなし」など）
  power?: Power // 着地の強さ: 0 何もなし / 1 リーチが増えた / 2 ビンゴが出た（金の光と粒子はここだけ）
}

type Power = 0 | 1 | 2

const CX = 640 // カードの中心（大画面の座標）
const CY = 440
const SCALE = 1.15 // カードまわりの拡大率（draw.css の .fxd-stage の scale と合わせる）
const ROW = 200 // リールの 1 コマの高さ
const BADGE_W = 368 // カードの帯に収める文字の幅

// カードの帯の言葉。回っている間は問いかけ、番号が出たら結果（渡されなければ「出ました！」）
const SPIN_WORD = '次の番号は…？'
const LANDED_WORD = '出ました！'

// 着地の音は、結果の強さで選ぶ。ビンゴの人数に応じたファンファーレは画面側が別に鳴らすので、ここは重くしすぎない
const IMPACT_SFX: readonly Tier[] = [0, 1, 2]
// 着地の粒子の色。金はビンゴが出たときだけ
const WHITE = ['#ffffff', '#dfe6ff', '#aebcf5'] as const

// リールのコマ: 1〜75 = 番号、0 = 空白、-1 = ？（動きを減らす設定で、回す代わりに出す）、-2 = 回る前の「--」
type Code = number
const BLANK = 0
const Q = -1
const DASH = -2

const ALL = Array.from({ length: 75 }, (_, i) => i + 1)

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
const pickOne = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]

function codeHtml(c: Code): string {
  if (c === Q) return '<span class="fxd-q">?</span>'
  if (c === DASH) return '<span class="fxd-dash">--</span>'
  if (c <= 0) return ''
  return `<span class="fxd-l">${'BINGO'[Math.floor((c - 1) / 15)] ?? ''}</span><span class="fxd-n">${c}</span>`
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
  // minD は最低限進めるコマ数（止める先のコマがまだ見えていない距離にする）
  stopOn(c: Code, T: number, minD: number): Promise<void> {
    this.finish()
    const p0 = this.pos
    const v0 = this.v
    // 一定の減速なら v0·T/2 進む。それ以上の整数のコマにする（エルミートが行き過ぎない条件 D ≥ v0·T/3 も満たす）
    const p1 = Math.ceil(p0 + Math.max(minD, (v0 * T) / 2) - 1e-6)
    this.set(p1, c)
    this.goal = 0
    return new Promise((done) => {
      this.tw = { p0, v0, p1, T: Math.max(16, T), t: 0, done }
    })
  }

  // 止めた状態で c を見せる（見えていない先のコマへ飛ぶ。上下のコマは空白にする）
  jumpTo(c: Code): void {
    this.halt()
    const p = this.index + 4
    this.pos = p
    this.set(p, c)
    this.set(p - 1, BLANK)
    this.set(p + 1, BLANK)
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

// 型ごとの全速・止めるときに進めるコマ数・着地までの遅れは、fx/landing.ts の MACHINE にある
interface SpinView {
  readonly kind: MachineStyle
  readonly root: HTMLElement // カードの窓の中に入る
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
    return MACHINE.reel.lock
  }
}

// カードめくり型: 窓には一番上の札の番号だけを出す。コマが替わるたびに、前の札を弾き飛ばす（飛ぶ札は抽選機が出す）
class StackView implements SpinView {
  readonly kind = 'stack' as const
  readonly root = el('div', 'fxd-stack')
  private shown: Code = Number.NaN

  constructor(private readonly ctx: ViewCtx) {}

  private show(c: Code): void {
    this.shown = c
    this.root.innerHTML = codeHtml(c)
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
    return MACHINE.stack.lock // 弾いた札がどいて、下の番号が見えるまで
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
  }

  render(): void {}

  cross(to: Code, v: number): void {
    const from = this.shown
    this.settle()
    this.shown = to
    const d = flapMs(v)
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
    return this.last // 最後の 1 枚が落ちきるまで（止まる瞬間の 1 枚なので、MACHINE.flap.lock と同じ長さになる）
  }
}

// ---- 抽選機 -----------------------------------------------------------------

const HTML = `
<div class="fxd-aura"></div>
<div class="fxd-rays"></div>
<div class="fxd-stage">
  <div class="fxd-glow"></div>
  <div class="fxd-halo"></div>
  <div class="fxd-rings"></div>
  <div class="fxd-under u2"></div>
  <div class="fxd-under u1"></div>
  <div class="fxd-pop"><div class="fxd-tilt"><div class="fxd-card">
    <div class="fxd-side fxd-face">
      <div class="fxd-art"></div>
      <div class="fxd-top"><b>BINGOO</b></div>
      <div class="fxd-win"></div>
      <div class="fxd-badge"><b></b></div>
      <div class="fxd-holo"></div>
      <div class="fxd-glare"></div>
    </div>
    <div class="fxd-side fxd-back">
      <div class="fxd-lattice"></div>
      <div class="fxd-emblem"><i>★</i></div>
      <div class="fxd-logo">BINGOO<small>PREMIUM PACK</small></div>
      <div class="fxd-sheen"></div>
      <div class="fxd-glare"></div>
    </div>
  </div></div></div>
  <div class="fxd-flyers"></div>
  <div class="fxd-ghosts"></div>
</div>
<canvas class="fxd-fx" width="1920" height="1080"></canvas>`

export class DrawMachine {
  readonly el: HTMLElement
  private speed: number
  private tl: Timeline
  private readonly fx: Particles
  private readonly strip: Strip
  private readonly ctx: ViewCtx
  private readonly views: Partial<Record<MachineStyle, SpinView>> = {}
  private view: SpinView
  private readonly forced: MachineStyle | undefined
  private readonly rmOption: boolean | undefined
  private rm = false
  private readonly history: MachineStyle[] = [] // 最近の型（自分で選ぶときに、同じ型を 3 回続けないため）
  private pool: number[] = []
  private lastPick = 0

  private readonly stage: HTMLElement
  private readonly rays: HTMLElement
  private readonly pop: HTMLElement
  private readonly tiltEl: HTMLElement
  private readonly card: HTMLElement
  private readonly face: HTMLElement
  private readonly win: HTMLElement
  private readonly holo: HTMLElement
  private readonly glares: HTMLElement[]
  private readonly badge: HTMLElement
  private readonly badgeText: HTMLElement
  private readonly halo: HTMLElement
  private readonly rings: HTMLElement
  private readonly flyers: HTMLElement
  private readonly ghosts: HTMLElement

  private isBack = true // カードが裏（待機中）を向いている
  private angle = 180 // カードの Y 回転（裏返すたびに 180 足す）
  private appeared = false
  private power: Power = 0 // 表の札の着地の強さ（捨て札として飛ばすときに、色を引き継ぐ）
  private flickSide = 1
  private raf = 0
  private last = 0
  private dead = false
  private readonly anims = new Set<Animation>()
  private readonly gates = new Map<string, number>()

  constructor(host: HTMLElement, o: DrawMachineOptions = {}) {
    this.speed = o.speed && o.speed > 0 ? o.speed : 1
    this.tl = new Timeline(this.speed)
    this.forced = o.variant
    this.rmOption = o.reducedMotion
    this.el = el('div', 'fxd', HTML)
    host.append(this.el)
    this.stage = this.$('.fxd-stage')
    this.rays = this.$('.fxd-rays')
    this.pop = this.$('.fxd-pop')
    this.tiltEl = this.$('.fxd-tilt')
    this.card = this.$('.fxd-card')
    this.face = this.$('.fxd-face')
    this.win = this.$('.fxd-win')
    this.holo = this.$('.fxd-holo')
    this.glares = [...this.el.querySelectorAll<HTMLElement>('.fxd-glare')]
    this.badge = this.$('.fxd-badge')
    this.badgeText = this.$('.fxd-badge b')
    this.halo = this.$('.fxd-halo')
    this.rings = this.$('.fxd-rings')
    this.flyers = this.$('.fxd-flyers')
    this.ghosts = this.$('.fxd-ghosts')
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

  // beats は core/show.ts の venueBeats(reveal)（appear → spin → decel → reveal）。
  // style を渡すと、その型で回す（権威が決めた型。スマホの手元の演出と着地の時刻をそろえるため）。
  // 渡されなければ、権威と同じ選び方（core/show.ts の pickStyle）でここで選ぶ
  start(beats: readonly Beat[], style?: MachineStyle): void {
    if (this.dead) return
    this.retire()
    this.clear()
    this.applyMotion()
    const kind = this.forced ?? style ?? pickStyle(this.history, Math.random)
    this.history.push(kind)
    if (this.history.length > 4) this.history.shift()
    this.mount(kind)
    this.rays.style.setProperty('--ray', `${360 / pickOne([12, 16, 20, 24])}deg`)
    this.rays.classList.toggle('rev', Math.random() < 0.5)
    this.el.dataset.phase = 'run'
    // 拍ごとに「次の拍までの持ち時間」を渡す（減速は、公開までの持ち時間に合わせてゆっくりになる）
    const list = [...beats].sort((a, b) => a.at - b.at)
    list.forEach((b, i) => this.tl.at(b.at, () => this.beat(b, slotOf(list, i))))
  }

  // 番号の着地。回っていればリールを減速して止め、裏向きのまま（回る前）ならめくって見せる
  async reveal(n: number, o: RevealOptions = {}): Promise<void> {
    // onLand は必ず 1 回だけ呼ぶ（公開が途中で打ち切られたときも。脇の欄が番号を出しそこねないように）
    let landed = false
    const land = (): void => {
      if (landed) return
      landed = true
      o.onLand?.()
    }
    try {
      await this.land(n, o.power ?? 0, o.result, land)
    } finally {
      land()
    }
  }

  private async land(n: number, power: Power, result: string | undefined, onLand: () => void): Promise<void> {
    if (this.dead) return
    this.tl.cancel()
    const tl = (this.tl = new Timeline(this.speed))
    this.el.dataset.phase = 'land'
    this.appeared = true
    // 着地までの時間は fx/landing.ts の数字で決める（スマホの手元の演出も、同じ数字で同じ時刻に着地する。段階はいつも 0）
    if (this.isBack || this.rm) {
      const f = flipPlan(0, this.rm)
      this.strip.jumpTo(n)
      this.view.sync(this.strip)
      this.flipTo(false, f.ms)
      await tl.wait(f.land)
    } else {
      await this.stopOn(n, stopMs(this.strip.v), MACHINE[this.view.kind].minStop)
      if (tl.cancelled) return
      const d = this.view.lockDelay()
      if (d > 0) await tl.wait(d)
    }
    if (tl.cancelled) return
    this.impact(power)
    onLand()
    // 番号が出たら、結果が主役: カードの帯を「何が起きたか」の言葉に替える（番号を先に見せてから）
    if (result) tl.at(280, () => this.showResult(result))
    else this.showResult(LANDED_WORD)
    await tl.wait([360, 520, 760][power])
    if (tl.cancelled) return
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

  // 大画面が使う拍は、登場・回り出し・減速だけ（reveal は公開の予定時刻の目印。ほかの拍はスマホの予告用なので、来ても何もしない）
  private beat(b: Beat, slot: number): void {
    if (b.kind !== 'appear' && b.kind !== 'spin' && b.kind !== 'decel') return
    if (!this.appeared) this.appear()
    if (b.kind === 'spin') this.spin()
    else if (b.kind === 'decel') this.decel(slot)
  }

  // 登場: 待機中の裏の札をめくって表にする。入り方は 3 通りから選ぶ
  private appear(): void {
    this.appeared = true
    this.strip.jumpTo(DASH)
    this.view.sync(this.strip)
    const d = Math.random() < 0.5 ? 1 : -1
    const from = pickOne([
      `translate3d(${-d * 380}px,90px,0) rotate(${-d * 16}deg) scale(.8)`, // 山札から配る
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
    this.run(reelRun.spin(this.view.kind))
  }

  // 減速: 公開に向けてリールがゆっくりになる
  private decel(slot: number): void {
    if (this.rm || this.isBack) return
    this.run(reelRun.decel(slot))
  }

  // ---- 着地 -----------------------------------------------------------------

  // 番号が止まった瞬間。結果の強さに応じて、弾み・衝撃の輪・光（中央の 1/3 以下）・粒子を重ねる。
  // 金の光と粒子・揺れは、ビンゴが出たとき（power 2）だけ
  private impact(p: Power): void {
    sfx.impact(IMPACT_SFX[p])
    this.power = p
    this.el.dataset.power = String(p)
    this.el.classList.add('is-done')
    this.view.land()
    this.glare()
    if (this.rm) return
    const big = [0.07, 0.11, 0.16][p]
    this.anim(
      this.pop,
      [{ transform: 'scale(1)' }, { transform: `scale(${1 + big})`, offset: 0.25 }, { transform: `scale(${1 - big * 0.22})`, offset: 0.55 }, { transform: 'scale(1)' }],
      420 + p * 70,
      { composite: 'add', easing: 'ease-out' },
    )
    this.flash(p)
    this.ring([460, 560, 680][p], 0, 6 + p)
    if (p >= 1) this.ring([0, 420, 540][p], 130, 4)
    // 粒は短い時間で消して、抽選機の領域の中に収める（上の HUD や下の番号の盤まで飛ばさない）
    const y = CY - 30 * SCALE
    this.fx.burst(CX, y, {
      count: [40, 110, 180][p],
      colors: p === 2 ? [...GOLD, '#ffffff'] : WHITE,
      speed: [6, 8, 9][p],
      shape: p >= 1 ? 'spark' : pickOne(['rect', 'dot'] as const),
      gravity: p >= 1 ? 0.06 : 0.2,
      life: 40 + 2 * p,
    })
    if (p >= 1) this.fx.burst(CX, y, { count: 50 + 40 * (p - 1), colors: ['#ffffff', p === 2 ? '#fff4cc' : '#dfe6ff'], speed: 4, shape: 'dot', gravity: 0.03, life: 60, size: 5 })
    if (p < 2) return
    // ビンゴが出た: カードが揺れ、金の粒がカードの足もとから立ち上る。
    // 画面いっぱいの紙吹雪とファンファーレは、画面側（ui/stage.ts）が人数に応じて出すので、ここでは重ねない
    this.shake()
    this.fx.burst(CX, y, { count: 140, colors: GOLD, speed: 9, shape: 'spark', gravity: 0.04, life: 44 })
    const foot = CY + 280 // カードの下の縁のあたり（下の番号の盤にはかけない）
    this.fx.rise(120, GOLD, CX - 280, CX + 280, foot)
    this.tl.at(380, () => this.fx.rise(80, GOLD, CX - 220, CX + 220, foot))
    this.rays.classList.add('boost')
    this.tl.at(1800, () => this.rays.classList.remove('boost'))
  }

  // 着地の光。中央の 1/3 以下の楕円で、立ち上がりは実時間で 160ms 以上
  private flash(p: Power): void {
    const w = [560, 640, 760][p]
    const h = Math.round(w * 0.86)
    const peak = [0.55, 0.8, 1][p]
    this.halo.style.cssText = `width:${w}px;height:${h}px;margin:${-h / 2}px 0 0 ${-w / 2}px`
    const rise = Math.max(160, this.tl.ms(180))
    const total = Math.max(rise + 520, this.tl.ms(1100))
    this.anim(
      this.halo,
      [
        { opacity: 0, transform: 'scale(.55)' },
        { opacity: peak, transform: 'scale(1)', offset: rise / total },
        { opacity: 0, transform: 'scale(1.12)' },
      ],
      total,
      { real: true, easing: 'ease-out' },
    )
  }

  // 揺れはビンゴが出たときだけ。8px 以内（拡大の 1.15 倍を含めて）・実時間で 300ms 以内
  private shake(): void {
    const pts = [[0, 0], [-6, 2], [5, -3], [-4, 2], [3, -1], [-1, 1], [0, 0]]
    const frames = pts.map(([x, y]) => ({ transform: `translate(${x}px,${y}px)` }))
    this.anim(this.stage, frames, Math.min(280, this.tl.ms(260)), { composite: 'add', real: true })
  }

  // ---- 部品 -----------------------------------------------------------------

  private make(kind: MachineStyle): SpinView {
    return kind === 'stack' ? new StackView(this.ctx) : kind === 'flap' ? new FlapView(this.ctx) : new ReelView(this.ctx)
  }

  private mount(kind: MachineStyle): void {
    const view = (this.views[kind] ??= this.make(kind))
    this.view = view
    this.el.dataset.variant = kind
    this.win.replaceChildren(view.root)
    this.strip.jumpTo(DASH)
    view.sync(this.strip)
  }

  private pick(): Code {
    const pool = this.pool.length ? this.pool : ALL
    let n = pool[Math.floor(Math.random() * pool.length)]
    if (n === this.lastPick && pool.length > 1) n = pool[(pool.indexOf(n) + 1) % pool.length]
    this.lastPick = n
    return n
  }

  private stopOn(c: Code, T: number, minD: number): Promise<void> {
    if (this.rm || !this.raf) {
      this.strip.jumpTo(c)
      this.view.sync(this.strip)
      return Promise.resolve()
    }
    return this.strip.stopOn(c, T, minD)
  }

  // カードめくり型: 一番上の札を弾き飛ばす（左右交互に、少しずつ角度を変える）。
  // 飛ぶのは抽選機の領域の中だけ（右の結果の欄に届く前に、小さくなって消える）
  private flick(c: Code, v: number): void {
    if (this.rm) return
    const fast = v * 1000 > 7
    const f = el('div', fast ? 'fxd-flick is-blur' : 'fxd-flick', `<div class="fxd-flick-art"></div><div class="fxd-flick-row">${codeHtml(c)}</div>`)
    this.flyers.append(f)
    while (this.flyers.childElementCount > 6) this.flyers.firstElementChild?.remove()
    const side = (this.flickSide = -this.flickSide)
    const dx = side * rand(220, 300)
    const dy = rand(-60, 60)
    const rot = side * rand(12, 26)
    const a = this.anim(
      f,
      [
        { transform: 'translate3d(0,0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate3d(${dx * 0.3}px,${dy * 0.55}px,30px) rotate(${rot * 0.35}deg)`, opacity: 1, offset: 0.3 },
        { transform: `translate3d(${dx}px,${dy}px,0) rotate(${rot}deg) scale(.9)`, opacity: 0 },
      ],
      fast ? 280 : 400,
      { easing: 'cubic-bezier(.3,.5,.5,1)' },
    )
    if (a) a.onfinish = () => f.remove()
    else f.remove()
  }

  // 表の札を捨て札として飛ばす（reset のあとすぐ start しても止まらないように、追跡しない）。
  // 飛んでいく札は、着地したときの色（ビンゴが出た回は金）のままにする
  private retire(): void {
    if (this.isBack || !this.appeared || this.rm) return
    const face = this.face.cloneNode(true) as HTMLElement
    face.querySelectorAll('.go').forEach((node) => node.classList.remove('go'))
    const g = el('div', this.el.classList.contains('is-done') ? 'fxd-ghost is-done' : 'fxd-ghost')
    g.dataset.power = String(this.power)
    g.append(face)
    this.ghosts.append(g)
    const d = Math.random() < 0.5 ? 1 : -1
    const a = g.animate(
      [
        { transform: 'translate3d(0,0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate3d(${d * 110}px,-40px,0) rotate(${d * 6}deg)`, opacity: 1, offset: 0.25 },
        { transform: `translate3d(${d * 480}px,240px,0) rotate(${d * 34}deg) scale(.8)`, opacity: 0 },
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

  // カードの表面を光の帯が横切る（点滅にならないよう、実時間で 0.42 秒に 1 回まで）
  private glare(): void {
    if (this.rm || !this.gate('glare', 420)) return
    for (const g of this.glares) {
      g.style.setProperty('--gd', `${Math.round(Math.max(380, this.tl.ms(650)))}ms`)
      replay(g, 'go')
    }
  }

  // カードの帯の言葉を替える。長い言葉（「リーチ +1280 人」など）は、帯の幅に収まるまで文字を小さくする
  private setBadge(text: string, result: boolean): void {
    const b = this.badgeText
    this.badge.classList.toggle('is-result', result)
    b.style.fontSize = ''
    b.textContent = text
    const w = b.offsetWidth
    if (w > BADGE_W) b.style.fontSize = `${Math.max(34, Math.floor((parseFloat(getComputedStyle(b).fontSize) * BADGE_W) / w))}px`
  }

  // 番号が出たあと: 帯を結果の言葉に替える
  private showResult(text: string): void {
    this.setBadge(text, true)
    this.anim(this.badge, [{ transform: 'scale(1.3)' }, { transform: 'scale(.97)', offset: 0.6 }, { transform: 'scale(1)' }], 320, {
      easing: 'cubic-bezier(.2,.9,.3,1)',
    })
  }

  private flipTo(back: boolean, ms: number): void {
    if (back === this.isBack) return
    const from = this.angle
    this.angle += 180
    this.isBack = back
    this.card.style.transform = `rotateY(${this.angle}deg)`
    this.anim(this.card, [{ transform: `rotateY(${from}deg)` }, { transform: `rotateY(${this.angle}deg)` }], ms, {
      easing: FLIP_EASING,
    })
  }

  // 一定の速さに向かう（数字は fx/landing.ts の reelRun）
  private run(r: ReelRun): void {
    this.strip.run(r.v, r.ease)
  }

  // 前の抽選の名残を消して、裏向きの札が待つ状態にする（演出はすべて止める）
  private clear(): void {
    this.tl.cancel()
    this.tl = new Timeline(this.speed)
    this.strip.halt()
    for (const a of [...this.anims]) a.cancel()
    this.anims.clear()
    this.flyers.replaceChildren()
    this.rings.replaceChildren()
    this.el.classList.remove('is-done')
    this.rays.classList.remove('boost')
    this.angle = 180
    this.isBack = true
    this.card.style.transform = 'rotateY(180deg)'
    this.appeared = false
    this.power = 0
    delete this.el.dataset.power
    this.el.dataset.phase = 'idle'
    this.setBadge(SPIN_WORD, false)
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
