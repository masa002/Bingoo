import './lastone.css'
import { engine, sfx, type GaraponVoice } from '../../audio'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { GOLD, RAINBOW, type BallColor } from '../theme'
import { BALL_INFO, GaraponMachine, ballHtml } from './garapon'

// ラストワン争奪のガラポン（スマホ側。390×844 のスマホ画面に重ねる）。
// 同じ回に上がった人が残りの景品を争うとき、それぞれが自分のスマホでガラポンを回す。
// タップで取っ手が回る（参加している手応え）が、玉が出る時刻は dropAt で決まっていて、大画面の発表と同時に出る。
// 結果はくじ（先に決まっている）。外れは「運がなかった」で、ダブルチャンスの玉が 3 個もらえる。
// 当たりのときは、このあと呼び出し側が景品パックの開封へ進む。
//
//   const brief = openLastOneBrief(phone, { prizes: 2, contestants: 7, autoMs: null }) // 説明の画面。司会の「スタート」まで出しておく
//   brief.close()
//   await playLastOneGarapon(phone, { dropAt: 6500, durationMs: 11000, color: 'gold', prize: 'ワイヤレスイヤホン', contestants: 7, prizes: 2 })
//
// 説明の画面とガラポンの画面は、見出しと抽選器を同じ位置に描いてある。close の直後に playLastOneGarapon を呼ぶと、
// 説明の文字だけがすっと消えて、見ていた抽選器がそのまま回り出す（見出しの出し直しは省き、すぐ回せるようにする）。
//
// 時間の使い方（D = dropAt、T = durationMs。演出上の ms で、speed で縮む）:
//   0〜      見出し（ラストワン争奪！・残り○個を○人で・色つきの玉で当たり）。説明の画面から続くときは 0.3 秒で回し始める
//   〜D      タップで回す（放っておいてもゆっくり回る）。D の 3・2・1 秒前に数字を出す（大画面と同じ時刻）
//   D の 0.7〜1.4 秒前（実時間）から、排出口が D ちょうどに真下へ来るように回転を寄せる（タップは取っ手の手ごたえだけになる）
//   D        玉が出る（大画面の発表と同時）。当たりは排出口のまわりが玉の色に光る
//   D+1.3 秒 玉を大きく見せて結果（当たり: 玉の色・言葉・景品の名前 / 外れ: 運がなかった…・ダブルチャンスの玉 3 個）
//   T-0.5 秒 ふわっと消して、T で片付けて解決する（D から T までが短いときは、結果の見せ方を縮める）
// sound: 'personal'（既定）は自分の抽選器と自分の結果の音だけ（デモでは大画面と同じ PC から鳴るため）。
//        'all' は大画面と同じ発表の音（見出し・3・2・1・結果）も鳴らす

export interface LastOneGaraponOptions {
  speed?: number
  sound?: 'personal' | 'all'
  dropAt: number // 始まってからこの ms で玉が出る（大画面の発表と同時）
  durationMs: number // 全体の長さ（結果を見せて片付けるまで）
  color: BallColor // 出る玉（white は外れ）
  prize?: string // 当たりのときの景品の名前
  contestants: number // 争奪している人数
  prizes: number // 残りの景品の数
}

export async function playLastOneGarapon(host: HTMLElement, o: LastOneGaraponOptions): Promise<void> {
  const play = new LastOnePlay(host, o)
  try {
    await play.run()
  } finally {
    play.dispose()
  }
}

// ---- 決まりごと ------------------------------------------------------------------

const MACHINE = 300 // 抽選器の大きさ（位置は lastone.css の .fxlp-stage）
const END_RPS = 0.9 // 玉が出る瞬間の回転（排出口が真下を通る速さ）
const IDLE_RPS = 0.22 // タップしていなくても、ゆっくり回しておく
const AUTO_RPS = 0.55 // タップが途切れたら、係の人が回すくらいの速さにする
const IDLE_MS = 1300 // タップが途切れてから AUTO_RPS にするまで
const DC_BALLS = 3 // 外れた人がもらえるダブルチャンスの玉
const POP_WORDS = ['ガラッ', 'ガラ', 'ガラガラ', 'ゴロッ', 'ガラッ', 'ゴロ'] // 当たりを思わせる「カラン」は使わない
const BURST: Readonly<Record<Exclude<BallColor, 'white'>, readonly string[]>> = {
  red: ['#ef4444', '#ff8a8a', '#ffffff', '#ffd1d1'],
  gold: GOLD,
  rainbow: RAINBOW,
}
// 抽選器の絵（320×320 の座標）の中の、排出口と受け皿の位置
const HOLE = { x: 160 / 320, y: 230 / 320 }
const TRAY = { x: 174 / 320, y: 275 / 320 }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const num = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const fmt = (n: number): string => Math.max(0, Math.round(num(n, 0))).toLocaleString('ja-JP')

// 音で例外が出ても、演出は止めずに進める（音は鳴らなくても、見た目と時刻は大画面とそろえる）
const safe = (fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    console.warn('[lastone] sound failed', err)
  }
}

// 光過敏への配慮: 速度を上げても、立ち上がりや揺れの長さが安全な範囲に収まるようにする
const clampMs = (ms: number, min: number, max = Infinity): number => Math.min(max, Math.max(min, ms))

const vibrate = (ms: number): void => {
  // ユーザーがまだ画面に触れていないとブラウザが止めて警告を出すので、そのときは呼ばない
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return
  try {
    navigator.vibrate?.(ms)
  } catch {
    // 振動に対応していない端末
  }
}

// 画面の拡大縮小（画面側の fit）を打ち消して、root の中の座標にする。fx・fy は node の中の位置（0〜1）
function localPoint(root: HTMLElement, node: Element, fx = 0.5, fy = 0.5): { x: number; y: number } {
  const r = root.getBoundingClientRect()
  const b = node.getBoundingClientRect()
  const s = r.width / (root.offsetWidth || r.width || 1) || 1
  return { x: (b.left + b.width * fx - r.left) / s, y: (b.top + b.height * fy - r.top) / s }
}

// タップを外に送らない（画面側のクリック処理に届かないようにする）
function swallow(root: HTMLElement): void {
  for (const type of ['pointerup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend']) {
    root.addEventListener(
      type,
      (e) => {
        e.stopPropagation()
        if (type !== 'pointerup' && e.cancelable) e.preventDefault()
      },
      { passive: false },
    )
  }
}

// 見出し（説明の画面とガラポンの画面で、同じものを同じ位置に出す）。shown なら最初から出しておく
function headHtml(prizes: number, contestants: number, shown: boolean): string {
  const cls = shown ? 'fxlp-in on' : 'fxlp-in'
  return `<div class="fxlp-kicker ${cls}">LAST ONE</div>
    <div class="fxlp-title ${cls}">ラストワン争奪！</div>
    <div class="fxlp-odds ${cls}">残り<b>${fmt(prizes)}</b>個を<b>${fmt(contestants)}</b>人で</div>
    <div class="fxlp-rule ${cls}">${ballHtml('red')}${ballHtml('gold')}${ballHtml('rainbow')}<span class="fxlp-rule-t">赤・金・虹の玉が出たら当たり！</span></div>`
}

// 出ている説明の画面（閉じる関数）。ガラポンが始まるとき、残っている説明をここから閉じて引き継ぐ
const briefs = new WeakMap<Element, () => void>()

// 争奪している人を小さな「？」の玉で並べる（先頭が自分）。多いときは +N にまとめる
function crowdHtml(n: number): string {
  const shown = n > 10 ? 9 : n
  const dots = Array.from(
    { length: shown },
    (_, i) => `<i class="fxlp-dot${i === 0 ? ' me' : ''}" style="animation-delay:${(-Math.random() * 1.6).toFixed(2)}s">?</i>`,
  ).join('')
  return dots + (n > shown ? `<span class="fxlp-dot-more">+${fmt(n - shown)}</span>` : '')
}

// ---- 本体 ------------------------------------------------------------------------

// 回転の寄せ方（エルミート補間）。角度は度、速さは度/秒、時刻と長さは実際の ms
interface Steer {
  p0: number
  p1: number
  v0: number
  v1: number
  start: number
  dur: number
}

type Phase = 'intro' | 'spin' | 'drop' | 'reveal'

class LastOnePlay {
  private readonly tl: Timeline
  private readonly o: LastOneGaraponOptions
  private readonly color: BallColor
  private readonly win: boolean
  private readonly all: boolean // 大画面と同じ発表の音も鳴らす
  private readonly reduced = prefersReducedMotion()
  private readonly attached: boolean
  private readonly fromBrief: boolean // 説明の画面から続けて始まった（見出しと抽選器は、もう見えている）
  private readonly t0 = performance.now()
  // 時刻（演出上の ms）
  private readonly D: number // 玉が出る
  private readonly T: number // 片付けて解決する
  private readonly S: number // 回し始める
  private readonly A: number // 回転を寄せ始める
  private readonly root: HTMLElement
  private readonly machine: GaraponMachine
  private readonly meter: HTMLElement
  private readonly left: HTMLElement
  private readonly sub: HTMLElement
  private fx: Particles | null = null
  private voice: GaraponVoice | null = null
  private phase: Phase = 'intro'
  private steer: Steer | null = null
  private aimed = false
  private heat = 0
  private idle = 0 // 最後のタップからの、演出上の ms
  private taps = 0
  private lastPop = 0
  private lastVoice = -1
  private shownSec = -1
  private glowUsed = false

  constructor(host: HTMLElement, o: LastOneGaraponOptions) {
    const speed = num(o.speed, 1)
    this.tl = new Timeline(speed > 0 ? speed : 1)
    this.o = o
    this.color = BALL_INFO[o.color] ? o.color : 'white'
    this.win = this.color !== 'white'
    this.all = o.sound === 'all'
    this.T = Math.max(0, num(o.durationMs, 11000))
    this.D = clamp(num(o.dropAt, 6500), 0, this.T)
    // 説明の画面が残っていれば、閉じて引き継ぐ（説明は上に重なったまま、すっと消える）
    const brief = host.querySelector(':scope > .fxlp-brief')
    this.fromBrief = !!brief
    if (brief) briefs.get(brief)?.()
    this.S = Math.min(this.D, this.fromBrief ? 300 : clamp(this.D * 0.25, 600, 1500))
    // 寄せる長さは、速度を上げても実際の時間で 0.7 秒以上とる（短いと、胴が急に速く回って見えるため）
    this.A = this.D - Math.min(this.D - this.S, clamp((this.D - this.S) * 0.3, 700, 1400) * Math.max(1, this.tl.speed))

    // 前の争奪の画面が残っていれば片付ける
    host.querySelectorAll(':scope > .fxlp:not(.fxlp-brief)').forEach((n) => n.remove())
    this.attached = host.isConnected
    this.root = el(
      'div',
      this.fromBrief ? 'fxlp fxlp-still on' : 'fxlp',
      `<div class="fxlp-bg"></div>
      <header class="fxlp-head">${headHtml(o.prizes, o.contestants, this.fromBrief)}</header>
      <div class="fxlp-crowd fxlp-in">
        <div class="fxlp-dots">${crowdHtml(Math.max(1, Math.round(num(o.contestants, 1))))}</div>
        <div class="fxlp-crowd-text">全員の玉が <b>いっせいに</b> 出る！</div>
      </div>
      <div class="fxlp-count"></div>
      <div class="fxlp-stage"><div class="fxlp-aura"></div></div>
      <footer class="fxlp-foot">
        <div class="fxlp-meter-label"><span>玉が出るまで</span><span class="fxlp-left"></span></div>
        <div class="fxlp-meter"><b></b></div>
        <div class="fxlp-prompt">タップで回せ！</div>
        <div class="fxlp-sub">画面のどこでもタップ</div>
      </footer>
      <div class="fxlp-pops"></div>
      <div class="fxlp-reveal"></div>
      <div class="fxlp-glow"></div>`,
    )
    this.root.dataset.phase = 'intro'
    this.root.style.setProperty('--fxlp-k', String(this.tl.ms(1)))
    this.meter = this.$('.fxlp-meter')
    this.left = this.$('.fxlp-left')
    this.sub = this.$('.fxlp-sub')

    this.machine = new GaraponMachine({ size: MACHINE })
    this.$('.fxlp-stage').append(this.machine.el)
    this.machine.onFrame = this.onFrame
    // 画面から外されたら（画面の切り替えなど）、その場で止めて解決する
    this.machine.onGone = () => {
      this.tl.cancel()
      this.stopVoice()
    }
    if (!this.reduced) {
      const canvas = el('canvas', 'fxlp-fx')
      canvas.width = host.clientWidth || 390
      canvas.height = host.clientHeight || 844
      this.root.append(canvas)
      this.fx = new Particles(canvas, 600)
      this.fx.speed = this.tl.speed
    }
    swallow(this.root)
    this.root.addEventListener('pointerdown', this.onTap)
    host.append(this.root)
    this.machine.start()
  }

  async run(): Promise<void> {
    const { D, T, S, A } = this
    void this.root.offsetWidth
    this.root.classList.add('on')

    // 見出し（説明の画面から続くときは、もう出ているので出し直さない。始まりの音も説明の側で鳴っている）
    if (!this.fromBrief) {
      this.show('.fxlp-kicker')
      this.show('.fxlp-title')
      if (this.all) this.at(Math.min(120, S * 0.1), () => safe(() => sfx.cutin(3)))
      this.at(S * 0.2, () => this.show('.fxlp-odds'))
      this.at(S * 0.4, () => this.show('.fxlp-rule'))
    }
    this.at(S * 0.6, () => this.show('.fxlp-crowd'))
    // 3・2・1（大画面と同じ時刻に出す）
    for (const k of [3, 2, 1]) {
      const t = D - k * 1000
      if (t >= S) this.at(t, () => this.count(k))
    }

    // 回す
    if (!(await this.until(S))) return
    this.setPhase('spin')
    this.startVoice()
    if (!(await this.until(A))) return
    this.aim()

    // 玉が出る（大画面の発表と同時）
    if (!(await this.until(D))) return
    const tray = this.drop()

    // 結果。D から T までが短いときは、見せ方を k の割合で縮める
    const post = T - D
    const outMs = clamp(post * 0.12, 200, 500)
    const k = clamp((post - outMs) / 3400, 0, 1)
    const R = D + 1300 * k
    this.at(Math.min(R, D + 900), () => this.stopVoice())
    if (!(await this.until(R))) return
    if (!(await this.reveal(tray, R, k))) return

    // ふわっと消して、T で片付ける
    if (!(await this.until(T - outMs))) return
    this.root.style.setProperty('--fxlp-out', `${this.tl.ms(outMs)}ms`)
    this.root.classList.add('out')
    await this.until(T)
  }

  dispose(): void {
    this.tl.cancel()
    this.stopVoice()
    this.machine.destroy()
    this.fx?.clear()
    this.root.removeEventListener('pointerdown', this.onTap)
    this.root.remove()
  }

  // ---- 時間 ----

  // 始まってからの、演出上の ms
  private elapsed(): number {
    return (performance.now() - this.t0) * this.tl.speed
  }

  // 始まりから t ms の時刻まで待つ（待つたびに始まりの時刻から測り直すので、ずれがたまらない）。
  // 取り消されたら（画面から外されたときも）false
  private async until(t: number): Promise<boolean> {
    const left = t - this.elapsed()
    if (left > 0) await this.tl.wait(left)
    return !this.gone()
  }

  // 始まりから t ms の時刻に fn を呼ぶ（待たない）
  private at(t: number, fn: () => void): void {
    this.tl.at(Math.max(0, t - this.elapsed()), fn)
  }

  private gone(): boolean {
    if (this.attached && !this.root.isConnected) this.tl.cancel()
    return this.tl.cancelled
  }

  // ---- 小物 ----

  private $(selector: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(selector)!
  }

  private show(selector: string): void {
    this.root.querySelector(selector)?.classList.add('on')
  }

  private setPhase(p: Phase): void {
    this.phase = p
    this.root.dataset.phase = p
  }

  private setSub(text: string): void {
    if (this.sub.textContent !== text) this.sub.textContent = text
  }

  private startVoice(): void {
    if (this.voice || this.gone()) return
    safe(() => (this.voice = sfx.garaponStart()))
    this.lastVoice = -1
  }

  private stopVoice(): void {
    const v = this.voice
    this.voice = null
    if (v) safe(() => v.stop())
  }

  // 3・2・1 の数字（0 で消す）。1 秒に 1 回だけ出る
  private count(k: number): void {
    const box = this.$('.fxlp-count')
    box.innerHTML = k > 0 ? `<b>${k}</b>` : ''
    const b = box.firstElementChild as HTMLElement | null
    if (!b) return
    void b.offsetWidth
    b.classList.add('tick')
    if (this.all) safe(() => sfx.countdown(k))
    vibrate(8)
  }

  // ---- 回す ----

  private readonly onTap = (e: PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    safe(() => engine.unlock())
    if (this.phase !== 'intro' && this.phase !== 'spin') return
    this.taps++
    this.idle = 0
    // 寄せている間も取っ手は押し込まれる（回転は寄せる側が決めるので、玉が出る時刻は変わらない）
    this.machine.kick()
    if (this.reduced) this.machine.addTurns(0.4)
    this.startVoice()
    vibrate(6)
    const now = performance.now()
    if (this.reduced || now - this.lastPop < 340) return // 手ごたえの演出は 1 秒に 3 回まで
    this.lastPop = now
    this.pop(e)
  }

  // 指の跡と「ガラッ」の文字
  private pop(e: PointerEvent): void {
    const r = this.root.getBoundingClientRect()
    const s = r.width / (this.root.offsetWidth || r.width || 1) || 1
    const ripple = el('div', 'fxlp-ripple')
    ripple.style.left = `${(e.clientX - r.left) / s}px`
    ripple.style.top = `${(e.clientY - r.top) / s}px`
    const c = localPoint(this.root, this.machine.el, 0.5, 0.42)
    const side = this.taps % 2 ? 1 : -1
    const word = this.word(POP_WORDS[this.taps % POP_WORDS.length], c.x + side * (70 + Math.random() * 60), c.y - 100 + Math.random() * 80)
    word.style.setProperty('--r', `${side * (6 + Math.random() * 10)}deg`)
    this.$('.fxlp-pops').append(ripple)
    this.tl.at(900, () => ripple.remove())
  }

  private word(text: string, x: number, y: number): HTMLElement {
    const word = el('div', 'fxlp-pop', text)
    word.style.left = `${x}px`
    word.style.top = `${y}px`
    this.$('.fxlp-pops').append(word)
    this.tl.at(900, () => word.remove())
    return word
  }

  private readonly onFrame = (dt: number): void => {
    const m = this.machine
    if (this.steer) this.steerFrame()
    // 熱: 回転の速さをゆっくりならした値。タップごとに明るさが跳ねないようにする
    const target = Math.min(1, m.rps / 2.2)
    this.heat += (target - this.heat) * Math.min(1, dt * 1.6)
    this.root.style.setProperty('--heat', this.heat.toFixed(3))
    // 音を回転に合わせる（変わったときだけ伝える）
    if (this.voice && Math.abs(m.rps - this.lastVoice) > 0.02) {
      this.lastVoice = m.rps
      const v = this.voice
      safe(() => v.setSpeed(m.rps))
    }
    if (this.phase !== 'intro' && this.phase !== 'spin') return
    // 玉が出るまでのメーターと残り秒数（時刻で決まる。タップでは変わらない）
    const now = this.elapsed()
    const { D, S } = this
    this.meter.style.setProperty('--p', clamp((now - S) / Math.max(1, D - S), 0, 1).toFixed(3))
    const sec = Math.max(0, Math.ceil((D - now) / 1000))
    if (sec !== this.shownSec) {
      this.shownSec = sec
      this.left.innerHTML = `あと<b>${sec}</b>秒`
    }
    if (this.phase !== 'spin') return
    this.idle += dt * 1000 * this.tl.speed
    // タップが途切れたら、ゆっくり自動で回す（寄せ始めたら回転は寄せる側に任せる）
    if (!this.aimed) m.cruise = this.idle > IDLE_MS ? AUTO_RPS : IDLE_RPS
    if (now >= D - 1000) this.setSub('いっせいに 玉が出るぞ…！')
    else if (m.rps >= 2) this.setSub('すごい勢い！')
    else if (m.rps >= 1.2) this.setSub('いい回転！')
    else if (this.taps > 0 && m.rps >= 0.4) this.setSub('その調子！')
    else if (this.idle > IDLE_MS) this.setSub(this.taps ? 'もっと回せ！' : 'タップすると、もっと速く回ります')
  }

  // 排出口が D ちょうどに真下（胴の角度が 360 の倍数）へ来るように、回転を寄せ始める。
  // 今の角度と速さから、D での角度と速さ（END_RPS）へ、なめらかにつなぐ
  private aim(): void {
    this.aimed = true
    if (this.reduced) return // 動きを減らす設定では回さないので、寄せない
    const m = this.machine
    const a0 = ((m.angle % 360) + 360) % 360
    const v0 = Math.max(0, m.rps) * 360
    const v1 = END_RPS * 360
    const dur = Math.max(16, this.tl.ms(this.D - this.elapsed()))
    const tr = dur / 1000
    // 逆回りしないように、進む量に下限を付ける（平均の速さ ≥ √(v0² + v1²) / 3 なら単調に進む）
    const least = Math.max(45, (tr * Math.hypot(v0, v1)) / 3)
    // そのうえで、平均の速さが今と D の速さの間くらいになる回転数を選ぶ
    const ideal = a0 + (tr * (v0 + v1)) / 2
    const turns = Math.max(Math.ceil((a0 + least) / 360), Math.round(ideal / 360))
    m.angle = a0
    m.cruise = 0
    this.steer = { p0: a0, p1: turns * 360, v0, v1, start: performance.now(), dur }
  }

  private steerFrame(): void {
    const st = this.steer!
    const m = this.machine
    const s = clamp((performance.now() - st.start) / st.dur, 0, 1)
    const tr = st.dur / 1000
    const s2 = s * s
    const s3 = s2 * s
    m.angle = (2 * s3 - 3 * s2 + 1) * st.p0 + (s3 - 2 * s2 + s) * tr * st.v0 + (3 * s2 - 2 * s3) * st.p1 + (s3 - s2) * tr * st.v1
    const v = ((6 * s2 - 6 * s) * st.p0 + (3 * s2 - 4 * s + 1) * tr * st.v0 + (6 * s - 6 * s2) * st.p1 + (3 * s2 - 2 * s) * tr * st.v1) / tr
    m.rps = Math.max(0, v / 360)
    if (s >= 1) {
      // 寄せ終わり。この速さのまま、玉を出す合図を待つ
      m.cruise = st.v1 / 360
      this.steer = null
    }
  }

  // ---- 玉が出る ----

  // 玉を出して、受け皿の玉の要素を返す（転がっている途中でも、結果の発表へつなげるため）
  private drop(): HTMLElement | null {
    this.steer = null
    this.setPhase('drop')
    this.count(0)
    this.setSub('')
    const m = this.machine
    // 出たら、すっと減速して止まる
    m.cruise = 0
    m.friction = 3.2
    safe(() => sfx.garaponDrop())
    if (this.all) safe(() => sfx.lastOne(this.win))
    vibrate(this.win ? 30 : 20)
    void m.dropBall(this.color, this.tl)
    const ball = m.el.querySelector<HTMLElement>('.fxg-m-balls > .fxg-ball:last-child')

    // 排出口のまわりを、玉の色でふわっと照らす（外れは淡い白）。立ち上がりは 160ms 以上
    const aura = this.$('.fxlp-aura')
    aura.dataset.color = this.color
    aura.style.transitionDuration = `${clampMs(this.tl.ms(260), 160)}ms`
    aura.classList.add('on')
    const hole = localPoint(this.root, m.el, HOLE.x, HOLE.y)
    if (this.win && this.fx) {
      const colors = BURST[this.color as Exclude<BallColor, 'white'>]
      this.fx.burst(hole.x, hole.y + 12, { count: 34, colors, speed: 6, size: 6, life: 48, shape: 'spark', gravity: 0.12 })
    }
    if (!this.reduced) {
      const tray = localPoint(this.root, m.el, TRAY.x, TRAY.y)
      this.word('コロン！', tray.x + 62, tray.y - 46).style.setProperty('--r', '8deg')
    }
    return ball
  }

  // ---- 結果 ----

  // 受け皿の小さな玉から、画面の真ん中の大きな玉へつないで結果を見せる。t は始めた時刻、k は縮める割合
  private async reveal(tray: HTMLElement | null, t: number, k: number): Promise<boolean> {
    const info = BALL_INFO[this.color]
    const win = this.win
    this.setPhase('reveal')
    const rv = this.$('.fxlp-reveal')
    const tokens = Array.from({ length: DC_BALLS }, () => '<i class="fxlp-token">?</i>').join('')
    rv.innerHTML = `
      <div class="fxlp-rv-ballwrap"><div class="fxlp-rv-halo"></div>${ballHtml(this.color)}</div>
      <div class="fxlp-rv-name"><span>${info.shape}</span>${info.name}</div>
      <div class="fxlp-rv-word" data-color="${this.color}">${win ? info.word : '運がなかった…'}</div>
      ${
        win
          ? `<div class="fxlp-plate" data-color="${this.color}"><small>★ ラストワン賞</small><b>${escapeHtml(this.o.prize || '景品')}</b></div>`
          : `<div class="fxlp-dc"><div class="fxlp-dc-head">でも、ダブルチャンスの玉を<b>${DC_BALLS}</b>個 プレゼント！</div><div class="fxlp-dc-balls">${tokens}</div></div>`
      }
      <div class="fxlp-rv-msg">${win ? 'このあと、景品パックを開けます' : `最後のガラポンで、${DC_BALLS} 回 回せます`}</div>`
    const big = rv.querySelector<HTMLElement>('.fxlp-rv-ballwrap > .fxg-ball')!
    const halo = rv.querySelector<HTMLElement>('.fxlp-rv-halo')!
    halo.style.setProperty('--halo', win ? `${info.color}5a` : 'rgba(140, 170, 255, 0.2)')
    const on = (sel: string) => rv.querySelector(sel)?.classList.add('on')

    if (!this.reduced && tray?.isConnected) {
      const from = localPoint(this.root, tray)
      const to = localPoint(this.root, big)
      const scale = (tray.getBoundingClientRect().width || 1) / (big.getBoundingClientRect().width || 1)
      big.animate(
        [{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${scale.toFixed(3)})` }, { transform: 'none' }],
        { duration: this.tl.ms(600 * k), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
    }
    if (tray) tray.style.visibility = 'hidden'
    if (!(await this.until(t + 600 * k))) return false
    halo.classList.add('on')
    on('.fxlp-rv-name')
    const c = localPoint(this.root, big)

    if (win) {
      const color = this.color as Exclude<BallColor, 'white'>
      safe(() => sfx.garaponWin(color))
      vibrate(30)
      if (!(await this.until(t + 750 * k))) return false
      on('.fxlp-rv-word')
      this.celebrate(color, c.x, c.y)
      if (color !== 'red') this.shake(rv)
      if (color === 'rainbow') this.glow()
      if (!(await this.until(t + 1250 * k))) return false
      on('.fxlp-plate')
      if (!(await this.until(t + 1650 * k))) return false
      on('.fxlp-rv-msg')
    } else {
      // 外れは、やさしく。熱がすっと冷めて、ダブルチャンスの玉を 1 つずつ渡す
      safe(() => sfx.garaponMiss())
      this.root.dataset.mood = 'cool'
      if (!(await this.until(t + 900 * k))) return false
      on('.fxlp-rv-word')
      this.fx?.rise(14, ['#9fb4ff', '#c9d6ff', '#e8ecff'], c.x - 90, c.x + 90, c.y + 40)
      if (!(await this.until(t + 1250 * k))) return false
      on('.fxlp-dc')
      rv.querySelectorAll<HTMLElement>('.fxlp-token').forEach((token, i) =>
        this.at(t + (1350 + 200 * i) * k, () => {
          token.classList.add('on')
          if (i === 0) safe(() => sfx.entry())
        }),
      )
      if (!(await this.until(t + 1950 * k))) return false
      on('.fxlp-rv-msg')
    }
    return true
  }

  private celebrate(color: Exclude<BallColor, 'white'>, x: number, y: number): void {
    const fx = this.fx
    if (!fx) return
    if (color === 'red') {
      fx.burst(x, y, { count: 40, colors: BURST.red, speed: 7, size: 9, life: 80 })
    } else if (color === 'gold') {
      fx.burst(x, y, { count: 60, colors: GOLD, speed: 8, life: 70, shape: 'spark' })
      fx.burst(x, y, { count: 40, colors: GOLD, speed: 6, size: 9, life: 90 })
    } else {
      fx.burst(x, y, { count: 90, colors: RAINBOW, speed: 9, size: 9, life: 95 })
      fx.rise(30, RAINBOW, x - 140, x + 140, y + 120)
    }
  }

  // 揺れは金と虹のときだけ（8px 以内、300ms 以内。速度を落としても延ばさない）
  private shake(node: HTMLElement): void {
    if (this.reduced) return
    node.animate(
      [
        { transform: 'translate(0, 0)' },
        { transform: 'translate(-6px, 2px)' },
        { transform: 'translate(5px, -2px)' },
        { transform: 'translate(-3px, 1px)' },
        { transform: 'translate(0, 0)' },
      ],
      { duration: clampMs(this.tl.ms(280), 120, 280), easing: 'ease-out' },
    )
  }

  // 全面の光は 1 回の演出につき 1 回まで（虹のときだけ）。立ち上がりは 120ms 以上
  private glow(): void {
    if (this.reduced || this.glowUsed) return
    this.glowUsed = true
    const rise = clampMs(this.tl.ms(320), 160)
    const fall = clampMs(this.tl.ms(1100), 400)
    this.$('.fxlp-glow').animate([{ opacity: 0 }, { opacity: 1, offset: rise / (rise + fall) }, { opacity: 0 }], {
      duration: rise + fall,
      easing: 'ease-out',
    })
  }
}

// ---- 説明の画面 ------------------------------------------------------------------

// 説明の画面（スマホ。争奪に入る人にだけ出す）: 残りの景品をガラポンで争うこと、このあとタップで回すこと、
// 赤・金・虹の玉なら当たりであること、外れてもダブルチャンスの玉がもらえることを出して、close が呼ばれるまで待つ。
// 抽選器は止まったまま見せる。この間のタップは何もしない（「合図を待っています」が、押すたびに小さく弾む）。
// close のあとに playLastOneGarapon を呼ぶと、見出しと抽選器はそのままで、説明の文字だけが消えて回り始める。
// 呼ばれなければ（新しいゲームを始めたときなど）、0.3 秒で消えて片付く
export interface LastOneBrief {
  speed?: number
  prizes: number // 残りの景品の数
  contestants: number // 争奪している人数
  autoMs: number | null // 自動で始まるまでの時間（司会の「スタート」を待つときは null）
}

const BRIEF_OUT = 320 // 説明の画面が消える長さ（演出上の ms）

export function openLastOneBrief(host: HTMLElement, o: LastOneBrief): { close(): void } {
  const speed = num(o.speed, 1)
  const tl = new Timeline(speed > 0 ? speed : 1)
  const reduced = prefersReducedMotion()
  const auto = typeof o.autoMs === 'number' && o.autoMs > 0 ? o.autoMs : null
  // 前の説明が残っていれば片付ける
  host.querySelectorAll(':scope > .fxlp-brief').forEach((n) => {
    briefs.get(n)?.()
    n.remove()
  })

  const tokens = Array.from({ length: DC_BALLS }, () => '<i class="fxlp-token on">?</i>').join('')
  const root = el(
    'div',
    'fxlp fxlp-brief',
    `<div class="fxlp-bg"></div>
    <header class="fxlp-head">${headHtml(o.prizes, o.contestants, false)}</header>
    <div class="fxlp-bf-you fxlp-in">
      <b>あなたは ラストワン争奪に参加！</b>
      <span>このあと、画面を<em>タップ</em>して<br>ガラポンを回そう</span>
    </div>
    <div class="fxlp-stage"></div>
    <footer class="fxlp-bf-foot fxlp-in">
      <div class="fxlp-bf-wait"><i></i><i></i><i></i><span>合図を待っています</span></div>
      <div class="fxlp-bf-sub"></div>
      ${auto && !reduced ? '<div class="fxlp-bf-bar"><b></b></div>' : ''}
      <div class="fxlp-bf-dc">外れても、ダブルチャンスの玉が<b>${DC_BALLS}</b>個もらえます<span>${tokens}</span></div>
    </footer>`,
  )
  root.style.setProperty('--fxlp-k', String(tl.ms(1)))
  // 抽選器は止まったまま見せる（ガラポンの画面と同じ位置・同じ向き）
  root.querySelector('.fxlp-stage')!.append(new GaraponMachine({ size: MACHINE }).el)
  const wait = root.querySelector<HTMLElement>('.fxlp-bf-wait')!
  const sub = root.querySelector<HTMLElement>('.fxlp-bf-sub')!

  // 始まるまでの案内。自動で始まるときは、残り秒数と残り時間の帯を出す
  const t0 = performance.now()
  let closed = false
  let hintUntil = 0
  const idle = (): string => {
    if (!auto) return 'スタートまで、そのままお待ちください'
    const left = Math.ceil((auto - (performance.now() - t0) * tl.speed) / 1000)
    return left > 0 ? `あと<b>${left}</b>秒で スタート` : 'まもなくスタート'
  }
  const renderSub = (): void => {
    if (closed || performance.now() < hintUntil) return
    const html = idle()
    if (sub.innerHTML !== html) sub.innerHTML = html
  }
  renderSub()
  if (auto) {
    for (let k = Math.floor(auto / 1000); k >= 0; k--) tl.at(auto - k * 1000 + 20, renderSub) // 秒が変わるたびに書き直す
    const bar = root.querySelector<HTMLElement>('.fxlp-bf-bar b') // 動きを減らす設定では、帯は出さず秒数だけ
    bar?.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: tl.ms(auto), easing: 'linear', fill: 'forwards' })
  }

  // この間のタップは回さない。押したことは伝わるように、「合図を待っています」を小さく弾ませて、ひと言出す
  let lastNudge = 0
  swallow(root)
  root.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    safe(() => engine.unlock()) // 触ってもらえたら、このあとの音が鳴るようにしておく
    const now = performance.now()
    if (closed || now - lastNudge < 400) return // 1 秒に 3 回までに間引く
    lastNudge = now
    hintUntil = now + tl.ms(1600)
    sub.textContent = 'まだ回りません。合図のあとにタップ！'
    tl.at(1650, renderSub)
    if (reduced) return
    wait.classList.remove('nudge')
    void wait.offsetWidth
    wait.classList.add('nudge')
  })

  host.append(root)
  void root.offsetWidth
  root.classList.add('on')
  const show = (sel: string): void => root.querySelector(sel)?.classList.add('on')
  show('.fxlp-kicker')
  show('.fxlp-title')
  tl.at(250, () => show('.fxlp-odds'))
  tl.at(450, () => show('.fxlp-rule'))
  tl.at(700, () => show('.fxlp-bf-you'))
  tl.at(1000, () => show('.fxlp-bf-foot'))
  vibrate(20)

  const close = (): void => {
    if (closed) return
    closed = true
    briefs.delete(root)
    // 下で始まったガラポンにタップが届くように、消えていく間は触れないようにする
    root.style.pointerEvents = 'none'
    if (reduced || !root.isConnected) {
      tl.cancel()
      root.remove()
      return
    }
    root.style.setProperty('--fxlp-out', `${tl.ms(BRIEF_OUT)}ms`)
    root.classList.add('out')
    tl.at(BRIEF_OUT + 40, () => {
      tl.cancel()
      root.remove()
    })
  }
  briefs.set(root, close)
  return { close }
}
