import { sfx } from '../../audio'
import type { Beat, BeatKind } from '../../core/show'
import { FLIP_EASING, MACHINE, flipPlan, landingOf, maStopMs, motionAt, pseudoPlan, reelRun, slotOf, type ReelRun } from '../landing'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { GOLD, HEAT_LABEL, MY_TIER_WORD, RAINBOW, TIER_SHAPE, TIER_WORD, type MachineStyle, type Tier } from '../theme'
import { txt, type AoriOutcome } from './aori'
import { boxIn, play, ring, settle, shake, sparkBurst } from './card'
import './spin.css' // card.css・aori.css より後に読み込む（カードのマスを照らす規則はここにある。縁取り文字 .fxa-txt の色もここで決める）

// 手元の抽選演出（390×844 のスマホ画面に重ねる）。この画面が答える問いは 1 つ: 「この番号は、自分のカードに当たりそうか」。
// 大画面と同じ拍の列（beats）を同じ時刻でなぞり、色と「どこまで上がるか」だけを、自分のカードにとっての段階（tier）に合わせる。
// 入力は受けない（タップは下へ通す）。
//   - 主語を形で分ける: 「外は会場、内は自分」。画面のふちの光は会場の色（大画面と同じ色）、内側のパネル（リールの枠・自分の段）は
//     自分の色。パネルの頭に、同じ形の 2 段を常に出す:「会場 ◆ ビンゴが出るかも！」（TIER_WORD）と
//     「あなた ▲ 当たるかも？」（MY_TIER_WORD: 当たるかも？ → リーチかビンゴかも！ → ビンゴのチャンス！ → ビンゴ確定！）。
//     自分の段の右には、期待度のランプ（▲ ◆ ★ ✦）が並ぶ。カットインには「あなたに」の札を付ける
//   - 大画面より低い段階なら途中で上がり止まるか、静かなまま。高ければ（自分のリーチ・ビンゴに絡む回）手元だけで上げる（昇格！）。
//     虹は自分のビンゴ確定のときだけ（時が止まる → 窓のガラスにヒビ → 「ビンゴ確定！」）
//   - オリパのお約束の合図:
//       昇格: 途中で色が上がる
//       復活: 青・緑のままだったのにリーチ・ビンゴになった回は、「はずれ…？」→ 一瞬の暗転（プチュン）→ 当たりに覆る
//   - 番号は大画面の公開と同時に出す。着地の時刻は fx/landing.ts のモデル（大画面の抽選機と同じ数字）で求める
//
//   const spin = new HandSpin(phone, { speed, sound: 'personal' })   // 本番のスマホは sound: 'all'
//   spin.start({ tier: 2, waiting: ['O65'], pool, beats, revealAt: t.reveal, venueTier: 1, venueVariant: style })   // drawScheduled
//   spin.awaitPush()                                  // 金・虹の回だけ（大画面が、司会の合図（公開）を待ちはじめた）
//   await spin.reveal(48)                             // numberRevealed（大画面の公開と同時）
//   await spin.resolve({ outcome: 'double', label: 'G48' })
//   await card.stamp(13) …                            // スタンプ・リーチの札・BINGO は組み込み側で
//
// 層は host 全体（inset 0、z-index 12、pointer-events: none）。本体（あなたの期待度・リールの窓・「あと O65」）は y 530〜830（--fxs-top）。
// 赤以上では画面を暗くし、同じ host の中にある CardView の「あと 1 つ」のマス（.fxc-cell.is-wait）だけを照らして脈動させる。
// 音: sound が 'personal'（既定）なら、自分だけの音（自分の段階が上がる・確定・復活・成功・失敗）だけを鳴らす
//     （デモは大画面と同じ PC から鳴るため）。'all' なら、回り出し・期待度の目盛り・着地の音も鳴らす（本番のスマホ）

export interface HandSpinStart {
  tier: Tier // 自分のカードにとっての段階（0 青〜3 金、4 虹は自分のビンゴ確定）
  waiting: readonly string[] // 「あと O65」
  pool: readonly number[] // リールに流す候補（まだ出ていない番号）
  beats: readonly Beat[] // 大画面と同じ拍の列（at は start からの ms）
  revealAt: number // 大画面の公開の予定時刻（ms）。金・虹は、ここから司会の合図（公開）を待つ
  venueTier: Tier // 大画面の段階
  // 大画面の抽選機の型（権威が決めて配る）。カードめくり型・パタパタ型は、着地の衝撃が少し遅い。省略するとリール型にそろえる
  venueVariant?: MachineStyle
}

export type HandSpinSound = 'personal' | 'all'

type Phase = 'idle' | 'run' | 'push' | 'landing' | 'landed' | 'result'
type Code = number // リールのコマ: 1〜75 = 番号、0 = 空白、-1 = ？、-2 = 回る前の「--」

const BLANK = 0
const Q = -1
const DASH = -2

// 手元の窓は、いつもリール型で描く（大画面がどの型でも。速さの変え方は fx/landing.ts の reelRun と同じ）
const STYLE: MachineStyle = 'reel'
// 大画面の熱についていく拍（自分の段階で頭打ちにする）
const FOLLOW: ReadonlySet<BeatKind> = new Set<BeatKind>(['holdChange', 'step', 'cutin', 'group', 'pseudo', 'telop', 'riser', 'heartbeat', 'goldEdge'])
// 自分だけで段階を上げるとき、寄せる先の大画面の拍
const ANCHOR: ReadonlySet<BeatKind> = new Set<BeatKind>(['step', 'cutin', 'group', 'pseudo', 'telop', 'riser', 'heartbeat', 'decel'])
const MAX_RPS = 13 // 手元のリールの見た目の速さの上限（コマ / 実時間の秒）。ぼかしと合わせて、ちらつきにしない
const ROW = 64 // リールの 1 コマの高さ（px）
const RAISE_GAP = 900 // 自分の段階を上げる間隔の最小（演出上の ms）。大きな演出が重なりすぎないように
const HEART_MS = 625 // 大画面の鼓動の間隔（96 bpm）
const LIGHT: Readonly<Record<Tier, string>> = { 0: '#93c5fd', 1: '#86efac', 2: '#fca5a5', 3: '#fff4cc', 4: '#ffffff' }
const COLORS: Readonly<Record<Tier, readonly string[]>> = {
  0: ['#3b82f6', '#9cc3ff', '#ffffff'],
  1: ['#22c55e', '#5aff8c', '#eafff0'],
  2: ['#ef4444', '#ffb03a', '#fff2a8', '#ffffff'],
  3: GOLD,
  4: RAINBOW,
}
// 2 段の言葉（青は、会場も自分も「静か」）
const LAMP_WORD = ['静か', MY_TIER_WORD[1], MY_TIER_WORD[2], MY_TIER_WORD[3], MY_TIER_WORD[4]] as const
const VENUE_WORD = ['静か', TIER_WORD[1], TIER_WORD[2], TIER_WORD[3], TIER_WORD[4]] as const
// 結果は、何が起きたかをそのまま言う
const HERO_TEXT: Readonly<Record<Exclude<AoriOutcome, 'none'>, string>> = {
  hit: 'カードにヒット！',
  reach: 'リーチ！',
  double: 'ダブルリーチ！',
  bingo: 'ビンゴ！',
}
const OUT_POWER: Readonly<Record<AoriOutcome, number>> = { none: 0, hit: 0, reach: 1, double: 2, bingo: 3 }
const FAIL_TEXT = 'はずれ…'
const UP_TAG = '<em class="fxs-up">昇格！</em>' // オリパのお約束: 途中で色が上がる
// カットインの頭に付ける札。大画面の「ビンゴが出そう！」（会場の話）と、だれの話かで見分けられるようにする
const tagsHtml = (up: boolean): string => `<span class="fxs-tags"><em class="fxs-me">あなたに</em>${up ? UP_TAG : ''}</span>`

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const pickOne = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]
const tierOf = (t: number): Tier => clamp(Math.round(t), 0, 4) as Tier
const colOf = (n: number): number => clamp(Math.floor((n - 1) / 15), 0, 4)
const letterOf = (n: number): string => 'BINGO'[colOf(n)]
const numOf = (label: string): number => Number(/\d+/.exec(label)?.[0] ?? NaN)

// リールのコマの中身: 列の文字の玉と番号（「B 12」）
function codeHtml(c: Code): string {
  if (c === Q) return '<b class="fxs-q">?</b>'
  if (c === DASH) return '<b class="fxs-dash">--</b>'
  if (c <= 0) return ''
  return `<i class="fxs-l">${letterOf(c)}</i><b class="fxs-n">${c}</b>`
}

// 叩きつける段階の言葉（自分のカードの話）。up は昇格（途中で色が上がった）
function emblemHtml(t: Tier, up: boolean): string {
  return `${tagsHtml(up)}${txt(`${TIER_SHAPE[t]}${MY_TIER_WORD[t]}`)}${t === 4 ? '<small>あなたのカードがそろいます</small>' : ''}`
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

// ---- 虹（自分のビンゴ確定）の時刻 ---------------------------------------------------

interface KakuteiPlan {
  freezeAt: number // 時が止まる
  crackAt: number // ヒビが走る
  at: number // 「確定」
}

// 虹（自分のビンゴ確定）の時刻。大画面に確定の拍があればそれにそろえ、なければ大画面の山場（金の縁・赤のカットイン・ライザー・鼓動）に重ねる
function planKakutei(list: readonly Beat[], r: number): KakuteiPlan {
  const k = list.find((b) => b.kind === 'kakutei')
  if (k) {
    const f = list.find((b) => b.kind === 'freeze' && b.at < k.at)
    const c = list.find((b) => b.kind === 'crack' && b.at < k.at)
    const freezeAt = f ? f.at : Math.max(0, k.at - 1370)
    return { freezeAt, crackAt: c ? c.at : Math.max(freezeAt + 200, k.at - 720), at: k.at }
  }
  // 金の縁（大画面のカードが金の箔に裏返る）があれば、そこで「確定」。なければ、公開にいちばん近い山場
  const ok = (b: Beat) => b.at >= 1900 && b.at <= r - 1700
  const gold = list.find((b) => b.kind === 'goldEdge' && ok(b))
  const peaks = list.filter((b) => ok(b) && ((b.kind === 'cutin' && (b.tier ?? 0) >= 2) || b.kind === 'riser' || b.kind === 'heartbeat'))
  const peak = gold ? gold.at : peaks.length ? peaks[peaks.length - 1].at : Math.max(Math.min(1900, r - 1200), r - 2400)
  const freezeAt = Math.max(400, peak - 1370)
  const at = Math.max(peak, freezeAt + 700)
  return { freezeAt, crackAt: Math.max(freezeAt + 200, at - 720), at }
}

// ---- リールの動き ----------------------------------------------------------------

interface Tween {
  p0: number
  v0: number
  p1: number
  T: number
  t: number
  done: () => void
}

// リールの位置（コマ単位）と速さ（コマ / 実時間の ms）。大画面の抽選機（stage/draw.ts の Strip）と同じ考え方で、
// 止めるときは 3 次エルミート曲線で、今の速さからなめらかに減速して目標のコマに、指定の時刻ぴったりに止める。
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

  // 減速して、T ms ちょうどで c のコマに止まる。止まった瞬間に解決する。
  // creep は最後をじわじわ滑らせる（期待の高い回）。before は止まる直前に中央を通るコマ、after は止めたコマの上に置くコマ
  stopOn(c: Code, T: number, minD: number, creep: boolean, before: Code, after: Code): Promise<void> {
    this.release()
    const p0 = this.pos
    const v0 = Math.max(0, this.v)
    // 一定の減速なら v0·T/2 進む。creep は v0·T/3（行き過ぎない最小。最後に長く滑る）
    const p1 = Math.ceil(p0 + Math.max(minD, (v0 * T) / (creep ? 3 : 2)) - 1e-6)
    this.set(p1, c)
    this.set(p1 + 1, after)
    // 手前のコマは、まだ見えていないときだけ差し替える（いま見えている番号が急に変わらないように）
    if (p1 - 1 > p0 + 1.4) this.set(p1 - 1, before)
    this.goal = 0
    return new Promise((done) => {
      this.tw = { p0, v0, p1, T: Math.max(1, T), t: 0, done }
    })
  }

  // 止めた状態で c を見せる（見えていない先のコマへ飛ぶ）
  jumpTo(c: Code, below: Code = BLANK, above: Code = BLANK): void {
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

// ---- 手元の抽選演出 ----------------------------------------------------------------

interface Parts {
  dim: HTMLCanvasElement
  wash: HTMLElement
  rays: HTMLElement
  cut: HTMLElement
  flock: HTMLElement
  emblem: HTMLElement
  body: HTMLElement
  lamp: HTMLElement
  meter: HTMLElement[]
  venue: HTMLElement
  win: HTMLElement
  reel: HTMLElement
  rows: { node: HTMLElement; i: number; c: Code }[]
  cover: HTMLElement
  next: HTMLElement
  msg: HTMLElement
  wait: HTMLElement | null
  fx: HTMLElement
  flash: HTMLElement
  dark: HTMLElement
}

export class HandSpin {
  readonly el: HTMLElement
  private tl: Timeline // 演出（くり返しの動きを含む）。resolve で結果の演出に切り替える
  private sched: Timeline // 大画面の拍と、自分の段階を上げる予定。公開で打ち切る
  private speed: number
  private readonly sound: HandSpinSound
  private gen = 0 // start / cancel ごとに増やす（古い演出の続きが、新しい回を書き換えないように）
  private dead = false
  private phase: Phase = 'idle'
  private parts: Parts | null = null
  private px: Particles | null = null
  private reel = new Reel(() => this.pick())
  private o: HandSpinStart = { tier: 0, waiting: [], pool: [], beats: [], revealAt: 0, venueTier: 0 }
  private beats: Beat[] = []
  private tier: Tier = 0
  private cap: Tier = 0 // 大画面についていく上限（虹は「確定」までの上限）
  private shown: Tier = 0 // いま見せている段階
  private pending: Tier = 0 // 上げたい段階（間隔をあけるため、少し待つことがある）
  private queued = false
  private lastRaise = -1e9
  private extra = false // 自分だけで上げている（大画面より熱い）
  private bandAt = -1e9 // カットインの帯を出した時刻と段階（帯で知らせたら、ランプの演出を重ねない）
  private bandTier = 0
  private venueHeat: Tier = 0
  private kk: KakuteiPlan | null = null
  private kakuteiOn = false
  private frozen = false
  private held = { cover: false, q: false, push: false } // 時が止まっている間に来た拍
  private covered = false
  private calm = false // 間（ま）に入った（鼓動を止める）
  private rising = false
  private still = false
  private pool: number[] = []
  private waits: number[] = []
  private lastPick = 0
  private n: number | null = null
  private landed: Promise<void> = Promise.resolve()
  private onLanded: (() => void) | null = null
  // 時計: start からの演出上の ms。速度を切り替えたら、そこまでの分を確定してから数え直す
  private e0 = 0
  private t0 = 0
  private msgText = ''
  private flashed = false // 全面の光は 1 回の演出につき 1 回まで
  private beating = false
  private dusting = false
  private dustColors: readonly string[] = GOLD
  private lit: HTMLElement[] = []
  private dimLevel = 0
  private raf = 0
  private last = 0
  private blur = -1
  private drawnPos = Number.NaN // 最後に描いたリールの位置と速さ（変わっていなければ描き直さない）
  private drawnV = Number.NaN
  private readonly gates = new Map<string, number>()

  constructor(host: HTMLElement, o: { speed?: number; sound?: HandSpinSound } = {}) {
    this.el = el('div', 'fxs')
    host.append(this.el)
    this.speed = o.speed && o.speed > 0 ? o.speed : 1
    this.sound = o.sound ?? 'personal'
    this.tl = new Timeline(this.speed)
    this.sched = new Timeline(this.speed)
    this.applyLoops()
  }

  setSpeed(speed: number): void {
    if (!(speed > 0)) return
    this.e0 = this.now()
    this.t0 = performance.now()
    this.speed = speed
    this.tl.speed = speed
    this.sched.speed = speed
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
    this.el.style.setProperty('--fxs-k', String(1 / s))
  }

  // start からの演出上の ms
  private now(): number {
    return this.e0 + (performance.now() - this.t0) * this.speed
  }

  start(o: HandSpinStart): void {
    if (this.dead) return
    this.reset()
    const tier = tierOf(o.tier)
    this.o = { ...o, tier, venueTier: tierOf(o.venueTier), revealAt: Math.max(0, o.revealAt) }
    this.beats = [...o.beats].sort((a, b) => a.at - b.at)
    this.tier = tier
    // 虹は「確定」の前に、大画面にどこまでついていくかを毎回変える（静かなまま突然・緑・赤・金からの昇格）
    this.cap = tier === 4 ? pickOne<Tier>([0, 1, 2, 3, 3]) : tier
    this.still = prefersReducedMotion()
    this.pool = o.pool.filter((x) => Number.isInteger(x) && x >= 1 && x <= 75)
    this.waits = o.waiting.map(numOf).filter((x) => x >= 1 && x <= 75)
    this.e0 = 0
    this.t0 = performance.now()
    this.landed = new Promise((r) => (this.onLanded = r))
    this.phase = 'run'
    const p = (this.parts = this.build(o.waiting))
    this.setLamp(0, false)
    this.setVenue(0, false, true)
    this.reel.jumpTo(DASH)
    this.drawReel()
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
    this.msg('この番号は、あなたのカードに当たる？')
    // 予定を組む: 大画面の拍をなぞる・自分だけで段階を上げる・虹の確定
    const s = this.sched
    this.beats.forEach((b, i) => s.at(b.at, () => this.onBeat(b, slotOf(this.beats, i))))
    if (!this.beats.some((b) => b.kind === 'spin' || b.kind === 'goldEdge' || b.kind === 'freeze')) s.at(300, () => this.runReel(reelRun.spin(STYLE)))
    if (tier === 4) this.kk = planKakutei(this.beats, this.o.revealAt)
    this.planExtra()
    if (this.kk) this.scheduleKakutei(this.kk)
    this.last = 0
    this.raf = requestAnimationFrame(this.frame)
  }

  // 大画面が、司会の合図（公開）を待ちはじめた（金・虹）。番号は見せず、溜めたまま一緒に待つ
  awaitPush(): void {
    if (this.phase !== 'run') return
    if (this.frozen) {
      this.held.push = true
      return
    }
    this.phase = 'push'
    this.el.dataset.phase = 'push'
    this.el.classList.add('is-push')
    this.endRise()
    this.msg('まもなく番号が開きます')
    if (this.still) return
    // ゆっくりした鼓動で待つ（自分の段階が赤以上のとき。1 秒に約 1 回より速くしない）
    const tl = this.tl
    void (async () => {
      while (!tl.cancelled && this.phase === 'push') {
        await tl.wait(Math.max(1200, 700 * tl.speed))
        if (!tl.cancelled && this.phase === 'push' && this.shown >= 2) this.beat(tl, 1200)
      }
    })()
  }

  // 大画面の公開と同時に呼ぶ。大画面の番号が見える時刻に、手元のリールを n に着地させる。着地の演出が一段落したら解決する
  async reveal(n: number): Promise<void> {
    if (this.phase !== 'run' && this.phase !== 'push') return
    const p = this.parts
    if (!p || !Number.isInteger(n) || n < 1 || n > 75) return
    const tl = this.tl
    const gen = this.gen
    // 大画面の抽選機が、いまどう動いていて、いつ着地するか（fx/landing.ts。大画面と同じ数字）
    const style = this.o.venueVariant ?? 'reel'
    const L = landingOf(motionAt(this.beats, this.now(), style), style, this.o.venueTier)
    this.n = n
    // これからの拍と、段階を上げる予定は打ち切る
    this.sched.cancel()
    this.sched = new Timeline(this.speed)
    this.phase = 'landing'
    this.el.dataset.phase = 'landing'
    this.el.classList.remove('is-push')
    this.endRise()
    // まだ見せていない段階があれば、ここで出す（最後に見せる段階は必ず tier）
    this.catchUp()
    const after = this.pickOther(n)
    const show = () => this.reel.jumpTo(n, this.pickOther(n, after), after)
    if (this.covered) {
      // 裏向き（金の箔）から: 大画面のカードと同じ間合いで、ぐっと縮めてからめくる
      show()
      this.uncover(tl)
    } else if (L.flip) {
      // 大画面は裏向きなのに、手元にふたがない（虹の確定の途中で公開になったときなど）: 大画面の表が見える時刻に切り替える
      tl.at(L.visible, show)
    } else if (!this.still) {
      // 回っている（または「？」で止まっている）リールを、大画面と同じ時刻に n へ着地させる
      const real = Math.max(1, tl.ms(L.land))
      const creep = this.tier >= 2 && this.reel.v * real >= 1.5
      const before = creep ? this.teaseFor(n) : this.pickOther(n, after)
      void this.reel.stopOn(n, real, creep ? 3 : MACHINE[STYLE].minStop, creep, before, after)
    }
    await tl.wait(L.land)
    if (tl.cancelled || gen !== this.gen) return
    this.reel.snap()
    if (this.still && !this.covered) show() // 動きを減らす設定: 着地の時刻に、番号へ切り替えるだけ
    this.land()
    await tl.wait(220)
  }

  async resolve(o: { outcome: AoriOutcome; label: string }): Promise<void> {
    if (this.phase === 'idle' || this.phase === 'result') return
    const gen = this.gen
    if (this.phase === 'run' || this.phase === 'push') {
      // 公開を呼ばずに結果が来た: ラベルの番号で着地させてから
      await this.reveal(numOf(o.label))
      if (gen !== this.gen) return
    }
    if (this.phase === 'landing') {
      await this.landed
      if (gen !== this.gen) return
    }
    this.phase = 'result'
    this.el.dataset.phase = 'result'
    // 溜めの演出（鼓動・立ち上る粒子）を止めて、結果の演出に切り替える
    this.sched.cancel()
    this.tl.cancel()
    const tl = (this.tl = new Timeline(this.speed))
    const t = this.tier
    if (o.outcome === 'none') {
      // あおったのに外れた
      if (t >= 1 && t <= 3) await this.fail(tl, o.label)
      else await this.quiet(tl)
    } else {
      // 復活: 青・緑のままだったのに、リーチ・ビンゴになった
      const revived = t <= 1 && o.outcome !== 'hit'
      if (revived) await this.revive(tl)
      if (!tl.cancelled) await this.success(tl, o.outcome, revived)
    }
    // 途中で start / cancel されたら、新しいほうを消さない
    if (this.gen === gen) this.reset()
  }

  // 途中でも片付ける
  cancel(): void {
    this.reset()
  }

  destroy(): void {
    this.reset()
    this.dead = true
    this.el.remove()
  }

  // ---- 組み立て -------------------------------------------------------------

  private build(waiting: readonly string[]): Parts {
    const nums = waiting.map(numOf)
    const waits = waiting.length
      ? `<div class="fxs-wait" data-count="${Math.min(3, waiting.length)}"><small>あと</small><span>${waiting
          .map((w, i) => `<b data-n="${nums[i]}">${escapeHtml(w)}</b>`)
          .join('')}</span></div>`
      : ''
    this.el.className = 'fxs'
    this.el.dataset.tier = '0'
    this.el.dataset.phase = 'run'
    this.el.innerHTML = `
      <canvas class="fxs-dim"></canvas>
      <i class="fxs-edge"></i>
      <i class="fxs-wash"></i>
      <div class="fxs-rays"><i></i></div>
      <div class="fxs-cut"><div class="fxs-cut-band"><i></i><i></i><i></i><div class="fxs-cut-txt"></div></div></div>
      <div class="fxs-flock"></div>
      <div class="fxs-body${waits ? ' has-wait' : ''}">
        <div class="fxs-head">
          <div class="fxs-who fxs-venue"><small>会場</small><i></i><b></b></div>
          <div class="fxs-who fxs-lamp"><small>あなた</small><i></i><b></b><span class="fxs-meter" title="${HEAT_LABEL.mine}">${([1, 2, 3, 4] as const)
            .map((k) => `<u data-k="${k}">${TIER_SHAPE[k]}</u>`)
            .join('')}</span></div>
        </div>
        <div class="fxs-win">
          <div class="fxs-reel">${'<div class="fxs-row"></div>'.repeat(5)}</div>
          <div class="fxs-cover"><b>?</b></div>
          <div class="fxs-next"><b>まだ止まらない！</b><em></em></div>
          <i class="fxs-glass"></i>
          <i class="fxs-pay is-l">▶</i><i class="fxs-pay is-r">◀</i>
        </div>
        <div class="fxs-msg"></div>
        ${waits}
      </div>
      <canvas class="fxs-px"></canvas>
      <div class="fxs-emblem"></div>
      <div class="fxs-fx"></div>
      <i class="fxs-flash"></i>
      <i class="fxs-dark"></i>`
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
      flock: $('.fxs-flock'),
      emblem: $('.fxs-emblem'),
      body: $('.fxs-body'),
      lamp: $('.fxs-lamp'),
      meter: [...this.el.querySelectorAll<HTMLElement>('.fxs-meter u')],
      venue: $('.fxs-venue'),
      win: $('.fxs-win'),
      reel: $('.fxs-reel'),
      rows: [...this.el.querySelectorAll<HTMLElement>('.fxs-row')].map((node) => ({ node, i: Number.NaN, c: Number.NaN })),
      cover: $('.fxs-cover'),
      next: $('.fxs-next'),
      msg: $('.fxs-msg'),
      wait: this.el.querySelector<HTMLElement>('.fxs-wait'),
      fx: $('.fxs-fx'),
      flash: $('.fxs-flash'),
      dark: $('.fxs-dark'),
    }
  }

  // ---- 毎フレーム -------------------------------------------------------------

  private readonly frame = (now: number): void => {
    this.raf = 0
    if (this.phase === 'idle') return
    const dt = Math.min(64, Math.max(0, now - (this.last || now)))
    this.last = now
    const crossed = this.reel.update(dt)
    // 着地の間だけ、コマ送りの音（本番のスマホだけ。デモは大画面の音と重なるので鳴らさない）
    if (crossed > 0 && this.phase === 'landing' && this.sound === 'all' && this.gate('tick', 70)) sfx.tick()
    // 止まっている間は、描き直さない（位置も速さも変わっていなければ、5 行のスタイルを書き直す意味がない）
    if (this.reel.pos !== this.drawnPos || this.reel.v !== this.drawnV) this.drawReel()
    this.raf = requestAnimationFrame(this.frame)
  }

  // 大画面のリールと同じ速さに向かう（演出上の速さを実時間に直し、見た目の上限で止める）
  private runReel(r: ReelRun): void {
    if (this.still || this.covered || this.frozen || (this.phase !== 'run' && this.phase !== 'push')) return
    this.reel.run(Math.min(MAX_RPS / 1000, r.v * this.speed), r.ease / this.speed)
  }

  // ---- 大画面の拍 -------------------------------------------------------------

  private onBeat(b: Beat, slot: number): void {
    if (this.phase !== 'run' && this.phase !== 'push') return
    this.setVenue(tierOf(b.heat), true)
    if (this.frozen) {
      // 時が止まっている間（虹）は、状態だけ覚えておき、動き出したら合わせる
      if (b.kind === 'goldEdge' || b.kind === 'freeze') this.held.cover = true
      if (b.kind === 'ma' || b.kind === 'freeze') this.held.q = true
      if (b.kind === 'push') this.held.push = true
      return
    }
    // 拍の段階を、自分の段階で頭打ちにする
    const c = Math.min(this.cap, tierOf(b.tier ?? b.heat)) as Tier
    switch (b.kind) {
      case 'spin':
        this.runReel(reelRun.spin(STYLE))
        if (this.sound === 'all') sfx.spinStart()
        if (this.still) this.reel.jumpTo(Q)
        break
      case 'holdChange':
        this.echo()
        break
      case 'step':
        // 大画面の「ビンゴ期待度」の目盛りが 1 段上がった。手元の目盛りは自分の期待度だけなので、ランプが小さく弾むだけにする
        this.echo()
        if (this.sound === 'all') sfx.spinLevel(Math.min(4, (b.index ?? 0) + 1), c)
        break
      case 'cutin': {
        // 大画面のカットインと同じ時刻に、自分の段階の色と言葉で（青のままなら出さない。すでに上なら、いまの段階を言い直す。
        // 虹の確定のあとは出さない）
        const t = Math.max(c, this.shown) as Tier
        if (t >= 1 && t <= 3) void this.band(this.tl, t, t > this.shown && this.shown >= 1)
        break
      }
      case 'group':
        this.flock(slot)
        break
      case 'pseudo':
        void this.pseudo(b.index ?? 0, slot)
        break
      case 'telop':
        if (b.text) this.msg(escapeHtml(b.text))
        break
      case 'decel':
        this.runReel(reelRun.decel(slot))
        break
      case 'riser':
        this.riser(b.dur ?? 1200)
        break
      case 'heartbeat':
        this.venueHeartbeat(b.dur ?? 1400)
        break
      case 'ma':
        this.ma(b.dur ?? 700)
        break
      case 'goldEdge':
        this.cover()
        break
      case 'freeze':
        // 自分が虹でなければ、大画面と同じく金の縁 → 間（ま）として受ける
        this.cover()
        this.ma(slot)
        break
      case 'push':
        this.awaitPush()
        break
      default:
        break
    }
    // 大画面の熱が上がったら、ついていく（自分の段階で止まる）。公開の直前には上げない
    if (FOLLOW.has(b.kind) && c > this.shown && b.at <= this.o.revealAt - 700) this.want(c)
  }

  // 自分のほうが熱い回: 大画面の拍だけでは届かない分を、手元だけで上げる（近くに大画面の拍があれば、そこにそろえる）
  private planExtra(): void {
    const r = this.o.revealAt
    let reach = 0
    let reachAt = 0
    for (const b of this.beats) {
      if (b.at > r - 700 || !FOLLOW.has(b.kind)) continue
      const c = Math.min(this.cap, tierOf(b.tier ?? b.heat))
      if (c > reach) {
        reach = c
        reachAt = b.at
      }
    }
    if (reach >= this.cap) return
    const need = this.cap - reach
    const cover = this.beats.find((b) => b.kind === 'goldEdge' || b.kind === 'freeze')
    const w0 = Math.max(1400, reachAt + 1300)
    const w1 = Math.min(r - 2200, (cover?.at ?? Infinity) - 300, this.kk ? this.kk.freezeAt - 900 : Infinity)
    const anchors = this.beats.filter((b) => ANCHOR.has(b.kind)).map((b) => b.at)
    const times: number[] = []
    if (w1 <= w0) times.push(Math.max(500, Math.min(w0, r - 1200)))
    else for (let k = 0; k < need; k++) times.push(need === 1 ? (w0 + w1) / 2 : w0 + ((w1 - w0) * k) / (need - 1))
    times.forEach((x, k) => {
      const a = anchors.reduce((best, y) => (Math.abs(y - x) < Math.abs(best - x) ? y : best), Infinity)
      const at = Math.abs(a - x) < 500 ? a : x
      const to = (k === times.length - 1 ? this.cap : reach + k + 1) as Tier
      this.sched.at(at, () => {
        this.extra = true
        this.want(to)
      })
    })
  }

  // 段階を上げたい。前に上げてから間がなければ、少し待ってまとめて上げる
  private want(to: Tier): void {
    if (to <= this.shown && to <= this.pending) return
    this.pending = Math.max(this.pending, to) as Tier
    const wait = this.lastRaise + RAISE_GAP - this.now()
    if (wait <= 0) return this.doRaise()
    if (this.queued) return
    this.queued = true
    this.sched.at(wait, () => {
      this.queued = false
      this.doRaise()
    })
  }

  private doRaise(): void {
    const to = this.pending
    if (to <= this.shown || this.frozen || this.kakuteiOn || (this.phase !== 'run' && this.phase !== 'push')) return
    this.lastRaise = this.now()
    this.raise(to)
  }

  // 公開の時点でまだ見せていない段階を、すぐに出す
  private catchUp(): void {
    if (this.tier === 4) {
      if (!this.kakuteiOn || this.frozen) this.kakuteiNow()
    } else if (this.shown < this.tier) {
      this.raise(this.tier, true)
    }
  }

  // ---- オリパの合図 -------------------------------------------------------------

  // 復活（オリパのお約束）: 青・緑のままだったのに、リーチ・ビンゴになった回。外れに見せてから、
  // 一瞬の暗転（プチュン）をはさんで、当たりに覆す。時刻は音に合わせる:
  //   「はずれ…？」→ puchun（0）→ 0.30 秒で暗転 → revive（0.85 秒。底を蹴る）→ 1.25 秒で弾けて明るくなる → 1.85 秒から成功の演出
  // 暗転は 1 回だけ。暗くなるのも戻るのも 120ms 以上かける。このあとの成功では、全面の光を重ねない
  private async revive(tl: Timeline): Promise<void> {
    const p = this.parts
    if (!p) return
    const still = this.still
    this.flashed = true
    this.el.classList.add('is-fail')
    this.fadeAura(tl, 400)
    const miss = this.missPlate(tl, '<b>はずれ…？</b>')
    await tl.wait(480)
    if (tl.cancelled) return
    // プチュン: 音が切れるところ（0.30 秒）で、画面が落ちきる
    sfx.puchun()
    void play(p.dark, [{ opacity: 0 }, { opacity: 0.9 }], 150, tl, { delay: 150, fill: 'both', min: 130, easing: 'ease-in' })
    await tl.wait(850)
    if (tl.cancelled) return
    miss.remove()
    this.el.classList.remove('is-fail')
    // 復活: 暗い中で底を蹴り、0.40 秒後に弾けて、明るさがゆっくり戻る
    sfx.revive()
    vibrate(40)
    const word = el('div', 'fxs-revive', `<div class="fxs-revive-in">${txt('復活！')}</div>`)
    this.el.append(word)
    const inner = word.firstElementChild as HTMLElement
    const W = this.el.clientWidth || 390
    if (still) {
      void play(inner, [{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], 1300, tl, { fill: 'forwards' }).then(() => word.remove())
    } else {
      void play(
        inner,
        [
          { transform: 'translateY(90px) scale(0.3)', opacity: 0, easing: 'cubic-bezier(.3,0,.7,1)' },
          { transform: 'translateY(14px) scale(0.7)', opacity: 0.55, offset: 0.24, easing: 'cubic-bezier(.2,.9,.3,1)' },
          { transform: 'translateY(0px) scale(1.18)', opacity: 1, offset: 0.31 },
          { transform: 'translateY(0px) scale(1)', opacity: 1, offset: 0.4 },
          { transform: 'translateY(0px) scale(1)', opacity: 1, offset: 0.85 },
          { transform: 'translateY(0px) scale(1.25)', opacity: 0 },
        ],
        1300,
        tl,
        { fill: 'forwards', easing: 'linear' },
      ).then(() => word.remove())
      tl.at(400, () => {
        this.px?.burst(W / 2, this.centerY(), { count: 110, colors: [...COLORS[this.tier], '#ffffff', '#ffe08a'], speed: 9, shape: 'spark', life: 55 })
        sparkBurst(p.fx, W / 2, this.centerY(), tl, { count: 14, colors: GOLD, dist: 170, size: 12, ms: 800, shape: 'star' })
      })
    }
    void play(p.dark, [{ opacity: 0.9 }, { opacity: 0 }], 420, tl, { delay: 400, fill: 'both', min: 300 })
    await tl.wait(1000)
  }

  // ---- 段階 -------------------------------------------------------------------

  // 予告が上がる（青 → 緑 → 赤 → 金）。quick は公開のときの早送り
  private raise(to: Tier, quick = false): void {
    if (to <= this.shown || to > 3 || this.kakuteiOn) return
    const tl = this.tl
    const gen = this.gen
    // 昇格（オリパのお約束）: 途中で色が上がった。手元だけで上げるときも、ここに入る
    const up = this.extra || this.shown >= 1
    this.shown = to
    this.el.dataset.tier = String(to)
    if (!quick) sfx.aoriStart(to) // 自分の段階が上がる音（自分だけの音なので、personal でも鳴らす）
    if (to >= 2) {
      this.light(to)
      this.dimOn(tl, to === 2 ? 0.42 : 0.5)
      if (!this.beating) void this.heartbeat(tl)
    }
    if (to === 3) void this.dust(tl, GOLD, 620)
    this.msg(`${up ? '<b>昇格！</b> ' : ''}${TIER_SHAPE[to]} ${MY_TIER_WORD[to]}`)
    // 大画面のカットインの帯で同じ段階を知らせた直後なら、ランプが変わるだけにする
    const told = this.now() - this.bandAt < 1100 && this.bandTier >= to
    if (quick || this.still || told) {
      this.setLamp(to, !this.still)
      if (this.still && !quick) this.showStill(tl, to)
      return
    }
    // 文字がランプに入ったところで、ランプを替える（もう次の段階に進んでいたら替えない）
    const lamp = () => {
      if (gen === this.gen && this.shown === to) this.setLamp(to, true)
    }
    if (to === 2) {
      // 赤: 斜めの帯が走り抜けるカットイン「リーチかビンゴかも！」
      void this.band(tl, 2, up).then(lamp)
      return
    }
    void this.slam(tl, to, to === 1 ? 520 : 760, up).then(lamp)
    tl.at(150, () => {
      const W = this.el.clientWidth || 390
      if (to === 3) shake(this.el.parentElement ?? this.el, tl, 5, 240) // 揺れは金と虹だけ
      this.px?.burst(W / 2, this.centerY(), { count: to === 3 ? 70 : 30, colors: COLORS[to], speed: 7, shape: 'spark', life: 40 })
    })
  }

  // 段階の文字を中央に叩きつけ、hold のあいだ見せてから、本体のランプへ吸い込ませる
  private slam(tl: Timeline, t: Tier, hold: number, up = false): Promise<void> {
    const p = this.parts
    if (!p) return Promise.resolve()
    const box = p.emblem
    for (const n of box.querySelectorAll('*')) n.getAnimations().forEach((a) => a.cancel())
    box.dataset.t = String(t)
    box.innerHTML = `<div class="fxs-em-in">${emblemHtml(t, up)}</div>`
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
    p.emblem.innerHTML = `<div class="fxs-em-in">${emblemHtml(t, false)}</div>`
    const inner = p.emblem.firstElementChild as HTMLElement
    inner.style.transform = `scale(${this.fit(inner).toFixed(3)})` // 画面の幅に収める
    void play(inner, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], 1500, tl, {
      fill: 'forwards',
    })
  }

  // カットイン: 斜めの帯が走り抜け、自分の段階の言葉（当たるかも？・リーチかビンゴかも！・ビンゴのチャンス！）が叩きつけられる
  private band(tl: Timeline, t: Tier, up = false): Promise<void> {
    const p = this.parts
    if (!p || this.still) return Promise.resolve()
    const d = 1000
    const band = p.cut.querySelector<HTMLElement>('.fxs-cut-band')!
    const word = p.cut.querySelector<HTMLElement>('.fxs-cut-txt')!
    this.bandAt = this.now()
    this.bandTier = t
    p.cut.dataset.t = String(t)
    word.innerHTML = `${tagsHtml(up)}${txt(`${TIER_SHAPE[t]}${MY_TIER_WORD[t]}`)}`
    // 言葉が長いので、画面の幅に収まる大きさにする
    word.style.fontSize = ''
    const k = this.fit(word)
    if (k < 1) word.style.fontSize = `${Math.floor(parseFloat(getComputedStyle(word).fontSize) * k)}px`
    for (const n of [band, word, ...band.querySelectorAll(':scope > i')]) n.getAnimations().forEach((a) => a.cancel())
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
        this.px?.burst(x, y + (W / 2 - x) * Math.tan((8 * Math.PI) / 180), { count: 8 + 4 * t, colors: COLORS[t], speed: 8, shape: 'spark', life: 36 })
      }
    })
    tl.at(d, () => p.cut.classList.remove('on'))
    return tl.wait(d)
  }

  // 保留変化・期待度の目盛り（大画面の熱が上がった）: ランプが小さく弾む
  private echo(): void {
    const p = this.parts
    if (!p || this.still) return
    void play(p.lamp, [{ transform: 'scale(1)' }, { transform: 'scale(1.15)', offset: 0.35 }, { transform: 'scale(1)' }], 320, this.tl, { composite: 'add' })
  }

  // 群予告: 裏向きのカードの群れが、カードの上を横切る
  private flock(slot: number): void {
    const p = this.parts
    if (!p || this.still) return
    const d = clamp(slot + 250, 700, 1150)
    const dir = Math.random() < 0.5 ? 1 : -1
    const W = this.el.clientWidth || 390
    const n = 9
    for (let k = 0; k < n; k++) {
      const z = 0.6 + Math.random() * 0.7
      const c = el('i', 'fxs-fc')
      p.flock.append(c)
      const y0 = 150 + Math.random() * 330
      const y1 = y0 + (Math.random() - 0.5) * 140
      const x0 = dir > 0 ? -40 : W + 40
      const x1 = dir > 0 ? W + 40 : -40
      const r0 = (Math.random() - 0.5) * 60
      const r1 = r0 + dir * (100 + Math.random() * 160)
      void play(
        c,
        [{ transform: `translate(${x0}px, ${y0}px) rotate(${r0}deg) scale(${z})` }, { transform: `translate(${x1}px, ${y1}px) rotate(${r1}deg) scale(${z})` }],
        (d * (0.8 + Math.random() * 0.25)) / Math.sqrt(z),
        this.tl,
        { delay: (k * d * 0.3) / n, easing: 'cubic-bezier(.3,.15,.7,.85)', fill: 'backwards' },
      ).then(() => c.remove())
    }
  }

  // 疑似連: 「？」で止まりかけ →「まだ止まらない！」→ 回り直す（大画面と同じ間合い）
  private async pseudo(i: number, slot: number): Promise<void> {
    const p = this.parts
    if (!p || this.covered) return
    const s = this.sched
    const q = pseudoPlan(STYLE, i, slot)
    if (this.still) this.reel.jumpTo(Q)
    else await Promise.race([this.stopQ(q.stop), s.wait(q.stop + 80)])
    await s.wait(q.pause)
    if (s.cancelled || this.covered || this.frozen) return
    this.showNext(i, q.show)
    await s.wait(q.rest)
    if (s.cancelled || this.covered || this.frozen) return
    this.runReel(q.resume)
  }

  private showNext(i: number, d: number): void {
    const p = this.parts
    if (!p) return
    p.next.dataset.i = String(Math.min(2, i))
    p.next.querySelector('em')!.textContent = `${i + 2} 回目`
    if (this.still) {
      void play(p.next, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], d, this.tl)
      return
    }
    void play(
      p.next,
      [
        { transform: 'translate(-50%,-50%) scale(.3) rotate(-10deg)', opacity: 0 },
        { transform: 'translate(-50%,-50%) scale(1.18) rotate(2deg)', opacity: 1, offset: 0.28 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.42 },
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.8 },
        { transform: 'translate(-50%,-90%) scale(1.04)', opacity: 0 },
      ],
      d,
      this.tl,
    )
    const b = boxIn(p.win, this.el)
    this.px?.burst(b.x + b.w / 2, b.y + b.h / 2, { count: 16 + 8 * i, colors: COLORS[this.shown], speed: 6, shape: 'spark', life: 34 })
  }

  // 「？」で止める。上下のコマは空白にしておく（公開のとき、そこを通って番号が下りてくる）
  private stopQ(T: number): Promise<void> {
    if (this.still) {
      this.reel.jumpTo(Q)
      return Promise.resolve()
    }
    return this.reel.stopOn(Q, Math.max(1, this.tl.ms(T)), MACHINE[STYLE].minStop, false, BLANK, BLANK)
  }

  // ライザー: リールが速くなり、窓のまわりの光が強まって、自分の段階の色の粒子が立ち上る
  private riser(dur: number): void {
    const p = this.parts
    if (!p || this.covered) return
    this.runReel(reelRun.riser(STYLE, dur))
    this.el.style.setProperty('--fxs-rise', `${Math.round(this.tl.ms(dur))}ms`)
    this.el.classList.add('is-rise')
    if (this.still || this.shown < 1) return
    this.rising = true
    const colors = COLORS[this.shown]
    const b = boxIn(p.win, this.el)
    for (let at = 0; at < dur; at += 130) {
      const k = at / dur
      this.sched.at(at, () => {
        if (this.rising) this.px?.rise(Math.round(2 + 7 * k), colors, b.x + 12, b.x + b.w - 12, b.y + b.h + 20)
      })
    }
  }

  private endRise(): void {
    this.rising = false
    this.el.classList.remove('is-rise')
  }

  // 大画面の鼓動: リールが 1 コマずつ見える速さまで落ちる。自分が青・緑なら、窓が静かに脈打つだけ
  private venueHeartbeat(dur: number): void {
    this.runReel(reelRun.heartbeat())
    if (this.still || this.shown >= 2) return // 赤以上は、自分の鼓動（heartbeat）が刻んでいる
    const n = Math.max(1, Math.ceil((dur - 80) / HEART_MS))
    for (let k = 0; k < n; k++) this.sched.at(k * HEART_MS + 70, () => this.softBeat())
  }

  private softBeat(): void {
    const p = this.parts
    if (!p || this.covered || !this.gate('soft', 460)) return
    void play(
      p.win,
      [{ transform: 'scale(1)' }, { transform: 'scale(1.025)', offset: 0.16 }, { transform: 'scale(1)', offset: 0.42 }, { transform: 'scale(1.012)', offset: 0.6 }, { transform: 'scale(1)' }],
      440,
      this.tl,
      { composite: 'add' },
    )
  }

  // 間（ま）: リールを「？」で止め、鼓動もやめて、何も動かない時間を作る
  private ma(dur: number): void {
    const p = this.parts
    if (!p) return
    if (this.frozen) {
      this.held.q = true
      return
    }
    this.calm = true
    this.endRise()
    this.msg('……')
    if (this.dimLevel) {
      this.dimLevel += 0.06
      void play(p.dim, [{ opacity: this.dimLevel }], 500, this.tl, { fill: 'forwards' })
    }
    if (this.covered) {
      // 裏向きの箔の上に「？」を型押しする
      p.cover.classList.add('has-q')
      if (!this.still) {
        void play(p.cover.querySelector('b')!, [{ transform: 'scale(1.5)', opacity: 0 }, { transform: 'scale(.96)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], 320, this.tl)
      }
      return
    }
    void this.stopQ(maStopMs(dur))
  }

  // 金の縁（大画面のカードが裏返って金の箔になる）: 手元の窓にもふたが下りる。色は自分の段階
  private cover(): void {
    const p = this.parts
    if (!p || this.covered) return
    if (this.frozen) {
      this.held.cover = true
      return
    }
    this.covered = true
    this.endRise()
    this.reel.hold()
    p.cover.classList.add('on')
    this.msg('番号は大画面と同時に開きます')
    if (this.still) return
    void play(p.cover, [{ transform: 'rotateX(-100deg)', opacity: 0.4 }, { transform: 'rotateX(0deg)', opacity: 1 }], 560, this.tl, {
      easing: FLIP_EASING,
    })
    if (this.shown >= 3) {
      const b = boxIn(p.win, this.el)
      this.px?.rise(30, this.shown >= 4 ? RAINBOW : GOLD, b.x, b.x + b.w, b.y + b.h)
    }
  }

  // ふたを開ける: 大画面の金の箔と同じく、ぐっと縮めてから、同じ長さ・同じ曲線でめくる（数字は fx/landing.ts の flipPlan）
  private uncover(tl: Timeline): void {
    const p = this.parts
    if (!p) return
    const f = flipPlan(this.o.venueTier)
    this.drawReel()
    if (this.still) {
      tl.at(f.visible, () => p.cover.classList.remove('on'))
      return
    }
    void play(
      p.win,
      [{ transform: 'scale(1)' }, { transform: 'scale(.9)', offset: 0.35 }, { transform: 'scale(1.05)', offset: 0.75 }, { transform: 'scale(1)' }],
      340,
      tl,
      { composite: 'add', easing: 'ease-in-out' },
    )
    tl.at(f.squeeze, () => {
      void play(p.cover, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(180deg)' }], f.ms, tl, {
        easing: FLIP_EASING,
        fill: 'forwards',
      }).then(() => p.cover.classList.remove('on'))
    })
  }

  // ---- 虹 ----------------------------------------------------------------------

  private scheduleKakutei(k: KakuteiPlan): void {
    const s = this.sched
    s.at(k.freezeAt, () => this.freeze())
    s.at(Math.max(k.freezeAt, k.at - 720), () => {
      if (this.frozen) sfx.aoriStart(4) // キュ・キュ・キュイーン（約 0.7 秒）→ 和音。和音に「確定」を合わせる
    })
    s.at(k.crackAt, () => {
      if (this.frozen) this.crack(this.tl, Math.max(200, k.at - k.crackAt))
    })
    s.at(k.at, () => this.kakuteiBang())
    s.at(k.at + 1150, () => {
      if (this.frozen && !this.covered && !this.held.cover && !this.still) this.reel.run(-0.011, 90) // 逆回転（確定のごほうび）
    })
    s.at(k.at + 1580, () => this.thaw())
  }

  // 時が止まる（虹の前ぶれ）: リールが止まり、色が抜ける
  private freeze(): void {
    if ((this.phase !== 'run' && this.phase !== 'push') || this.kakuteiOn) return
    this.kakuteiOn = true
    this.frozen = true
    this.endRise()
    this.reel.hold()
    this.el.classList.add('is-freeze')
    this.msg('……')
  }

  // 「確定」: 虹の背景がゆっくり回り、後光が差す
  private kakuteiBang(): void {
    const p = this.parts
    if (!p || !this.frozen) return
    const tl = this.tl
    const gen = this.gen
    this.el.classList.remove('is-freeze')
    this.el.classList.add('is-kakutei')
    this.shown = 4
    this.el.dataset.tier = '4'
    this.light(4)
    this.dimOn(tl, 0.36)
    this.msg('<b>ビンゴ確定！</b> あなたのカードがそろいます')
    vibrate(40)
    this.glow(tl)
    if (this.still) {
      this.setLamp(4, false)
      this.showStill(tl, 4)
      return
    }
    shake(this.el.parentElement ?? this.el, tl, 7, 280)
    this.px?.burst((this.el.clientWidth || 390) / 2, this.centerY(), { count: 150, colors: RAINBOW, speed: 10, shape: 'spark', life: 60 })
    void this.slam(tl, 4, 1150, true).then(() => {
      if (gen === this.gen) this.setLamp(4, true)
    })
  }

  // 全面の光はここの 1 回だけ（虹の淡い色が、ゆっくり差す。明るさの変化は 20% 以下）。後光は強く差してから落ち着く
  private glow(tl: Timeline): void {
    const p = this.parts
    if (!p) return
    if (!this.flashed) {
      this.flashed = true
      void play(p.wash, [{ opacity: 0, offset: 0 }], 600, tl, { min: 300 })
    }
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
  }

  // 時が動き出す。止まっている間に来た大画面の拍（金の縁・間・公開待ち）に合わせる
  private thaw(): void {
    if (!this.frozen) return
    this.frozen = false
    this.el.classList.remove('is-freeze')
    const m = motionAt(this.beats, this.now(), STYLE)
    if (this.held.cover || m.back) this.cover()
    else this.runReel({ v: Math.max(m.v, 0.004), ease: 220 })
    if (this.held.q) this.ma(600)
    if (this.held.push) this.awaitPush()
    void this.dust(this.tl, RAINBOW, 700)
  }

  // 公開の時点で「確定」をまだ見せていない: 動きを止めずに、色と文字で出す
  private kakuteiNow(): void {
    const p = this.parts
    if (!p) return
    this.kakuteiOn = true
    this.frozen = false
    this.el.classList.remove('is-freeze')
    this.el.classList.add('is-kakutei')
    this.shown = 4
    this.el.dataset.tier = '4'
    this.light(4)
    this.dimOn(this.tl, 0.36)
    this.setLamp(4, !this.still)
    this.glow(this.tl)
  }

  // 窓のガラスを横切るヒビ。until で砕けて消える
  private crack(tl: Timeline, until: number): void {
    const p = this.parts
    if (!p || this.still) return
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

  // ---- 暗転・照らす・鼓動・粒子 ---------------------------------------------------

  // 暗くして、あと 1 つのマスだけスポットライトで抜く（本体はこの上にあるので暗くならない）
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

  // 自分の鼓動（赤・金）: 公開が近づくほど速くなる。明滅は 1 秒に約 2 回まで（実時間で 460ms より短くしない）。
  // 大画面の間（ま）で止まる
  private async heartbeat(tl: Timeline): Promise<void> {
    if (this.still) return
    this.beating = true
    while (!tl.cancelled && this.phase === 'run' && !this.calm && this.shown >= 2 && this.shown <= 3) {
      if (this.frozen) {
        await tl.wait(300)
        continue
      }
      const k = clamp(this.now() / Math.max(1, this.o.revealAt), 0, 1)
      const period = Math.max(840 - 280 * k, 460 * tl.speed)
      this.beat(tl, period)
      await tl.wait(period)
    }
    if (!tl.cancelled) this.beating = false
  }

  // 1 拍: ランプと「あと O65」がドクンと弾み、照らしたマスが光る
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
    void play(p.lamp, thump, d, tl, { composite: 'add' })
    for (const b of p.wait?.querySelectorAll('b') ?? []) void play(b, thump, d, tl, { composite: 'add' })
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

  // ---- 着地 ---------------------------------------------------------------------

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

  // 番号にぴたりと止まった（大画面の着地と同じ時刻）。番号を大きく見せる
  private land(): void {
    const p = this.parts
    const n = this.n
    if (!p || n === null) return
    const tl = this.tl
    const t = this.tier
    this.phase = 'landed'
    this.el.dataset.phase = 'landed'
    this.drawReel()
    p.cover.classList.remove('on')
    p.win.classList.add('is-landed')
    if (this.sound === 'all') sfx.reelLand(t)
    this.msg(`出た番号は <b>${letterOf(n)} ${n}</b>`)
    // 「あと O65」が来た
    const hit = p.wait?.querySelector<HTMLElement>(`b[data-n="${n}"]`)
    hit?.classList.add('is-hit')
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
      if (hit) {
        const hb = boxIn(hit, this.el)
        sparkBurst(p.fx, hb.x + hb.w / 2, hb.y + hb.h / 2, tl, { count: 12, colors: GOLD, dist: 90, size: 10, ms: 700, shape: 'star' })
      }
    }
    this.onLanded?.()
    this.onLanded = null
  }

  // ---- 結果 -------------------------------------------------------------------

  // 当たり: 窓の上に言葉が飛び出し、番号が玉になってカードのマスへ飛んでいく（このあと組み込み側がスタンプを押す）
  private async success(tl: Timeline, outcome: Exclude<AoriOutcome, 'none'>, revived = false): Promise<void> {
    const p = this.parts
    if (!p) return
    const t = this.tier
    const power = Math.min(4, Math.max(t, OUT_POWER[outcome]))
    const colors = COLORS[t]
    const wb = boxIn(p.win, this.el)
    const cx = wb.x + wb.w / 2
    const cy = wb.y + wb.h / 2
    // 復活のあとは、青のままだった回でも成功の音を鳴らす（revive の和音が、ここでつながる）
    if (t >= 1 || revived) sfx.aoriSuccess(Math.max(1, t) as Tier)
    vibrate(power >= 3 ? 45 : 25)
    this.el.classList.add('is-win', 'is-hero') // 言葉が出ている間は、頭の 2 段を消す（重ねない）
    const hero = el('div', 'fxs-hero', txt(HERO_TEXT[outcome]))
    hero.dataset.t = String(revived ? 3 : t) // 復活した当たりは、金の文字で祝う
    hero.style.top = `${wb.y + 2}px`
    p.fx.append(hero)
    // 言葉が長いとき（「ダブルリーチ！」など）は、画面の幅に収まるまで縮める
    const hk = this.fit(hero)
    hero.style.transform = `translate(-50%, -100%) scale(${hk.toFixed(3)})`
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
        { transform: `translate(-50%, -100%) translateY(46px) scale(${hk * 0.3})`, opacity: 0 },
        { transform: `translate(-50%, -100%) translateY(-6px) scale(${hk * 1.12})`, opacity: 1, offset: 0.55 },
        { transform: `translate(-50%, -100%) translateY(0px) scale(${hk})`, opacity: 1 },
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

  // あおったのに外れた: 光がしぼみ、自分の段の色が抜けて、パネルの中に「はずれ…」が出る
  private async fail(tl: Timeline, label: string): Promise<void> {
    const p = this.parts
    if (!p) return
    const still = this.still
    sfx.aoriFail()
    this.el.classList.add('is-fail')
    this.px?.clear()
    this.fadeAura(tl, 520)
    if (!still) {
      // 自分の段がしぼんで、色が抜ける（砕いて散らさない。外れは毎回のように出るので、静かに）
      settle(p.lamp)
      void play(
        p.lamp,
        [
          { transform: 'scale(1, 1)', filter: 'grayscale(0) brightness(1)' },
          { transform: 'scale(1.02, 0.86)', filter: 'grayscale(0.4) brightness(1)', offset: 0.3 },
          { transform: 'scale(1, 1)', filter: 'grayscale(1) brightness(0.8)' },
        ],
        460,
        tl,
        { fill: 'forwards', easing: 'cubic-bezier(.3,.6,.4,1)' },
      )
      const b = boxIn(p.lamp, this.el)
      this.onoma('プシュ～', b.x + b.w - 40, b.y - 8, tl)
    }
    await tl.wait(still ? 150 : 420)
    if (tl.cancelled) return
    // 「はずれ…」は、下のパネルの中に、不透明で水平に出す（カードには乗せない。外れは抽選の大半で出るので、
    // 毎回カードの数字が汚れて見えないように）。次につながる一言を添える
    this.missPlate(tl, `<b>${FAIL_TEXT}</b><small>${escapeHtml(label)} は、あなたのカードにありません</small><em>次の番号に期待！</em>`)
    await tl.wait(still ? 1300 : 1500)
    if (!tl.cancelled) await this.retract(tl)
  }

  // 外れの札（パネルの下の段。窓の下の一行と「あと O65」の位置を、不透明の札で覆う）
  private missPlate(tl: Timeline, html: string): HTMLElement {
    const plate = el('div', 'fxs-fail', html)
    this.parts?.body.append(plate)
    void play(
      plate,
      this.still
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transform: 'translateY(16px)', opacity: 0 },
            { transform: 'translateY(-2px)', opacity: 1, offset: 0.7 },
            { transform: 'translateY(0px)', opacity: 1 },
          ],
      280,
      tl,
      { fill: 'backwards', easing: 'ease-out' },
    )
    return plate
  }

  // 青（と、あおっていない外れ）: 番号を少し見せてから、静かに引っ込む
  private async quiet(tl: Timeline): Promise<void> {
    const n = this.n
    if (n !== null) this.msg(`<b>${letterOf(n)} ${n}</b> は、${FAIL_TEXT} 次の番号に期待！`)
    this.fadeAura(tl, 300)
    await tl.wait(700)
    if (!tl.cancelled) await this.retract(tl)
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
    this.drawnPos = r.pos
    this.drawnV = r.v
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

  private setLamp(t: Tier, pop: boolean): void {
    const p = this.parts
    if (!p) return
    p.lamp.dataset.t = String(t)
    p.lamp.querySelector('i')!.textContent = TIER_SHAPE[t]
    p.lamp.querySelector('b')!.textContent = LAMP_WORD[t]
    // 期待度のランプ（▲ ◆ ★ ✦ の 4 つ。いまの段階まで点く）
    p.meter.forEach((m, k) => m.classList.toggle('on', k < t))
    if (!pop || this.still) return
    void play(p.lamp, [{ transform: 'scale(1.45)' }, { transform: 'scale(0.94)', offset: 0.55 }, { transform: 'scale(1)' }], 360, this.tl, {
      easing: 'cubic-bezier(.2,.8,.3,1)',
    })
    const b = boxIn(p.lamp, this.el)
    sparkBurst(p.fx, b.x + b.w / 2, b.y + b.h / 2, this.tl, { count: 8, colors: COLORS[t], dist: 70, size: 8, ms: 520, shape: t >= 3 ? 'star' : 'diamond' })
  }

  // 会場（大画面）の段階: 頭の「会場」の段（大画面の帯と同じ形: 形 → 言葉）と、画面のふちの光の色。色は戻さない（大画面と同じ）
  private setVenue(h: Tier, pop: boolean, force = false): void {
    const p = this.parts
    if (!p || (!force && h <= this.venueHeat)) return
    this.venueHeat = h
    this.el.dataset.venue = String(h)
    p.venue.dataset.t = String(h)
    p.venue.querySelector('i')!.textContent = TIER_SHAPE[h]
    p.venue.querySelector('b')!.textContent = VENUE_WORD[h]
    if (pop && !this.still) void play(p.venue, [{ transform: 'scale(1.12)' }, { transform: 'scale(1)' }], 300, this.tl)
  }

  // 本体の中の一行（声かけ・大画面のテロップ）
  private msg(html: string): void {
    const p = this.parts
    if (!p) return
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
    return BLANK
  }

  // node を画面の幅に収めるための倍率（1 以下。縁取りの分の余白を残す）
  private fit(node: HTMLElement): number {
    return Math.min(1, ((this.el.clientWidth || 390) - 36) / Math.max(1, node.offsetWidth))
  }

  private centerY(): number {
    const v = getComputedStyle(this.el).getPropertyValue('--fxs-center').trim()
    return v.endsWith('px') ? parseFloat(v) : 318
  }

  // 同じ光や音が、実時間で ms より短い間隔で続かないようにする
  private gate(key: string, ms: number): boolean {
    const now = performance.now()
    if (now - (this.gates.get(key) ?? -1e9) < ms) return false
    this.gates.set(key, now)
    return true
  }

  // 何もしていない状態に戻す
  private reset(): void {
    this.gen++
    this.tl.cancel()
    this.tl = new Timeline(this.speed)
    this.sched.cancel()
    this.sched = new Timeline(this.speed)
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.unlight()
    this.px?.clear()
    this.px = null
    this.el.getAnimations().forEach((a) => a.cancel())
    this.el.replaceChildren()
    this.el.className = 'fxs'
    delete this.el.dataset.tier
    delete this.el.dataset.venue
    delete this.el.dataset.phase
    this.el.style.removeProperty('--fxs-rise')
    this.parts = null
    this.phase = 'idle'
    this.reel = new Reel(() => this.pick())
    this.beats = []
    this.shown = 0
    this.pending = 0
    this.queued = false
    this.lastRaise = -1e9
    this.extra = false
    this.bandAt = -1e9
    this.bandTier = 0
    this.venueHeat = 0
    this.kk = null
    this.kakuteiOn = false
    this.frozen = false
    this.held = { cover: false, q: false, push: false }
    this.covered = false
    this.calm = false
    this.rising = false
    this.drawnPos = Number.NaN
    this.drawnV = Number.NaN
    this.n = null
    this.onLanded?.() // resolve() が待っていたら、先へ進めて抜けさせる（gen が変わっている）
    this.onLanded = null
    this.msgText = ''
    this.flashed = false
    this.beating = false
    this.dusting = false
    this.dimLevel = 0
    this.blur = -1
    this.gates.clear()
  }
}
