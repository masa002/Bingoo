import './lastone.css'
import { bgm, sfx, type GaraponVoice } from '../../audio'
import { Particles } from '../particles'
import { GaraponMachine, ballHtml } from '../phone/garapon'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { GOLD, STAGE_H, STAGE_W } from '../theme'
import type { StageEventBase } from './events'

// ラストワン争奪のガラポン（大画面。1920×1080 全体に重ねる）。
// 同じ回に上がった人の名前を並べ、全員が自分のスマホでガラポンを回している様子を見せる。
// dropAt で当たりの人を一斉に発表する（スマホで玉が出るのと同時）。外れの人は「運がなかった」（ダブルチャンスの玉 3 個）。
// durationMs で片付けてから解決する。
//
//   await playLastOneGarapon(stageRoot, { dropAt: 6500, durationMs: 11000, prizes: 2, entrants })
//
// 時間の使い方（D = dropAt、T = durationMs。演出上の ms で、speed で縮む）:
//   0〜        見出し（ラストワン争奪！・残り○個を○人で）→ 大きな抽選器 → 名前の札が抽選器から配られる
//   D の 3 割  「全員スマホでガラポン！」。札の「？」の玉がゆれ、会場のあちこちから「ガラガラ」
//   D-3〜1 秒  3・2・1（スマホと同じ時刻）
//   D          一斉に発表。当たりの札は金に光り（王冠と ★ ラストワン賞）、外れの札は白い玉になって暗くなる
//   D+0.7 秒   「はずれた人には ダブルチャンスの玉 3 個」
//   T-0.5 秒   ふわっと消して、T で片付けて解決する
// 名前は 16 枠まで並べる（超えたら 15 人と「ほか○人」の札。自分と当たりの人を先に入れる）。
// 大画面は勝ち負けしか知らないので、当たりの札は玉の色ではなく王冠で見せる（スマホの玉の色と食い違わないように）。
// 重なり順はイベントの層が z-index 44、粒子の canvas が 60。山場では BGM を下げ、終わったら戻す

export interface LastOneStageOptions extends StageEventBase {
  prizes: number // 残りの景品の数
  dropAt: number // 始まってからこの ms で当たりを発表する
  durationMs: number
  entrants: { name: string; isMe: boolean; win: boolean }[]
}

export async function playLastOneGarapon(host: HTMLElement, o: LastOneStageOptions): Promise<void> {
  const show = new LastOneShow(host, o)
  safe(() => bgm.duck(true))
  try {
    await show.run()
  } catch (err) {
    if (err !== CANCELLED) throw err
  } finally {
    show.dispose()
    safe(() => bgm.duck(false))
  }
}

// ---- 決まりごと ------------------------------------------------------------------

// 取り消されたときに、演出の途中から抜けるための印
const CANCELLED = Symbol('cancelled')

const CELLS = 16 // 名前の札の枠
const GRID = { x: 620, y: 296, w: 1240, h: 640 } // 名前の札を並べる欄
const GAP = 20
const MACHINE = { x: 110, y: 290, size: 420 } // 大きな抽選器（位置は lastone.css の .fxls-mwrap と合わせる）
const DRUM = { x: MACHINE.x + (160 / 320) * MACHINE.size, y: MACHINE.y + (138 / 320) * MACHINE.size } // 胴の中心
const CRUISE = 0.08 // 大きな絵なので、回転はゆっくり（1 秒に 0.1 回転以下）
const DC_BALLS = 3 // 外れた人がもらえるダブルチャンスの玉
// 回している音の文字だけにする（「カラン」など当たりを思わせる言葉は、結果と関係なく出さない）
const POP_WORDS = ['ガラガラ', 'ガラッ', 'ゴロゴロ', 'ガラガラ…', 'ゴロッ']
const SPIN_LABELS = ['ガラガラ…', 'ゴロゴロ…', 'ガラッ ガラッ', '回しています…']

// 音で例外が出ても、演出は止めずに進める（音は鳴らなくても、見た目と時刻はスマホとそろえる）
const safe = (fn: () => void): void => {
  try {
    fn()
  } catch (err) {
    console.warn('[lastone] sound failed', err)
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const num = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const fmt = (n: number): string => Math.max(0, Math.round(num(n, 0))).toLocaleString('ja-JP')

const octagon = (cx: number, cy: number, r: number): string =>
  Array.from({ length: 8 }, (_, k) => {
    const a = ((22.5 + 45 * k) * Math.PI) / 180
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`
  }).join(' ')

// 「全員スマホでガラポン！」の横に添える、ガラポンが映ったスマホ
const PHONE_SVG = `<svg class="fxls-phone" viewBox="0 0 36 58" aria-hidden="true">
  <rect x="2" y="2" width="32" height="54" rx="7" fill="#141b3d" stroke="#ffe2b8" stroke-width="3"/>
  <polygon points="${octagon(18, 24, 9.5)}" fill="#cf9558" stroke="#7a4a22" stroke-width="1.5"/>
  <circle cx="18" cy="24" r="2" fill="#7a4a22"/>
  <path d="M10 41 L26 41" stroke="#7a4a22" stroke-width="3" stroke-linecap="round"/>
  <circle cx="18" cy="49" r="2.2" fill="#ffe2b8"/>
</svg>`

// 当たりの札の印（王冠）。大画面は玉の色を知らないので、玉ではなく王冠で見せる
const CROWN_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true">
  <path d="M9 45 L11 19 L23 31 L32 13 L41 31 L53 19 L55 45 Z" fill="#ffd34d" stroke="#fff4cc" stroke-width="2.5" stroke-linejoin="round"/>
  <rect x="9" y="47" width="46" height="8" rx="2.5" fill="#ffd34d" stroke="#fff4cc" stroke-width="2.5"/>
  <circle cx="11" cy="17" r="3.6" fill="#fff4cc"/><circle cx="32" cy="11" r="3.6" fill="#fff4cc"/><circle cx="53" cy="17" r="3.6" fill="#fff4cc"/>
  <circle cx="32" cy="37" r="4" fill="#5ad2ff" stroke="#fff4cc" stroke-width="1.5"/>
</svg>`

const crown = (): string => `<span class="fxls-crown">${CROWN_SVG}</span>`

interface Entrant {
  name: string
  isMe: boolean
  win: boolean
}

// 並べるのは max 人まで。自分と当たる人を先に入れて、元の順番のまま並べる
function pick(all: readonly Entrant[], max: number): Entrant[] {
  if (all.length <= max) return [...all]
  const keep = new Set<number>()
  for (const [i, e] of all.entries()) if (e.isMe && keep.size < max) keep.add(i)
  for (const [i, e] of all.entries()) if (e.win && keep.size < max) keep.add(i)
  for (let i = 0; i < all.length && keep.size < max; i++) keep.add(i)
  return [...keep].sort((a, b) => a - b).map((i) => all[i])
}

// 札の並べ方。人数に合わせて 1〜4 列にし、欄の真ん中に寄せる（最後の行も真ん中に寄せる）
function layout(cells: number) {
  const cols = cells <= 3 ? 1 : cells <= 8 ? 2 : cells <= 12 ? 3 : 4
  const rows = Math.max(1, Math.ceil(cells / cols))
  const cw = Math.min(cols === 1 ? 680 : 600, (GRID.w - (cols - 1) * GAP) / cols)
  const ch = Math.min(150, (GRID.h - (rows - 1) * GAP) / rows)
  const sd = Math.round(Math.min(cw >= 560 ? 88 : cw >= 380 ? 76 : 62, ch - 44)) // 玉の大きさ
  const fs = cw >= 560 ? 46 : cw >= 380 ? 40 : 30 // 名前の大きさ
  const pad = cw >= 380 ? 20 : 14
  const x0 = GRID.x + (GRID.w - (cols * cw + (cols - 1) * GAP)) / 2
  const y0 = GRID.y + (GRID.h - (rows * ch + (rows - 1) * GAP)) / 2
  const at = (i: number): { x: number; y: number } => {
    const r = Math.floor(i / cols)
    const inRow = r === rows - 1 ? cells - r * cols : cols
    return { x: x0 + ((cols - inRow) * (cw + GAP)) / 2 + (i % cols) * (cw + GAP), y: y0 + r * (ch + GAP) }
  }
  return { cw, ch, sd, fs, pad, at }
}

function winnerText(ws: readonly Entrant[]): string {
  if (!ws.length) return 'ラストワン賞は 該当なし'
  const who = (e: Entrant): string => (e.isMe ? 'あなた' : `${escapeHtml(e.name)} さん`)
  if (ws.length === 1) return `${who(ws[0])}が獲得！`
  if (ws.length === 2) return `${who(ws[0])}・${who(ws[1])}が獲得！`
  return ws.some((e) => e.isMe) ? `あなたと ほか ${fmt(ws.length - 1)} 人が獲得！` : `${fmt(ws.length)} 人が獲得！`
}

// ---- 本体 ------------------------------------------------------------------------

class LastOneShow {
  private readonly tl: Timeline
  private readonly root: HTMLElement
  private readonly dim: HTMLElement
  private readonly body: HTMLElement // 揺らす層（暗転は揺らさない）
  private readonly rm = prefersReducedMotion()
  private readonly attached: boolean
  private readonly t0 = performance.now()
  // 時刻（演出上の ms）
  private readonly D: number // 一斉に発表する
  private readonly T: number // 片付けて解決する
  private readonly I: number // 全員で回し始める
  private readonly all: readonly Entrant[]
  private readonly shown: readonly Entrant[]
  private readonly hidden: readonly Entrant[] // 「ほか○人」にまとめた人
  private readonly cards: HTMLElement[] = []
  private readonly centers: { x: number; y: number }[] = [] // 札の中心
  private readonly slots: { x: number; y: number }[] = [] // 札の玉の中心
  private readonly more: HTMLElement | null = null
  private readonly machine: GaraponMachine
  private readonly fx: Particles | null = null
  private readonly canvas: HTMLCanvasElement | null = null
  private voice: GaraponVoice | null = null
  private lastVoice = -1
  private phase: 'intro' | 'spin' | 'reveal' = 'intro'
  private popAcc = 0
  private popN = 0
  private glowed = false

  constructor(
    private readonly host: HTMLElement,
    o: LastOneStageOptions,
  ) {
    const speed = num(o.speed, 1)
    this.tl = new Timeline(speed > 0 ? speed : 1)
    this.T = Math.max(0, num(o.durationMs, 11000))
    this.D = clamp(num(o.dropAt, 6500), 0, this.T)
    this.I = Math.min(this.D, clamp(this.D * 0.3, 1200, 2200))
    this.all = (o.entrants ?? []).map((e) => ({ name: String(e.name ?? ''), isMe: !!e.isMe, win: !!e.win }))
    this.shown = pick(this.all, this.all.length > CELLS ? CELLS - 1 : CELLS)
    const picked = new Set(this.shown)
    this.hidden = this.all.filter((e) => !picked.has(e))
    this.attached = host.isConnected

    const balls = `${ballHtml('red')}${ballHtml('gold')}${ballHtml('rainbow')}`
    const tokens = Array.from({ length: DC_BALLS }, () => '<i class="fxls-token">?</i>').join('')
    this.root = el('div', `fxls${this.rm ? ' fxls-rm' : ''}`)
    this.root.style.setProperty('--k', String(this.tl.ms(1)))
    this.root.dataset.phase = 'intro'
    this.dim = el('div', 'fxls-dim')
    this.body = el(
      'div',
      'fxls-body',
      `<div class="fxls-warm"></div>
      <div class="fxls-rays"></div>
      <div class="fxls-mwrap"></div>
      <div class="fxls-status">
        <div class="fxls-banner">${PHONE_SVG}<span>全員スマホでガラポン！</span></div>
        <div class="fxls-hint">玉は <b>いっせいに</b> 出ます</div>
        <div class="fxls-count"></div>
        <div class="fxls-tally"></div>
      </div>
      <header class="fxls-head">
        <div class="fxls-kicker">上のランクまで 景品が尽きた！</div>
        <div class="fxls-title fxls-ol" data-text="ラストワン争奪！"><b>ラストワン争奪！</b></div>
        <div class="fxls-line">
          <div class="fxls-sub">残り<b>${fmt(o.prizes)}</b>個を<b>${fmt(this.all.length)}</b>人で</div>
          <div class="fxls-result"></div>
        </div>
      </header>
      <div class="fxls-grid"></div>
      <div class="fxls-foot">
        <div class="fxls-rule">${balls}<span class="fxls-rule-t">赤・金・虹の玉が出たら当たり！</span><span class="fxls-rule-w">${ballHtml('white')}白は はずれ</span></div>
        <div class="fxls-dc">はずれた人には<b>ダブルチャンスの玉 ${DC_BALLS} 個</b>${tokens}</div>
      </div>
      <div class="fxls-pops"></div>`,
    )
    this.root.append(this.dim, this.body, el('div', 'fxls-glow'))

    // 名前の札（「？」の玉は、発表の瞬間に王冠か白い玉に替わる）
    const g = layout(this.shown.length + (this.hidden.length ? 1 : 0))
    const grid = this.$('.fxls-grid')
    grid.style.setProperty('--fs', `${g.fs}px`)
    grid.style.setProperty('--sd', `${g.sd}px`)
    grid.style.setProperty('--pad', `${g.pad}px`)
    const card = (i: number, cls: string, html: string): HTMLElement => {
      const { x, y } = g.at(i)
      const node = el('div', `fxls-card${cls}`, html)
      node.style.cssText =
        `left:${x.toFixed(0)}px; top:${y.toFixed(0)}px; width:${g.cw.toFixed(0)}px; height:${g.ch.toFixed(0)}px;` +
        `--fx:${(DRUM.x - x - g.cw / 2).toFixed(0)}px; --fy:${(DRUM.y - y - g.ch / 2).toFixed(0)}px;` +
        `--dk:${(i * 0.06).toFixed(2)}; --wob:${(-Math.random() * 1.5).toFixed(2)}s`
      grid.append(node)
      this.centers.push({ x: x + g.cw / 2, y: y + g.ch / 2 })
      this.slots.push({ x: x + g.pad + 3 + g.sd / 2, y: y + g.ch / 2 })
      return node
    }
    this.shown.forEach((e, i) => {
      const label = e.isMe ? 'スマホを回して！' : SPIN_LABELS[i % SPIN_LABELS.length]
      this.cards.push(
        card(
          i,
          e.isMe ? ' me' : '',
          `<div class="fxls-in">
            <div class="fxls-slot"><span class="fxls-q"><i>?</i></span><span class="fxls-res">${e.win ? crown() : ballHtml('white')}</span></div>
            <div class="fxls-txt"><b>${escapeHtml(e.name)}</b><small>${label}</small></div>
          </div>
          ${e.isMe ? '<i class="fxls-me">あなた</i>' : ''}`,
        ),
      )
    })
    if (this.hidden.length) {
      this.more = card(
        this.shown.length,
        ' fxls-more',
        `<div class="fxls-in">
          <div class="fxls-slot"><span class="fxls-q"><i>…</i></span><span class="fxls-res"></span></div>
          <div class="fxls-txt"><b>ほか ${fmt(this.hidden.length)} 人</b><small>みんな スマホで回しています</small></div>
        </div>`,
      )
      this.centers.pop()
      this.slots.pop()
    }

    // 大きな抽選器（スマホと同じ絵）
    this.machine = new GaraponMachine({ size: MACHINE.size })
    this.machine.friction = 0.6
    this.$('.fxls-mwrap').append(this.machine.el)
    this.machine.onFrame = this.onFrame
    // 画面から外されたら（画面の切り替えなど）、その場で止めて解決する
    this.machine.onGone = () => {
      this.tl.cancel()
      this.stopVoice()
    }

    // 粒子の canvas（z-index 60）。動きを減らす設定のときは出さない
    if (!this.rm) {
      const c = el('canvas', 'fxls-canvas')
      c.width = STAGE_W
      c.height = STAGE_H
      this.canvas = c
      this.fx = new Particles(c)
      this.fx.speed = this.tl.speed
    }
    host.append(this.root)
    if (this.canvas) host.append(this.canvas)
    this.machine.start()
  }

  async run(): Promise<void> {
    const { D, T, I } = this
    const fx = this.fx

    // 幕開け: 暗転 → 「ラストワン争奪！」 → 抽選器 → 名前の札が抽選器から配られる
    this.dimTo(0.93, 450)
    this.on('.fxls-kicker')
    await this.until(150)
    this.on('.fxls-title')
    safe(() => sfx.cutin(3))
    fx?.burst(960, 170, { count: 110, colors: GOLD, speed: 11, shape: 'spark', gravity: 0.1, life: 55 })
    await this.until(450)
    this.on('.fxls-sub')
    await this.until(600)
    this.on('.fxls-warm')
    this.on('.fxls-rays')
    this.on('.fxls-mwrap')
    await this.until(750)
    for (const c of this.cards) this.onEl(c)
    if (this.more) this.onEl(this.more)
    this.on('.fxls-rule')
    // 3・2・1（スマホと同じ時刻に出す）
    for (const k of [3, 2, 1]) {
      const t = D - k * 1000
      if (t >= I + 300) this.at(t, () => this.count(k))
    }

    // 全員スマホでガラポン！
    await this.until(I)
    this.phase = 'spin'
    this.root.dataset.phase = 'spin'
    this.on('.fxls-banner')
    this.on('.fxls-hint')
    safe(() => sfx.telop())
    safe(() => (this.voice = sfx.garaponStart()))
    this.lastVoice = -1
    this.machine.cruise = CRUISE

    // 一斉に発表（スマホで玉が出るのと同時）
    await this.until(D)
    this.reveal()

    // 外れた人へのダブルチャンス
    const post = T - D
    const outMs = clamp(post * 0.12, 200, 500)
    await this.until(D + Math.min(700, (post - outMs) * 0.4))
    if (this.all.some((e) => !e.win)) {
      this.$('.fxls-rule').classList.add('off')
      this.on('.fxls-dc')
    }

    // ふわっと消して、T で片付ける
    await this.until(T - outMs)
    const fade = `opacity ${this.tl.ms(outMs)}ms ease`
    this.root.style.transition = fade
    this.root.style.opacity = '0'
    if (this.canvas) {
      this.canvas.style.transition = fade
      this.canvas.style.opacity = '0'
    }
    await this.until(T)
  }

  dispose(): void {
    this.tl.cancel()
    this.stopVoice()
    this.machine.destroy()
    this.fx?.clear()
    this.canvas?.remove()
    this.root.remove()
  }

  // ---- 時間 ----

  // 始まってからの、演出上の ms
  private elapsed(): number {
    return (performance.now() - this.t0) * this.tl.speed
  }

  // 始まりから t ms の時刻まで待つ（待つたびに始まりの時刻から測り直すので、ずれがたまらない）。
  // 取り消されたら（host が外されたときも）CANCELLED を投げて抜ける
  private async until(t: number): Promise<void> {
    const left = t - this.elapsed()
    if (left > 0) await this.tl.wait(left)
    if (this.attached && !this.host.isConnected) this.tl.cancel()
    if (this.tl.cancelled) throw CANCELLED
  }

  // 始まりから t ms の時刻に fn を呼ぶ（待たない）
  private at(t: number, fn: () => void): void {
    this.tl.at(Math.max(0, t - this.elapsed()), fn)
  }

  // ---- 小物 ----

  private $(selector: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(selector)!
  }

  // 付けたクラスの transition が必ず効くように、いったん配置を確定させてから付ける
  private onEl(node: Element, cls = 'on'): void {
    void node.getBoundingClientRect()
    node.classList.add(cls)
  }

  private on(selector: string): void {
    const node = this.root.querySelector(selector)
    if (node) this.onEl(node)
  }

  // 暗転（明るさを下げるだけなので、動きを減らす設定でもなめらかに変える）
  private dimTo(opacity: number, ms: number): void {
    void this.dim.getBoundingClientRect()
    this.dim.style.transition = `opacity ${this.tl.ms(ms)}ms ease`
    this.dim.style.opacity = String(opacity)
  }

  private stopVoice(): void {
    const v = this.voice
    this.voice = null
    if (v) safe(() => v.stop())
  }

  // 3・2・1 の数字（0 で消す）。1 秒に 1 回だけ出る
  private count(k: number): void {
    const box = this.$('.fxls-count')
    box.innerHTML = k > 0 ? `<b>${k}</b>` : ''
    const b = box.firstElementChild as HTMLElement | null
    if (!b) return
    void b.offsetWidth
    b.classList.add('tick')
    safe(() => sfx.countdown(k))
  }

  // 揺れ（金のときだけ使う。8px 以内、300ms 以内）
  private shake(px: number, ms: number): void {
    if (this.rm) return
    const a = Math.min(8, px)
    const frames = [0, a, -a * 0.8, a * 0.55, -a * 0.3, 0].map((x, i) => ({
      transform: `translate(${x}px, ${(i % 2 ? -0.4 : 0.3) * x}px)`,
    }))
    this.body.animate(frames, { duration: Math.min(300, this.tl.ms(ms)), easing: 'linear' })
  }

  // 全面の光。1 回の演出につき 1 回まで、明るさの変化は 14%、立ち上がりは 150ms 以上
  private glow(): void {
    if (this.rm || this.glowed) return
    this.glowed = true
    const rise = Math.max(150, this.tl.ms(220))
    const fall = Math.max(450, this.tl.ms(700))
    this.$('.fxls-glow').animate([{ opacity: 0 }, { opacity: 0.14, offset: rise / (rise + fall) }, { opacity: 0 }], {
      duration: rise + fall,
      easing: 'ease-out',
    })
  }

  // ---- 全員で回している ----

  private readonly onFrame = (dt: number): void => {
    // 発表が近づくほど、会場のガラガラを少しずつ速くする（音だけ。大きな絵はゆっくりのまま）
    if (this.voice) {
      const p = clamp((this.elapsed() - this.I) / Math.max(1, this.D - this.I), 0, 1)
      const rps = 0.6 + 1.3 * p * p
      if (Math.abs(rps - this.lastVoice) > 0.02) {
        this.lastVoice = rps
        const v = this.voice
        safe(() => v.setSpeed(rps))
      }
    }
    // 会場のあちこちの札から「ガラガラ」が聞こえてくる（実時間で 1 秒に 1.7 回まで）
    if (this.phase === 'spin' && !this.rm) {
      this.popAcc += dt
      if (this.popAcc > 0.6) {
        this.popAcc = 0
        this.pop()
      }
    }
  }

  private pop(): void {
    const n = this.popN++
    const side = n % 2 ? 1 : -1
    let x = DRUM.x + side * (180 + Math.random() * 70)
    let y = DRUM.y - 130 + Math.random() * 170
    if (this.slots.length && n % 3 !== 2) {
      const s = this.slots[Math.floor(Math.random() * this.slots.length)]
      x = s.x + 14
      y = s.y - 58
    }
    const word = el('div', 'fxls-pop', POP_WORDS[n % POP_WORDS.length])
    word.style.left = `${x.toFixed(0)}px`
    word.style.top = `${y.toFixed(0)}px`
    word.style.setProperty('--r', `${side * (4 + Math.random() * 8)}deg`)
    this.$('.fxls-pops').append(word)
    this.tl.at(1600, () => word.remove())
  }

  // ---- 一斉に発表 ----

  private reveal(): void {
    const { D } = this
    this.phase = 'reveal'
    this.root.dataset.phase = 'reveal'
    this.stopVoice()
    this.count(0)
    this.machine.cruise = 0
    const winners = this.all.filter((e) => e.win)
    const losers = this.all.length - winners.length

    // 札をいっせいに開ける（当たりは王冠、外れは白い玉）
    this.cards.forEach((card, i) => {
      const win = this.shown[i].win
      card.classList.add('done', win ? 'win' : 'lose')
      const label = card.querySelector('small')
      if (label) label.textContent = win ? '★ ラストワン賞' : 'はずれ'
    })
    const more = this.more
    if (more) {
      const w = this.hidden.filter((e) => e.win).length
      more.querySelector('.fxls-res')!.innerHTML = w ? crown() : ballHtml('white')
      more.classList.add('done', w ? 'some' : 'lose')
      const label = more.querySelector('small')
      if (label) label.textContent = w ? `うち ${fmt(w)} 人が当たり` : 'みんな はずれ'
    }

    // 見出しの下に「○○ さんが獲得！」、抽選器の下に人数
    this.$('.fxls-sub').classList.add('off')
    const result = this.$('.fxls-result')
    result.innerHTML = winnerText(winners)
    this.onEl(result)
    // 人数は「全員スマホでガラポン！」が消えてから出す（重ならないように）
    const tally = this.$('.fxls-tally')
    tally.innerHTML = winners.length
      ? `<b>★ 当たり ${fmt(winners.length)} 人</b><small>はずれ ${fmt(losers)} 人</small>`
      : `<b>当たりは なし</b><small>はずれ ${fmt(losers)} 人</small>`
    this.at(D + 320, () => this.onEl(tally))

    safe(() => sfx.lastOne(winners.length > 0))
    if (winners.length) {
      this.shake(5, 240)
      this.glow()
      const fx = this.fx
      const lit = this.shown.filter((e) => e.win).length
      const count = Math.round(clamp(220 / Math.max(1, lit), 40, 150))
      this.shown.forEach((e, i) => {
        if (!e.win) return
        const c = this.centers[i]
        fx?.burst(c.x, c.y, { count, colors: GOLD, speed: 12, shape: 'spark', gravity: 0.12, life: 60 })
        fx?.burst(c.x, c.y, { count: Math.round(count / 3), colors: ['#ffffff', '#fff4cc'], speed: 7, shape: 'dot', gravity: 0.05, life: 50 })
      })
      this.at(D + 450, () => fx?.rain(200, GOLD))
    }
    // 外れの札は、白い玉を見せてから暗くする（自分の「あなた」の印は残す）
    this.at(D + 380, () => {
      this.cards.forEach((card, i) => {
        if (!this.shown[i].win) card.classList.add('out')
      })
      if (more?.classList.contains('lose')) more.classList.add('out')
    })
  }
}
