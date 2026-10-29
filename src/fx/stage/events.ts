import './events.css'
import { bgm, sfx } from '../../audio'
import { GOLD, Particles, RAINBOW } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion, replay } from '../runtime'
import { STAGE_H, STAGE_W } from '../theme'

// 大画面の特別なイベント（1920×1080 の大画面全体に重ねる）。どれも演出が終わったら自分で片付けてから解決する。
//   playAllKakutei  全員確定（大画面の虹）。いちばんの見せ場（約 11 秒）
//   playMole        モグラ（BAD だが笑える雰囲気で。約 7 秒）
//   playFinalBall   「この1球で景品が尽きる！」の予告（約 3.7 秒）
//   playLastOne     ラストワン争奪（人数と当たりの数で 6〜12 秒）
// 重なり順はイベントの層が z-index 40〜46、粒子の canvas が 60。
// 時間はすべて Timeline で進める（speed で縮む）。host が画面から外されたら、その場で片付けて解決する。
// 山場では BGM を下げ（bgm.duck）、終わったら戻す。

export interface StageEventBase {
  speed?: number
}

// ---- 共通の部品 ------------------------------------------------------------------

// 取り消されたときに、演出の途中から抜けるための印
const CANCELLED = Symbol('cancelled')

const fmt = (n: number): string => n.toLocaleString('ja-JP')
const count = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0)

// 付けたクラスの transition が必ず効くように、いったん配置を確定させてから付ける
function on(node: Element, cls = 'on'): void {
  void node.getBoundingClientRect()
  node.classList.add(cls)
}

function place(node: HTMLElement, x: number, y: number): void {
  node.style.left = `${x}px`
  node.style.top = `${y}px`
}

// 1 つの演出の舞台。層・時間・粒子・揺れ・全面の光をまとめて持ち、最後に全部片付ける
class Scene {
  readonly tl: Timeline
  readonly root: HTMLElement
  readonly dim: HTMLElement
  readonly body: HTMLElement // 揺らす層（暗転は揺らさない）
  readonly rm = prefersReducedMotion()
  private now = 0 // 演出上の現在時刻（ms）
  private fx: Particles | null = null
  private canvas: HTMLCanvasElement | null = null
  private glowed = false
  private lastTick = 0
  private readonly attached: boolean

  constructor(
    readonly host: HTMLElement,
    name: string,
    z: number,
    speed: number,
  ) {
    this.tl = new Timeline(Number.isFinite(speed) && speed > 0 ? speed : 1)
    this.attached = host.isConnected
    this.root = el('div', `fxe fxe-${name}${this.rm ? ' fxe-rm' : ''}`)
    this.root.style.zIndex = String(z)
    this.timeVars(this.root)
    this.dim = el('div', 'fxe-dim')
    this.body = el('div', 'fxe-body')
    this.root.append(this.dim, this.body)
    host.append(this.root)
  }

  // CSS の時間の単位。繰り返す光と色の回転は、速度を上げても 1 秒に 3 回を超えない周期にとどめる
  private timeVars(node: HTMLElement): void {
    const { tl } = this
    node.style.setProperty('--u', `${tl.ms(1000)}ms`)
    node.style.setProperty('--pulse', `${Math.max(700, tl.ms(1400))}ms`)
    node.style.setProperty('--hue', `${Math.max(1800, tl.ms(3600))}ms`)
  }

  // 演出の始まりから t ms の時刻まで待つ。取り消されたら（host が外されたときも）CANCELLED を投げて抜ける
  async until(t: number): Promise<void> {
    if (t > this.now) {
      await this.tl.wait(t - this.now)
      this.now = t
    }
    if (this.attached && !this.host.isConnected) this.tl.cancel()
    if (this.tl.cancelled) throw CANCELLED
  }

  wait(ms: number): Promise<void> {
    return this.until(this.now + ms)
  }

  // 演出の始まりから t ms の時刻に fn を呼ぶ（待たない）
  at(t: number, fn: () => void): void {
    this.tl.at(t - this.now, fn)
  }

  add(cls: string, html = '', parent: HTMLElement = this.body): HTMLElement {
    const node = el('div', cls, html)
    parent.append(node)
    return node
  }

  // 暗転（明るさを下げるだけなので、動きを減らす設定でもなめらかに変える）
  dimTo(opacity: number, ms: number): void {
    void this.dim.getBoundingClientRect()
    this.dim.style.transition = `opacity ${this.tl.ms(ms)}ms ease`
    this.dim.style.opacity = String(opacity)
  }

  // 粒子の canvas（z-index 60）。動きを減らす設定のときは出さない
  particles(): Particles | null {
    if (this.rm) return null
    if (!this.fx) {
      const c = el('canvas', 'fxe-canvas')
      c.width = STAGE_W
      c.height = STAGE_H
      this.timeVars(c)
      this.host.append(c)
      this.canvas = c
      this.fx = new Particles(c)
      this.fx.speed = this.tl.speed
    }
    return this.fx
  }

  // requestAnimationFrame で k = 0→1 を回す（長さは演出上の ms）。待たずに流す
  tween(ms: number, fn: (k: number) => void): void {
    const dur = this.tl.ms(ms)
    if (this.rm || dur <= 0) return fn(1)
    const t0 = performance.now()
    const frame = (now: number): void => {
      if (this.tl.cancelled) return
      const k = Math.min(1, (now - t0) / dur)
      fn(k)
      if (k < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  // 数字を 0 から数え上げる。tick なら、数字が変わるたびに軽い音を鳴らす（間引いて）
  countUp(node: HTMLElement, to: number, ms: number, tick = false): void {
    let shown = -1
    this.tween(ms, (k) => {
      const v = Math.round(to * (1 - Math.pow(1 - k, 3)))
      if (v === shown) return
      shown = v
      node.textContent = fmt(v)
      const now = performance.now()
      if (tick && k < 1 && now - this.lastTick > 70) {
        this.lastTick = now
        sfx.tick()
      }
    })
    // 描画が止まっていても（タブが裏にあるときなど）、最後は必ず正しい数字にする
    this.tl.at(ms, () => (node.textContent = fmt(to)))
  }

  // 揺れ（金と虹のときだけ使う。8px 以内、300ms 以内）
  shake(px: number, ms: number): void {
    if (this.rm) return
    const a = Math.min(8, px)
    const frames = [0, a, -a * 0.8, a * 0.55, -a * 0.3, 0].map((x, i) => ({
      transform: `translate(${x}px, ${(i % 2 ? -0.4 : 0.3) * x}px)`,
    }))
    this.body.animate(frames, { duration: Math.min(300, this.tl.ms(ms)), easing: 'linear' })
  }

  // 全面の光。1 回の演出につき 1 回まで、明るさの変化は 16%、立ち上がりは 150ms 以上
  glow(): void {
    if (this.rm || this.glowed) return
    this.glowed = true
    const g = this.add('fxe-glow', '', this.root)
    const duration = Math.max(600, this.tl.ms(900))
    g.animate([{ opacity: 0 }, { opacity: 0.16, offset: 0.25 }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' })
  }

  // 全体をふわっと消す（片付けは dispose）
  out(): void {
    this.root.classList.add('fxe-out')
    this.canvas?.classList.add('fxe-out')
  }

  dispose(): void {
    this.tl.cancel()
    this.fx?.clear()
    this.canvas?.remove()
    this.root.remove()
  }
}

// 演出を 1 つ流す。最後まで流れても途中で取り消されても、必ず片付けて BGM を戻してから解決する
async function run(host: HTMLElement, name: string, z: number, o: StageEventBase, body: (s: Scene) => Promise<void>): Promise<void> {
  const s = new Scene(host, name, z, o.speed ?? 1)
  bgm.duck(true)
  try {
    await body(s)
  } catch (err) {
    if (err !== CANCELLED) throw err
  } finally {
    s.dispose()
    bgm.duck(false)
  }
}

// ---- 全員確定（大画面の虹） ------------------------------------------------------

let crackId = 0

// 中央から放射状に伸びる、ギザギザの虹のヒビ（主のヒビ 13 本と枝）。still なら最初から描き終えた形で出す
function crackSvg(cx: number, cy: number, still: boolean): string {
  const id = `fxe-crack-${++crackId}`
  const paths: string[] = []
  const line = (pts: [number, number][], width: number, delay: number): void => {
    let len = 0
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    const d = 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')
    const dash = still ? '' : ` stroke-dasharray="${Math.ceil(len)}" stroke-dashoffset="${Math.ceil(len)}"`
    paths.push(`<path d="${d}" stroke="url(#${id})" stroke-width="${width}"${dash} style="--dk:${delay.toFixed(2)}"/>`)
  }
  const N = 13
  for (let i = 0; i < N; i++) {
    const base = (i / N) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
    const segs = 6 + Math.floor(Math.random() * 3)
    const reach = 420 + Math.random() * 520
    const pts: [number, number][] = [[cx, cy]]
    let x = cx
    let y = cy
    for (let k = 0; k < segs; k++) {
      const a = base + (Math.random() - 0.5) * 0.7
      const step = (reach / segs) * (0.6 + Math.random() * 0.8)
      x += Math.cos(a) * step
      y += Math.sin(a) * step
      pts.push([x, y])
    }
    const delay = Math.random() * 0.18
    line(pts, 7, delay)
    // 途中から枝分かれする細いヒビ（本線がそこまで伸びたころに伸び始める）
    const j = 2 + Math.floor(Math.random() * (segs - 2))
    const side = Math.random() < 0.5 ? -1 : 1
    const branch: [number, number][] = [pts[j]]
    let [bx, by] = pts[j]
    for (let k = 0; k < 3; k++) {
      const a = base + side * (0.5 + Math.random() * 0.5)
      const step = 40 + Math.random() * 70
      bx += Math.cos(a) * step
      by += Math.sin(a) * step
      branch.push([bx, by])
    }
    line(branch, 4, delay + 0.7 * (j / segs))
  }
  const stops = RAINBOW.map((c, i) => `<stop offset="${(i / (RAINBOW.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')
  return (
    `<svg class="fxe-k-crack" viewBox="0 0 ${STAGE_W} ${STAGE_H}" aria-hidden="true">` +
    `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="700">${stops}</radialGradient></defs>` +
    `${paths.join('')}</svg>`
  )
}

// ヒビが割れて飛び散る破片
function makeShards(s: Scene, cx: number, cy: number): HTMLElement[] {
  const list: HTMLElement[] = []
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4
    const r = 60 + Math.random() * 140
    const w = 40 + Math.random() * 70
    const shard = s.add('fxe-k-shard')
    shard.style.cssText =
      `left:${cx + Math.cos(a) * r}px; top:${cy + Math.sin(a) * r}px; --w:${w}px; --h:${w * (0.8 + Math.random() * 0.6)}px;` +
      `--dx:${Math.cos(a) * (300 + Math.random() * 400)}px; --dy:${Math.sin(a) * 300 + 250 + Math.random() * 300}px;` +
      `--rot:${(Math.random() - 0.5) * 540}deg`
    list.push(shard)
  }
  return list
}

// 見本のカード。開いている斜めの 3 マスに、虹玉で 1 マス（★ の右下）が開いてリーチになる
function miniCard(): string {
  const nums = [7, 19, 33, 52, 64, 12, 24, 41, 49, 70, 3, 28, 0, 55, 61, 14, 17, 38, 47, 72, 9, 22, 44, 58, 66]
  const open = new Set([0, 6, 12, 3, 21])
  return nums.map((n, i) => `<i class="${i === 18 ? 'w' : open.has(i) ? 'o' : ''}">${i === 12 ? '★' : n}</i>`).join('')
}

// 全員確定（大画面の虹）: すべてを止める → 確定音 → 虹のヒビ → 「全員確定」 → 虹玉 → 全員のカードが 1 マス開く。
// newReach / newDouble は、この 1 マスで新しくリーチ・ダブルリーチになった人数（結果として出す）
export async function playAllKakutei(host: HTMLElement, o: StageEventBase & { total: number; newReach: number; newDouble: number }): Promise<void> {
  const total = count(o.total)
  const newReach = count(o.newReach)
  const newDouble = count(o.newDouble)
  await run(host, 'kakutei', 46, o, async (s) => {
    const fx = s.particles()
    const cx = 960
    const cy = 450 // ヒビの起点

    // 重なり順のとおりに、先に全部作っておく（後ろ → 前）
    const aura = s.add('fxe-k-aura')
    const rays = s.add('fxe-k-rays')
    s.body.insertAdjacentHTML('beforeend', crackSvg(cx, cy, s.rm))
    const crack = s.body.lastElementChild as SVGSVGElement
    const ring = s.add('fxe-k-ring')
    place(ring, cx, cy)
    const shards = makeShards(s, cx, cy)
    const star = s.add('fxe-k-star')
    place(star, cx, cy)
    const logo = s.add(
      'fxe-k-logo',
      `<div class="fxe-k-title" data-text="全員確定"><b class="fxe-rbtext">全員確定</b><i>全員確定</i></div>
       <div class="fxe-k-sub"><span class="fxe-rbtext">✦</span>会場の全員に当たり！<span class="fxe-rbtext">✦</span><em>${fmt(total)} 人</em></div>`,
    )
    const ball = s.add(
      'fxe-k-ball',
      `<div class="fxe-k-ball-in"><div class="fxe-k-ball-color"></div><div class="fxe-k-ball-shade"></div>
       <div class="fxe-k-ball-face"><b class="fxe-rbtext">✦</b><small>虹玉</small></div></div>`,
    )
    const panel = s.add(
      'fxe-k-panel',
      `<div class="fxe-k-head">全員のカードが <em class="fxe-rbtext">1 マス</em> 開く！</div>
       <div class="fxe-k-row">
         <div class="fxe-k-card">${miniCard()}</div>
         <div class="fxe-k-stats">
           <div class="fxe-k-stat"><span class="fxe-k-sh">▲</span><span class="fxe-k-lb">新しくリーチ</span><span class="fxe-k-num">+<b>0</b><small>人</small></span></div>
           <div class="fxe-k-stat"><span class="fxe-k-sh">◆</span><span class="fxe-k-lb">ダブルリーチ</span><span class="fxe-k-num">+<b>0</b><small>人</small></span></div>
         </div>
       </div>
       <div class="fxe-k-foot">会場 ${fmt(total)} 人のカードが、いっせいに 1 マス開きました</div>`,
    )
    const stats = [...panel.querySelectorAll<HTMLElement>('.fxe-k-stat')]

    // 1. すべてを止める（暗転と静寂）
    sfx.silence()
    sfx.ma()
    s.dimTo(0.25, 450)
    await s.until(1000)

    // 2. 確定音と同時に、中央から虹のヒビが広がる（明るさは一定で、色だけが回る）
    sfx.kakutei()
    sfx.crack()
    on(crack)
    on(ring)
    on(star)
    fx?.burst(cx, cy, { count: 90, colors: RAINBOW, speed: 9, shape: 'spark', gravity: 0, life: 50 })
    await s.until(1500)
    on(aura)
    on(rays)

    // ヒビが割れて破片が飛ぶ
    await s.until(2050)
    for (const shard of shards) on(shard)
    crack.classList.add('fade')

    // 3. 「全員確定」と「会場の全員に当たり！」
    await s.until(2150)
    on(logo.querySelector('.fxe-k-title')!)
    s.at(2400, () => {
      s.shake(4, 220)
      fx?.burst(960, 390, { count: 160, colors: RAINBOW, speed: 13, shape: 'spark', gravity: 0.12, life: 60 })
    })
    await s.until(2750)
    on(logo.querySelector('.fxe-k-sub')!)

    // 4. 虹玉が上から落ちてきて弾ける
    await s.until(4300)
    logo.classList.add('up')
    aura.classList.add('low')
    rays.classList.add('low')
    crack.classList.add('gone')
    await s.until(4500)
    sfx.wildBall()
    on(ball)
    const from = -760 // 画面の上の外（着地点からの距離）
    s.tween(750, (k) => {
      const y = from * (1 - k * k)
      ball.style.transform = k < 1 ? `translateY(${y.toFixed(1)}px)` : ''
      if (k < 1) fx?.burst(960, 560 + y, { count: 3, colors: RAINBOW, speed: 2, shape: 'dot', gravity: -0.02, life: 40, size: 7 })
    })
    await s.until(5250)
    ball.style.transform = ''
    on(ball, 'land')
    s.shake(7, 260)
    fx?.burst(960, 670, { count: 60, colors: RAINBOW, speed: 7, shape: 'dot', gravity: 0.3, life: 40 })
    await s.until(5550)
    on(ball, 'charge')
    await s.until(5800)
    sfx.rainbowChord()
    ball.classList.add('pop')
    s.glow()
    const wave = s.add('fxe-k-ring')
    place(wave, 960, 560)
    on(wave)
    fx?.burst(960, 560, { count: 320, colors: RAINBOW, speed: 16, shape: 'spark', gravity: 0.1, life: 75 })
    fx?.burst(960, 560, { count: 160, colors: RAINBOW, speed: 10, shape: 'dot', gravity: 0.08, life: 90, size: 9 })

    // 5. 「全員のカードが 1 マス開く！」→ 結果の数字をカウントアップ
    await s.until(6250)
    on(panel)
    await s.until(6750)
    on(panel.querySelector('.fxe-k-card')!, 'go')
    await s.until(7050)
    on(stats[0])
    s.countUp(stats[0].querySelector('b')!, newReach, 1300, true)
    s.at(8350, () => stats[0].classList.add('done'))
    await s.until(7350)
    on(stats[1])
    s.countUp(stats[1].querySelector('b')!, newDouble, 1300, true)
    s.at(8650, () => stats[1].classList.add('done'))

    // 6. 虹の紙吹雪で締めて消える
    await s.until(8500)
    fx?.rain(520, RAINBOW)
    fx?.burst(140, 1000, { count: 140, colors: RAINBOW, speed: 18, shape: 'rect', gravity: 0.32, life: 110, size: 12 })
    fx?.burst(1780, 1000, { count: 140, colors: RAINBOW, speed: 18, shape: 'rect', gravity: 0.32, life: 110, size: 12 })
    await s.until(10500)
    s.out()
    await s.until(11100)
  })
}

// ---- モグラ（BAD） ---------------------------------------------------------------

// モグラの絵（ヘルメット、ピンクの鼻、つめ）。表情は data-face で切り替える（n ふつう / dig 掘る / smug してやったり）
const MOLE_SVG = `<svg class="fxe-m-svg" viewBox="0 0 220 250" aria-hidden="true">
  <path d="M28 252 C24 150 52 78 110 78 C168 78 196 150 192 252 Z" fill="#7b5340"/>
  <path d="M62 252 C60 186 80 150 110 150 C140 150 160 186 158 252 Z" fill="#a8775c"/>
  <ellipse cx="70" cy="150" rx="13" ry="8" fill="#ff9bb3" opacity=".6"/>
  <ellipse cx="150" cy="150" rx="13" ry="8" fill="#ff9bb3" opacity=".6"/>
  <g class="fxe-m-eye-n" fill="#1d1020">
    <ellipse cx="84" cy="128" rx="7.5" ry="9.5"/><ellipse cx="136" cy="128" rx="7.5" ry="9.5"/>
    <circle cx="86.5" cy="124.5" r="2.8" fill="#fff"/><circle cx="138.5" cy="124.5" r="2.8" fill="#fff"/>
  </g>
  <g class="fxe-m-eye-d" fill="none" stroke="#1d1020" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M77 120 L90 128 L77 136"/><path d="M143 120 L130 128 L143 136"/>
  </g>
  <g class="fxe-m-eye-s" fill="none" stroke="#1d1020" stroke-width="5" stroke-linecap="round">
    <path d="M76 131 Q84 119 92 131"/><path d="M128 131 Q136 119 144 131"/>
  </g>
  <ellipse cx="110" cy="158" rx="30" ry="21" fill="#f0cfae"/>
  <ellipse cx="110" cy="146" rx="15" ry="11" fill="#ff7fa6"/>
  <ellipse cx="105" cy="142" rx="5" ry="3" fill="#ffd3e1"/>
  <path d="M98 162 q6 7 12 0 q6 7 12 0" fill="none" stroke="#5a2e1c" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  <g stroke="#f6e6d4" stroke-width="2.5" stroke-linecap="round" opacity=".9">
    <path d="M80 156 L52 150"/><path d="M80 163 L52 167"/><path d="M140 156 L168 150"/><path d="M140 163 L168 167"/>
  </g>
  <path d="M44 104 C44 50 176 50 176 104 Z" fill="#ffcd3c"/>
  <path d="M62 92 C66 68 86 58 102 57" fill="none" stroke="#fff3b0" stroke-width="7" stroke-linecap="round" opacity=".8"/>
  <rect x="103" y="53" width="14" height="48" rx="5" fill="#f2b000"/>
  <rect x="34" y="98" width="152" height="14" rx="7" fill="#f2b000"/>
  <circle cx="110" cy="80" r="13" fill="#fff8d6" stroke="#d99a00" stroke-width="4"/>
  <g class="fxe-m-paw fxe-m-paw-l">
    <ellipse cx="58" cy="202" rx="27" ry="18" fill="#f3b9a2"/>
    <path d="M37 192 L30 175 L44 186 Z M50 186 L48 168 L58 183 Z M64 185 L67 168 L72 185 Z" fill="#fffaf0" stroke="#d7b8a0" stroke-width="1.5" stroke-linejoin="round"/>
  </g>
  <g class="fxe-m-paw fxe-m-paw-r">
    <ellipse cx="162" cy="202" rx="27" ry="18" fill="#f3b9a2"/>
    <path d="M183 192 L190 175 L176 186 Z M170 186 L172 168 L162 183 Z M156 185 L153 168 L148 185 Z" fill="#fffaf0" stroke="#d7b8a0" stroke-width="1.5" stroke-linejoin="round"/>
  </g>
</svg>`

const SOIL = ['#7a4a2e', '#a8714a', '#5a3a22', '#c9a27e'] as const

// 穴の位置（x, 土の下端からの高さ, 大きさ）。奥の穴ほど小さく、高い位置にある
const HOLES: readonly (readonly [number, number, number])[] = [
  [270, 118, 0.84],
  [625, 64, 0.98],
  [960, 30, 1.08],
  [1295, 64, 0.98],
  [1650, 118, 0.84],
]

interface Mole {
  x: number
  y: number // 穴の中心（画面の座標）
  mole: HTMLElement
  bubble: HTMLElement
}

function say(m: Mole, text: string): void {
  m.bubble.textContent = text
  replay(m.bubble, 'on')
}

function dust(s: Scene, x: number, y: number): void {
  if (s.rm) return
  for (let i = 0; i < 3; i++) {
    const d = s.add('fxe-m-dust')
    d.style.cssText = `left:${x + (i - 1) * 50}px; top:${y - 10}px; --dx:${(i - 1) * 60}px; animation-delay:${s.tl.ms(i * 60)}ms`
  }
}

function poko(s: Scene, x: number, y: number, r: number): void {
  const p = s.add('fxe-m-poko fxe-ol', '<b>ぽこっ</b>')
  p.dataset.text = 'ぽこっ'
  p.style.cssText = `left:${x}px; top:${y}px; --r:${r}deg`
  on(p)
}

// モグラ（BAD）: モグラが出る → 掘る → 一部の人の穴を埋める → 帰る。
// hit は穴を埋められた人数、lostReach はそれでリーチが消えた人数
export async function playMole(host: HTMLElement, o: StageEventBase & { total: number; hit: number; lostReach: number }): Promise<void> {
  const total = count(o.total)
  const hit = count(o.hit)
  const lostReach = count(o.lostReach)
  await run(host, 'mole', 40, o, async (s) => {
    const fx = s.particles()
    const head = hit > 0 ? 'モグラが穴を埋めた！' : 'モグラは空振り！'
    const rows =
      hit > 0
        ? `<div class="fxe-m-row"><span>● 埋められた</span><b>0</b><small>人</small></div>` +
          (lostReach > 0
            ? `<div class="fxe-m-row"><span>▲ リーチが消えた</span><b>0</b><small>人</small></div>`
            : `<div class="fxe-m-row safe"><span>▲ リーチは</span><b>全員無事</b></div>`)
        : `<div class="fxe-m-row safe"><span>● 埋められた人は</span><b>いません</b></div>`

    const title = s.add(
      'fxe-m-title',
      `<span class="fxe-ol" data-text="モグラ出現！？"><b>モグラ出現！？</b></span><small>${fmt(total)} 人のカードの穴が ねらわれている…</small>`,
    )
    const sign = s.add(
      'fxe-m-sign',
      `<i class="fxe-m-rope l"></i><i class="fxe-m-rope r"></i>
       <div class="fxe-m-board">
         <div class="fxe-m-head fxe-ol" data-text="${head}"><b>${head}</b></div>
         <div class="fxe-m-rows">${rows}</div>
         <div class="fxe-m-stamp"><b>BAD</b><small>✖ 穴うめ</small></div>
       </div>`,
    )
    const soil = s.add('fxe-m-soil')
    const moles: Mole[] = HOLES.map(([x, b, sc]) => {
      const hole = s.add(
        'fxe-m-hole',
        `<div class="fxe-m-mound"></div><div class="fxe-m-pit"></div>
         <div class="fxe-m-clip"><div class="fxe-m-mole" data-face="n">${MOLE_SVG}</div></div>
         <div class="fxe-m-lip"></div><div class="fxe-m-bubble"></div>`,
        soil,
      )
      hole.style.cssText = `left:${x + 20}px; bottom:${b}px; --s:${sc}`
      return {
        x,
        y: 1090 - b - 70 * sc,
        mole: hole.querySelector<HTMLElement>('.fxe-m-mole')!,
        bubble: hole.querySelector<HTMLElement>('.fxe-m-bubble')!,
      }
    })

    // 土がせり上がり、モグラが次々に顔を出す
    s.dimTo(0.3, 400)
    on(soil)
    await s.until(250)
    on(title)
    for (const [i, k] of [2, 1, 3, 0, 4].entries()) {
      await s.until(650 + i * 150)
      const m = moles[k]
      on(m.mole, 'up')
      sfx.moleAppear()
      fx?.burst(m.x, m.y, { count: 14, colors: SOIL, speed: 6, gravity: 0.45, life: 40, shape: 'rect', size: 8 })
    }

    // 掘る（土ぼこりが立つ）
    await s.until(1750)
    for (const m of moles) {
      m.mole.dataset.face = 'dig'
      on(m.mole, 'dig')
    }
    say(moles[1], 'ほりほり♪')
    say(moles[3], 'ざっくざく')
    for (let k = 0; k < 4; k++) {
      s.at(1750 + k * 300, () => {
        if (k % 2 === 0) sfx.moleDig()
        moles.forEach((m, i) => {
          if ((i + k) % 2) return
          dust(s, m.x, m.y)
          fx?.burst(m.x, m.y - 10, { count: 18, colors: SOIL, speed: 8, gravity: 0.5, life: 45, shape: 'rect', size: 9 })
        })
      })
    }

    // 「モグラが穴を埋めた！」と、埋められた人数・リーチが消えた人数
    await s.until(3100)
    sfx.moleFill()
    title.classList.add('off')
    for (const m of moles) {
      m.bubble.classList.remove('on')
      m.mole.classList.remove('dig')
      m.mole.dataset.face = 'smug'
      on(m.mole, 'smug')
    }
    say(moles[2], hit > 0 ? 'うめちゃった♪' : 'あれれ？')
    if (hit > 0) {
      poko(s, moles[1].x - 80, moles[1].y - 330, -12)
      poko(s, moles[3].x - 80, moles[3].y - 330, 10)
    }
    on(sign)
    await s.until(3550)
    if (hit > 0) on(sign.querySelector('.fxe-m-stamp')!)
    const values = [hit, lostReach]
    for (const [i, row] of [...sign.querySelectorAll<HTMLElement>('.fxe-m-row')].entries()) {
      s.at(3550 + i * 300, () => {
        on(row)
        if (!row.classList.contains('safe')) s.countUp(row.querySelector('b')!, values[i], 700)
      })
    }
    // してやったりのジャンプのあとは、また体をゆらす
    s.at(4200, () => moles.forEach((m) => m.mole.classList.remove('smug')))

    // モグラが引っ込んで、土ごと消える
    await s.until(5500)
    for (const m of moles) m.bubble.classList.remove('on')
    say(moles[1], 'またね〜')
    say(moles[3], 'ばいば〜い')
    for (const [i, k] of [0, 4, 1, 3, 2].entries()) s.at(5650 + i * 90, () => moles[k].mole.classList.add('down'))
    await s.until(5900)
    sign.classList.add('off')
    await s.until(6150)
    for (const m of moles) m.bubble.classList.remove('on')
    soil.classList.add('off')
    s.dimTo(0, 500)
    await s.until(6650)
    s.out()
    await s.until(7150)
  })
}

// ---- 「この1球で景品が尽きる！」 -------------------------------------------------

// 「この1球で景品が尽きる！」の予告（抽選を始める前に出す）。
// 警報のような高まりを、赤の点滅ではなく金と白のゆっくりした脈動で作る
export async function playFinalBall(host: HTMLElement, o: StageEventBase & { prizesLeft: number }): Promise<void> {
  const left = count(o.prizesLeft)
  await run(host, 'final', 42, o, async (s) => {
    const fx = s.particles()
    // 流れる文字と光の振れは、速度を上げても速くなりすぎないようにする
    s.root.style.setProperty('--marq', `${Math.max(6000, s.tl.ms(12000))}ms`)
    s.root.style.setProperty('--sweep', `${Math.max(1000, s.tl.ms(1600))}ms`)
    const text = '★ FINAL BALL ★ この1球で景品が尽きる '.repeat(4)
    const band = (pos: string): HTMLElement =>
      s.add(`fxe-f-band ${pos}`, `<div class="fxe-f-track"><span>${text}</span><span>${text}</span></div>`)
    // 残りが 10 個までなら、景品の箱も並べる
    const gifts =
      left > 0 && left <= 10
        ? `<span class="fxe-f-gifts">${Array.from({ length: left }, (_, i) => `<i class="fxe-f-gift" style="--k:${i}"></i>`).join('')}</span>`
        : ''

    const halo = s.add('fxe-f-halo')
    const beams = [s.add('fxe-f-beam l'), s.add('fxe-f-beam r')]
    const bands = [band('top'), band('bottom')]
    const center = s.add(
      'fxe-f-center',
      `<div class="fxe-f-pre">この1球で</div>
       <div class="fxe-f-main" data-text="景品が尽きる！"><b>景品が尽きる！</b></div>
       <div><div class="fxe-f-left">残り <b>${fmt(left)}</b> 個${gifts}</div></div>`,
    )
    const main = center.querySelector<HTMLElement>('.fxe-f-main')!

    sfx.finalBall()
    s.dimTo(0.45, 400)
    for (const b of bands) on(b)
    await s.until(200)
    on(halo)
    for (const b of beams) on(b)
    await s.until(450)
    on(center.querySelector('.fxe-f-pre')!)
    await s.until(850)
    on(main)
    // 文字が着地した瞬間（金なので揺れてよい）
    s.at(1100, () => {
      s.shake(5, 240)
      fx?.burst(960, 470, { count: 140, colors: GOLD, speed: 14, shape: 'spark', gravity: 0.15, life: 55 })
    })
    await s.until(1300)
    main.classList.add('pulse')
    on(center.querySelector('.fxe-f-left')!)
    // 金の粒が下から立ちのぼり続けて、緊張を高める
    for (let t = 1300; t < 3100; t += 450) s.at(t, () => fx?.rise(36, GOLD, 120, 1800, 1000))
    await s.until(3250)
    s.out()
    await s.until(3750)
  })
}

// ---- ラストワン争奪 ---------------------------------------------------------------

interface Entrant {
  name: string
  isMe: boolean
  win: boolean
}

// 並べるのは max 人まで。当たる人と自分は必ず入れて、元の順番のまま並べる
function pickShown(all: readonly Entrant[], max: number): Entrant[] {
  const keep = new Set<number>()
  for (const [i, e] of all.entries()) if (e.win && keep.size < max) keep.add(i)
  for (const [i, e] of all.entries()) if (e.isMe && keep.size < max) keep.add(i)
  for (let i = 0; i < all.length && keep.size < max; i++) keep.add(i)
  return [...keep].sort((a, b) => a - b).map((i) => all[i])
}

function winnerText(ws: readonly Entrant[]): string {
  if (!ws.length) return 'ラストワン賞は該当なし'
  const me = ws.some((e) => e.isMe)
  if (ws.length === 1) return me ? 'あなたが獲得！' : `${escapeHtml(ws[0].name)} さんが獲得！`
  if (ws.length <= 3) return ws.map((e) => (e.isMe ? 'あなた' : `${escapeHtml(e.name)} さん`)).join('・') + ' が獲得！'
  return me ? `あなたと ほか ${ws.length - 1} 人が獲得！` : `${ws.length} 人が獲得！`
}

// 光を順に回して、target のカードで止める。最後の 3 コマはじらしながら遅くなる。
// どのカードも光るのは 1 秒に 3 回以下にする（1 周の実時間を 340ms 以上に保つ）
async function chase(s: Scene, cards: readonly HTMLElement[], from: number, target: number, laps: number, slowest: number): Promise<number> {
  const n = cards.length
  const steps = laps * n + ((((target - from) % n) + n) % n)
  const floor = Math.max(340 / n, 40) * s.tl.speed // 1 コマの最短（演出上の ms）
  let cur = from
  for (let k = 1; k <= steps; k++) {
    if (cur >= 0) cards[cur].classList.remove('lit')
    cur = (cur + 1) % n
    cards[cur].classList.add('lit')
    sfx.tick()
    const tail = steps - k
    const ms = 50 + (slowest - 50) * Math.pow(k / steps, 3) + Math.max(0, 3 - tail) * 140
    await s.wait(Math.max(ms, floor))
  }
  return cur
}

// ラストワン争奪（上のランクまで景品が尽きたときだけ。めったに起きない）。
// entrants の中から win の人だけが景品を得る。名前は 12 人まで並べ、超える分は「ほか○人」とする
export async function playLastOne(
  host: HTMLElement,
  o: StageEventBase & { prizes: number; entrants: { name: string; isMe: boolean; win: boolean }[] },
): Promise<void> {
  const all: readonly Entrant[] = o.entrants ?? []
  const shown = pickShown(all, 12)
  const rest = all.length - shown.length
  const n = shown.length
  await run(host, 'lastone', 44, o, async (s) => {
    const fx = s.particles()
    // 楕円に並べる（上から時計回り）。中央のタイトルとは重ならない大きさにしてある
    const pos = shown.map((_, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / n
      return [960 + 760 * Math.cos(a), 540 + 350 * Math.sin(a)] as const
    })
    const rays = s.add('fxe-l-rays')
    const center = s.add(
      'fxe-l-center',
      `<div class="fxe-l-kicker">上のランクまで 景品が尽きた！</div>
       <div class="fxe-l-title fxe-ol" data-text="ラストワン争奪！"><b>ラストワン争奪！</b></div>
       <div class="fxe-l-sub">残り <b>${fmt(count(o.prizes))}</b> 個を <b>${fmt(all.length)}</b> 人で</div>
       ${rest > 0 ? `<div class="fxe-l-more">ほか ${fmt(rest)} 人</div>` : ''}
       <div class="fxe-l-result"></div>`,
    )
    const cards = shown.map((e, i) => {
      const [x, y] = pos[i]
      const card = s.add(
        `fxe-l-card${e.isMe ? ' me' : ''}`,
        `<small>No.${String(i + 1).padStart(2, '0')}</small><b>${escapeHtml(e.name)}</b>${e.isMe ? '<i>あなた</i>' : ''}`,
      )
      card.style.cssText =
        `left:${x.toFixed(0)}px; top:${y.toFixed(0)}px; --fx:${(960 - x).toFixed(0)}px; --fy:${(540 - y).toFixed(0)}px;` +
        `--dk:${(i * 0.07).toFixed(2)}`
      return card
    })
    const result = center.querySelector<HTMLElement>('.fxe-l-result')!

    // 幕開け: タイトル → 名前のカードが中央から配られる
    s.dimTo(0.55, 400)
    on(rays)
    on(center.querySelector('.fxe-l-kicker')!)
    await s.until(200)
    on(center.querySelector('.fxe-l-title')!)
    fx?.burst(960, 470, { count: 120, colors: GOLD, speed: 11, shape: 'spark', gravity: 0.1, life: 55 })
    await s.until(450)
    on(center.querySelector('.fxe-l-sub')!)
    const more = center.querySelector('.fxe-l-more')
    if (more) on(more)
    await s.until(700)
    for (const c of cards) on(c)
    await s.until(1300 + n * 70)

    // ルーレット: 光が回って、当たりの人で止まる（3 人目まではひとりずつ。それより多い分はまとめて）
    const wins = shown.flatMap((e, i) => (e.win ? [i] : []))
    const lock = (i: number, sound: boolean): void => {
      cards[i].classList.remove('lit')
      on(cards[i], 'win')
      if (sound) sfx.lastOne(true)
      const [x, y] = pos[i]
      fx?.burst(x, y, { count: 200, colors: GOLD, speed: 13, shape: 'spark', gravity: 0.12, life: 65 })
      fx?.burst(x, y, { count: 60, colors: ['#ffffff', '#fff4cc'], speed: 8, shape: 'dot', gravity: 0.05, life: 50 })
    }
    let cur = -1
    for (const [k, w] of wins.slice(0, 3).entries()) {
      // 動きを減らす設定では光を回さず、少し間を置いて当たりだけを示す
      if (s.rm) await s.wait(1200)
      else cur = await chase(s, cards, cur, w, k === 0 ? Math.max(2, Math.ceil(16 / n)) : Math.max(1, Math.ceil(6 / n)), k === 0 ? 440 : 340)
      lock(w, true)
      s.shake(5, 240)
      await s.wait(k === 0 ? 900 : 700)
    }
    if (wins.length > 3) {
      sfx.lastOne(true)
      for (const i of wins.slice(3)) lock(i, false)
      await s.wait(700)
    }

    // 当たらなかった人は暗くして、結果を出す
    cards.forEach((c, i) => {
      if (!shown[i].win) c.classList.add('out')
    })
    result.innerHTML = winnerText(wins.map((i) => shown[i]))
    on(result)
    if (wins.length) fx?.rain(260, GOLD)
    else sfx.lastOne(false)
    await s.wait(2400)
    s.out()
    await s.wait(500)
  })
}
