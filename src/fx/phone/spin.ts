import { sfx } from '../../audio'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { GOLD, RAINBOW, TIER_SHAPE, TIER_WORD, type Tier } from '../theme'
import { txt, type AoriOutcome } from './aori'
import { boxIn, play, ring, settle, shake, sparkBurst } from './card'
import './spin.css' // card.css・aori.css より後に読み込む（カードのマスを照らす規則と、縁取り文字の色を上書きするため）

// 手元のスロット（390×844 のスマホ画面に重ねる）。抽選のたびに、自分のスマホで番号を開ける。
//   1. start: リールが回り出す。連打するほど速く回り、ゲージが溜まる（何もしなくても、時間切れの約 1.5 秒前に満タン）。
//      ゲージが 25・50・75・100% を越えるたびに、自分のカードにとっての段階（tier）の予告が 1 段ずつ上がる。
//      上がり方は毎回変わるが、最後に見せる段階は必ず tier（嘘はつかない）。虹は満タンの手前で時が止まって「確定」
//   2. open: 番号が届く。ゲージが満タンで、minChargeMs を過ぎていれば STOP が光る
//   3. stopped: STOP を押すか、deadlineMs で時間切れになると、リールがその番号にぴたりと止まって解決する
//   4. resolve: 止まったあとの結果（当たりは「当たった！」の瞬間まで。あおったのに外れたら失敗演出）
// 番号は先に決まっていて、STOP で変わるのは止めるタイミングだけ。
//
//   const spin = new HandSpin(phone, { speed })
//   spin.start({ tier: 2, waiting: ['O65'], pool, minChargeMs: 5500, deadlineMs: 9000 })
//   spin.open(48)                                    // 番号が届いたら（start の直後でも、あとからでもよい）
//   const { by } = await spin.stopped()              // 'tap' = 自分で止めた、'auto' = 時間切れ・forceStop
//   await spin.resolve({ outcome: 'double', label: 'G48' })
//   await card.stamp(13) …                           // スタンプ・リーチの札・BINGO は組み込み側で
//
// 層は host 全体（inset 0、z-index 12）。スロットの本体（リールの窓・ゲージ・STOP）は y 530〜830（--fxs-top で動かせる）。
// 回っている間は、画面のどこをタップしても連打に数える（pointerdown を受ける。伝播は止めない）。STOP はボタンを押したときだけ。
// 終わったら中身は空になり、タップも下へ通す。
// 赤以上では画面を暗くし、同じ host の中にある CardView の「あと 1 つ」のマス（.fxc-cell.is-wait）だけを照らして脈動させる。
// 段階の文字を叩きつける高さは --fxs-center（既定 318px＝カードの中心）

export interface HandSpinStart {
  tier: Tier // 自分のカードにとっての段階（0 青〜3 金、4 虹は自分のビンゴ確定）
  waiting: readonly string[] // 「あと B12」
  pool: readonly number[] // リールに流す候補（まだ出ていない番号）
  minChargeMs: number // 連打しても、これより早くは STOP できない（溜めの時間を残す）
  deadlineMs: number // start からこの時間で自動で止まる
}

type By = 'tap' | 'auto'
type Phase = 'idle' | 'charge' | 'ready' | 'stopping' | 'landed' | 'result'
type Code = number // リールのコマ: 1〜75 = 番号、0 = 空白、-1 = ？

const Q = -1
const LEVELS = [0.25, 0.5, 0.75, 1] as const // ゲージの段階。越えるたびに予告が 1 段上がりうる
const KAKUTEI_AT = 0.88 // 虹: ゲージがここまで来たら時が止まり、「確定」が出る
const FREEZE_MS = 2950 // 虹の「止まる → ヒビ → 確定 → 逆回転」の長さ（この間はゲージも止まる）
const FULL_LEAD = 1500 // 何もしなくても、時間切れのこれだけ前に満タンになる
const TAP_GAIN = 0.022 // 1 打で増えるゲージ（上限の近くでは小さくする）
const ROW = 64 // リールの 1 コマの高さ（px）
const MAX_RPS = 13 // リールの見た目の速さの上限（コマ / 実時間の秒）。ぼかしと合わせて、ちらつきにしない
const BASE_RPS: Readonly<Record<Tier, number>> = { 0: 5, 1: 5.5, 2: 6.5, 3: 7.5, 4: 8.5 }
// STOP から止まるまで（演出上の ms）。期待の高い回ほど長く、最後をじわじわ滑らせる
const STOP_MS: Readonly<Record<Tier, number>> = { 0: 480, 1: 620, 2: 920, 3: 1080, 4: 780 }
const COL = ['#ff5a5a', '#ffb84d', '#3ccf6e', '#3aa8ff', '#a85aff'] as const // B I N G O の玉の色（aori.ts の BINGO の玉と同じ）
const LIGHT: Readonly<Record<Tier, string>> = { 0: '#93c5fd', 1: '#86efac', 2: '#fca5a5', 3: '#fff4cc', 4: '#ffffff' }
const COLORS: Readonly<Record<Tier, readonly string[]>> = {
  0: ['#3b82f6', '#9cc3ff', '#ffffff'],
  1: ['#22c55e', '#5aff8c', '#eafff0'],
  2: ['#ef4444', '#ffb03a', '#fff2a8', '#ffffff'],
  3: GOLD,
  4: RAINBOW,
}
const LAMP_WORD = ['あなたのスロット', TIER_WORD[1], TIER_WORD[2], TIER_WORD[3], TIER_WORD[4]] as const
const RAISE_TEXT = ['', 'CHANCE 到来！', '激アツ！', 'BINGO CHANCE！'] as const
const CHEER: readonly (readonly string[])[] = [
  ['いい調子！', 'その調子！', 'ナイス連打！'],
  ['半分きた！', 'まだまだ！', 'いいぞ、その勢い！'],
  ['あと少し！', 'もうひと押し！', 'ラストスパート！'],
]
const HERO_TEXT: Readonly<Record<Exclude<AoriOutcome, 'none'>, string>> = {
  hit: 'ヒット！',
  reach: 'あたり！',
  double: 'あたり！！',
  bingo: '大あたり！！',
}
const OUT_POWER: Readonly<Record<AoriOutcome, number>> = { none: 0, hit: 0, reach: 1, double: 2, bingo: 3 }
const FAIL_TEXT: Readonly<Record<1 | 2 | 3, string>> = { 1: 'ざんねん…', 2: '惜しい！', 3: '失敗…' }

// 砕けるときのかけら（段階のランプを % で分けた多角形。すき間なく敷き詰める）
const SHARDS: readonly (readonly [number, number])[][] = [
  [[0, 0], [38, 0], [30, 45], [0, 60]],
  [[38, 0], [70, 0], [55, 40], [30, 45]],
  [[70, 0], [100, 0], [100, 35], [55, 40]],
  [[0, 60], [30, 45], [42, 100], [0, 100]],
  [[30, 45], [55, 40], [68, 70], [42, 100]],
  [[55, 40], [100, 35], [100, 75], [68, 70]],
  [[68, 70], [100, 75], [100, 100], [42, 100]],
]

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const pickOne = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]
const colOf = (n: number): number => clamp(Math.floor((n - 1) / 15), 0, 4)
const letterOf = (n: number): string => 'BINGO'[colOf(n)]
const numOf = (label: string): number => Number(/\d+/.exec(label)?.[0] ?? NaN)

// リールのコマの中身: 列の文字の玉と番号（「B 12」）
function codeHtml(c: Code): string {
  if (c === Q) return '<b class="fxs-q">?</b>'
  if (c <= 0) return ''
  return `<i class="fxs-l" style="--b:${COL[colOf(c)]}">${letterOf(c)}</i><b class="fxs-n">${c}</b>`
}

// 叩きつける段階の文字
function emblemHtml(t: Tier): string {
  if (t === 3) return txt(`${TIER_SHAPE[3]}BINGO`) + txt('CHANCE')
  if (t === 4) return `${txt('確定')}<small>${TIER_SHAPE[4]} あなたのビンゴ確定！ ${TIER_SHAPE[4]}</small>`
  return txt(`${TIER_SHAPE[t]}${TIER_WORD[t]}`)
}

// ゲージのレベル 1〜4 を越えたあとに見せる段階。1 段ずつしか上がらず、最後は tier（虹は別に、満タンの手前で「確定」）。
// どのレベルで上がるかは毎回変える（早く上がるほど熱い、とは限らない）
function planFor(tier: Tier): Tier[] {
  const r = Math.random()
  // ks は予告が 1 段上がるレベル
  const at = (...ks: number[]): Tier[] => [1, 2, 3, 4].map((lv) => ks.filter((k) => k <= lv).length as Tier)
  switch (tier) {
    case 0:
      return at()
    case 1:
      return at(r < 0.3 ? 1 : r < 0.7 ? 2 : 3)
    case 2:
      return r < 0.25 ? at(1, 2) : r < 0.6 ? at(1, 3) : at(2, 3)
    case 3:
      return r < 0.5 ? at(1, 2, 3) : r < 0.7 ? at(1, 2, 4) : r < 0.8 ? at(1, 3, 4) : at(2, 3, 4)
    default:
      // 虹: 金まで上がってから昇格 / ずっと静かなまま突然 / 緑・赤の途中から
      return r < 0.4 ? at(1, 2, 3) : r < 0.7 ? at() : r < 0.85 ? at(2) : at(1, 3)
  }
}

// 軽い振動（Android）。ユーザーが画面に触れる前は呼ばない（ブラウザが止めて警告を出すため）
function vibrate(ms: number): void {
  const ua = navigator.userActivation
  if (!ua || !ua.hasBeenActive || !('vibrate' in navigator)) return
  try {
    navigator.vibrate(ms)
  } catch {
    // 振動に対応していない端末
  }
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

// リールの位置（コマ単位）と速さ（コマ / 実時間の ms）。大画面の抽選機（stage/draw.ts の Strip）と同じ考え方で、
// 止めるときは 3 次エルミート曲線で、今の速さからなめらかに減速して目標のコマにぴたりと止める。
// 速さは実時間で持つ（デモの速度を上げても、見た目の速さの上限を超えないように）。逆回転もできる
class Reel {
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
      if (this.codes.size > 60) {
        const at = this.index
        for (const k of this.codes.keys()) if (Math.abs(k - at) > 8) this.codes.delete(k)
      }
    }
    return c
  }

  set(i: number, c: Code): void {
    this.codes.set(i, c)
  }

  // 一定の速さに向かう（ease は追いつくまでの時定数 ms）
  run(v: number, ease = 200): void {
    this.release()
    this.goal = v
    this.ease = Math.max(16, ease)
  }

  // 減速して c のコマで止まる。止まった瞬間に解決する。
  // creep は最後をじわじわ滑らせる（期待の高い回）。before は止まる直前に中央を通るコマ、after は止めたコマの上に置くコマ
  stopOn(c: Code, T: number, minD: number, creep: boolean, before: Code, after: Code): Promise<void> {
    this.release()
    const p0 = this.pos
    const v0 = Math.max(0, this.v)
    // 一定の減速なら v0·T/2 進む。creep は v0·T/3（行き過ぎない最小。最後に長く滑る）
    const p1 = Math.ceil(p0 + Math.max(minD, (v0 * T) / (creep ? 3 : 2)) - 1e-6)
    // 滑らせるときは、コマ数に合わせて長さを少し延ばし、毎回同じくらい滑るようにする
    const T1 = creep && v0 > 0 ? Math.min(T * 1.35, (3 * (p1 - p0)) / v0) : T
    this.set(p1, c)
    this.set(p1 + 1, after)
    // 手前のコマは、まだ見えていないときだけ差し替える（いま見えている番号が急に変わらないように）
    if (p1 - 1 > p0 + 1.4) this.set(p1 - 1, before)
    this.goal = 0
    return new Promise((done) => {
      this.tw = { p0, v0, p1, T: Math.max(16, T1), t: 0, done }
    })
  }

  // 止めた状態で c を見せる（見えていない先のコマへ飛ぶ）
  jumpTo(c: Code, below: Code = 0, above: Code = 0): void {
    this.halt()
    const p = this.index + 4
    this.pos = p
    this.set(p, c)
    this.set(p - 1, below)
    this.set(p + 1, above)
  }

  // dt（実時間の ms）だけ進める。戻り値は中央を跨いだコマの数
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
      if (s >= 1) this.snap()
    } else if (this.goal !== 0 || this.v !== 0) {
      this.v += (this.goal - this.v) * (1 - Math.exp(-dt / this.ease))
      if (this.goal === 0 && Math.abs(this.v) < 1e-4) this.v = 0
      this.pos += this.v * dt
    }
    return Math.abs(this.index - before)
  }

  // 減速の途中なら、止まる先へ飛んで解決する（画面が裏にあって毎フレームの処理が止まったときなど）
  snap(): void {
    const tw = this.tw
    if (!tw) return
    this.tw = null
    this.pos = tw.p1
    this.v = 0
    tw.done()
  }

  // その場で止める（コマの途中でも。時が止まったように）
  hold(): void {
    this.release()
    this.goal = 0
    this.v = 0
  }

  halt(): void {
    this.hold()
    this.pos = Math.round(this.pos)
  }

  // 減速を打ち切る（待っている側には解決を返す）
  private release(): void {
    const tw = this.tw
    this.tw = null
    tw?.done()
  }
}

// ---- 手元のスロット ---------------------------------------------------------

interface Parts {
  dim: HTMLCanvasElement
  wash: HTMLElement
  rays: HTMLElement
  cut: HTMLElement
  emblem: HTMLElement
  body: HTMLElement
  lamp: HTMLElement
  wait: HTMLElement | null
  win: HTMLElement
  reel: HTMLElement
  rows: { node: HTMLElement; i: number; c: Code }[]
  gauge: HTMLElement
  marks: HTMLElement[]
  msg: HTMLElement
  btn: HTMLButtonElement
  cap: HTMLElement
  word: HTMLElement
  sub: HTMLElement
  combo: HTMLElement
  fx: HTMLElement
  flash: HTMLElement
}

export class HandSpin {
  readonly el: HTMLElement
  private tl: Timeline
  private speed: number
  private gen = 0 // start / cancel ごとに増やす（古い演出の続きが、新しい回を書き換えないように）
  private dead = false
  private phase: Phase = 'idle'
  private parts: Parts | null = null
  private px: Particles | null = null
  private reel = new Reel(() => this.pick())
  private o: HandSpinStart = { tier: 0, waiting: [], pool: [], minChargeMs: 0, deadlineMs: 1 }
  private tier: Tier = 0
  private shown: Tier = 0 // いま見せている段階
  private plan: Tier[] = [0, 0, 0, 0]
  private level = 0 // 越えたゲージの段階（0〜4）
  private still = false
  private pool: number[] = []
  private waits: number[] = []
  private lastPick = 0
  private n: number | null = null
  private want: By | null = null // 止めたい（番号やフリーズの終わりを待っている）
  private done: ((r: { by: By }) => void) | null = null
  private result: Promise<{ by: By }> = Promise.resolve({ by: 'auto' })
  private landed: Promise<void> = Promise.resolve()
  private onLanded: (() => void) | null = null
  // 時計: start からの演出上の ms。速度を切り替えたら、そこまでの分を確定してから数え直す
  private e0 = 0
  private t0 = 0
  // ゲージ
  private fullAt = 1 // 何もしなくても満タンになるまでの溜めの時間
  private g = 0 // 実際の量
  private gs = 0 // 表示（なめらかに追う）
  private spring = 0 // 押した瞬間だけ少し伸びる分
  private bonus = 0 // 連打で上乗せした分
  private drawn = -1
  private frozenAt = -1 // 虹で時が止まった時刻（止まっていなければ -1）
  private frozenMs = 0
  private kakuteiOn = false
  private busyUntil = 0 // 予告の演出が終わる時刻（演出上）。それまでは STOP を光らせない
  private lockUntil = 0 // STOP が光ってから押せるようになるまで（実時間。連打の勢いで誤って止めないように）
  private msgUntil = 0
  private msgText = ''
  // 連打
  private taps = 0
  private rev = 0 // 連打の勢い（0〜1）。リールの速さと光の強さになる
  private heat = 0
  private heatDrawn = -1
  private lastTap = -1e9
  private flashed = false // 全面の光は 1 回の演出につき 1 回まで
  private beating = false
  private dusting = false
  private dustColors: readonly string[] = GOLD
  private lit: HTMLElement[] = []
  private dimLevel = 0
  private raf = 0
  private last = 0
  private blur = -1
  private readonly gates = new Map<string, number>()

  constructor(host: HTMLElement, o: { speed?: number } = {}) {
    this.el = el('div', 'fxs')
    host.append(this.el)
    this.speed = o.speed && o.speed > 0 ? o.speed : 1
    this.tl = new Timeline(this.speed)
    this.applyLoops()
    this.el.addEventListener('pointerdown', this.onDown)
    this.el.addEventListener('click', this.onClick)
  }

  setSpeed(speed: number): void {
    if (!(speed > 0)) return
    this.e0 = this.now()
    this.t0 = performance.now()
    this.speed = speed
    this.tl.speed = speed
    if (this.px) this.px.speed = speed
    this.applyLoops()
  }

  // くり返しの動きの長さ。速度を上げても、回転は 10 秒に 1 周、明滅は 1 秒に約 1 回より速くしない
  private applyLoops(): void {
    const s = this.speed
    const set = (name: string, ms: number, min: number) => this.el.style.setProperty(name, `${Math.round(Math.max(min, ms / s))}ms`)
    set('--fxs-breathe-ms', 1600, 1000)
    set('--fxs-edge-ms', 2400, 1000)
    set('--fxs-hue-ms', 12000, 10000)
    set('--fxs-spin-ms', 20000, 10000)
    set('--fxs-sheen-ms', 2600, 1400)
    this.el.style.setProperty('--fxs-k', String(1 / s))
  }

  // start からの演出上の ms
  private now(): number {
    return this.e0 + (performance.now() - this.t0) * this.speed
  }

  start(o: HandSpinStart): void {
    if (this.dead) return
    this.reset()
    const tier = clamp(Math.round(o.tier), 0, 4) as Tier
    this.o = { ...o, tier, minChargeMs: Math.max(0, o.minChargeMs), deadlineMs: Math.max(1, o.deadlineMs) }
    this.tier = tier
    this.still = prefersReducedMotion()
    this.plan = planFor(tier)
    this.pool = o.pool.filter((x) => Number.isInteger(x) && x >= 1 && x <= 75)
    this.waits = o.waiting.map(numOf).filter((x) => x >= 1 && x <= 75)
    // 何もしなくても、時間切れの約 1.5 秒前に満タンになる（虹は、時が止まる分を先に引いておく）
    this.fullAt = Math.max(1000, this.o.deadlineMs - FULL_LEAD - (tier === 4 ? FREEZE_MS : 0))
    this.e0 = 0
    this.t0 = performance.now()
    this.result = new Promise((r) => (this.done = r))
    this.landed = new Promise((r) => (this.onLanded = r))
    this.phase = 'charge'
    const p = (this.parts = this.build(o.waiting))
    this.setLamp(0, false)
    this.setButton('連打！', '画面のどこでもタップ')
    if (this.still) this.reel.jumpTo(Q)
    else this.reel.run(0.004, 260)
    this.drawReel()
    sfx.spinStart()
    // 本体が下からせり上がる
    if (this.still) void play(p.body, [{ opacity: 0 }, { opacity: 1 }], 220, this.tl)
    else
      void play(
        p.body,
        [
          { transform: 'translateY(70px)', opacity: 0 },
          { transform: 'translateY(-6px)', opacity: 1, offset: 0.7 },
          { transform: 'translateY(0px)', opacity: 1 },
        ],
        420,
        this.tl,
        { easing: 'cubic-bezier(.2,.8,.3,1)' },
      )
    this.msg('連打でゲージをためろ！', 1800)
    this.last = 0
    this.raf = requestAnimationFrame(this.frame)
    void this.coach(this.tl)
  }

  open(n: number): void {
    if (this.phase !== 'charge' && this.phase !== 'ready') return // 止めたあとは変えない
    if (!Number.isInteger(n) || n < 1 || n > 75) return
    this.n = n
    this.tick(this.now())
    if (this.want) this.request(this.want)
  }

  stopped(): Promise<{ by: 'tap' | 'auto' }> {
    return this.result
  }

  // 自動で止める（番号がまだなら届いたときに、虹のフリーズ中なら「確定」を見せてから）
  forceStop(): void {
    this.request('auto')
  }

  async resolve(o: { outcome: AoriOutcome; label: string }): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'result') return
    const gen = this.gen
    if (this.phase !== 'landed') {
      if (this.n === null) {
        // 番号が届かないまま結果が来た: リールを止めて、結果だけ見せる
        this.reel.jumpTo(Q)
        this.drawReel()
      } else {
        this.request('auto')
        await this.landed
        if (gen !== this.gen) return
      }
    }
    this.phase = 'result'
    this.el.dataset.phase = 'result'
    this.el.classList.remove('is-live')
    // 溜めの演出（鼓動・立ち上る粒子・見張り）を止めて、結果の演出に切り替える
    this.tl.cancel()
    const tl = (this.tl = new Timeline(this.speed))
    const t = this.tier
    if (o.outcome === 'none') {
      if (t >= 1 && t <= 3) await this.fail(tl, t as 1 | 2 | 3, o.label)
      else await this.quiet(tl)
    } else {
      await this.success(tl, o.outcome)
    }
    // 途中で start / cancel されたら、新しいほうを消さない
    if (this.gen === gen) this.reset()
  }

  // 途中でも片付ける（stopped() は解決しない）
  cancel(): void {
    this.reset()
  }

  destroy(): void {
    this.reset()
    this.dead = true
    this.el.removeEventListener('pointerdown', this.onDown)
    this.el.removeEventListener('click', this.onClick)
    this.el.remove()
  }

  // ---- 組み立て -------------------------------------------------------------

  private build(waiting: readonly string[]): Parts {
    const waits = waiting.map(escapeHtml).join('・')
    this.el.className = 'fxs is-live'
    this.el.dataset.tier = '0'
    this.el.dataset.phase = 'charge'
    this.el.innerHTML = `
      <canvas class="fxs-dim"></canvas>
      <i class="fxs-edge"></i>
      <i class="fxs-wash"></i>
      <div class="fxs-rays"><i></i></div>
      <div class="fxs-cut"><div class="fxs-cut-band"><i></i><i></i><i></i><div class="fxs-cut-txt">${txt(`${TIER_SHAPE[2]}激アツ${TIER_SHAPE[2]}`)}</div></div></div>
      <div class="fxs-body">
        <div class="fxs-head">
          <span class="fxs-lamp"></span>
          ${waits ? `<span class="fxs-wait"><small>あと</small><b>${waits}</b></span>` : ''}
        </div>
        <div class="fxs-win">
          <div class="fxs-reel">${'<div class="fxs-row"></div>'.repeat(5)}</div>
          <i class="fxs-glass"></i>
          <i class="fxs-pay is-l">▶</i><i class="fxs-pay is-r">◀</i>
        </div>
        <div class="fxs-gauge"><i class="fxs-fill"></i>${LEVELS.slice(0, 3)
          .map((x) => `<i class="fxs-mark" style="left:calc(3px + ${x} * (100% - 6px))"></i>`)
          .join('')}<i class="fxs-tip"></i></div>
        <div class="fxs-msg"></div>
        <button type="button" class="fxs-btn"><i class="fxs-btn-side"></i><span class="fxs-btn-cap"><b class="fxs-btn-word"></b><small class="fxs-btn-sub"></small><em class="fxs-combo"></em></span></button>
      </div>
      <canvas class="fxs-px"></canvas>
      <div class="fxs-emblem"></div>
      <div class="fxs-fx"></div>
      <i class="fxs-flash"></i>`
    const $ = <T extends Element = HTMLElement>(s: string): T => this.el.querySelector<T>(s)!
    const W = this.el.clientWidth || 390
    const H = this.el.clientHeight || 844
    for (const c of this.el.querySelectorAll('canvas')) {
      c.width = W
      c.height = H
    }
    this.px = new Particles($<HTMLCanvasElement>('.fxs-px'), 700)
    this.px.speed = this.speed
    return {
      dim: $<HTMLCanvasElement>('.fxs-dim'),
      wash: $('.fxs-wash'),
      rays: $('.fxs-rays'),
      cut: $('.fxs-cut'),
      emblem: $('.fxs-emblem'),
      body: $('.fxs-body'),
      lamp: $('.fxs-lamp'),
      wait: this.el.querySelector<HTMLElement>('.fxs-wait'),
      win: $('.fxs-win'),
      reel: $('.fxs-reel'),
      rows: [...this.el.querySelectorAll<HTMLElement>('.fxs-row')].map((node) => ({ node, i: Number.NaN, c: Number.NaN })),
      gauge: $('.fxs-gauge'),
      marks: [...this.el.querySelectorAll<HTMLElement>('.fxs-mark')],
      msg: $('.fxs-msg'),
      btn: $<HTMLButtonElement>('.fxs-btn'),
      cap: $('.fxs-btn-cap'),
      word: $('.fxs-btn-word'),
      sub: $('.fxs-btn-sub'),
      combo: $('.fxs-combo'),
      fx: $('.fxs-fx'),
      flash: $('.fxs-flash'),
    }
  }

  // ---- 毎フレーム -------------------------------------------------------------

  private readonly frame = (now: number): void => {
    this.raf = 0
    if (this.phase === 'idle') return
    const dt = Math.min(64, Math.max(0, now - (this.last || now)))
    this.last = now
    this.step(dt)
    this.raf = requestAnimationFrame(this.frame)
  }

  // dt は実時間の ms（リール・連打の勢い・表示のなめらかさは実時間で動かす）
  private step(dt: number): void {
    this.rev *= Math.exp(-dt / 650)
    this.tick(this.now())
    // リールの速さ: 連打の勢いと、いま見せている段階で決める（時が止まっている間と、止めている間は触らない）
    const live = this.phase === 'charge' || this.phase === 'ready'
    if (live && this.frozenAt < 0 && !this.still) this.reel.run(this.targetV(), 180)
    this.spring *= Math.exp(-dt / 110)
    this.gs += (this.g - this.gs) * (1 - Math.exp(-dt / 70))
    this.drawGauge()
    const crossed = this.reel.update(dt)
    // 止める間だけ、コマ送りの音（カタカタ…カタッ）
    if (crossed > 0 && this.phase === 'stopping' && this.gate('tick', 70)) sfx.tick()
    this.drawReel()
    // 熱（連打の勢い）。光の強さはゆっくり変える（タップごとに明るさが跳ねないように）
    this.heat += ((live ? this.rev : 0) - this.heat) * (1 - Math.exp(-dt / 350))
    if (Math.abs(this.heat - this.heatDrawn) > 0.01) {
      this.heatDrawn = this.heat
      this.el.style.setProperty('--heat', this.heat.toFixed(2))
    }
  }

  private targetV(): number {
    const base = BASE_RPS[this.shown]
    let rps = base + (MAX_RPS - base) * this.rev
    if (this.phase === 'ready') rps = Math.max(9, rps)
    return Math.min(MAX_RPS, rps) / 1000
  }

  // ゲージ・段階・STOP・時間切れを進める（毎フレームと、画面が裏にあるときの見張りから呼ぶ）
  private tick(t: number): void {
    if (this.phase !== 'charge' && this.phase !== 'ready') return
    if (this.frozenAt < 0) this.g = Math.max(this.g, this.gaugeAt(t))
    for (;;) {
      const lv = this.level < 4 ? LEVELS[this.level] : Infinity
      const k = this.tier === 4 && !this.kakuteiOn ? KAKUTEI_AT : Infinity
      if (k <= lv && this.g >= k) {
        void this.kakutei() // 時が止まる（ゲージもここで止まる）
        break
      }
      if (this.g < lv - 1e-9) break
      this.cross(++this.level)
    }
    if (this.phase === 'charge' && this.g >= 1 && this.frozenAt < 0) {
      if (this.n === null) this.setButton('まもなく', '番号を受け取っています')
      else if (t >= this.o.minChargeMs && t >= this.busyUntil) this.ready()
    }
    if (t >= this.o.deadlineMs) this.request('auto')
  }

  // 今の時刻のゲージ。何もしなくても少しずつ溜まり（base）、連打の分（bonus）が上乗せされる。
  // ただし minChargeMs より早くは満タンにならない（cap）
  private gaugeAt(t: number): number {
    return Math.min(1, this.capAt(t), this.baseAt(t) + this.bonus)
  }

  private capAt(t: number): number {
    return this.o.minChargeMs > 0 ? Math.min(1, t / this.o.minChargeMs) : 1
  }

  private baseAt(t: number): number {
    const frozen = this.frozenMs + (this.frozenAt >= 0 ? t - this.frozenAt : 0)
    return Math.max(0, t - frozen) / this.fullAt
  }

  // ---- 連打 -------------------------------------------------------------------

  private readonly onDown = (e: PointerEvent): void => {
    if (this.phase === 'idle' || this.phase === 'result') return
    if (e.cancelable) e.preventDefault()
    if (e.button > 0) return // 右クリックなどは数えない
    if (this.phase === 'charge') return this.tap(e)
    if (this.phase !== 'ready') return
    if (performance.now() < this.lockUntil) return this.feel(e, false) // 光った直後は、連打の続きとして受け流す
    if (this.onButton(e)) return this.request('tap')
    // STOP はボタンだけ。ほかの場所は押した跡だけ見せて、ボタンへ誘う
    if (this.gate('ripple', 340)) {
      const pt = this.local(e)
      ring(this.parts!.fx, pt.x, pt.y, 56, '#ffe08a', this.tl, 380)
    }
    this.msg('STOP ボタンを押して止めよう', 900)
  }

  // キーボード（Enter / Space）で押されたとき。タップは pointerdown で受けている
  private readonly onClick = (e: MouseEvent): void => {
    const btn = this.parts?.btn
    if (e.detail !== 0 || !btn || !(e.target instanceof Node) || !btn.contains(e.target)) return
    if (this.phase === 'charge') this.tap(null)
    else if (this.phase === 'ready' && performance.now() >= this.lockUntil) this.request('tap')
  }

  private tap(e: PointerEvent | null): void {
    const t = this.now()
    const frozen = this.frozenAt >= 0
    this.taps++
    this.lastTap = t
    if (!frozen) {
      // 上限（minChargeMs までの時間で決まる）に近いほど、1 打の伸びは小さくする。溜めすぎた分は 3% まで
      const cap = this.capAt(t)
      const k = clamp((cap - this.g) / 0.08, 0.12, 1)
      this.bonus = Math.min(this.bonus + TAP_GAIN * k, Math.max(0, cap - this.baseAt(t)) + 0.03)
      this.spring = Math.min(0.045, this.spring + 0.016)
      this.rev = Math.min(1, this.rev + 0.13)
      this.tick(t) // 自分の 1 打が、予告のきっかけになる
      if (this.gate('tap-sfx', 75)) sfx.spinTap(this.g)
      if (this.gate('vibrate', 90)) vibrate(7)
    }
    this.feel(e, frozen)
  }

  // 押した手応え: ボタンがへこみ、連打の数が弾み、ゲージの先から火花、指の跡
  private feel(e: PointerEvent | null, frozen: boolean): void {
    const p = this.parts
    if (!p || (this.phase !== 'charge' && this.phase !== 'ready')) return // 止めたあとは、沈んだボタンを動かさない
    const tl = this.tl
    // 押した感触なので、速度を上げても短くしすぎない
    if (!this.still) {
      p.cap.animate([{ transform: 'translateY(0px)' }, { transform: 'translateY(6px)', offset: 0.3 }, { transform: 'translateY(0px)' }], {
        duration: Math.max(110, tl.ms(160)),
        easing: 'ease-out',
      })
    }
    if (frozen || this.phase !== 'charge') return
    p.combo.textContent = `×${this.taps}`
    if (this.still) return
    if (this.gate('combo', 110)) void play(p.combo, [{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], 180, tl)
    // 火花は 1 秒に 8 回まで、指の跡は 1 秒に 3 回まで（同じ場所が速く明滅しないように）
    if (this.gate('spark', 120)) {
      const b = boxIn(p.gauge, this.el)
      const x = b.x + 3 + (b.w - 6) * Math.min(1, this.gs + this.spring)
      this.px?.burst(x, b.y + b.h / 2, { count: 5, colors: COLORS[this.shown], speed: 3.6, gravity: 0.14, life: 24, size: 3, shape: 'spark' })
    }
    if (e && this.gate('ripple', 340)) {
      const pt = this.local(e)
      ring(p.fx, pt.x, pt.y, 56, LIGHT[this.shown], tl, 380)
    }
  }

  // ---- 段階 -------------------------------------------------------------------

  // ゲージの段階を越えた
  private cross(level: number): void {
    const to = this.plan[level - 1] ?? this.shown
    const up = to > this.shown && to <= 3
    sfx.spinLevel(level, up ? to : this.shown)
    this.ding(level)
    this.rev = Math.min(1, this.rev + 0.35) // リールがひと伸びする
    if (level === 4) {
      this.parts?.gauge.classList.add('is-full')
      vibrate(12)
    }
    if (up) this.raise(to)
    else if (level < 4) this.msg(pickOne(CHEER[level - 1]), 1300)
  }

  // 目盛りが光り、輪と火花が出る
  private ding(level: number): void {
    const p = this.parts
    if (!p) return
    p.marks[level - 1]?.classList.add('on')
    if (this.still) return
    const tl = this.tl
    const b = boxIn(p.gauge, this.el)
    const x = b.x + 3 + (b.w - 6) * LEVELS[level - 1]
    const y = b.y + b.h / 2
    ring(p.fx, x, y, 46 + level * 10, LIGHT[this.shown], tl, 520)
    this.px?.burst(x, y, { count: 10 + level * 5, colors: COLORS[this.shown], speed: 4 + level, gravity: 0.1, life: 34, size: 4, shape: 'spark' })
    void play(p.gauge, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(1.3)', offset: 0.3 }, { transform: 'scaleY(1)' }], 260, tl)
  }

  // 予告が上がる（青 → 緑 → 赤 → 金）。quick は早送り（溜めの途中で止めたとき）
  private raise(to: Tier, quick = false): void {
    if (to <= this.shown || to > 3) return
    const tl = this.tl
    const gen = this.gen
    this.shown = to
    this.el.dataset.tier = String(to)
    if (to >= 2) {
      this.light(to)
      this.dimOn(tl, to === 2 ? 0.42 : 0.5)
      if (!this.beating) void this.heartbeat(tl)
    }
    if (to === 3) void this.dust(tl, GOLD, 620)
    this.msg(to === 2 && this.lit.length ? '激アツ！ あと 1 つが光ってる…' : RAISE_TEXT[to as 1 | 2 | 3], 1600)
    if (quick || this.still) {
      this.setLamp(to, !this.still)
      if (this.still && !quick) this.showStill(tl, to)
      return
    }
    this.busyUntil = this.now() + [0, 900, 1100, 1250][to]
    // 文字がランプに入ったところで、ランプを替える（もう次の段階に進んでいたら替えない）
    const lamp = () => {
      if (gen === this.gen && this.shown === to) this.setLamp(to, true)
    }
    if (to === 2) {
      // 緑 → 赤: 斜めの帯が走り抜けるカットイン「激アツ」
      void this.cutIn(tl).then(lamp)
      return
    }
    void this.slam(tl, to, to === 1 ? 520 : 760).then(lamp)
    tl.at(150, () => {
      const W = this.el.clientWidth || 390
      if (to === 3) shake(this.el.parentElement ?? this.el, tl, 5, 240) // 揺れは金と虹だけ
      this.px?.burst(W / 2, this.centerY(), { count: to === 3 ? 70 : 30, colors: COLORS[to], speed: 7, shape: 'spark', life: 40 })
    })
  }

  // 段階の文字を中央に叩きつけ、hold のあいだ見せてから、本体のランプへ吸い込ませる
  private slam(tl: Timeline, t: Tier, hold: number): Promise<void> {
    const p = this.parts
    if (!p) return Promise.resolve()
    const box = p.emblem
    for (const n of box.querySelectorAll('*')) n.getAnimations().forEach((a) => a.cancel())
    box.dataset.t = String(t)
    box.innerHTML = `<div class="fxs-em-in">${emblemHtml(t)}</div>`
    const inner = box.firstElementChild as HTMLElement
    const eb = boxIn(inner, this.el)
    const lb = boxIn(p.lamp, this.el)
    const dx = lb.x + lb.w / 2 - (eb.x + eb.w / 2)
    const dy = lb.y + lb.h / 2 - (eb.y + eb.h / 2)
    const k = clamp(lb.h / Math.max(1, eb.h), 0.1, 0.5)
    // 叩きつけるときの大きさは、画面の幅に収まるまで（縁取りの分の余白を残す）
    const big = Math.min(1, ((this.el.clientWidth || 390) - 36) / Math.max(1, eb.w))
    const total = 260 + hold + 420
    const o1 = 260 / total
    const o2 = (260 + hold) / total
    return play(
      inner,
      [
        { transform: `translate(0px, 0px) scale(${big * 1.7})`, opacity: 0, offset: 0, easing: 'cubic-bezier(.2,.9,.3,1)' },
        { transform: `translate(0px, 0px) scale(${big * 0.92})`, opacity: 1, offset: o1 * 0.6 },
        { transform: `translate(0px, 0px) scale(${big * 1.03})`, opacity: 1, offset: o1 * 0.85 },
        { transform: `translate(0px, 0px) scale(${big})`, opacity: 1, offset: o1 },
        { transform: `translate(0px, 0px) scale(${big})`, opacity: 1, offset: o2, easing: 'cubic-bezier(.55,0,.75,.4)' },
        { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0.9, offset: 0.97 },
        { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0, offset: 1 },
      ],
      total,
      tl,
      { fill: 'forwards', easing: 'linear' },
    )
  }

  // 動きを減らす設定のとき: 段階の文字を、動かさずにしばらく見せる
  private showStill(tl: Timeline, t: Tier): void {
    const p = this.parts
    if (!p) return
    p.emblem.dataset.t = String(t)
    p.emblem.innerHTML = `<div class="fxs-em-in">${emblemHtml(t)}</div>`
    void play(p.emblem.firstElementChild!, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], 1500, tl, {
      fill: 'forwards',
    })
  }

  // 緑 → 赤のカットイン: 斜めの帯が走り抜け、「激アツ」が叩きつけられる
  private cutIn(tl: Timeline): Promise<void> {
    const p = this.parts
    if (!p) return Promise.resolve()
    const d = 1000
    const band = p.cut.querySelector<HTMLElement>('.fxs-cut-band')!
    const word = p.cut.querySelector<HTMLElement>('.fxs-cut-txt')!
    p.cut.classList.add('on')
    void play(
      band,
      [
        { transform: 'translateX(-112%)', easing: 'cubic-bezier(.12,.9,.25,1)' },
        { transform: 'translateX(0%)', offset: 0.22 },
        { transform: 'translateX(2%)', offset: 0.8, easing: 'cubic-bezier(.6,0,.9,.5)' },
        { transform: 'translateX(112%)' },
      ],
      d,
      tl,
      { fill: 'forwards', easing: 'linear' },
    )
    void play(
      word,
      [
        { transform: 'scale(1.8)', opacity: 0 },
        { transform: 'scale(1.8)', opacity: 0, offset: 0.12, easing: 'ease-out' },
        { transform: 'scale(0.94)', opacity: 1, offset: 0.3 },
        { transform: 'scale(1)', opacity: 1, offset: 0.4 },
        { transform: 'scale(1.04)', opacity: 1, offset: 0.8 },
        { transform: 'scale(1.1) translateX(10%) skewX(-14deg)', opacity: 0 },
      ],
      d,
      tl,
      { fill: 'forwards', easing: 'linear' },
    )
    band.querySelectorAll(':scope > i').forEach((line, k) => {
      void play(line, [{ transform: 'translateX(-140%)' }, { transform: 'translateX(260%)' }], d * 0.34, tl, {
        delay: d * (0.14 + 0.16 * k),
        easing: 'linear',
        fill: 'backwards',
      })
    })
    tl.at(d * 0.26, () => {
      const W = this.el.clientWidth || 390
      const y = this.centerY()
      for (const x of [W * 0.2, W * 0.5, W * 0.8]) {
        this.px?.burst(x, y + (W / 2 - x) * Math.tan((8 * Math.PI) / 180), { count: 16, colors: COLORS[2], speed: 8, shape: 'spark', life: 36 })
      }
    })
    tl.at(d, () => p.cut.classList.remove('on'))
    return tl.wait(d)
  }

  // 虹: 時が止まる → 窓のガラスにヒビ → 「確定」→ リールが逆に回ってから、また回り出す
  private async kakutei(): Promise<void> {
    if (this.kakuteiOn) return
    const p = this.parts
    if (!p) return
    this.kakuteiOn = true
    const tl = this.tl
    const gen = this.gen
    const still = this.still
    const alive = () => !tl.cancelled && gen === this.gen
    this.frozenAt = this.now()
    this.reel.hold()
    this.el.classList.add('is-freeze')
    this.msg('……', 4000)
    await tl.wait(still ? 250 : 650)
    if (!alive()) return
    if (!still) this.crack(tl, 720)
    sfx.aoriStart(4) // キュ・キュ・キュイーン（約 0.7 秒）→ 和音。和音に「確定」を合わせる
    await tl.wait(still ? 300 : 720)
    if (!alive()) return
    this.el.classList.remove('is-freeze')
    this.el.classList.add('is-kakutei')
    this.shown = 4
    this.el.dataset.tier = '4'
    this.light(4)
    this.dimOn(tl, 0.36)
    this.msg('確定！ あなたのビンゴが決まった！', 2600)
    vibrate(40)
    // 全面の光はここの 1 回だけ（虹の淡い色が、ゆっくり差す。明るさの変化は 20% 以下）
    this.flashed = true
    void play(p.wash, [{ opacity: 0, offset: 0 }], 600, tl, { min: 300 })
    // 後光は強く差してから、カードが読める明るさまで落ち着く
    void play(
      p.rays,
      [
        { opacity: 0, transform: 'scale(0.4)', offset: 0 },
        { opacity: 0.55, transform: 'scale(1)', offset: 0.35 },
      ],
      2000,
      tl,
      { easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    if (still) {
      this.setLamp(4, false)
      this.showStill(tl, 4)
    } else {
      shake(this.el.parentElement ?? this.el, tl, 7, 280)
      this.px?.burst((this.el.clientWidth || 390) / 2, this.centerY(), { count: 150, colors: RAINBOW, speed: 10, shape: 'spark', life: 60 })
      void this.slam(tl, 4, 1150).then(() => {
        if (gen === this.gen) this.setLamp(4, true)
      })
    }
    await tl.wait(still ? 900 : 1150)
    if (!alive()) return
    // 逆回転（確定のごほうび）
    if (!still) this.reel.run(-0.011, 90)
    await tl.wait(still ? 0 : 430)
    if (!alive()) return
    // ゲージがまた動き出す
    this.frozenMs += this.now() - this.frozenAt
    this.frozenAt = -1
    if (!still) this.reel.run(this.targetV(), 220)
    void this.dust(tl, RAINBOW, 700)
    if (this.want) this.request(this.want)
  }

  // 窓のガラスを横切るヒビ。until で砕けて消える
  private crack(tl: Timeline, until: number): void {
    const p = this.parts
    if (!p) return
    const W = this.el.clientWidth || 390
    const H = this.el.clientHeight || 844
    const b = boxIn(p.win, this.el)
    const y = b.y + b.h * 0.52
    let d = `M ${(b.x - 8).toFixed(1)} ${(y + 8).toFixed(1)}`
    for (let x = b.x + 20; x < b.x + b.w + 16; x += 24) d += ` L ${x.toFixed(1)} ${(y + (Math.random() - 0.5) * 34).toFixed(1)}`
    const x1 = b.x + b.w * 0.3
    const x2 = b.x + b.w * 0.66
    const branches = [`M ${x1} ${y} l 18 -30 l 6 -24`, `M ${x2} ${y} l -16 32 l 12 22`, `M ${x2 + 40} ${y} l 10 -26`]
    const svg = el(
      'div',
      '',
      `<svg class="fxs-crack" viewBox="0 0 ${W} ${H}">${[d, ...branches].map((s) => `<path pathLength="1" d="${s}"/>`).join('')}</svg>`,
    ).firstElementChild!
    p.fx.append(svg)
    svg.querySelectorAll('path').forEach((path, i) => {
      void play(path, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], until * (i ? 0.3 : 0.55), tl, {
        delay: until * (i ? 0.55 : 0.15),
        fill: 'both',
        easing: 'cubic-bezier(.5,0,.3,1)',
      })
    })
    tl.at(until, () => {
      // 砕ける: ガラスのかけらが散る
      sparkBurst(p.fx, b.x + b.w / 2, y, tl, { count: 16, colors: ['#ffffff', '#cfe3ff', '#a8c8ff'], dist: 150, size: 9, ms: 700 })
      void play(svg, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.15)' }], 320, tl, { fill: 'forwards' }).then(() => svg.remove())
    })
  }

  // 暗くして、あと 1 つのマスだけスポットライトで抜く（スロットの本体はこの上にあるので暗くならない）
  private dimOn(tl: Timeline, level: number): void {
    const c = this.parts?.dim
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const W = c.width
    const H = c.height
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, W, H)
    const g = ctx.createRadialGradient(W / 2, H * 0.4, H * 0.12, W / 2, H * 0.4, H * 0.75)
    g.addColorStop(0, 'rgba(2, 4, 12, 0.72)')
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
    const from = this.dimLevel
    this.dimLevel = level
    c.style.opacity = String(level)
    if (from !== level) void play(c, [{ opacity: from, offset: 0 }], 600, tl, { min: 200 })
  }

  // 同じ画面のカードの「あと 1 つ」のマスを照らす（本体の下に隠れているマスは除く）
  private light(t: Tier): void {
    const root = this.el.parentElement
    if (!this.lit.length && root && this.parts) {
      const top = boxIn(this.parts.body, this.el).y
      this.lit = [...root.querySelectorAll<HTMLElement>('.fxc-cell.is-wait')].filter((c) => {
        const b = boxIn(c, this.el)
        return b.h > 0 && b.y + b.h / 2 < top
      })
    }
    for (const c of this.lit) {
      c.classList.remove('fxs-lit-2', 'fxs-lit-3', 'fxs-lit-4')
      c.classList.add('fxs-lit', `fxs-lit-${clamp(t, 2, 4)}`)
    }
  }

  private unlight(): void {
    for (const c of this.lit) c.classList.remove('fxs-lit', 'fxs-lit-2', 'fxs-lit-3', 'fxs-lit-4')
    this.lit = []
  }

  // 鼓動（赤・金）: ゲージが溜まるほど速くなる。明滅は 1 秒に約 2 回まで（実時間で 460ms より短くしない）。
  // STOP を押したら止まる（止まるまでの「間」になる）
  private async heartbeat(tl: Timeline): Promise<void> {
    if (this.still) return
    this.beating = true
    while (!tl.cancelled && (this.phase === 'charge' || this.phase === 'ready') && this.shown >= 2 && this.shown <= 3) {
      const period = Math.max(840 - 300 * this.g, 460 * tl.speed)
      this.beat(tl, period)
      await tl.wait(period)
    }
    if (!tl.cancelled) this.beating = false
  }

  // 1 拍: ランプと「あと〇〇」がドクンと弾み、照らしたマスが光る
  private beat(tl: Timeline, period: number): void {
    const p = this.parts
    if (!p) return
    const d = period * 0.7
    const thump: Keyframe[] = [
      { transform: 'scale(1)' },
      { transform: 'scale(1.1)', offset: 0.14 },
      { transform: 'scale(1)', offset: 0.3 },
      { transform: 'scale(1.05)', offset: 0.42 },
      { transform: 'scale(1)', offset: 0.6 },
      { transform: 'scale(1)' },
    ]
    for (const n of [p.lamp, p.wait]) if (n) void play(n, thump, d, tl, { composite: 'add' })
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
  }

  // 本体の上から粒子が立ち上る（金・虹）。結果が出るまで続ける
  private async dust(tl: Timeline, colors: readonly string[], every: number): Promise<void> {
    this.dustColors = colors
    if (this.still || this.dusting) return
    this.dusting = true
    const W = this.el.clientWidth || 390
    const y = this.parts ? boxIn(this.parts.body, this.el).y - 20 : 510
    while (!tl.cancelled && this.phase !== 'idle' && this.phase !== 'result') {
      this.px?.rise(8, this.dustColors, 20, W - 20, y)
      await tl.wait(every)
    }
    if (!tl.cancelled) this.dusting = false
  }

  // 見張り（画面が裏にあって毎フレームの処理が止まっていても、時間切れで止める）と、ひとことの声かけ
  private async coach(tl: Timeline): Promise<void> {
    for (;;) {
      await tl.wait(250)
      if (tl.cancelled || this.phase === 'idle' || this.phase === 'result') return
      const t = this.now()
      this.tick(t)
      if (this.phase === 'ready') {
        const left = Math.ceil((this.o.deadlineMs - t) / 1000)
        if (t >= this.msgUntil && left >= 1) this.msg(`押さないと あと <b>${left}</b> 秒で自動 STOP`, 0)
        continue
      }
      if (this.phase !== 'charge' || this.frozenAt >= 0 || t < this.msgUntil) continue
      if (this.g >= 1 && this.n === null) this.msg('まもなく番号が届きます…', 800)
      else if (t - this.lastTap > 1700) this.msg(this.taps ? 'もっと連打！ リールが速くなる' : 'タップでゲージがたまる！', 1500)
      else if (this.rev > 0.72) this.msg('すごい連打！', 1200)
    }
  }

  // ---- STOP -----------------------------------------------------------------

  // STOP が押せるようになった
  private ready(): void {
    const p = this.parts
    if (!p) return
    const tl = this.tl
    this.phase = 'ready'
    this.el.dataset.phase = 'ready'
    // 連打の勢いで誤って止めないよう、光ってから少しの間は押しても止まらない（実時間）
    this.lockUntil = performance.now() + Math.max(280, tl.ms(450))
    tl.at(180, () => sfx.stopReady()) // 満タンの音と重ならないように少しずらす
    this.setButton('STOP', '押して止める！')
    this.msg('今だ！ STOP を押せ！', 900) // このあとは、自動で止まるまでの残り秒数を出す
    vibrate(12)
    if (this.still) return
    void play(p.btn, [{ transform: 'scale(0.94)' }, { transform: 'scale(1.06)', offset: 0.45 }, { transform: 'scale(1)' }], 380, tl, {
      easing: 'cubic-bezier(.2,1.4,.4,1)',
    })
    const b = boxIn(p.btn, this.el)
    ring(p.fx, b.x + b.w / 2, b.y + b.h / 2, 200, '#ffe08a', tl, 600)
    this.px?.burst(b.x + b.w / 2, b.y + b.h / 2, { count: 36, colors: GOLD, speed: 7, gravity: 0.1, life: 40, size: 4, shape: 'spark' })
  }

  // 止めたい（STOP を押した・時間切れ・forceStop）。番号がまだ届いていない、虹のフリーズ中なら、終わってから止める
  private request(by: By): void {
    if (this.phase !== 'charge' && this.phase !== 'ready') return
    this.want ??= by
    if (this.n === null || this.frozenAt >= 0) return
    if (this.tier === 4 && !this.kakuteiOn) {
      void this.kakutei() // 「確定」を見せてから止める
      return
    }
    void this.stop(this.want)
  }

  private async stop(by: By): Promise<void> {
    const p = this.parts
    const n = this.n
    if (!p || n === null) return
    const tl = this.tl
    const gen = this.gen
    const t = this.tier
    this.phase = 'stopping'
    this.el.dataset.phase = 'stopping'
    this.el.dataset.by = by
    this.want = null
    // 溜めの途中で止めたとき（forceStop）は、まだ見せていない段階をここで出す（最後に見せる段階は必ず tier）
    if (this.shown < Math.min(t, 3)) this.raise(Math.min(t, 3) as Tier, true)
    this.g = 1
    p.marks.forEach((m) => m.classList.add('on'))
    p.gauge.classList.add('is-full')
    if (by === 'tap') {
      sfx.stopPress()
      vibrate(22)
    }
    // 自動で止めるのは、時間切れのときと、組み込み側の forceStop のとき
    const late = this.now() >= this.o.deadlineMs
    this.setButton(by === 'tap' ? 'STOP' : 'AUTO', by === 'tap' ? '' : late ? '時間切れ' : '')
    this.msg(by === 'tap' ? 'STOP！' : late ? '時間切れ — 自動で止めます' : '自動で止めます', 60000)
    this.pressHold(by)
    const before = this.teaseFor(n)
    const after = this.pickOther(n, before)
    if (this.still || document.hidden) {
      this.reel.jumpTo(n, before, after)
    } else {
      const T = STOP_MS[t]
      const real = Math.max(240, tl.ms(T))
      const creep = t >= 2
      // 画面が裏に回るなどで毎フレームの処理が止まっても、止まる先へ飛んで先へ進む
      await Promise.race([this.reel.stopOn(n, real, creep ? 3 : 2, creep, before, after), tl.wait(Math.max(T * 1.35 + 500, (real * 1.35 + 450) * tl.speed))])
      this.reel.snap()
    }
    if (tl.cancelled || gen !== this.gen) return
    this.land(by)
  }

  // 止まる直前に中央を通るコマ。赤・金で外れるときは、自分の「あと 1 つ」の番号が通り過ぎることがある（惜しい！）。
  // 当たるときは、1 つ違いの番号が通ってから止まる
  private teaseFor(n: number): Code {
    const t = this.tier
    if (t >= 2) {
      const others = this.waits.filter((x) => x !== n)
      if (t <= 3 && !this.waits.includes(n) && others.length && Math.random() < 0.65) return pickOne(others)
      const near = [n - 1, n + 1].filter((x) => x >= 1 && x <= 75)
      if (Math.random() < 0.6) return pickOne(near)
    }
    return this.pickOther(n)
  }

  // 押した瞬間: ボタンが深く沈んだまま止まり、輪と星が散る（自動のときは、ボタンがひとりでに沈む）
  private pressHold(by: By): void {
    const p = this.parts
    if (!p || this.still) return
    const tl = this.tl
    void play(p.cap, [{ transform: 'translateY(0px) scale(1)' }, { transform: 'translateY(9px) scale(0.97)', offset: 0.4 }, { transform: 'translateY(6px) scale(1)' }], 260, tl, {
      easing: 'ease-out',
    })
    const b = boxIn(p.btn, this.el)
    const x = b.x + b.w / 2
    const y = b.y + b.h / 2
    ring(p.fx, x, y, 170, by === 'tap' ? '#ffffff' : LIGHT[this.shown], tl, 480)
    if (by === 'tap') sparkBurst(p.fx, x, y, tl, { count: 12, colors: GOLD, dist: 120, size: 9, ms: 600, shape: 'star' })
  }

  // 番号にぴたりと止まった。番号を大きく見せて、stopped() を解決する
  private land(by: By): void {
    const p = this.parts
    const n = this.n
    if (!p || n === null) return
    const tl = this.tl
    const t = this.tier
    this.phase = 'landed'
    this.el.dataset.phase = 'landed'
    this.drawReel()
    p.win.classList.add('is-landed')
    sfx.reelLand(t)
    if (t >= 3) vibrate(30)
    this.msg(`出た番号は <b>${letterOf(n)} ${n}</b>`, 60000)
    if (!this.still) {
      // 止まった瞬間に、リールが少しだけ行き過ぎて戻り、番号がひとまわり大きくなる
      void play(
        p.reel,
        [{ transform: 'translateY(9px) scale(1.02)' }, { transform: 'translateY(-3px) scale(1.13)', offset: 0.45 }, { transform: 'translateY(0px) scale(1.09)' }],
        300,
        tl,
        { fill: 'forwards', easing: 'ease-out' },
      )
      const b = boxIn(p.win, this.el)
      const x = b.x + b.w / 2
      const y = b.y + b.h / 2
      ring(p.fx, x, y, 150 + t * 20, LIGHT[t], tl, 520)
      this.px?.burst(x, y, { count: [14, 24, 40, 60, 90][t], colors: COLORS[t], speed: 4 + t, gravity: 0.08, life: 36, size: 4, shape: 'spark' })
    }
    const done = this.done
    this.done = null
    done?.({ by })
    this.onLanded?.()
    this.onLanded = null
  }

  // ---- 結果 -------------------------------------------------------------------

  // 当たり: 窓の上に言葉が飛び出し、番号が玉になってカードのマスへ飛んでいく（このあと組み込み側がスタンプを押す）
  private async success(tl: Timeline, outcome: Exclude<AoriOutcome, 'none'>): Promise<void> {
    const p = this.parts
    if (!p) return
    const t = this.tier
    const power = Math.min(4, Math.max(t, OUT_POWER[outcome]))
    const colors = COLORS[t]
    const wb = boxIn(p.win, this.el)
    const cx = wb.x + wb.w / 2
    const cy = wb.y + wb.h / 2
    if (t >= 1) sfx.aoriSuccess(t)
    vibrate(power >= 3 ? 45 : 25)
    this.el.classList.add('is-win')
    const hero = el('div', 'fxs-hero', txt(HERO_TEXT[outcome]))
    hero.dataset.t = String(t)
    hero.style.top = `${wb.y + 2}px`
    p.fx.append(hero)
    this.fadeAura(tl, 420)
    if (this.still) {
      await play(hero, [{ opacity: 0 }, { opacity: 1 }], 200, tl)
      await tl.wait(900)
      if (!tl.cancelled) await this.retract(tl)
      return
    }
    void play(
      hero,
      [
        { transform: 'translate(-50%, -100%) translateY(46px) scale(0.3)', opacity: 0 },
        { transform: 'translate(-50%, -100%) translateY(-6px) scale(1.12)', opacity: 1, offset: 0.55 },
        { transform: 'translate(-50%, -100%) translateY(0px) scale(1)', opacity: 1 },
      ],
      340,
      tl,
      { fill: 'backwards', easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    ring(p.fx, cx, cy, 180 + power * 30, LIGHT[t], tl, 620)
    this.px?.burst(cx, cy, {
      count: [24, 46, 80, 120, 170][power],
      colors,
      speed: 6 + power,
      shape: power >= 3 ? 'rect' : 'spark',
      life: 55 + power * 10,
    })
    if (power >= 2) sparkBurst(p.fx, cx, wb.y, tl, { count: 10, colors, dist: 150, size: 12, ms: 800, shape: 'star' })
    if (t >= 3) shake(this.el.parentElement ?? this.el, tl, t === 4 ? 7 : 5, 260)
    // 全面のやわらかい光は赤・金だけ（虹は確定で使った。ビンゴはこのあと playBingo が使う）。20% 以下で、ゆっくり立ち上げる
    if (!this.flashed && (t === 2 || t === 3) && outcome !== 'bingo') {
      this.flashed = true
      void play(p.flash, [{ opacity: 0 }, { opacity: 0.16, offset: 0.2 }, { opacity: 0 }], 700, tl, { min: 600 })
    }
    await tl.wait(380 + 110 * power)
    if (tl.cancelled) return
    await this.flyToCard(tl, colors)
    if (tl.cancelled) return
    void play(hero, [{ opacity: 1 }, { opacity: 0 }], 260, tl, { fill: 'forwards' })
    await this.retract(tl)
  }

  // 窓の番号が玉になって抜け出し、カードの同じ番号のマスへ飛んでいく
  private async flyToCard(tl: Timeline, colors: readonly string[]): Promise<void> {
    const p = this.parts
    const n = this.n
    const cell = n === null ? null : this.cellOf(n)
    if (!p || n === null || !cell) return
    const wb = boxIn(p.win, this.el)
    const cb = boxIn(cell, this.el)
    const x0 = wb.x + wb.w / 2
    const y0 = wb.y + wb.h / 2
    const dx = cb.x + cb.w / 2 - x0
    const dy = cb.y + cb.h / 2 - y0
    const lift = Math.min(80, Math.abs(dy) * 0.3)
    const orb = el('div', 'fxs-orb', codeHtml(n))
    orb.style.left = `${x0}px`
    orb.style.top = `${y0}px`
    p.fx.append(orb)
    p.win.classList.add('is-sent')
    await play(
      orb,
      [
        { transform: 'translate(-50%, -50%) translate(0px, 0px) scale(1)', opacity: 0.5 },
        { transform: `translate(-50%, -50%) translate(${dx * 0.2}px, ${dy * 0.35 - lift}px) scale(1.1)`, opacity: 1, offset: 0.35 },
        { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.5)`, opacity: 1, offset: 0.92 },
        { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.4)`, opacity: 0 },
      ],
      560,
      tl,
      { fill: 'forwards', easing: 'cubic-bezier(.45,0,.35,1)' },
    )
    orb.remove()
    if (tl.cancelled) return
    const x = cb.x + cb.w / 2
    const y = cb.y + cb.h / 2
    ring(p.fx, x, y, cb.w * 1.3, '#ffffff', tl, 420)
    sparkBurst(p.fx, x, y, tl, { count: 8, colors, dist: cb.w * 0.9, size: 7, ms: 520, shape: 'star' })
  }

  // 同じ番号のマス（本体の下に隠れていないもの）
  private cellOf(n: number): HTMLElement | null {
    const root = this.el.parentElement
    const p = this.parts
    if (!root || !p) return null
    const top = boxIn(p.body, this.el).y
    for (const c of root.querySelectorAll<HTMLElement>('.fxc-cell')) {
      if (c.querySelector('.fxc-num')?.textContent?.trim() !== String(n)) continue
      const b = boxIn(c, this.el)
      if (b.h > 0 && b.y + b.h / 2 < top) return c
    }
    return null
  }

  // あおったのに外れた（確変失敗のように）: 光がしぼみ、ランプが砕けて、ちょっと情けない文字が落ちてくる
  private async fail(tl: Timeline, t: 1 | 2 | 3, label: string): Promise<void> {
    const p = this.parts
    if (!p) return
    const still = this.still
    sfx.aoriFail()
    this.el.classList.add('is-fail')
    this.px?.clear()
    this.fadeAura(tl, 520)
    if (!still) {
      settle(p.lamp)
      void play(
        p.lamp,
        [
          { transform: 'scale(1, 1) translateY(0px)', filter: 'grayscale(0) brightness(1)' },
          { transform: 'scale(1.12, 0.88) translateY(0px)', filter: 'grayscale(0.3) brightness(1)', offset: 0.2 },
          { transform: 'scale(0.8, 0.76) translateY(3px)', filter: 'grayscale(1) brightness(0.75)' },
        ],
        460,
        tl,
        { fill: 'forwards', easing: 'cubic-bezier(.3,.6,.4,1)' },
      )
      const b = boxIn(p.lamp, this.el)
      this.onoma('プシュ～', b.x + b.w + 14, b.y + 2, tl)
    }
    await tl.wait(still ? 150 : 480)
    if (tl.cancelled) return
    if (!still) this.shatter(tl, p.lamp)
    const msg = el('div', 'fxs-fail', `<b>${FAIL_TEXT[t]}</b><small>出たのは ${escapeHtml(label)}</small><i class="fxs-sweat"></i>`)
    p.fx.append(msg)
    if (still) {
      await tl.wait(1300)
      if (!tl.cancelled) await this.retract(tl)
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
      msg.querySelector('.fxs-sweat')!,
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
    if (!tl.cancelled) await this.retract(tl)
  }

  // 青（と、あおっていない外れ）: 番号を少し見せてから、静かに引っ込む
  private async quiet(tl: Timeline): Promise<void> {
    this.fadeAura(tl, 300)
    await tl.wait(700)
    if (!tl.cancelled) await this.retract(tl)
  }

  // ランプを、かけらに分けて落とす
  private shatter(tl: Timeline, node: HTMLElement): void {
    const p = this.parts
    if (!p) return
    settle(node)
    const t = node.style.transform
    const base = t && t !== 'none' ? t : ''
    const b = boxIn(node, this.el)
    for (const poly of SHARDS) {
      const s = node.cloneNode(true) as HTMLElement
      s.classList.add('fxs-shard')
      s.style.left = `${b.x}px`
      s.style.top = `${b.y}px`
      s.style.width = `${b.w}px`
      s.style.height = `${b.h}px`
      s.style.clipPath = `polygon(${poly.map(([x, y]) => `${x}% ${y}%`).join(', ')})`
      p.fx.append(s)
      const cx = poly.reduce((a, [x]) => a + x, 0) / poly.length
      const dx = (cx - 50) * 1.4 + (Math.random() - 0.5) * 24
      const dy = 90 + Math.random() * 110
      const rot = (Math.random() - 0.5) * 90
      void play(
        s,
        [
          { transform: `${base} translate(0px, 0px) rotate(0deg)`, opacity: 1 },
          { transform: `${base} translate(${dx * 0.35}px, ${-12 - Math.random() * 14}px) rotate(${rot * 0.3}deg)`, opacity: 1, offset: 0.22 },
          { transform: `${base} translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 0 },
        ],
        900,
        tl,
        { fill: 'forwards', easing: 'cubic-bezier(.35,.1,.7,1)' },
      ).then(() => s.remove())
    }
    node.style.visibility = 'hidden'
    sparkBurst(p.fx, b.x + b.w / 2, b.y + b.h / 2, tl, { count: 10, colors: ['#9aa3b8', '#c7cdd9', '#6b7390'], dist: 70, size: 6, ms: 700 })
  }

  // 擬音（「プシュ～」など）
  private onoma(text: string, x: number, y: number, tl: Timeline): void {
    const fx = this.parts?.fx
    if (!fx) return
    const z = el('i', 'fxs-onoma', text)
    z.style.left = `${x}px`
    z.style.top = `${y}px`
    fx.append(z)
    void play(
      z,
      [
        { transform: 'translate(-50%, -50%) scale(0.5) rotate(-8deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.05) rotate(-8deg)', opacity: 1, offset: 0.25 },
        { transform: 'translate(-30%, -110%) scale(1) rotate(-8deg)', opacity: 0 },
      ],
      800,
      tl,
    ).then(() => z.remove())
  }

  // 暗さとあおりの名残（縁の光・カットイン・段階の文字）を引かせる
  private fadeAura(tl: Timeline, ms: number): void {
    this.unlight()
    const p = this.parts
    if (!p) return
    for (const n of [p.dim, this.el.querySelector('.fxs-edge'), p.cut, p.emblem]) {
      if (!n) continue
      settle(n)
      void play(n, [{ opacity: 0 }], ms, tl, { fill: 'forwards' })
    }
  }

  // 本体が下へ引っ込み、全体が消える
  private async retract(tl: Timeline): Promise<void> {
    const p = this.parts
    if (p && !this.still) {
      void play(p.body, [{ transform: 'translateY(0px)' }, { transform: 'translateY(44px)' }], 420, tl, {
        fill: 'forwards',
        easing: 'cubic-bezier(.5,0,.75,.4)',
      })
    }
    await play(this.el, [{ opacity: 1 }, { opacity: 0 }], 420, tl, { fill: 'forwards' })
  }

  // ---- 描画 -------------------------------------------------------------------

  // 5 コマを縦に並べて、上から下へ流す。中央の 1 コマが主役で、上下は胴の丸みで縮めて暗くする
  private drawReel(): void {
    const p = this.parts
    if (!p) return
    const r = this.reel
    const base = r.index
    const center = Math.round(r.pos)
    for (let j = -2; j <= 2; j++) {
      const i = base + j
      const row = p.rows[((i % 5) + 5) % 5]
      const c = r.code(i)
      if (row.i !== i || row.c !== c) {
        row.i = i
        row.c = c
        row.node.innerHTML = codeHtml(c)
      }
      const off = i - r.pos // 正 = まだ上にある（これから下りてくる）
      const k = Math.min(1, Math.abs(off) / 1.3)
      row.node.style.transform = `translate3d(0,${(-off * ROW).toFixed(1)}px,0) scaleY(${(1 - 0.38 * k * k).toFixed(3)})`
      row.node.style.opacity = (1 - 0.7 * k).toFixed(3)
      row.node.classList.toggle('is-c', i === center)
    }
    // 速いほどぼかして、流れて見せる（数字がちらつかないように）
    const v = Math.abs(r.v) * 1000
    const blur = v > 10 ? 2 : v > 6.5 ? 1 : 0
    if (blur !== this.blur) {
      this.blur = blur
      p.win.dataset.blur = String(blur)
    }
  }

  private drawGauge(): void {
    const p = this.parts
    if (!p) return
    const v = this.g >= 1 ? 1 : Math.min(0.985, this.gs + this.spring)
    if (Math.abs(v - this.drawn) < 0.0008) return
    this.drawn = v
    p.gauge.style.setProperty('--g', v.toFixed(4))
  }

  private setLamp(t: Tier, pop: boolean): void {
    const p = this.parts
    if (!p) return
    p.lamp.dataset.t = String(t)
    p.lamp.innerHTML = `<i>${TIER_SHAPE[t]}</i><b>${LAMP_WORD[t]}</b>`
    if (!pop || this.still) return
    void play(p.lamp, [{ transform: 'scale(1.45)' }, { transform: 'scale(0.94)', offset: 0.55 }, { transform: 'scale(1)' }], 360, this.tl, {
      easing: 'cubic-bezier(.2,.8,.3,1)',
    })
    const b = boxIn(p.lamp, this.el)
    sparkBurst(p.fx, b.x + b.w / 2, b.y + b.h / 2, this.tl, { count: 8, colors: COLORS[t], dist: 70, size: 8, ms: 520, shape: t >= 3 ? 'star' : 'diamond' })
  }

  private setButton(word: string, sub: string): void {
    const p = this.parts
    if (!p || p.word.textContent === word) return
    p.word.textContent = word
    p.sub.textContent = sub
  }

  // 本体の中の一行（声かけ）。hold の間は、ほかの声かけで上書きしない
  private msg(html: string, hold = 1200): void {
    const p = this.parts
    if (!p) return
    this.msgUntil = this.now() + hold
    if (this.msgText === html) return
    this.msgText = html
    p.msg.innerHTML = html
    if (!this.still) void play(p.msg, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], 200, this.tl)
  }

  // ---- 小物 -------------------------------------------------------------------

  private pick(): Code {
    const pool = this.pool.length ? this.pool : null
    let c = pool ? pool[Math.floor(Math.random() * pool.length)] : 1 + Math.floor(Math.random() * 75)
    if (c === this.lastPick) c = pool && pool.length > 1 ? pool[(pool.indexOf(c) + 1) % pool.length] : (c % 75) + 1
    this.lastPick = c
    return c
  }

  private pickOther(...not: number[]): Code {
    for (let k = 0; k < 8; k++) {
      const c = this.pick()
      if (!not.includes(c)) return c
    }
    return 0
  }

  private centerY(): number {
    const v = getComputedStyle(this.el).getPropertyValue('--fxs-center').trim()
    return v.endsWith('px') ? parseFloat(v) : 318
  }

  // 指の位置（画面側で縮小表示されていても、390×844 の座標に直す）
  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect()
    const k = r.width / (this.el.offsetWidth || r.width || 1) || 1
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  // STOP ボタンの上か（親指がずれても届くよう、少し広めに取る）
  private onButton(e: PointerEvent): boolean {
    const p = this.parts
    if (!p) return false
    const pt = this.local(e)
    const b = boxIn(p.btn, this.el)
    const pad = 14
    return pt.x >= b.x - pad && pt.x <= b.x + b.w + pad && pt.y >= b.y - pad && pt.y <= b.y + b.h + pad
  }

  // 同じ光や音が、実時間で ms より短い間隔で続かないようにする
  private gate(key: string, ms: number): boolean {
    const now = performance.now()
    if (now - (this.gates.get(key) ?? -1e9) < ms) return false
    this.gates.set(key, now)
    return true
  }

  // 何もしていない状態に戻す（stopped() は解決しない）
  private reset(): void {
    this.gen++
    this.tl.cancel()
    this.tl = new Timeline(this.speed)
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.unlight()
    this.px?.clear()
    this.px = null
    this.el.getAnimations().forEach((a) => a.cancel())
    this.el.replaceChildren()
    this.el.className = 'fxs'
    delete this.el.dataset.tier
    delete this.el.dataset.phase
    delete this.el.dataset.by
    this.el.style.removeProperty('--heat')
    this.parts = null
    this.phase = 'idle'
    this.reel = new Reel(() => this.pick())
    this.shown = 0
    this.level = 0
    this.n = null
    this.want = null
    this.done = null
    this.onLanded?.() // resolve() が待っていたら、先へ進めて抜けさせる（gen が変わっている）
    this.onLanded = null
    this.g = 0
    this.gs = 0
    this.spring = 0
    this.bonus = 0
    this.drawn = -1
    this.frozenAt = -1
    this.frozenMs = 0
    this.kakuteiOn = false
    this.busyUntil = 0
    this.lockUntil = 0
    this.msgUntil = 0
    this.msgText = ''
    this.taps = 0
    this.rev = 0
    this.heat = 0
    this.heatDrawn = -1
    this.lastTap = -1e9
    this.flashed = false
    this.beating = false
    this.dusting = false
    this.dimLevel = 0
    this.blur = -1
    this.gates.clear()
  }
}
