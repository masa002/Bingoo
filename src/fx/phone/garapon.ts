import './garapon.css'
import { engine, sfx, type GaraponVoice } from '../../audio'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { GOLD, RAINBOW, TIER_COLOR, type BallColor } from '../theme'

// ダブルチャンスのガラポン（390×844 のスマホ画面全体に重ねる）。熱を冷ます締めくくり。
// 連打でヒートアップして、玉がコロンと出たら、熱がすっと冷めて落ち着いて終わる。
//
//   if (await askEntry(phone, { seconds: 30 })) {
//     await playGarapon(phone, { balls: [{ color: 'red', prize: 'グルメカタログ' }], stats })
//   }
//
// 抽選器の絵（GaraponMachine）と玉（ballHtml）は、大画面（stage/doublechance.ts）でも使い回す

// ---- 玉 ------------------------------------------------------------------------

export interface BallInfo {
  name: string // 玉の呼び名
  short: string // 一文字の呼び名（一覧など狭いところ用）
  shape: string // 色だけで伝えないための形
  word: string // 発表の言葉
  color: string // 代表色（文字や光に使う）
}

// 白 ○ ははずれ。赤 ◆ ・金 ★ ・虹 ✦ は当たりで、上ほど上の景品
export const BALL_INFO: Readonly<Record<BallColor, BallInfo>> = {
  white: { name: '白い玉', short: '白', shape: '○', word: 'はずれ', color: '#e9edf5' },
  red: { name: '赤い玉', short: '赤', shape: '◆', word: '当たり！', color: TIER_COLOR[2] },
  gold: { name: '金色の玉', short: '金', shape: '★', word: '大当たり！', color: TIER_COLOR[3] },
  rainbow: { name: '虹色の玉', short: '虹', shape: '✦', word: '超大当たり！', color: '#ff5ad2' },
}

// 玉の要素。大きさは CSS 変数 --d で決める（既定 40px）
export function ballHtml(color: BallColor, className = ''): string {
  return `<span class="fxg-ball ${className}" data-color="${color}"><i>${BALL_INFO[color].shape}</i></span>`
}

// ---- 抽選器の絵 ----------------------------------------------------------------
// 320×320 の座標で描く。八角形の木の胴（正面から見た形）、取っ手、脚、台、受け皿。
// 胴は回るので、縞・模様は薄くして、速く回るほどさらに薄くする（光過敏への配慮）

const CX = 160
const CY = 138
const R_OUT = 100 // 胴の外周（八角形の頂点までの距離）
const R_IN = 84 // 正面の板
const HOLE_DEG = 90 // 排出口の向き（胴の中での角度。0 度は右、90 度は下）
const ARM_DEG = -40 // 取っ手の向き（胴の中での角度）
const ARM_LEN = 74
const BALL_REST = { x: 174, y: 275 } // 受け皿で玉が止まる位置
const BALL_R = 11
const MAX_RPS = 3 // 見た目の回転の上限（これより速いと形が崩れて見えるため）

let uid = 0

const oct = (r: number): string =>
  Array.from({ length: 8 }, (_, k) => {
    const a = ((22.5 + 45 * k) * Math.PI) / 180
    return `${(CX + r * Math.cos(a)).toFixed(1)},${(CY + r * Math.sin(a)).toFixed(1)}`
  }).join(' ')

const polar = (deg: number, r: number): { x: number; y: number } => {
  const a = (deg * Math.PI) / 180
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) }
}

function machineSvg(id: string): { back: string; front: string } {
  const arm = polar(ARM_DEG, ARM_LEN)
  const hole = polar(HOLE_DEG, R_OUT * Math.cos(Math.PI / 8) - 5)
  const studs = Array.from({ length: 8 }, (_, k) => polar(22.5 + 45 * k, R_OUT - 8))
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.2" fill="url(#${id}-brass)"/>`)
    .join('')
  // 木目: 横向きのゆるい曲線と、節（ふし）を 2 つ。節は回転の手がかりになる
  const grain = [94, 108, 121, 133, 146, 160, 173, 186]
    .map((y, i) => {
      const w = i % 2 ? 5 : -4
      return `<path d="M60 ${y} C 110 ${y + w}, 150 ${y - w}, 260 ${y + w * 0.6}"/>`
    })
    .join('')
  // 胴の下地は中心から同心の塗りにする（回しても、どの点の明るさも変わらない＝明滅しない）。
  // 立体感は、回らない光の層（light）で付ける
  const back = `
<svg viewBox="0 0 320 320" aria-hidden="true">
  <defs>
    <radialGradient id="${id}-wood" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#cf9558"/><stop offset="0.7" stop-color="#bf8045"/><stop offset="1" stop-color="#a86a35"/>
    </radialGradient>
    <radialGradient id="${id}-rim" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.8" stop-color="#93592a"/><stop offset="1" stop-color="#7a4a22"/>
    </radialGradient>
    <linearGradient id="${id}-leg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6f4220"/><stop offset="1" stop-color="#4e2c12"/>
    </linearGradient>
    <linearGradient id="${id}-base" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8a5328"/><stop offset="1" stop-color="#5a3315"/>
    </linearGradient>
    <radialGradient id="${id}-brass" cx="0.35" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#fff1c2"/><stop offset="0.5" stop-color="#e3bd6a"/><stop offset="1" stop-color="#8f6d2c"/>
    </radialGradient>
    <radialGradient id="${id}-knob" cx="0.35" cy="0.3" r="0.8">
      <stop offset="0" stop-color="#f0c08a"/><stop offset="0.5" stop-color="#b0723a"/><stop offset="1" stop-color="#5e3616"/>
    </radialGradient>
    <radialGradient id="${id}-light" cx="0.32" cy="0.26" r="0.85">
      <stop offset="0" stop-color="#fff" stop-opacity="0.24"/><stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.8" stop-color="#000" stop-opacity="0.12"/><stop offset="1" stop-color="#000" stop-opacity="0.3"/>
    </radialGradient>
    <radialGradient id="${id}-dish" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0" stop-color="#4a2a10"/><stop offset="1" stop-color="#2c170a"/>
    </radialGradient>
    <clipPath id="${id}-face"><polygon points="${oct(R_IN)}"/></clipPath>
    <clipPath id="${id}-turn"><polygon data-k="clip" points="${oct(R_OUT + 1)}"/></clipPath>
  </defs>
  <ellipse cx="160" cy="309" rx="132" ry="8" fill="#000" opacity="0.38"/>
  <g stroke-linecap="round">
    <line x1="${CX}" y1="${CY}" x2="80" y2="292" stroke="url(#${id}-leg)" stroke-width="17"/>
    <line x1="${CX}" y1="${CY}" x2="240" y2="292" stroke="url(#${id}-leg)" stroke-width="17"/>
    <line x1="${CX - 4}" y1="${CY + 10}" x2="82" y2="286" stroke="#a46a38" stroke-width="3" opacity="0.5"/>
    <line x1="${CX + 4}" y1="${CY + 10}" x2="236" y2="286" stroke="#a46a38" stroke-width="3" opacity="0.4"/>
  </g>
  <rect x="44" y="286" width="232" height="19" rx="6" fill="url(#${id}-base)" stroke="#3d220e" stroke-width="2"/>
  <rect x="50" y="288" width="220" height="3" rx="1.5" fill="#c58a52" opacity="0.45"/>
  <g data-k="ghosts" fill="none" stroke="#2a1608" stroke-width="7" stroke-linejoin="round" opacity="0">
    <polygon data-k="g1" points="${oct(R_OUT)}" opacity="0.6"/>
    <polygon data-k="g2" points="${oct(R_OUT)}" opacity="0.3"/>
  </g>
  <g data-k="drum">
    <polygon points="${oct(R_OUT)}" fill="url(#${id}-rim)" stroke="#3d220e" stroke-width="3" stroke-linejoin="round"/>
    <rect x="${(hole.x - 16).toFixed(1)}" y="${(hole.y - 4).toFixed(1)}" width="32" height="10" rx="4" fill="#1b0d04" stroke="#5a3315" stroke-width="1.5"/>
    <polygon points="${oct(R_IN)}" fill="url(#${id}-wood)" stroke="#6b3d18" stroke-width="2" stroke-linejoin="round"/>
    <g data-k="detail">
      <g clip-path="url(#${id}-face)" fill="none" stroke="#5b3414" stroke-width="1.3" opacity="0.2">${grain}
        <ellipse cx="118" cy="178" rx="9" ry="4.5"/><ellipse cx="118" cy="178" rx="4" ry="2"/>
        <ellipse cx="203" cy="104" rx="7" ry="3.5"/>
      </g>
      <line x1="${CX - 28}" y1="${CY - 80}" x2="${CX - 28}" y2="${CY + 80}" stroke="#6b3d18" stroke-width="1.5" opacity="0.32" clip-path="url(#${id}-face)"/>
      <line x1="${CX + 28}" y1="${CY - 80}" x2="${CX + 28}" y2="${CY + 80}" stroke="#6b3d18" stroke-width="1.5" opacity="0.32" clip-path="url(#${id}-face)"/>
      <polygon points="${oct(R_IN + 4)}" fill="none" stroke="#ffe2b8" stroke-width="1.2" opacity="0.22"/>
      ${studs}
      <circle cx="${CX}" cy="${CY - 50}" r="15" fill="#c63a2f" opacity="0.92"/>
      <circle cx="${CX}" cy="${CY - 50}" r="12" fill="none" stroke="#ffe7cf" stroke-width="1" opacity="0.6"/>
      <text x="${CX}" y="${CY - 44}" text-anchor="middle" font-size="17" font-weight="900" fill="#fff4e4"
        font-family="'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif">福</text>
    </g>
    <line x1="${CX}" y1="${CY}" x2="${arm.x.toFixed(1)}" y2="${arm.y.toFixed(1)}" stroke="#3b2413" stroke-width="10" stroke-linecap="round"/>
    <line x1="${CX}" y1="${CY}" x2="${arm.x.toFixed(1)}" y2="${arm.y.toFixed(1)}" stroke="#7a4d2a" stroke-width="3" stroke-linecap="round" opacity="0.7"/>
  </g>
  <rect x="${CX - R_OUT - 2}" y="${CY - R_OUT - 2}" width="${R_OUT * 2 + 4}" height="${R_OUT * 2 + 4}" fill="url(#${id}-light)" clip-path="url(#${id}-turn)"/>
  <circle cx="${CX}" cy="${CY}" r="13" fill="url(#${id}-brass)" stroke="#6d5020" stroke-width="1.5"/>
  <circle cx="${CX}" cy="${CY}" r="4" fill="#6d5020"/>
  <g data-k="knob">
    <circle r="13" fill="url(#${id}-knob)" stroke="#3b2413" stroke-width="2"/>
    <ellipse cx="-4" cy="-5" rx="4.5" ry="3" fill="#fff" opacity="0.35"/>
  </g>
  <ellipse cx="160" cy="279" rx="52" ry="12.5" fill="#7a4a22" stroke="#3d220e" stroke-width="2"/>
  <ellipse cx="160" cy="280" rx="44" ry="9" fill="url(#${id}-dish)"/>
</svg>`
  // 受け皿の手前のふち（玉より手前に描く）
  const front = `
<svg viewBox="0 0 320 320" aria-hidden="true">
  <path d="M108 279 A52 12.5 0 0 0 212 279 L212 285 A52 13.5 0 0 1 108 285 Z" fill="#a8692f" stroke="#3d220e" stroke-width="2" stroke-linejoin="round"/>
  <path d="M116 286 A46 10 0 0 0 204 286" fill="none" stroke="#e0a76a" stroke-width="1.5" opacity="0.45"/>
</svg>`
  return { back, front }
}

// ---- 抽選器（絵と回転の物理） ----------------------------------------------------
// タップ（kick）で加速し、放っておくと摩擦で減速する。cruise を入れると、その速さを保って回り続ける。
// 描画ループは自分で回し、要素が画面から外されたら止まる（onGone を呼ぶ）

export class GaraponMachine {
  readonly el: HTMLElement
  angle = 0 // 度（時計回り）
  rps = 0 // 毎秒の回転数
  turns = 0 // 回った量の累計（回転数）
  cruise = 0 // 放っておいても保つ回転数（大画面のゆっくり回る絵、自動で回すとき）
  friction = 0.8 // 減速の強さ（1 秒あたり）
  onFrame: ((dt: number) => void) | null = null
  onHoleBottom: (() => void) | null = null // 排出口が真下を通った
  onGone: (() => void) | null = null

  private readonly reduced = prefersReducedMotion()
  private readonly inner: HTMLElement
  private readonly balls: HTMLElement
  private readonly drum: SVGGElement
  private readonly ghosts: SVGGElement
  private readonly g1: SVGElement
  private readonly g2: SVGElement
  private readonly detail: SVGGElement
  private readonly knob: SVGGElement
  private readonly clip: SVGElement
  private squash = 0
  private last = 0
  private raf = 0
  private seen = false
  private drawn = ''

  constructor(o: { size?: number } = {}) {
    const id = `fxg${++uid}`
    const { back, front } = machineSvg(id)
    this.el = el('div', 'fxg-machine')
    this.inner = el('div', 'fxg-m-inner', `${back}<div class="fxg-m-balls"></div>${front}`)
    this.el.append(this.inner)
    this.balls = this.inner.querySelector<HTMLElement>('.fxg-m-balls')!
    const $ = <T extends Element>(k: string) => this.inner.querySelector<T>(`[data-k="${k}"]`)!
    this.drum = $('drum')
    this.ghosts = $('ghosts')
    this.g1 = $('g1')
    this.g2 = $('g2')
    this.detail = $('detail')
    this.knob = $('knob')
    this.clip = $('clip')
    this.setSize(o.size ?? 320)
    this.render()
  }

  setSize(px: number): void {
    this.el.style.width = `${px}px`
    this.el.style.height = `${px}px`
    this.inner.style.transform = `scale(${px / 320})`
  }

  // タップ 1 回ぶんの加速。速いほど伸びにくい（上限に近づくほど効きが弱まる）
  kick(power = 1): void {
    const k = this.rps / MAX_RPS
    this.rps = Math.min(MAX_RPS, this.rps + 0.45 * power * Math.max(0, 1 - k * k))
    if (!this.reduced) this.squash = 1 // 取っ手を押し込んだ手ごたえ
  }

  start(): void {
    if (this.raf) return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  destroy(): void {
    this.stop()
    this.el.remove()
  }

  // 受け皿の玉を片付ける
  clearTray(): void {
    this.balls.replaceChildren()
  }

  // 排出口から玉を出して、受け皿に落とす（はねて、転がって止まる）。止まったら解決する
  async dropBall(color: BallColor, tl: Timeline): Promise<HTMLElement> {
    const wrap = el('div', '', ballHtml(color))
    const ball = wrap.firstElementChild as HTMLElement
    const hole = polar(HOLE_DEG, R_OUT * Math.cos(Math.PI / 8))
    const at = (x: number, y: number, sx = 1, sy = sx) =>
      `translate(${(x - BALL_R).toFixed(1)}px, ${(y - BALL_R).toFixed(1)}px) scale(${sx}, ${sy})`
    this.balls.append(ball)
    if (this.reduced) {
      ball.style.transform = at(BALL_REST.x, BALL_REST.y)
      return ball
    }
    const { x: rx, y: ry } = BALL_REST
    const dur = tl.ms(1150)
    ball.animate(
      [
        { offset: 0, transform: at(hole.x, hole.y - 6, 0.4), easing: 'ease-out' },
        { offset: 0.12, transform: at(hole.x, hole.y + 8), easing: 'ease-in' },
        { offset: 0.36, transform: at(hole.x + 3, ry, 1.12, 0.86), easing: 'ease-out' },
        { offset: 0.52, transform: at(hole.x + 8, ry - 16), easing: 'ease-in' },
        { offset: 0.66, transform: at(hole.x + 11, ry, 1.06, 0.93), easing: 'ease-out' },
        { offset: 0.76, transform: at(hole.x + 12.5, ry - 5), easing: 'ease-in' },
        { offset: 0.84, transform: at(hole.x + 13, ry), easing: 'ease-out' },
        { offset: 1, transform: at(rx, ry) },
      ],
      { duration: dur, fill: 'forwards' },
    )
    // 転がるぶん、玉の印も回す
    ball.querySelector('i')?.animate([{ transform: 'rotate(-40deg)' }, { transform: 'rotate(0deg)' }], {
      duration: dur,
      easing: 'ease-out',
      fill: 'forwards',
    })
    await tl.wait(1150)
    return ball
  }

  private readonly frame = (now: number): void => {
    this.raf = 0
    if (this.el.isConnected) this.seen = true
    else if (this.seen) {
      this.onGone?.()
      return
    }
    // タブが裏にあった後などに大きく飛ばないよう、1 コマは 50ms までにする
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000))
    this.last = now
    this.step(dt)
    this.onFrame?.(dt)
    this.render()
    this.raf = requestAnimationFrame(this.frame)
  }

  private step(dt: number): void {
    if (this.rps < this.cruise) this.rps = Math.min(this.cruise, this.rps + dt * 1.2)
    else this.rps = Math.max(this.cruise, this.rps * Math.exp(-this.friction * dt))
    if (this.rps < 0.004) this.rps = 0
    this.squash = Math.max(0, this.squash - dt * 7)
    if (this.reduced) return // 動きを減らす設定では回さない（回った量だけ数える）
    const before = this.angle
    this.angle += this.rps * 360 * dt
    this.turns += this.rps * dt
    // 排出口が真下（胴の角度が 360 の倍数）を通り過ぎたか
    if (Math.floor(this.angle / 360) > Math.floor(before / 360)) this.onHoleBottom?.()
    if (this.angle > 36000) this.angle -= 36000
  }

  // 動きを減らす設定のとき、回った量を外から足す（タップごと）
  addTurns(n: number): void {
    this.turns += n
  }

  private render(): void {
    const a = this.angle
    const blur = Math.min(1, this.rps / 2.4)
    const key = `${a.toFixed(2)}|${blur.toFixed(3)}|${this.squash.toFixed(2)}`
    if (key === this.drawn) return
    this.drawn = key
    const rot = (d: number) => `rotate(${d.toFixed(2)} ${CX} ${CY})`
    this.drum.setAttribute('transform', rot(a))
    this.clip.setAttribute('transform', rot(a))
    // 速いほど、輪郭の残像を出し、木目や印を薄くする（ぶれて見える）
    this.ghosts.setAttribute('opacity', (blur * 0.55).toFixed(3))
    this.g1.setAttribute('transform', rot(a - 7))
    this.g2.setAttribute('transform', rot(a - 14))
    this.detail.setAttribute('opacity', (1 - blur * 0.75).toFixed(3))
    const k = polar(a + ARM_DEG, ARM_LEN)
    const s = 1 - 0.16 * this.squash
    this.knob.setAttribute('transform', `translate(${k.x.toFixed(2)} ${k.y.toFixed(2)}) scale(${s.toFixed(3)})`)
  }
}

// ---- 共通の小物 ----------------------------------------------------------------

// 光過敏への配慮: 速度を上げても、立ち上がりや揺れの長さが安全な範囲に収まるようにする
const clampMs = (ms: number, min: number, max = Infinity): number => Math.min(max, Math.max(min, ms))

function setSpeedVar(node: HTMLElement, tl: Timeline): void {
  node.style.setProperty('--fxg-k', String(tl.ms(1)))
}

// 画面の拡大縮小（画面側の fit）を打ち消して、root の中の座標にする
function localCenter(root: HTMLElement, node: Element): { x: number; y: number } {
  const r = root.getBoundingClientRect()
  const b = node.getBoundingClientRect()
  const s = r.width / (root.offsetWidth || r.width || 1) || 1
  return { x: (b.left + b.width / 2 - r.left) / s, y: (b.top + b.height / 2 - r.top) / s }
}

function makeParticles(root: HTMLElement, tl: Timeline): Particles {
  const canvas = el('canvas', 'fxg-fx')
  canvas.width = root.clientWidth || 390
  canvas.height = root.clientHeight || 844
  root.append(canvas)
  const fx = new Particles(canvas, 500)
  fx.speed = tl.speed
  return fx
}

// タップを外に送らない（画面側のクリック処理に届かないようにする）
function swallow(root: HTMLElement): void {
  for (const type of ['pointerup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend']) {
    root.addEventListener(type, (e) => {
      e.stopPropagation()
      if (type !== 'pointerup' && e.cancelable) e.preventDefault()
    }, { passive: false })
  }
}

const BELL_SVG = `
<svg class="fxg-bell" viewBox="0 0 64 76" aria-hidden="true">
  <defs>
    <linearGradient id="fxg-bell-body" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#9c7a33"/><stop offset="0.35" stop-color="#ffe9a8"/><stop offset="0.7" stop-color="#e3bd6a"/><stop offset="1" stop-color="#8f6d2c"/>
    </linearGradient>
  </defs>
  <rect x="27" y="2" width="10" height="22" rx="4" fill="#8a5328" stroke="#4a2a10" stroke-width="1.5"/>
  <path d="M32 22 C 18 22 15 36 14 48 C 13 56 8 60 6 64 L 58 64 C 56 60 51 56 50 48 C 49 36 46 22 32 22 Z" fill="url(#fxg-bell-body)" stroke="#6d5020" stroke-width="1.5"/>
  <rect x="5" y="62" width="54" height="5" rx="2.5" fill="#c9a24d" stroke="#6d5020" stroke-width="1"/>
  <circle cx="32" cy="70" r="5" fill="#6d5020"/>
</svg>`

const vibrate = (ms: number): void => {
  // ユーザーがまだ画面に触れていないとブラウザが止めて警告を出すので、そのときは呼ばない
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return
  try {
    navigator.vibrate?.(ms)
  } catch {
    // 振動に対応していない端末
  }
}

const RING_C = 2 * Math.PI * 124 // エントリーの残り時間の輪の長さ

// ---- エントリー ------------------------------------------------------------------

// エントリー受付。seconds 秒以内にボタンを押せば true（押した瞬間に解決する）。時間切れは false。
// 押したあとは「締め切りまで あと N 秒」を出して待ち、締め切ったら自分で閉じる
// （先に playGarapon を始めた場合は、そこで閉じる）。時間切れは「受付終了」を見せて閉じてから false
export async function askEntry(
  host: HTMLElement,
  o: { speed?: number; seconds: number; sound?: boolean },
): Promise<boolean> {
  const total = Math.max(0, o.seconds)
  if (total <= 0) return false
  const tl = new Timeline(o.speed ?? 1)
  const sound = o.sound ?? true
  const reduced = prefersReducedMotion()
  host.querySelectorAll(':scope > .fxg').forEach((n) => n.remove())

  const root = el(
    'div',
    'fxg fxg-entry',
    `<div class="fxg-bg"></div>
    <div class="fxg-head">
      <div class="fxg-kicker">DOUBLE CHANCE</div>
      <div class="fxg-title">ダブルチャンス</div>
      <div class="fxg-en-lead">最後に、ガラポンで景品が当たるかも！<br>参加する人は、ボタンを押してください</div>
    </div>
    <div class="fxg-en-wrap">
      <svg class="fxg-en-ring" viewBox="0 0 264 264" aria-hidden="true">
        <circle class="bg" cx="132" cy="132" r="124"/>
        <circle class="fg" cx="132" cy="132" r="124" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="0"/>
      </svg>
      <div class="fxg-en-wave"></div>
      <button class="fxg-en-btn" type="button"><b>エントリー</b><small>タップで参加</small></button>
    </div>
    <div class="fxg-en-time"></div>
    <div class="fxg-en-note">ボタンを押した人だけが、ガラポンを回せます</div>`,
  )
  setSpeedVar(root, tl)
  host.append(root)
  swallow(root)
  void root.offsetWidth
  root.classList.add('on')

  const btn = root.querySelector<HTMLButtonElement>('.fxg-en-btn')!
  const ring = root.querySelector<SVGCircleElement>('.fxg-en-ring .fg')!
  const time = root.querySelector<HTMLElement>('.fxg-en-time')!
  const note = root.querySelector<HTMLElement>('.fxg-en-note')!
  let fx: Particles | null = null
  let state: 'open' | 'done' | 'closed' = 'open'
  let pressedAt = 0
  let shown = -1
  let raf = 0

  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
    }

    // 残り秒数と輪。押したあとは「締め切りまで」に言い替える
    const start = performance.now()
    const tick = (now: number) => {
      raf = 0
      if (!root.isConnected) {
        tl.cancel()
        settle(false)
        return
      }
      const left = Math.max(0, total - ((now - start) * tl.speed) / 1000)
      const n = Math.ceil(left)
      if (n !== shown && state !== 'closed') {
        shown = n
        time.innerHTML = state === 'done' ? `締め切りまで あと<b>${n}</b>秒` : `受付 のこり<b>${n}</b>秒`
        if (n <= 5) ring.style.stroke = state === 'done' ? '' : '#ffa24d'
      }
      ring.setAttribute('stroke-dashoffset', (RING_C * (1 - left / total)).toFixed(1))
      if (left > 0) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    const press = (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      if (state !== 'open') return
      state = 'done'
      shown = -1
      pressedAt = performance.now()
      root.dataset.state = 'done'
      ring.style.stroke = ''
      btn.innerHTML = '<b>✓ 完了</b><small>エントリーしました</small>'
      note.textContent = 'このままお待ちください。まもなくガラポンが始まります'
      if (sound) {
        engine.unlock()
        sfx.entry()
      }
      vibrate(15)
      if (!reduced) {
        root.querySelector('.fxg-en-wave')?.classList.add('on')
        fx ??= makeParticles(root, tl)
        const c = localCenter(root, btn)
        fx.burst(c.x, c.y, { count: 26, colors: ['#22c55e', '#b9f7cf', '#f5c542', '#ffffff'], speed: 5, size: 6, life: 55, shape: 'dot', gravity: 0.08 })
      }
      settle(true)
    }
    btn.addEventListener('pointerdown', press)
    btn.addEventListener('click', press)
    root.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
    })

    const close = async () => {
      root.classList.add('out')
      await tl.wait(600)
      cancelAnimationFrame(raf)
      fx?.clear()
      root.remove()
    }

    void (async () => {
      await tl.wait(total * 1000)
      if (tl.cancelled || !root.isConnected) return settle(false)
      if (state === 'open') {
        state = 'closed'
        root.dataset.state = 'closed'
        btn.innerHTML = '<b>受付終了</b>'
        time.textContent = '受付は終了しました'
        note.textContent = 'またの機会に、ぜひ！'
        await tl.wait(1300)
        await close()
        settle(false)
      } else {
        // 押した直後に締め切ったときも、「完了」は少し見せてから閉じる
        const held = (performance.now() - pressedAt) * tl.speed
        await tl.wait(Math.max(0, 1200 - held))
        if (!root.isConnected) return
        time.textContent = '締め切りました'
        await tl.wait(600)
        await close()
      }
    })()
  })
}

// ---- ガラポン ------------------------------------------------------------------

export interface GaraponBall {
  color: BallColor
  prize?: string
}

export interface GaraponStats {
  hits: number // カードに出た番号の数
  maxReach: number // いちばん多かったリーチの本数
  nearMiss: number // あと 1 つで外れた回数
  won?: string // 当たった景品（あれば）
}

const TURNS_NEEDED = 4 // これだけ回すと玉が出る（×1 のとき）
const AUTO_MS = 6500 // タップしなくても、この時間で玉が出る
const IDLE_MS = 2200 // タップが途切れてから、係の人が回すように自動で回し始めるまで
const POP_WORDS = ['ガラッ', 'ガラ', 'ガラガラ', 'ゴロッ', 'ガラッ', 'ゴロ'] // 当たりを思わせる「カラン」は使わない
const DWELL: Readonly<Record<BallColor, number>> = { white: 2600, red: 2900, gold: 3300, rainbow: 3700 }

// ガラポンを回す。連打で速く回る（タップはスマホの中だけで処理し、サーバーには送らない）。
// 結果は balls に先に決まっている（1 回なら 1 個、ラストワン争奪で外れた人は複数）。
// 最後に、その人のゲームの結果（stats）を出して「おつかれさまでした」で終える。
// その画面は残す（keep: false なら閉じる）。sound: false で音を出さない
export async function playGarapon(
  host: HTMLElement,
  o: {
    speed?: number
    balls: GaraponBall[]
    stats: GaraponStats
    sound?: boolean
    keep?: boolean
  },
): Promise<void> {
  const play = new GaraponPlay(host, o)
  try {
    await play.run()
  } finally {
    play.dispose()
  }
}

function noshiHtml(color: BallColor, prize: string | undefined): string {
  return `<div class="fxg-noshi" data-color="${color}"><small>目録</small><b>${escapeHtml(prize || '景品が当たりました')}</b></div>`
}

function cheerText(s: GaraponStats, wins: number): string {
  if (s.won || wins > 0) return 'おめでとうございます！'
  if (s.nearMiss >= 2) return `あと 1 つが ${s.nearMiss} 回…！<br>本当に惜しかった`
  if (s.maxReach >= 2) return `${s.maxReach} 本のリーチ、見事でした`
  if (s.maxReach === 1) return 'リーチまで行きました。あと一歩！'
  return '今日は、運をためておく日でした'
}

class GaraponPlay {
  private readonly tl: Timeline
  private readonly sound: boolean
  private readonly keep: boolean
  private readonly balls: GaraponBall[]
  private readonly stats: GaraponStats
  private readonly reduced = prefersReducedMotion()
  private readonly root: HTMLElement
  private readonly machine: GaraponMachine
  private readonly meter: HTMLElement
  private readonly sub: HTMLElement
  private fx: Particles | null = null
  private voice: GaraponVoice | null = null
  private phase: 'spin' | 'drop' | 'reveal' | 'result' = 'spin'
  private wake: (() => void) | null = null
  private heat = 0
  private elapsed = 0 // この回を回し始めてからの、演出上の ms
  private idle = 0 // 最後のタップからの、演出上の ms
  private taps = 0
  private lastPop = 0
  private lastVoice = -1
  private glowUsed = false

  constructor(host: HTMLElement, o: { speed?: number; balls: GaraponBall[]; stats: GaraponStats; sound?: boolean; keep?: boolean }) {
    this.tl = new Timeline(o.speed ?? 1)
    this.sound = o.sound ?? true
    this.keep = o.keep ?? true
    this.balls = o.balls
    this.stats = o.stats
    // エントリーの画面や、前のガラポンが残っていれば片付ける
    host.querySelectorAll(':scope > .fxg').forEach((n) => n.remove())
    this.root = el(
      'div',
      'fxg fxg-play',
      `<div class="fxg-bg"></div>
      <div class="fxg-head">
        <div class="fxg-kicker">DOUBLE CHANCE</div>
        <div class="fxg-title">ガラポン抽選</div>
        <div class="fxg-left"></div>
        <div class="fxg-slots"></div>
      </div>
      <div class="fxg-stage"></div>
      <div class="fxg-foot">
        <div class="fxg-meter-label"><span>ガラガラ…</span><span>玉が出るまで</span></div>
        <div class="fxg-meter"><b></b></div>
        <div class="fxg-prompt">連打で回せ！</div>
        <div class="fxg-sub"></div>
      </div>
      <div class="fxg-pops"></div>
      <div class="fxg-reveal"></div>
      <div class="fxg-result"></div>
      <div class="fxg-glow"></div>`,
    )
    this.root.dataset.phase = 'spin'
    setSpeedVar(this.root, this.tl)
    host.append(this.root)
    this.meter = this.$('.fxg-meter')
    this.sub = this.$('.fxg-sub')

    this.machine = new GaraponMachine({ size: Math.min(320, (host.clientWidth || 390) - 50) })
    this.$('.fxg-stage').append(this.machine.el)
    this.machine.onFrame = this.onFrame
    this.machine.onGone = () => {
      this.tl.cancel()
      this.stopVoice()
      this.release()
    }
    this.machine.start()
    if (!this.reduced) this.fx = makeParticles(this.root, this.tl)

    swallow(this.root)
    this.root.addEventListener('pointerdown', this.onTap)
    void this.root.offsetWidth
    this.root.classList.add('on')
  }

  async run(): Promise<void> {
    const n = this.balls.length
    for (let i = 0; i < n; i++) {
      this.renderHead(i)
      await this.spin(i)
      if (this.gone()) return
      const tray = await this.drop(this.balls[i].color)
      if (this.gone()) return
      await this.reveal(this.balls[i], tray, n - i - 1)
      if (this.gone()) return
    }
    this.renderHead(n)
    await this.result()
    if (this.gone() || this.keep) return
    this.root.classList.add('out')
    await this.tl.wait(600)
    this.root.remove()
  }

  dispose(): void {
    this.stopVoice()
    this.machine.stop()
    this.root.removeEventListener('pointerdown', this.onTap)
  }

  private $(selector: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(selector)!
  }

  private gone(): boolean {
    return this.tl.cancelled || !this.root.isConnected
  }

  // 待っている段階（回す・排出口待ち）を終わらせる
  private release(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  private renderHead(done: number): void {
    const n = this.balls.length
    const left = n - done
    this.$('.fxg-left').innerHTML =
      n === 1 ? 'チャンスは<b>1</b>回' : left > 0 ? `のこり<b>${left}</b>回` : `<b>${n}</b>回 回しました`
    this.$('.fxg-slots').innerHTML = this.balls
      .map((b, i) =>
        i < done
          ? `<span class="fxg-slot is-done">${ballHtml(b.color)}</span>`
          : `<span class="fxg-slot${i === done ? ' now' : ''}">${i === done ? '?' : ''}</span>`,
      )
      .join('')
  }

  private setSub(text: string): void {
    if (this.sub.textContent !== text) this.sub.textContent = text
  }

  // ---- 回す ----

  private spin(i: number): Promise<void> {
    this.phase = 'spin'
    this.root.dataset.phase = 'spin'
    delete this.root.dataset.mood
    const m = this.machine
    m.clearTray()
    m.turns = 0
    m.cruise = 0
    m.friction = 0.8
    this.elapsed = 0
    this.idle = 0
    this.taps = 0
    this.meter.style.setProperty('--p', '0')
    this.$('.fxg-prompt').textContent = i === 0 ? '連打で回せ！' : 'もう一回！ 連打で回せ！'
    this.setSub('画面のどこでもタップ')
    return new Promise<void>((resolve) => {
      this.wake = resolve
      if (this.gone()) this.release()
    })
  }

  private readonly onTap = (e: PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (this.sound) engine.unlock()
    if (this.phase !== 'spin') return
    this.taps++
    this.idle = 0
    this.machine.kick()
    // 動きを減らす設定では回さないので、タップぶんだけ進める
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
    const pops = this.$('.fxg-pops')
    const r = this.root.getBoundingClientRect()
    const s = r.width / (this.root.offsetWidth || r.width || 1) || 1
    const ripple = el('div', 'fxg-ripple')
    ripple.style.left = `${(e.clientX - r.left) / s}px`
    ripple.style.top = `${(e.clientY - r.top) / s}px`
    const c = localCenter(this.root, this.machine.el)
    const word = el('div', 'fxg-pop', POP_WORDS[this.taps % POP_WORDS.length])
    const side = this.taps % 2 ? 1 : -1
    word.style.left = `${c.x + side * (70 + Math.random() * 60)}px`
    word.style.top = `${c.y - 120 + Math.random() * 90}px`
    word.style.setProperty('--r', `${side * (6 + Math.random() * 10)}deg`)
    pops.append(ripple, word)
    this.tl.at(900, () => {
      ripple.remove()
      word.remove()
    })
  }

  private readonly onFrame = (dt: number): void => {
    const m = this.machine
    // 熱: 回転の速さをゆっくりならした値。タップごとに明るさが跳ねないようにする
    const target = Math.min(1, m.rps / 2.2)
    this.heat += (target - this.heat) * Math.min(1, dt * 1.6)
    this.root.style.setProperty('--heat', this.heat.toFixed(3))
    // 音を回転に合わせる（変わったときだけ伝える）
    if (this.voice && Math.abs(m.rps - this.lastVoice) > 0.02) {
      this.lastVoice = m.rps
      this.voice.setSpeed(m.rps)
    }
    if (this.phase !== 'spin') return
    const ms = dt * 1000 * this.tl.speed
    this.elapsed += ms
    this.idle += ms
    // タップが途切れたら、ゆっくり自動で回す（放っておいても数秒で玉が出る）
    m.cruise = this.idle > IDLE_MS ? 0.55 : 0
    if (m.cruise > 0) this.startVoice()
    const need = Math.max(1, TURNS_NEEDED / this.tl.speed)
    const p = Math.min(1, Math.max(m.turns / need, this.elapsed / AUTO_MS))
    this.meter.style.setProperty('--p', p.toFixed(3))
    if (m.rps >= 2) this.setSub('すごい勢い！')
    else if (m.rps >= 1.2) this.setSub('いい回転！')
    else if (this.taps > 0 && m.rps >= 0.3) this.setSub('その調子！')
    else if (m.cruise > 0) this.setSub('タップすると、もっと速く回ります')
    if (p >= 1) this.release()
  }

  private startVoice(): void {
    if (this.voice || !this.sound) return
    this.voice = sfx.garaponStart()
    this.lastVoice = -1
  }

  private stopVoice(): void {
    this.voice?.stop()
    this.voice = null
  }

  // ---- 玉が出る ----

  private async drop(color: BallColor): Promise<HTMLElement> {
    this.phase = 'drop'
    this.root.dataset.phase = 'drop'
    this.setSub('')
    const m = this.machine
    // 排出口が真下を通るまでは回し続け、通った瞬間に玉を出す（動きを減らす設定では待たない）
    if (!this.reduced) {
      m.cruise = Math.max(0.6, Math.min(m.rps, 1.4))
      await new Promise<void>((resolve) => {
        this.wake = resolve
        m.onHoleBottom = () => this.release()
        if (this.gone()) this.release()
      })
      m.onHoleBottom = null
    }
    // 出たら、すっと減速して止まる
    m.cruise = 0
    m.friction = 3.2
    if (this.sound) sfx.garaponDrop()
    vibrate(20)
    this.setSub('コロン！')
    const ball = await m.dropBall(color, this.tl)
    this.stopVoice()
    return ball
  }

  // ---- 発表 ----

  private async reveal(b: GaraponBall, tray: HTMLElement, left: number): Promise<void> {
    const info = BALL_INFO[b.color]
    const win = b.color !== 'white'
    await this.tl.wait(500) // 受け皿で止まった玉を、ひと呼吸見せる
    if (this.gone()) return
    this.phase = 'reveal'
    this.root.dataset.phase = 'reveal'
    const more = left > 0 ? `まだ <b>あと ${left} 回</b> 回せます` : ''
    const msg = win ? more : more || 'ざんねん…<br>でも、最後まで遊んでくれてありがとう'
    const rv = this.$('.fxg-reveal')
    rv.innerHTML = `
      <div class="fxg-rv-ballwrap"><div class="fxg-rv-halo"></div>${ballHtml(b.color)}${win ? BELL_SVG : ''}</div>
      <div class="fxg-rv-name"><span>${info.shape}</span>${info.name}</div>
      <div class="fxg-rv-word" data-color="${b.color}">${info.word}</div>
      ${win ? `<div class="fxg-rv-prize">${noshiHtml(b.color, b.prize)}</div>` : ''}
      ${msg ? `<div class="fxg-rv-msg">${msg}</div>` : ''}`
    const big = rv.querySelector<HTMLElement>('.fxg-rv-ballwrap > .fxg-ball')!
    const halo = rv.querySelector<HTMLElement>('.fxg-rv-halo')!
    halo.style.setProperty('--halo', win ? `${info.color}55` : 'rgba(140, 170, 255, 0.2)')
    const on = (sel: string) => rv.querySelector(sel)?.classList.add('on')

    // 受け皿の小さな玉から、画面の真ん中の大きな玉へつなぐ
    if (!this.reduced) {
      const from = localCenter(this.root, tray)
      const to = localCenter(this.root, big)
      const scale = (tray.getBoundingClientRect().width || 22) / (big.getBoundingClientRect().width || 150)
      big.animate(
        [{ transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${scale.toFixed(3)})` }, { transform: 'none' }],
        { duration: this.tl.ms(700), easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
    }
    tray.style.visibility = 'hidden'
    await this.tl.wait(700)
    if (this.gone()) return
    halo.classList.add('on')
    on('.fxg-rv-name')
    const c = localCenter(this.root, big)

    if (win) {
      const color = b.color as Exclude<BallColor, 'white'>
      if (this.sound) sfx.garaponWin(color)
      vibrate(30)
      const bell = rv.querySelector<SVGElement>('.fxg-bell')
      if (bell && !this.reduced) {
        bell.style.animationDuration = `${clampMs(this.tl.ms(1500), 900, 2400)}ms`
        bell.classList.add('ring')
      } else bell?.classList.add('ring')
      await this.tl.wait(150)
      on('.fxg-rv-word')
      this.celebrate(color, c.x, c.y)
      if (color !== 'red') this.shake(rv)
      if (color === 'rainbow') this.glow()
      await this.tl.wait(650)
      on('.fxg-rv-prize')
      await this.tl.wait(500)
      on('.fxg-rv-msg')
    } else {
      // はずれは、やさしく。熱がすっと冷める
      if (this.sound) sfx.garaponMiss()
      this.root.dataset.mood = 'cool'
      await this.tl.wait(350)
      on('.fxg-rv-word')
      this.fx?.rise(14, ['#9fb4ff', '#c9d6ff', '#e8ecff'], c.x - 90, c.x + 90, c.y + 40)
      await this.tl.wait(700)
      on('.fxg-rv-msg')
    }
    await this.tl.wait(DWELL[b.color] - 1300)
    if (this.gone() || left === 0) return
    // 次の回へ。発表をそっと消して、抽選器に戻す
    rv.querySelectorAll('.on').forEach((n) => n.classList.remove('on'))
    await this.tl.wait(450)
    rv.replaceChildren()
  }

  private celebrate(color: Exclude<BallColor, 'white'>, x: number, y: number): void {
    const fx = this.fx
    if (!fx) return
    if (color === 'red') {
      fx.burst(x, y, { count: 40, colors: ['#ef4444', '#ff8a8a', '#ffffff', '#ffd1d1'], speed: 7, size: 9, life: 80 })
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
    this.$('.fxg-glow').animate([{ opacity: 0 }, { opacity: 1, offset: rise / (rise + fall) }, { opacity: 0 }], {
      duration: rise + fall,
      easing: 'ease-out',
    })
  }

  // ---- その人の結果と、締め ----

  private async result(): Promise<void> {
    const s = this.stats
    this.stopVoice()
    this.machine.cruise = 0
    this.phase = 'result'
    const rv = this.$('.fxg-reveal')
    rv.querySelectorAll('.on').forEach((n) => n.classList.remove('on'))
    await this.tl.wait(this.balls.length ? 400 : 0)
    if (this.gone()) return
    rv.replaceChildren()
    this.root.dataset.phase = 'result'
    this.root.dataset.mood = 'cool'

    // 当たった景品（ゲーム本編の景品と、ガラポンの景品）。同じ名前は 1 つにまとめる
    const prizes = new Map<string, BallColor>()
    if (s.won) prizes.set(s.won, 'red')
    for (const b of this.balls) if (b.color !== 'white' && b.prize) prizes.set(b.prize, b.color)
    const wins = this.balls.filter((b) => b.color !== 'white').length
    const rs = this.$('.fxg-result')
    rs.innerHTML = `
      <div class="fxg-rs-kicker fxg-in">RESULT</div>
      <div class="fxg-rs-title fxg-in">あなたの結果</div>
      <ul class="fxg-rs-list">
        <li class="fxg-in"><span>カードに出た番号</span><span><b data-n="${s.hits}">0</b><small>個</small></span></li>
        <li class="fxg-in"><span>いちばん多いリーチ</span><span><b data-n="${s.maxReach}">0</b><small>本</small></span></li>
        <li class="fxg-in"><span>あと 1 つで外れた回数</span><span><b data-n="${s.nearMiss}">0</b><small>回</small></span></li>
      </ul>
      ${this.balls.length ? `<div class="fxg-rs-row fxg-in"><span>ガラポン</span>${this.balls.map((b) => ballHtml(b.color)).join('')}</div>` : ''}
      <div class="fxg-rs-cheer fxg-in">${cheerText(s, wins)}</div>
      ${prizes.size ? `<div class="fxg-rs-prizes fxg-in">${[...prizes].slice(0, 3).map(([p, c]) => noshiHtml(c, p)).join('')}</div>` : ''}
      <div class="fxg-rs-fin fxg-in"><b>おつかれさまでした</b><small>ご参加ありがとうございました</small></div>`

    const items = [...rs.querySelectorAll<HTMLElement>('.fxg-in')]
    const fin = items.pop()!
    await this.tl.wait(500)
    for (const item of items) {
      if (this.gone()) return
      item.classList.add('on')
      const num = item.querySelector<HTMLElement>('b[data-n]')
      if (num) this.countUp(num, Number(num.dataset.n) || 0, 900)
      await this.tl.wait(260)
    }
    await this.tl.wait(1100)
    if (this.gone()) return
    fin.classList.add('on')
    if (this.sound) sfx.outro()
    const w = this.root.clientWidth || 390
    const h = this.root.clientHeight || 844
    this.fx?.rise(26, ['#ffd9a0', '#ffe9c7', '#c9d6ff', '#9fb4ff'], 30, w - 30, h - 40)
    await this.tl.wait(1800)
  }

  private countUp(node: HTMLElement, to: number, ms: number): void {
    if (this.reduced || to <= 0) {
      node.textContent = String(to)
      return
    }
    const dur = Math.max(1, this.tl.ms(ms))
    const t0 = performance.now()
    const step = (now: number) => {
      if (!node.isConnected) return
      const k = Math.min(1, (now - t0) / dur)
      node.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))))
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
}
