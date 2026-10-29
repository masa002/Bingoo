import './prize.css'
import { sfx } from '../../audio'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion, replay } from '../runtime'
import { GOLD, PHONE_H, PHONE_W, RAINBOW, RARITY_NAME, type Glow, type Rarity } from '../theme'

// スマホの景品まわり（390×844 のスマホ画面全体に重ねる）。当たった瞬間はスマホで特別に見せる。
// どれも host 全体（inset 0、z-index 40〜44）に重ね、終わったら片付けて解決する。
// 時間は Timeline で進める（speed で縮む）。tl を渡すと、その速度に合わせ、cancel されたら途中でも片付けて解決する。
// host から外されたときも、途中で止めて解決する。
//
//   await playPackOpen(phone, { rarity: 'R', prize: 'グルメカタログ', glow: 'white', upgrade: false })
//   const pick = await askChoice(phone, { rarity: 'R', prize: 'グルメカタログ', challenge: { allowed: true, target: 'SR', chance: 0.3 } })
//   if (pick === 'challenge') await playChallengeStart(phone, { target: 'SR' }) // このあと 3×3 のカードを配る
//   await playChallengeResult(phone, { success: true, rarity: 'SR', prize: 'スマートウォッチ' })

export interface PackSpec {
  rarity: Rarity | null // null はダブルチャンス券
  prize: string
  glow: Glow // パックの光（先バレ。ガセあり）
  upgrade: boolean // UR の縁が金から虹に昇格する
  rankUp?: { from: Rarity; to: Rarity } // 在庫切れで 1 ランクアップした
}

// どの演出にも渡せる、省略可能な引数
export interface PrizeFxOptions {
  speed?: number
  tl?: Timeline // 外側の Timeline。速度はこちらに合わせ、cancel されたら途中でも片付けて解決する
}

// パックがどう開いたか（onOpen に渡す）
export type OpenBy = 'swipe' | 'tap' | 'auto'

type Edge = 'silver' | 'blue' | 'gold' | 'rainbow' | 'ticket'
type Look = Rarity | 'W' // W はダブルチャンス券

// 縁は正直に出す（UR も金。虹になるのは昇格のときだけ）
const EDGE: Readonly<Record<Rarity, Edge>> = { C: 'silver', R: 'blue', SR: 'gold', UR: 'gold' }
// 色だけに頼らず、形と文字も重ねる
const SHAPE: Readonly<Record<Rarity, string>> = { C: '●', R: '◆', SR: '★', UR: '✦' }
const SPARK: Readonly<Record<Rarity, readonly string[]>> = {
  C: ['#ffffff', '#e6e9f2', '#c0c6d6'],
  R: ['#ffffff', '#9cc3ff', '#3b82f6'],
  SR: GOLD,
  UR: RAINBOW,
}
const GLOW_SPARK: Readonly<Record<Glow, readonly string[]>> = { white: ['#ffffff', '#dfe7ff', '#bcd0ff'], gold: GOLD, rainbow: RAINBOW }
const TICKET = ['#7dd3fc', '#a7f3d0', '#fde68a', '#fbcfe8', '#ffffff'] as const
const GREY = ['#8a93b8', '#5d6684', '#c3c9dc'] as const
// 発表のあと、結果を見せておく長さ（タップで早めに閉じられる）
const HOLD: Readonly<Record<Look, number>> = { C: 1500, R: 1900, SR: 2400, UR: 3000, W: 1700 }

// 画面の中の位置（390×844）。パックとカードは (AX, AY) を中心に置く
const AX = PHONE_W / 2
const AY = 410
const CARD_Y = -46 // 発表のときのカードの位置（中心からのずれ）
const CARD_SCALE = 1.14
const CX = AX
const CY = AY + CARD_Y
const PACK_W = 236
const SLIT_Y = AY - 168 + 54 // 破る線の高さ
const TEAR_RANGE = 170 // この距離（px）をスワイプすると破り切る

const CANCELLED = Symbol('cancelled')

// 1 回の演出の舞台。host 全体に重ねる層・粒子・時間をまとめて持ち、終わったら片付ける。
// 中身は 390×844 の舞台（stage）で組み、host がそれより小さければ縮めて真ん中に置く（背景だけは host 全体）
class Scene {
  readonly root: HTMLDivElement
  readonly stage: HTMLDivElement
  readonly quake: HTMLDivElement // 揺らす層。中身はここに入れる
  readonly tl: Timeline
  readonly rm = prefersReducedMotion()
  private readonly fx: Particles
  private alive = true
  private flashed = false
  private frozen: Animation[] | null = null

  constructor(host: HTMLElement, o: PrizeFxOptions, kind: string, z: number) {
    this.tl = new Timeline(o.tl?.speed ?? o.speed ?? 1)
    this.root = el('div', `fxp fxp-${kind}${this.rm ? ' fxp-rm' : ''}`)
    this.root.style.zIndex = String(z)
    const bg = el('div', 'fxp-bg')
    this.stage = el('div', 'fxp-stage')
    this.quake = el('div', 'fxp-quake')
    const canvas = el('canvas', 'fxp-fx')
    canvas.width = PHONE_W
    canvas.height = PHONE_H
    this.stage.append(this.quake, canvas)
    this.root.append(bg, this.stage)
    this.fx = new Particles(canvas, 900)
    this.setSpeed(this.tl.speed)
    host.append(this.root)
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    this.stage.style.setProperty('--fxp-k', String(w && h ? Math.min(1, w / PHONE_W, h / PHONE_H) : 1))
    this.anim(bg, [{ opacity: 0 }, { opacity: 1 }], 260)

    // Timeline には知らせの仕組みが無いので、毎フレーム見て合わせる（外側の取り消し・速度、host から外されたか）
    const outer = o.tl
    let seen = false
    const watch = () => {
      if (!this.alive) return
      if (this.root.isConnected) seen = true
      if (outer?.cancelled || (seen && !this.root.isConnected)) return this.tl.cancel()
      if (outer && outer.speed !== this.tl.speed) this.setSpeed(outer.speed)
      requestAnimationFrame(watch)
    }
    requestAnimationFrame(watch)
  }

  private setSpeed(speed: number): void {
    this.tl.speed = speed
    if (!this.frozen) this.fx.speed = speed
    // CSS のくり返しアニメーションの長さ。明滅・回転は、速度を上げても安全な下限を守る
    const st = this.root.style
    st.setProperty('--fxp-t', String(1 / speed))
    st.setProperty('--fxp-float', `${Math.max(1800, this.ms(2800))}ms`)
    st.setProperty('--fxp-sheen', `${Math.max(1500, this.ms(3200))}ms`)
    st.setProperty('--fxp-hue', `${Math.max(4000, this.ms(6000))}ms`)
    st.setProperty('--fxp-spin', `${Math.max(10500, this.ms(26000))}ms`)
    st.setProperty('--fxp-beat', `${Math.max(700, this.ms(860))}ms`)
  }

  get cancelled(): boolean {
    return this.tl.cancelled
  }

  ms(x: number): number {
    return this.tl.ms(x)
  }

  check(): void {
    if (this.tl.cancelled) throw CANCELLED
  }

  // 演出上の ms だけ待つ。取り消されたら CANCELLED を投げ、run の finally で片付ける
  async wait(x: number): Promise<void> {
    await this.tl.wait(x)
    this.check()
  }

  add<T extends HTMLElement>(node: T, parent: HTMLElement = this.quake): T {
    parent.append(node)
    return node
  }

  // 動きを減らす設定のときは、すぐ最後の形にする
  anim(node: Element, frames: Keyframe[], x: number, o: { easing?: string; delay?: number; fill?: FillMode } = {}): Animation {
    return node.animate(frames, {
      duration: this.rm ? 1 : Math.max(1, this.ms(x)),
      delay: this.rm ? 0 : this.ms(o.delay ?? 0),
      easing: o.easing ?? 'ease-out',
      fill: o.fill ?? 'both',
    })
  }

  // 画面側で縮小表示されていても、390×844 の座標に直す
  scale(): number {
    return this.stage.getBoundingClientRect().width / PHONE_W || 1
  }

  pointOf(node: Element): { x: number; y: number } {
    const r = node.getBoundingClientRect()
    const base = this.stage.getBoundingClientRect()
    const k = this.scale()
    return { x: (r.left + r.width / 2 - base.left) / k, y: (r.top + r.height / 2 - base.top) / k }
  }

  // 粒子（動きを減らす設定のときは出さない）
  burst(x: number, y: number, o: Parameters<Particles['burst']>[2]): void {
    if (!this.rm) this.fx.burst(x, y, o)
  }

  rain(count: number, colors: readonly string[]): void {
    if (!this.rm) this.fx.rain(count, colors)
  }

  rise(count: number, colors: readonly string[], x0: number, x1: number, y: number): void {
    if (!this.rm) this.fx.rise(count, colors, x0, x1, y)
  }

  // 全面の光は 1 回の演出につき 1 回まで。輝度の変化は 20% 以下、立ち上がりは 120ms 以上（速度を上げても守る）
  flash(color: string, peak = 0.15): void {
    if (this.flashed || this.rm) return
    this.flashed = true
    const wash = this.add(el('div', 'fxp-wash'), this.root)
    wash.style.background = color
    const rise = Math.max(140, this.ms(180))
    const fall = Math.max(320, this.ms(720))
    wash
      .animate([{ opacity: 0 }, { opacity: Math.min(0.18, peak), offset: rise / (rise + fall) }, { opacity: 0 }], {
        duration: rise + fall,
        easing: 'ease-out',
        fill: 'both',
      })
      .finished.then(
        () => wash.remove(),
        () => wash.remove(),
      )
  }

  // 揺れは金と虹のときだけ使う（8px 以内、300ms 以内）
  shake(px: number): void {
    if (this.rm) return
    const p = Math.min(8, px)
    const path = [0, -1, 0.8, -0.55, 0.3, 0]
    this.quake.animate(
      path.map((k, i) => ({ transform: `translate(${(k * p).toFixed(1)}px, ${((i % 2 ? 0.5 : -0.4) * k * p).toFixed(1)}px)` })),
      { duration: Math.min(300, this.ms(280)), easing: 'ease-out' },
    )
  }

  // 時が止まる（UR の 1 秒フリーズ）。動いているアニメーションと粒子を止め、色を落とす
  freeze(on: boolean): void {
    if (on && !this.frozen) {
      this.frozen = this.root.getAnimations({ subtree: true }).filter((a) => a.playState === 'running')
      this.frozen.forEach((a) => a.pause())
      this.fx.speed = 0
    } else if (!on && this.frozen) {
      this.frozen.forEach((a) => a.play())
      this.frozen = null
      this.fx.speed = this.tl.speed
    }
    this.root.classList.toggle('is-frozen', on)
  }

  async leave(x = 320): Promise<void> {
    this.anim(this.root, [{ opacity: 1 }, { opacity: 0 }], x, { easing: 'ease-in' })
    await this.wait(x)
  }

  dispose(): void {
    if (!this.alive) return
    this.alive = false
    this.tl.cancel()
    this.fx.clear()
    this.root.remove()
  }
}

// 演出の本体を走らせ、取り消しでも例外でも必ず片付ける
async function run<T>(s: Scene, body: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await body()
  } catch (err) {
    if (err === CANCELLED) return fallback
    throw err
  } finally {
    s.dispose()
  }
}

// 外から呼ぶ仕組み（入力など）で起こす合図。Timeline の wait と競わせて使う
function signal(): { fire: () => void; fired: Promise<void> } {
  let fire = () => {}
  const fired = new Promise<void>((resolve) => (fire = () => resolve()))
  return { fire: () => fire(), fired }
}

const fadeUp: Keyframe[] = [
  { opacity: 0, transform: 'translateY(12px)' },
  { opacity: 1, transform: 'none' },
]
const fadeOut: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }]
const slam = (from: number): Keyframe[] => [
  { opacity: 0, transform: `scale(${from})` },
  { opacity: 1, transform: 'scale(.96)', offset: 0.7 },
  { opacity: 1, transform: 'scale(1)' },
]
const chip = (r: Rarity): string => `<span class="fxp-chip" data-r="${r}"><i>${SHAPE[r]}</i>${r}</span>`

// ---- 部品 -------------------------------------------------------------------

// 景品のカード。裏の縁はレア度どおり（正直）、表はレア度と景品名
function makeCard(r: Rarity | null, prize: string, edge: Edge): HTMLElement {
  const frame = `<i class="fxp-frame" data-edge="${edge}"></i>`
  const name = escapeHtml(prize)
  const front = r
    ? `<div class="fxp-holo"></div>
       <div class="fxp-rank"><i>${SHAPE[r]}</i><b>${r}</b></div>
       <div class="fxp-rname">${RARITY_NAME[r]}</div>
       <div class="fxp-pname">${name}</div>`
    : `<small class="fxp-tk-top">DOUBLE CHANCE</small>
       <div class="fxp-rank"><i>◎</i><b>W</b></div>
       <div class="fxp-rname">ダブルチャンス券</div>
       ${prize && prize !== 'ダブルチャンス券' ? `<div class="fxp-pname">${name}</div>` : ''}`
  const card = el(
    'div',
    'fxp-card',
    `<div class="fxp-spin">
       <div class="fxp-face fxp-back">${frame}<div class="fxp-face-in"><div class="fxp-mark"><b>B</b></div><small>BINGOO PRIZE</small></div></div>
       <div class="fxp-face fxp-front">${frame}<div class="fxp-face-in">${front}</div></div>
     </div>
     <i class="fxp-shine"></i>
     <i class="fxp-twinkle">✦</i>`,
  )
  card.dataset.r = r ?? 'W'
  return card
}

// カードの下の大きな字（レア度と景品名）
function makeCaption(r: Rarity | null, prize: string): HTMLElement {
  const cap = el(
    'div',
    'fxp-caption',
    r
      ? `<small><i>${SHAPE[r]}</i> ${r}　${RARITY_NAME[r]}</small><b>${escapeHtml(prize)}</b>`
      : `<small><i>◎</i> DOUBLE CHANCE</small><b>${escapeHtml(prize || 'ダブルチャンス券')}</b><em>最後のダブルチャンスで使えます</em>`,
  )
  cap.dataset.r = r ?? 'W'
  return cap
}

// 縁の色を変える（新しい縁を上に重ねて、ふわっと切り替える）
function setEdge(s: Scene, card: HTMLElement, edge: Edge, x = 420): void {
  for (const face of card.querySelectorAll<HTMLElement>('.fxp-face')) {
    const old = [...face.querySelectorAll<HTMLElement>('.fxp-frame')]
    const next = el('i', 'fxp-frame')
    next.dataset.edge = edge
    face.insertBefore(next, face.querySelector('.fxp-face-in'))
    s.anim(next, [{ opacity: 0 }, { opacity: 1 }], x, { easing: 'ease-in-out' }).finished.then(
      () => old.forEach((f) => f.remove()),
      () => {},
    )
  }
}

// 後光（放射状の光）。色を変えた 18 本の筋を conic-gradient で作る
function raysCss(colors: readonly string[]): string {
  const n = 18
  const step = 360 / n
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    const a = i * step
    parts.push(`${colors[i % colors.length]} ${a}deg ${a + 6}deg`, `transparent ${a + 6}deg ${a + step}deg`)
  }
  return `conic-gradient(from 0deg, ${parts.join(', ')})`
}

let crackSeq = 0

// 虹のヒビ。中心から折れ線を伸ばして枝分かれさせる（毎回形が変わる）
function makeCrack(x0: number, y0: number): HTMLElement {
  const id = `fxp-crack-${++crackSeq}`
  const lines: string[] = []
  const grow = (x: number, y: number, ang: number, len: number, depth: number): void => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`
    const steps = 4 + Math.floor(Math.random() * 3)
    for (let i = 0; i < steps; i++) {
      ang += (Math.random() - 0.5) * 0.8
      const seg = (len / steps) * (0.7 + Math.random() * 0.6)
      x += Math.cos(ang) * seg
      y += Math.sin(ang) * seg
      d += ` L${x.toFixed(1)} ${y.toFixed(1)}`
      if (depth < 2 && Math.random() < 0.3) grow(x, y, ang + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5), len * 0.45, depth + 1)
    }
    lines.push(d)
  }
  for (let i = 0; i < 9; i++) grow(x0, y0, (i / 9) * Math.PI * 2 + Math.random() * 0.4, 140 + Math.random() * 110, 0)
  const stops = RAINBOW.map((c, i) => `<stop offset="${i / (RAINBOW.length - 1)}" stop-color="${c}"/>`).join('')
  const paths = (stroke: string) =>
    lines.map((d, i) => `<path d="${d}" stroke="${stroke}" pathLength="1" style="animation-delay:calc(${(i % 5) * 40}ms * var(--fxp-t))"/>`).join('')
  return el(
    'div',
    'fxp-crack',
    `<svg viewBox="0 0 ${PHONE_W} ${PHONE_H}" width="${PHONE_W}" height="${PHONE_H}">
       <defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0 - 200}" y1="${y0 - 200}" x2="${x0 + 200}" y2="${y0 + 200}">${stops}</linearGradient></defs>
       <g class="fxp-crack-glow">${paths(`url(#${id})`)}</g>
       <g class="fxp-crack-core">${paths('#ffffff')}</g>
     </svg>`,
  )
}

// 結果を見せて待つ。少したってからはタップで早めに閉じられる
async function holdThenLeave(s: Scene, x: number): Promise<void> {
  const hint = s.add(el('div', 'fxp-close', 'タップで閉じる'), s.stage)
  s.anim(hint, [{ opacity: 0 }, { opacity: 1 }], 400, { delay: 500 })
  let tapped = false
  s.root.addEventListener('pointerdown', () => (tapped = true))
  for (let t = 0; t < x; t += 100) {
    if (t < 500) tapped = false
    else if (tapped) break
    await s.wait(100)
  }
  await s.leave()
}

// ---- オリパのパック開封 -------------------------------------------------------

// パックが出る → 指に追従して破れる → 縁だけ見える（正直）→ 引き出す →（ランクアップ）→ めくって発表。
// スワイプかタップ 3 回で開く（autoOpenMs、既定 10 秒で自動）。onOpen は開いた瞬間に呼ぶ（デモの権威に伝えるのに使える）
export async function playPackOpen(
  host: HTMLElement,
  o: PackSpec & PrizeFxOptions & { autoOpenMs?: number; onOpen?: (by: OpenBy) => void },
): Promise<void> {
  const s = new Scene(host, o, 'pack', 40)
  return run(
    s,
    async () => {
      const r = o.rarity
      // ランクアップのときは、引いた枠（from）の縁で出てきて、発表の前に to の縁に変わる
      const first: Edge = o.rankUp ? EDGE[o.rankUp.from] : r ? EDGE[r] : 'ticket'
      const anchor = s.add(el('div', 'fxp-anchor'))
      const label = s.add(el('div', 'fxp-label', 'BINGO PRIZE PACK'))
      const halo = s.add(el('i', 'fxp-halo'), anchor)
      halo.dataset.glow = o.glow
      const rays = s.add(el('i', 'fxp-rays'), anchor)
      const card = s.add(makeCard(r, o.prize, first), anchor)
      const pack = s.add(makePack(o.glow), anchor)
      const caption = s.add(makeCaption(r, o.prize))

      // 1. パックが落ちてきて、光で先バレする（ガセあり）
      s.anim(label, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], 400, { delay: 150 })
      s.anim(
        pack,
        [
          { opacity: 0, transform: 'translateY(-560px) rotate(-14deg)' },
          { opacity: 1, transform: 'translateY(18px) rotate(3deg)', offset: 0.7 },
          { opacity: 1, transform: 'translateY(-6px) rotate(-1deg)', offset: 0.86 },
          { opacity: 1, transform: 'none' },
        ],
        760,
        { easing: 'cubic-bezier(.3,.7,.4,1)' },
      )
      s.anim(halo, [{ opacity: 0 }, { opacity: 1 }], 700, { delay: 420 })
      await s.wait(470)
      sfx.packAppear(o.glow)
      if (o.glow !== 'white') s.rise(o.glow === 'gold' ? 26 : 34, GLOW_SPARK[o.glow], AX - 120, AX + 120, AY + 150)
      await s.wait(400)

      // 2. 破る（指に追従。タップ 3 回でも、時間切れでも開く）
      const { by, dir } = await tearPack(s, pack, o.glow, o.autoOpenMs ?? 10000)
      o.onOpen?.(by)
      ripOpen(s, pack, o.glow, dir)
      await s.wait(380)

      // 3. 縁が見える → 引き出す
      await drawOut(s, card, pack, halo, label, first)

      // 4.（あれば）在庫切れで 1 ランクアップ → 5. めくって発表
      if (o.rankUp) await rankUpShow(s, card, o.rankUp)
      await reveal(s, card, rays, caption, r, o.upgrade)
      await holdThenLeave(s, HOLD[r ?? 'W'])
    },
    undefined,
  )
}

// パック。上の封（破る所）と本体を分けて重ねる。絵はレア度によらず同じ（違うのは光だけ）
function makePack(glow: Glow): HTMLElement {
  const pack = el(
    'div',
    'fxp-pack',
    `<div class="fxp-pack-in">
       <div class="fxp-pack-body">
         <i class="fxp-pack-foil"></i>
         <div class="fxp-pack-logo"><small>BINGO PRIZE</small><b>BINGOO</b><span>PACK</span></div>
         <div class="fxp-pack-star">✦</div>
         <div class="fxp-pack-note">1 CARD INSIDE</div>
         <i class="fxp-pack-crimp"></i>
       </div>
       <div class="fxp-cap fxp-cap-rest"><i class="fxp-guide"></i></div>
       <div class="fxp-cap fxp-cap-torn"></div>
       <i class="fxp-slit"></i>
       <i class="fxp-beam"></i>
     </div>`,
  )
  pack.dataset.glow = glow
  return pack
}

// パックを破る。破れた側の封が指についてめくれ上がり、すき間から光（パックの光の色）が漏れる。
// 画面のどこをスワイプ・タップしてもよい（押しやすさのため）
async function tearPack(s: Scene, pack: HTMLElement, glow: Glow, autoMs: number): Promise<{ by: OpenBy; dir: 1 | -1 }> {
  const torn = pack.querySelector<HTMLElement>('.fxp-cap-torn')!
  const rest = pack.querySelector<HTMLElement>('.fxp-cap-rest')!
  const slit = pack.querySelector<HTMLElement>('.fxp-slit')!
  const hint = s.add(
    el(
      'div',
      'fxp-hint',
      `<b>スワイプ、またはタップ 3 回で開封</b>
       <span class="fxp-dots"><i></i><i></i><i></i></span>
       <small>あと <em>${Math.ceil(autoMs / 1000)}</em> 秒で自動で開きます</small>`,
    ),
  )
  const dots = [...hint.querySelectorAll<HTMLElement>('.fxp-dots i')]
  const count = hint.querySelector<HTMLElement>('em')!
  s.anim(hint, fadeUp, 360)

  // 状態はまとめて持つ（イベントから書き換えるため）
  const st = {
    p: 0, // 破れた割合（0〜1）
    dir: 1 as 1 | -1, // 1 は左から右へ破る。最初のスワイプの向きで決まる
    taps: 0,
    by: null as OpenBy | null,
    drag: null as { x: number; base: number; moved: boolean } | null,
    sparkAt: 0,
  }
  const opened = signal()

  const render = () => {
    const cut = st.p * PACK_W
    const keep = PACK_W - cut
    const right = st.dir === 1
    torn.style.clipPath = right ? `inset(0 ${keep}px 0 0)` : `inset(0 0 0 ${keep}px)`
    rest.style.clipPath = right ? `inset(0 0 0 ${cut}px)` : `inset(0 ${cut}px 0 0)`
    slit.style.clipPath = right ? `inset(-20px ${keep}px -20px -20px)` : `inset(-20px -20px -20px ${keep}px)`
    // 破れた側は、破れ目を支点にしてめくれ上がる
    torn.style.transformOrigin = `${right ? cut : keep}px 100%`
    torn.style.transform = s.rm ? '' : `translateY(${(-st.p * 8).toFixed(1)}px) rotate(${(st.dir * st.p * 13).toFixed(2)}deg)`
    pack.classList.toggle('is-torn', st.p > 0)
  }

  // 破れ目の先から火花（パックの光の色）
  const spark = (n: number) => {
    const now = performance.now()
    if (now - st.sparkAt < 45) return
    st.sparkAt = now
    const x = AX - PACK_W / 2 + (st.dir === 1 ? st.p : 1 - st.p) * PACK_W
    s.burst(x, SLIT_Y, { count: n, colors: GLOW_SPARK[glow], speed: 3.5, gravity: 0.12, life: 28, size: 3, shape: 'spark' })
  }

  // タップと自動は、破れ目をすっと伸ばす
  const tween = (to: number, x: number) => {
    const from = st.p
    const t0 = performance.now()
    const dur = Math.max(1, s.ms(x))
    const step = (now: number) => {
      if (s.cancelled) return
      const k = Math.min(1, (now - t0) / dur)
      st.p = Math.max(st.p, from + (to - from) * (1 - (1 - k) ** 3))
      render()
      spark(2)
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  const finish = (how: OpenBy) => {
    if (st.by) return
    st.by = how
    opened.fire()
  }

  s.root.addEventListener('pointerdown', (e) => {
    if (st.by) return
    try {
      s.root.setPointerCapture(e.pointerId)
    } catch {
      // 合成イベントなどで取れないときは、そのまま続ける
    }
    st.drag = { x: e.clientX, base: st.p, moved: false }
  })
  s.root.addEventListener('pointermove', (e) => {
    const d = st.drag
    if (!d || st.by) return
    const dx = (e.clientX - d.x) / s.scale()
    if (!d.moved) {
      if (Math.abs(dx) < 10) return
      d.moved = true
      if (st.p === 0) st.dir = dx >= 0 ? 1 : -1
    }
    // 戻しても、破れたところは戻らない
    const next = Math.min(1, d.base + Math.abs(dx) / TEAR_RANGE)
    if (next > st.p) {
      st.p = next
      render()
      spark(3)
    }
    if (st.p >= 1) finish('swipe')
  })
  const release = () => {
    const d = st.drag
    st.drag = null
    if (!d || st.by) return
    if (d.moved) {
      if (st.p >= 0.72) finish('swipe') // ほとんど破れていれば、残りは自動で
      return
    }
    st.taps++
    dots.forEach((dot, i) => dot.classList.toggle('is-on', i < st.taps))
    sfx.uiTap()
    s.anim(pack, [{ transform: 'scale(1)' }, { transform: 'scale(.965, .975)', offset: 0.4 }, { transform: 'scale(1)' }], 200)
    if (st.taps >= 3) finish('tap')
    else tween(st.taps === 1 ? 0.24 : 0.56, 220)
  }
  s.root.addEventListener('pointerup', release)
  s.root.addEventListener('pointercancel', () => (st.drag = null)) // 取り消された指はタップに数えない

  // 残り秒数を出しながら待つ（時間切れで自動で開く）
  for (let left = autoMs; !st.by; left -= 100) {
    count.textContent = String(Math.max(0, Math.ceil(left / 1000)))
    if (left <= 0) {
      finish('auto')
      break
    }
    await Promise.race([s.tl.wait(100), opened.fired])
    s.check()
  }
  // 残りを破り切る（自動のときは、ゆっくり見せる）
  const by = st.by ?? 'auto'
  const finishMs = by === 'auto' ? 560 : 160
  if (st.p < 1) tween(1, finishMs)
  s.anim(hint, fadeOut, 240)
  await s.wait(finishMs + 20)
  st.p = 1
  render()
  return { by, dir: st.dir }
}

// 破り切った瞬間。封が飛び、すき間から光の柱が立つ
function ripOpen(s: Scene, pack: HTMLElement, glow: Glow, dir: 1 | -1): void {
  sfx.packTear()
  const torn = pack.querySelector<HTMLElement>('.fxp-cap-torn')!
  pack.classList.add('is-open')
  pack.querySelector<HTMLElement>('.fxp-cap-rest')!.style.opacity = '0'
  s.anim(
    torn,
    [
      { opacity: 1, transform: torn.style.transform || 'none' },
      { opacity: 0, transform: `translate(${dir * 150}px, -190px) rotate(${dir * 48}deg)` },
    ],
    560,
    { easing: 'cubic-bezier(.2,.6,.35,1)' },
  )
  s.anim(
    pack.querySelector('.fxp-beam')!,
    [
      { opacity: 0, transform: 'scaleY(.2)' },
      { opacity: 0.9, transform: 'scaleY(1)', offset: 0.35 },
      { opacity: 0, transform: 'scaleY(1.1)' },
    ],
    900,
  )
  s.anim(pack.querySelector('.fxp-slit')!, [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], 900)
  const n = { white: 50, gold: 80, rainbow: 100 }[glow]
  s.burst(AX, SLIT_Y, { count: n, colors: GLOW_SPARK[glow], speed: 7, gravity: 0.18, life: 55, size: 4, shape: 'spark' })
}

// カードを引き出す。まず縁だけが見え（色は正直）、溜めてから全部出す
async function drawOut(s: Scene, card: HTMLElement, pack: HTMLElement, halo: HTMLElement, label: HTMLElement, edge: Edge): Promise<void> {
  const move = (from: string, to: string, x: number, easing: string) => s.anim(card, [{ transform: from }, { transform: to }], x, { easing })
  move('translateY(26px)', 'translateY(-74px)', 560, 'cubic-bezier(.2,.8,.3,1)')
  await s.wait(420)
  replay(card, 'is-glint')
  if (edge === 'gold') s.rise(16, GOLD, AX - 90, AX + 90, AY - 110)
  // 金の縁なら、ここで長めに溜める
  await s.wait({ silver: 260, blue: 420, gold: 760, rainbow: 760, ticket: 260 }[edge])
  move('translateY(-74px)', 'translateY(-250px)', 480, 'cubic-bezier(.45,0,.3,1)')
  s.anim(pack, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(460px) rotate(-10deg)' }], 620, {
    delay: 180,
    easing: 'cubic-bezier(.5,0,.8,.4)',
  })
  s.anim(halo, fadeOut, 500)
  s.anim(label, fadeOut, 300)
  await s.wait(500)
  move('translateY(-250px)', `translateY(${CARD_Y}px) scale(${CARD_SCALE})`, 560, 'cubic-bezier(.3,1.35,.5,1)')
  await s.wait(600)
}

// 在庫切れで 1 ランクアップ（from → to）。縁も to の色に変わる。終わったら小さな札にして上に残す
async function rankUpShow(s: Scene, card: HTMLElement, ru: { from: Rarity; to: Rarity }): Promise<void> {
  const box = s.add(
    el(
      'div',
      'fxp-rankup',
      `<small>在庫切れで</small><b>1 ランクアップ！</b>
       <div class="fxp-ru-row">${chip(ru.from)}<i class="fxp-ru-arrow">➜</i>${chip(ru.to)}</div>`,
    ),
  )
  const to = box.querySelectorAll<HTMLElement>('.fxp-chip')[1]
  sfx.rankUp()
  s.anim(box, [{ opacity: 0, transform: 'translateY(-14px) scale(.92)' }, { opacity: 1, transform: 'none' }], 340, {
    easing: 'cubic-bezier(.2,1.4,.4,1)',
  })
  s.anim(to, [{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1)' }], 320, {
    delay: 600,
    easing: 'cubic-bezier(.2,1.6,.4,1)',
  })
  await s.wait(640)
  setEdge(s, card, EDGE[ru.to])
  replay(card, 'is-glint')
  s.burst(CX, CY - 150, { count: 40, colors: SPARK[ru.to], speed: 6, gravity: 0.1, life: 50, size: 4, shape: 'spark' })
  await s.wait(1000)
  s.anim(box, [{ opacity: 1, transform: 'none' }, { opacity: 0.85, transform: 'translateY(-46px) scale(.66)' }], 380, { easing: 'ease-in-out' })
  await s.wait(300)
}

// ---- レア度の発表（パック開封とチャレンジ成功で共通） ----------------------------------

// C はすぐ、R はきらり、SR は金の爆発、UR は 1 秒フリーズ → 虹のヒビ →（昇格なら縁が虹に）→ 景品名をドン。
// ダブルチャンス券は明るいが控えめに。カードは発表の位置（裏向き）にある前提
async function reveal(s: Scene, card: HTMLElement, rays: HTMLElement, caption: HTMLElement, r: Rarity | null, upgrade: boolean): Promise<void> {
  const spin = card.querySelector<HTMLElement>('.fxp-spin')!
  const rank = card.querySelector<HTMLElement>('.fxp-front .fxp-rank')!
  const at = `translateY(${CARD_Y}px)`
  const flip = (x: number) => s.anim(spin, [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }], x, { easing: 'cubic-bezier(.35,.05,.25,1)' })
  const pop = (k: number, x: number) =>
    s.anim(
      card,
      [
        { transform: `${at} scale(${CARD_SCALE})` },
        { transform: `${at} scale(${(CARD_SCALE * k).toFixed(3)})`, offset: 0.35 },
        { transform: `${at} scale(${CARD_SCALE})` },
      ],
      x,
    )
  const showCaption = () => s.anim(caption, fadeUp, 380)
  const showRays = (colors: readonly string[]) => {
    rays.style.background = raysCss(colors)
    s.anim(rays, [{ opacity: 0 }, { opacity: 0.6 }], 600)
  }

  if (r === null) {
    // ダブルチャンス券: パステルの紙吹雪で、明るく控えめに
    sfx.cardFlip()
    flip(440)
    await s.wait(330)
    sfx.rarity(null)
    pop(1.06, 380)
    s.burst(CX, CY - 40, { count: 44, colors: TICKET, speed: 6, gravity: 0.16, life: 80, size: 8, shape: 'rect' })
    showCaption()
    await s.wait(500)
    return
  }

  if (r === 'C') {
    // すぐ
    sfx.cardFlip()
    flip(380)
    await s.wait(230)
    sfx.rarity('C')
    s.burst(CX, CY, { count: 22, colors: SPARK.C, speed: 4, gravity: 0.04, life: 40, size: 4, shape: 'dot' })
    showCaption()
    await s.wait(450)
    return
  }

  if (r === 'R') {
    // きらり: 斜めの光が 1 回走り、角で星が光る
    sfx.cardFlip()
    flip(440)
    await s.wait(360)
    sfx.rarity('R')
    replay(card, 'is-kirari')
    pop(1.04, 420)
    s.burst(CX + 92, CY - 140, { count: 26, colors: SPARK.R, speed: 5, gravity: 0.05, life: 46, size: 4, shape: 'spark' })
    s.burst(CX, CY, { count: 30, colors: SPARK.R, speed: 7, gravity: 0.08, life: 50, size: 4, shape: 'spark' })
    showCaption()
    await s.wait(700)
    return
  }

  // SR と UR は溜める。縁はどちらも金なので、ここではまだ区別がつかない
  card.classList.add('is-charge')
  s.rise(24, GOLD, CX - 110, CX + 110, CY + 170)
  await s.wait(700)
  sfx.cardFlip()

  if (r === 'SR') {
    // 金の爆発
    flip(380)
    await s.wait(300)
    sfx.rarity('SR')
    card.classList.replace('is-charge', 'is-gold')
    s.flash('#fff1c2', 0.15)
    s.shake(6)
    pop(1.1, 420)
    showRays(GOLD)
    s.anim(rank, slam(1.8), 260, { easing: 'cubic-bezier(.2,.9,.3,1)' })
    s.burst(CX, CY, { count: 150, colors: GOLD, speed: 13, gravity: 0.12, life: 70, size: 5, shape: 'spark' })
    s.burst(CX, CY, { count: 70, colors: GOLD, speed: 9, gravity: 0.22, life: 110, size: 10, shape: 'rect' })
    showCaption()
    await s.wait(900)
    return
  }

  // UR: ゆっくりめくり始めたところで、すべてが止まる（1 秒）
  const turn = flip(1200)
  await s.wait(260)
  s.freeze(true)
  await s.wait(1000)
  // 虹のヒビが走る（止まった時間の中で、ヒビだけが進む）
  const crack = s.add(makeCrack(CX, CY))
  sfx.crack()
  await s.wait(850)
  // 割れて、一気に表へ
  s.freeze(false)
  turn.updatePlaybackRate(5)
  s.anim(crack, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.12)' }], 420, { easing: 'ease-in' })
  await s.wait(180)
  sfx.rarity('UR')
  card.classList.replace('is-charge', 'is-rainbow')
  s.flash('#ffffff', 0.15)
  s.shake(8)
  pop(1.1, 440)
  showRays(RAINBOW)
  s.anim(rank, slam(1.8), 260, { easing: 'cubic-bezier(.2,.9,.3,1)' })
  s.burst(CX, CY, { count: 170, colors: RAINBOW, speed: 14, gravity: 0.1, life: 80, size: 5, shape: 'spark' })
  s.rain(90, RAINBOW)
  await s.wait(800)

  if (upgrade) {
    // 縁が金から虹に昇格する
    replay(card, 'is-ascend')
    await s.wait(360)
    setEdge(s, card, 'rainbow', 520)
    const tag = s.add(el('div', 'fxp-ascend', '<span>✦ 縁が虹に昇格！</span>'))
    s.anim(tag, slam(1.5), 320, { easing: 'cubic-bezier(.2,1.2,.4,1)' })
    for (const [dx, dy] of [
      [-104, -150],
      [104, -150],
      [-104, 150],
      [104, 150],
    ]) {
      s.burst(CX + dx, CY + dy, { count: 18, colors: RAINBOW, speed: 5, gravity: 0.05, life: 40, size: 4, shape: 'spark' })
    }
    await s.wait(900)
  }

  // 景品名をドンと出す
  s.anim(caption, slam(1.9), 300, { easing: 'cubic-bezier(.2,.9,.3,1)' })
  await s.wait(200)
  s.shake(4)
  s.burst(CX, 600, { count: 60, colors: RAINBOW, speed: 9, gravity: 0.2, life: 90, size: 9, shape: 'rect' })
  await s.wait(900)
}

// ---- ビンゴ後の選択 -----------------------------------------------------------

const RING = 2 * Math.PI * 52 // 残り秒数のリングの周の長さ（prize.css の stroke-dasharray と同じ）

// ビンゴ後の選択。seconds 秒（既定 10）で時間切れなら 'receive'。
// challenge.allowed が false のとき（終盤など）は受け取るだけ。chance は成功の目安（0〜1、出さなくてもよい）。
// double は倍々（チャレンジ成功のあとの 2 回目）。省略したときは、いまの景品が SR 以上なら倍々として見せる
export async function askChoice(
  host: HTMLElement,
  o: PrizeFxOptions & {
    rarity: Rarity
    prize: string
    seconds?: number
    challenge: { allowed: boolean; target: Rarity; chance?: number; reason?: string }
    double?: boolean
  },
): Promise<'receive' | 'challenge'> {
  const s = new Scene(host, o, 'choice', 44)
  return run(
    s,
    async () => {
      const ch = o.challenge
      const double = o.double ?? (o.rarity === 'SR' || o.rarity === 'UR')
      const total = Math.max(1, o.seconds ?? 10) * 1000
      const cur = `<i>${SHAPE[o.rarity]}</i> ${o.rarity}`
      const goal = `<i>${SHAPE[ch.target]}</i> ${ch.target}`
      const chance = ch.chance === undefined ? '' : `<em>成功の目安 ${ch.chance < 0.01 ? '1% 未満' : `${Math.round(ch.chance * 100)}%`}</em>`
      const riskBody = ch.allowed
        ? `<b>上位チャレンジ</b><small>${goal} ${RARITY_NAME[ch.target]}を狙う</small>${chance}`
        : `<b>上位チャレンジ</b><small>${escapeHtml(ch.reason ?? 'いまはチャレンジできません')}</small>`
      if (double) s.root.classList.add('is-double')
      const box = s.add(
        el(
          'div',
          'fxp-ch',
          `<div class="fxp-ch-head">
             <small>${double ? 'DOUBLE OR NOTHING' : 'BINGO PRIZE'}</small>
             <h2>${double ? 'まだ行く？' : 'どうする？'}</h2>
             <p>${double ? `${cur} を手放して ${goal} に挑む？` : '受け取るか、上位を狙うか'}</p>
           </div>
           <div class="fxp-ch-prize">
             <div class="fxp-mini" data-r="${o.rarity}"><i class="fxp-frame" data-edge="${EDGE[o.rarity]}"></i>
               <div class="fxp-mini-in"><i>${SHAPE[o.rarity]}</i><b>${o.rarity}</b><span>${RARITY_NAME[o.rarity]}</span></div></div>
             <div class="fxp-ch-pname"><small>いまの景品</small><b>${escapeHtml(o.prize)}</b></div>
           </div>
           <div class="fxp-ch-timer">
             <svg viewBox="0 0 120 120"><circle class="fxp-ring-bg" cx="60" cy="60" r="52"/><circle class="fxp-ring" cx="60" cy="60" r="52"/></svg>
             <b>${Math.ceil(total / 1000)}</b>
           </div>
           <small class="fxp-ch-note">時間切れは「受け取る」になります</small>
           <div class="fxp-ch-btns">
             <button type="button" class="fxp-btn fxp-take"><b>受け取る</b><small>${cur}　${escapeHtml(o.prize)}</small></button>
             <button type="button" class="fxp-btn fxp-risk" data-target="${ch.target}"${ch.allowed ? '' : ' disabled'}>${riskBody}</button>
           </div>`,
        ),
      )
      const take = box.querySelector<HTMLButtonElement>('.fxp-take')!
      const risk = box.querySelector<HTMLButtonElement>('.fxp-risk')!
      const ring = box.querySelector<SVGCircleElement>('.fxp-ring')!
      const num = box.querySelector<HTMLElement>('.fxp-ch-timer b')!
      const note = box.querySelector<HTMLElement>('.fxp-ch-note')!

      // 上から順に出す（終わったら CSS に任せる。押したときの動きを邪魔しない）
      box.querySelectorAll<HTMLElement>('.fxp-ch-head, .fxp-ch-prize, .fxp-ch-timer, .fxp-ch-note, .fxp-btn').forEach((part, i) =>
        s.anim(part, fadeUp, 360, { delay: 60 * i, fill: 'backwards' }),
      )

      const st = { pick: null as 'receive' | 'challenge' | null }
      const picked = signal()
      const choose = (kind: 'receive' | 'challenge') => {
        if (st.pick) return
        st.pick = kind
        picked.fire()
      }
      take.addEventListener('click', () => choose('receive'))
      risk.addEventListener('click', () => ch.allowed && choose('challenge'))

      // 残り秒数（残り 3 秒からは周りが暗くなり、リングの色が変わる）
      let timeUp = false
      let shown = -1
      for (let left = total; !st.pick; left -= 100) {
        const sec = Math.max(0, Math.ceil(left / 1000))
        if (sec !== shown) {
          shown = sec
          num.textContent = String(sec)
          if (sec > 0) {
            sfx.countdown(sec)
            if (s.ms(1000) >= 340) replay(num, 'is-tick') // 速度を上げても、拍は 1 秒に 3 回以下
          }
          if (sec <= 3) s.root.classList.add('is-hurry')
        }
        ring.style.strokeDashoffset = (RING * (1 - Math.max(0, left) / total)).toFixed(2)
        if (left <= 0) {
          timeUp = true
          choose('receive')
          break
        }
        await Promise.race([s.tl.wait(100), picked.fired])
        s.check()
      }

      const kind = st.pick ?? 'receive'
      sfx.choose(kind)
      s.root.classList.add('is-chosen')
      const [on, off] = kind === 'receive' ? [take, risk] : [risk, take]
      on.classList.add('is-on')
      off.classList.add('is-gone')
      if (timeUp) note.textContent = '時間切れ — 受け取ります'
      if (kind === 'challenge') {
        const p = s.pointOf(risk)
        s.burst(p.x, p.y, { count: 60, colors: SPARK[ch.target], speed: 8, gravity: 0.15, life: 55, size: 5, shape: 'spark' })
      }
      await s.wait(kind === 'challenge' ? 700 : 500)
      await s.leave(260)
      return kind
    },
    'receive' as 'receive' | 'challenge',
  )
}

// ---- 上位チャレンジ -------------------------------------------------------------

// 「上位チャレンジ！」の幕開け（このあと組み込み側が 3×3 のカードを配る。最後に challengeDeal を鳴らす）
export async function playChallengeStart(host: HTMLElement, o: PrizeFxOptions & { target: Rarity }): Promise<void> {
  const s = new Scene(host, o, 'start', 42)
  return run(
    s,
    async () => {
      const t = o.target
      const hot = t === 'SR' || t === 'UR' // 揺れは金と虹のときだけ
      s.root.dataset.target = t
      const band = (cls: string) => s.add(el('div', `fxp-band ${cls}`, `<span>${'CHALLENGE ✦ '.repeat(10)}</span>`))
      const a = band('fxp-band-a')
      const b = band('fxp-band-b')
      const sub = s.add(el('div', 'fxp-st-sub', 'TOP CHALLENGE'))
      const title = s.add(el('div', 'fxp-st-title', '上位チャレンジ！'))
      const target = s.add(el('div', 'fxp-st-target', `${chip(t)}<span>${RARITY_NAME[t]}を狙え！</span>`))
      const rule = s.add(el('div', 'fxp-st-rule', 'まだ出ていない数字だけの 3×3 カード。<br>ビンゴすれば獲得、外れたら景品なし'))
      const slide = (node: HTMLElement, from: number, to: number, x: number, easing: string) =>
        s.anim(node, [{ transform: `translateX(${from}%) rotate(-10deg)` }, { transform: `translateX(${to}%) rotate(-10deg)` }], x, { easing })

      // 帯が左右から走り込み、文字がドンと出る
      slide(a, -110, 0, 420, 'cubic-bezier(.2,.8,.3,1)')
      slide(b, 110, 0, 420, 'cubic-bezier(.2,.8,.3,1)')
      s.anim(sub, fadeUp, 300, { delay: 200 })
      await s.wait(380)
      s.anim(title, slam(1.7), 280, { easing: 'cubic-bezier(.2,.9,.3,1)' })
      await s.wait(200)
      if (hot) s.shake(6)
      s.burst(AX, 350, { count: 60, colors: SPARK[t], speed: 9, gravity: 0.14, life: 55, size: 5, shape: 'spark' })
      s.anim(target, slam(0.6), 320, { delay: 150, easing: 'cubic-bezier(.2,1.5,.4,1)' })
      s.anim(rule, fadeUp, 360, { delay: 450 })
      await s.wait(1500)

      // 幕が上がって、カードが配られる
      sfx.challengeDeal()
      slide(a, 0, 110, 380, 'ease-in')
      slide(b, 0, -110, 380, 'ease-in')
      s.anim(title, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.25)' }], 320, { easing: 'ease-in' })
      for (const n of [sub, target, rule]) s.anim(n, fadeOut, 260)
      await s.wait(300)
      await s.leave(220)
    },
    undefined,
  )
}

// 上位チャレンジの結果。成功なら上位の景品をパック風に（縁は正直、めくって発表）、失敗なら「景品なし」。
// upgrade は UR の縁を虹に昇格させるか（省略時は UR なら昇格）。
// 失敗のとき rarity を渡すと、割れるカードの縁がその色になる（省略時は金）
export async function playChallengeResult(
  host: HTMLElement,
  o: PrizeFxOptions & { success: boolean; rarity?: Rarity; prize?: string; upgrade?: boolean },
): Promise<void> {
  const s = new Scene(host, o, o.success ? 'win' : 'lose', 44)
  return run(
    s,
    () => (o.success ? challengeWin(s, o.rarity ?? 'SR', o.prize ?? '', o.upgrade ?? o.rarity === 'UR') : challengeLose(s, o.rarity)),
    undefined,
  )
}

async function challengeWin(s: Scene, r: Rarity, prize: string, upgrade: boolean): Promise<void> {
  const head = s.add(el('div', 'fxp-win-title', '<small>CHALLENGE CLEAR</small><b>チャレンジ成功！</b>'))
  const anchor = s.add(el('div', 'fxp-anchor'))
  const rays = s.add(el('i', 'fxp-rays'), anchor)
  const card = s.add(makeCard(r, prize, EDGE[r]), anchor)
  const caption = s.add(makeCaption(r, prize))
  sfx.challengeSuccess()
  s.anim(head, slam(1.6), 300, { easing: 'cubic-bezier(.2,.9,.3,1)' })
  await s.wait(220)
  s.burst(AX, 120, { count: 70, colors: SPARK[r], speed: 9, gravity: 0.16, life: 60, size: 5, shape: 'spark' })
  // 景品のカードが下から上がってくる（裏向き。縁はレア度どおり）
  s.anim(card, [{ transform: 'translateY(620px) scale(1)' }, { transform: `translateY(${CARD_Y}px) scale(${CARD_SCALE})` }], 680, {
    easing: 'cubic-bezier(.25,1.2,.4,1)',
  })
  await s.wait(720)
  replay(card, 'is-glint')
  await s.wait(r === 'C' || r === 'R' ? 300 : 500)
  await reveal(s, card, rays, caption, r, upgrade)
  await holdThenLeave(s, HOLD[r])
}

// 失敗: カードが落ちてきて、まっぷたつに割れて色が抜ける。重すぎないが、ちゃんと悔しく
async function challengeLose(s: Scene, aimed: Rarity | undefined): Promise<void> {
  const edge: Edge = aimed ? EDGE[aimed] : 'gold'
  const half = (side: 'l' | 'r') =>
    `<div class="fxp-half fxp-half-${side}"><i class="fxp-frame" data-edge="${edge}"></i><div class="fxp-face-in"><div class="fxp-mark"><b>B</b></div></div></div>`
  const anchor = s.add(el('div', 'fxp-anchor'))
  const broken = s.add(el('div', 'fxp-broken', half('l') + half('r')), anchor)
  const title = s.add(el('div', 'fxp-lose-title', 'チャレンジ失敗…'))
  const none = s.add(el('div', 'fxp-lose-none', '景品なし'))
  const sub = s.add(el('div', 'fxp-lose-sub', 'あと一歩…！ ナイスチャレンジ'))
  s.anim(
    broken,
    [
      { opacity: 0, transform: 'translateY(-520px)' },
      { opacity: 1, transform: 'translateY(10px)', offset: 0.75 },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    560,
    { easing: 'cubic-bezier(.4,0,.6,1)' },
  )
  await s.wait(900)

  sfx.challengeFail()
  broken.classList.add('is-broken')
  const [l, r] = broken.querySelectorAll<HTMLElement>('.fxp-half')
  for (const [node, k] of [
    [l, -1],
    [r, 1],
  ] as const) {
    s.anim(
      node,
      [
        { opacity: 1, transform: 'none' },
        { opacity: 1, transform: `translate(${k * 8}px, 6px) rotate(${k * 3}deg)`, offset: 0.25 },
        { opacity: 0, transform: `translate(${k * 46}px, 420px) rotate(${k * 16}deg)` },
      ],
      1100,
      { delay: 120, easing: 'cubic-bezier(.5,0,.75,.4)' },
    )
  }
  s.burst(AX, AY - 87, { count: 36, colors: GREY, speed: 3, gravity: 0.3, life: 70, size: 4, shape: 'dot' })
  await s.wait(300)
  // 文字は落ちてきて、少し傾いて止まる（しょんぼり）
  s.anim(
    title,
    [
      { opacity: 0, transform: 'translateY(-60px)' },
      { opacity: 1, transform: 'translateY(0)', offset: 0.55 },
      { opacity: 1, transform: 'translateY(5px) rotate(-2.5deg)', offset: 0.8 },
      { opacity: 1, transform: 'translateY(3px) rotate(-2deg)' },
    ],
    900,
    { easing: 'ease-in' },
  )
  s.anim(none, fadeUp, 400, { delay: 700 })
  s.anim(sub, fadeUp, 400, { delay: 1100 })
  await s.wait(1500)
  await holdThenLeave(s, 1700)
}
