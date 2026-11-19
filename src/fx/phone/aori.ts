import { sfx } from '../../audio'
import { Particles } from '../particles'
import { GOLD, RAINBOW } from '../theme'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { boxIn, play, ring, shake, sparkBurst } from './card'
import './aori.css'

// スマホの単発の演出（390×844 のスマホ画面に重ねる層。host 全体、z-index 22）。どれも終わったら自分で消えてから解決する。
//   playReach       「リーチ！」（2 本以上なら「ダブルリーチ！」）
//   playBingo       B・I・N・G・O の玉がそろって「第○位」
//   playWildResult  全員確定（虹玉）で自分のマスが開いた
// 縁取り文字の txt と、番号が出たときの結果の AoriOutcome は、手元のスロット（spin.ts）と緊急クエスト（quest.ts）でも使う。

// 出た番号が自分のカードにとって何だったか
export type AoriOutcome = 'none' | 'hit' | 'reach' | 'double' | 'bingo'

// 縁取りした大きな文字
export function txt(text: string, cls = ''): string {
  return `<span class="fxa-txt ${cls}"><i>${text}</i><b>${text}</b></span>`
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
