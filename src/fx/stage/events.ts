import './events.css'
import { bgm, sfx } from '../../audio'
import { GOLD, Particles, RAINBOW } from '../particles'
import { Timeline, el, prefersReducedMotion } from '../runtime'
import { STAGE_H, STAGE_W } from '../theme'

// 大画面の特別なイベント（1920×1080 の大画面全体に重ねる）。どれも演出が終わったら自分で片付けてから解決する。
//   playAllKakutei  全員確定（大画面の虹）。いちばんの見せ場（約 11 秒）
//   playFinalBall   「この 1 球で景品がなくなる！」の予告（約 3.7 秒）
// 重なり順はイベントの層が z-index 42（予告）と 46（全員確定）、粒子の canvas が 60。
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

  // 粒子の canvas（z-index 60）。動きを減らす設定のときは出さない。
  // behind なら、いちばん手前ではなく body の今の位置に重ねる（このあと add する文字やパネルは、粒子より手前になる）
  particles(behind = false): Particles | null {
    if (this.rm) return null
    if (!this.fx) {
      const c = el('canvas', behind ? 'fxe-canvas fxe-canvas-in' : 'fxe-canvas')
      c.width = STAGE_W
      c.height = STAGE_H
      this.timeVars(c)
      if (behind) this.body.append(c)
      else this.host.append(c)
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

// 見本のカード（見た目はスマホのカード phone/card.css に合わせる: 紺地、開いたマスは濃いピンクのスタンプ、FREE は金の星）。
// 開いている斜めの 3 マスに、虹玉で 1 マス（★ の右下）が虹の縁で開いてリーチになる
function miniCard(): string {
  const nums = [7, 19, 33, 52, 64, 12, 24, 41, 49, 70, 3, 28, 0, 55, 61, 14, 17, 38, 47, 72, 9, 22, 44, 58, 66]
  const open = new Set([0, 6, 3, 21])
  return nums.map((n, i) => `<i class="${i === 12 ? 'f' : i === 18 ? 'w' : open.has(i) ? 'o' : ''}">${i === 12 ? '★' : n}</i>`).join('')
}

// 全員確定（大画面の虹）: すべてを止める → 確定音 → 虹のヒビ → 「全員確定」 → 虹玉 → 全員のカードが 1 マス開く。
// newReach はこの 1 マスでリーチになった人数、newDouble はリーチの本数が増えた人数（結果として出す）
export async function playAllKakutei(host: HTMLElement, o: StageEventBase & { total: number; newReach: number; newDouble: number }): Promise<void> {
  const total = count(o.total)
  const newReach = count(o.newReach)
  const newDouble = count(o.newDouble)
  await run(host, 'kakutei', 46, o, async (s) => {
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
    // 粒子はここ（光とヒビより手前、文字・虹玉・パネルより後ろ）。火花や紙吹雪が文字にかぶらない
    const fx = s.particles(true)
    const logo = s.add(
      'fxe-k-logo',
      `<div class="fxe-k-title" data-text="全員確定"><b class="fxe-rbtext">全員確定</b><i>全員確定</i></div>
       <div class="fxe-k-sub"><span class="fxe-rbtext">✦</span>会場の <em>${fmt(total)} 人</em>、みんな当たり！<span class="fxe-rbtext">✦</span></div>`,
    )
    const ball = s.add(
      'fxe-k-ball',
      `<div class="fxe-k-ball-in"><div class="fxe-k-ball-color"></div><div class="fxe-k-ball-shade"></div>
       <div class="fxe-k-ball-face"><b class="fxe-rbtext">✦</b><small>虹玉</small></div></div>`,
    )
    const panel = s.add(
      'fxe-k-panel',
      `<div class="fxe-k-head">会場 ${fmt(total)} 人、全員のカードが <em class="fxe-rbtext">1 マス</em>あく！</div>
       <div class="fxe-k-row">
         <div class="fxe-k-card">${miniCard()}</div>
         <div class="fxe-k-stats">
           <div class="fxe-k-stat"><span class="fxe-k-sh">▲</span><span class="fxe-k-lb">リーチになった人</span><span class="fxe-k-num"><b>0</b><small>人</small></span></div>
           <div class="fxe-k-stat"><span class="fxe-k-sh">◆</span><span class="fxe-k-lb">リーチが増えた人</span><span class="fxe-k-num"><b>0</b><small>人</small></span></div>
         </div>
       </div>`,
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

    // 4. 見出しは HUD のすぐ下へ縮めて、虹玉が上から落ちてきて弾ける
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

    // 5. 「会場 ○ 人、全員のカードが 1 マスあく！」→ 結果の数字をカウントアップ（パネルは HUD と番号の盤の間に収める）
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

// ---- 「この 1 球で景品がなくなる！」 -----------------------------------------------

// 「この 1 球で景品がなくなる！」の予告（抽選を始める前に出す）。
// 警報のような高まりを、赤の点滅ではなく金と白のゆっくりした脈動で作る
export async function playFinalBall(host: HTMLElement, o: StageEventBase & { prizesLeft: number }): Promise<void> {
  const left = count(o.prizesLeft)
  await run(host, 'final', 42, o, async (s) => {
    const fx = s.particles()
    // 流れる文字と光の振れは、速度を上げても速くなりすぎないようにする
    s.root.style.setProperty('--marq', `${Math.max(6000, s.tl.ms(12000))}ms`)
    s.root.style.setProperty('--sweep', `${Math.max(1000, s.tl.ms(1600))}ms`)
    const text = `★ この 1 球で景品がなくなる ★ 景品 残り ${fmt(left)} 個 `.repeat(4)
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
      `<div class="fxe-f-pre">この 1 球で</div>
       <div class="fxe-f-main" data-text="景品がなくなる！"><b>景品がなくなる！</b></div>
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
