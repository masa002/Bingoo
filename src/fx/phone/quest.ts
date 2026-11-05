import { sfx } from '../../audio'
import { Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion } from '../runtime'
import { GOLD } from '../theme'
import { txt } from './aori'
import { MOLE_SVG, boxIn, play, ring, type CardView } from './card'
import './quest.css' // aori.css より後に読み込む（縁取り文字の色と大きさを上書きするため）

// 緊急クエスト「モグラ撃退」のスマホ側（390×844 のスマホ画面に重ねる）。
//   1. play: 警報（introMs。大画面と同時に始まる）→ 叩く時間（playMs）。モグラはカードのマスから顔を出し、タップで叩く。
//      target のときは、ボスモグラが cell（自分のリーチのマス）を狙っていることを見せ、守る気持ちにさせる
//      （登場してマスに潜り、叩く時間の間ずっと、影・光る目・ひび・照準を見せる。叩くたびにボスがひるむ）。
//      狙われていない人も叩ける（叩いた数は会場の合計と撃退王に入る。失うものはない）。
//      叩く時間が終わったら、叩いた数で解決する（呼び出し側がそれを権威へ送る）
//   2. result: 権威が結果を決めたら呼ぶ。
//      lost なら「頑張ったけどダメだった」演出のあと、card.moleFill(cell) でマスを埋めてから解決する。
//      守りきった人は防衛成功、狙われていない人は自分の撃退数と順位を見せる
// 誰がやられるかは権威が決める。やられる割合は先に決まっていて、叩いた数が会場全体の下位に入った人がやられる。
// だから need（あと何匹叩けば守れたか）は本当の数字で、そのまま見せてよい。
//
//   const q = new MoleQuest(phone, { speed })        // sound: 'personal'（既定）は自分の音だけ、'all' は警報・合図も鳴らす
//   const score = await q.play(card, { introMs: 2600, playMs: 10000, target: true, cell: 12, label: 'N38' })
//   send({ type: 'questScore', score })
//   await q.result({ score, lost: true, need: 4, total: 18234, rank: 412, players: 1000 })
//   card.setMarks(mask, { filled: [12], … })         // 埋めたあとの状態は呼び出し側で描き直す
//
// 層は host 全体（inset 0、z-index 21）。カードの外を暗くし、カードのマスの位置にモグラを重ねる（位置は play の始めに測る）。
// 上の時計は y 36〜102、下の点数と結果はカードの下（カードの下端 +12px）から。
// 警報と叩く時間の間は、画面のどこを押しても pointerdown を受ける（伝播は止めない）。叩く時間が終わったら、タップを下へ通す。
// cancel / destroy で途中でも片付く（待っている play は、その時点の数で解決する）。
//
// モグラの出方（×1、10 秒）: 始めは約 0.6 秒ごとに 1 匹・1.1 秒出ている → 終わりは約 0.2 秒ごと・同時に最大 6 匹・0.6 秒。
// 全部で約 31 匹（29〜33。3×3 のカードは約 28 匹）。叩ける数の目安（仮想の叩き手で見積もった）は、
// 熱心に叩けば 19〜32 匹（多くは 22〜28、うまい人で 30 前後）、なんとなくなら 3〜13 匹（多くは 5〜10）。
// 速度を上げても、顔を出している長さは実時間で 380ms より短くしない（叩けるように）

export interface MoleQuestStart {
  introMs: number // 警報の長さ（大画面とそろえる）
  playMs: number // 叩ける時間
  target: boolean // 自分のリーチが狙われている
  cell: number | null // ボスモグラが狙う、card のマスの番号（0 から。狙われていなければ null）
  label: string // そのマスの番号（「N38」。狙われていなければ空）
}

export interface MoleQuestResult {
  score: number // 自分が叩いた数
  lost: boolean // 守りきれなかった（cell が埋まる）
  need: number // 守りきれなかったとき、あと何匹叩けば守れたか（それ以外は 0）
  total: number // 会場で叩いた数の合計
  rank: number // 会場での撃退数の順位（1 から）
  players: number // 参加人数
}

type Phase = 'idle' | 'intro' | 'play' | 'over' | 'result'
type HoleState = 'idle' | 'up' | 'down' | 'hit'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Pt {
  x: number
  y: number
}

// モグラが出る穴（カードのマス 1 つ）。時刻はすべて実時間（performance.now）
interface Hole {
  i: number // マスの番号
  box: Box
  node: HTMLElement
  pit: HTMLElement
  mole: HTMLElement
  state: HoleState
  downAt: number // 引っ込み始める
  hitUntil: number // ここまでは叩ける（引っ込む途中も少しだけ許す）
  endAt: number // 引っ込み終わる（叩かれたときは、落ちきる）
  fall: number // 引っ込む長さ
  freeAt: number // 次に使える
  serial: number // 何回目に顔を出したか（ギャラリーの自動の叩き手が、同じモグラを 2 度狙わないため）
  a: Animation | null // モグラの動き
  pa: Animation | null // 穴の開け閉め
}

// ボスモグラ（狙われたマスに重ねる）
interface Boss {
  box: Box
  node: HTMLElement
  marks: HTMLElement // 影・ひび・照準（叩く時間の間ずっと見せる）
  flinch: HTMLElement
  cracks: SVGPathElement[]
  pit: HTMLElement
  clip: HTMLElement
  body: HTMLElement
}

interface Parts {
  shade: HTMLElement
  edge: HTMLElement
  field: HTMLElement
  hud: HTMLElement
  sec: HTMLElement
  fill: HTMLElement
  hype: HTMLElement
  floor: HTMLElement
  panel: HTMLElement
  num: HTMLElement
  combo: HTMLElement
  mission: HTMLElement
  res: HTMLElement
  banner: HTMLElement
  fx: HTMLElement
  wash: HTMLElement
}

// ---- モグラの出方（演出上の ms。叩く時間の進み具合 0〜1 で、始め → 終わりへ変える） ----
const FIRST = 220 // 叩き始めから最初のモグラまで
const TAIL = 350 // 終わりのこれだけ前からは出さない
const GAP: readonly [number, number] = [620, 200] // 次のモグラまで（±25% ゆらす）
const UP: readonly [number, number] = [1100, 600] // 顔を出している長さ（±10% ゆらす）
const CAP: readonly [number, number] = [2, 6] // 同時に出ている数の上限
const PAIR = { from: 0.3, p: 0.3 } // これより後は、ときどき 2 匹同時に出る
const TRIO = { from: 0.65, p: 0.35 } // さらに後は、もう 1 匹
const RISE = 120 // 顔を出すまで
const FALL = 170 // 引っ込むまで
const COOL = 260 // 同じ穴を次に使えるまで
const MIN_UP = 380 // 実時間: 速度を上げても、叩けるだけの長さは残す
const COMBO_GAP = 2000 // 実時間: これより間が空いたら、コンボは切れる（空振りでも切れる）
const BURST = 420 // 実時間: bossAppear を呼んでから「ドバッ！」と飛び出す音まで（音の担当と合わせた）

const ONOMA = ['ポカッ', 'ペチッ', 'ボコッ', 'ポコッ', 'バシッ'] as const
const COMBO_WORD: Readonly<Record<number, string>> = { 5: 'ナイス！', 10: 'すごい！', 15: '達人！', 20: '神業！', 25: '伝説！', 30: '撃退王級！' }
const SPARK = ['#ffffff', '#fff4cc', '#ffe08a', '#f5c542'] as const
const SOIL = ['#6e4a2a', '#93693f', '#4a2f19', '#2f1d0e'] as const
const EMBER = ['#ff8a5a', '#ffd0a0', '#ffffff', '#ffb03a'] as const

// 叩かれた顔（card.ts の MOLE_SVG に重ねる）。目は ×、口は「お」、ヘルメットにたんこぶ
const DAZE_SVG = `<svg class="fxq-daze" viewBox="0 0 100 90" aria-hidden="true">
  <circle cx="38" cy="45" r="6.4" fill="#6b4a2f"/><circle cx="62" cy="45" r="6.4" fill="#6b4a2f"/>
  <path d="M34 41l8 8M42 41l-8 8M58 41l8 8M66 41l-8 8" stroke="#140c06" stroke-width="2.8" stroke-linecap="round"/>
  <ellipse cx="50" cy="66" rx="9" ry="4.6" fill="#c99a6e"/>
  <ellipse cx="50" cy="66.5" rx="3.8" ry="4.4" fill="#4a2a14"/>
  <ellipse cx="61" cy="8.5" rx="7" ry="5.4" fill="#ff8fab" stroke="#e0607f" stroke-width="1.5"/>
</svg>`

// ボスモグラ（赤いヘルメットにドリル、怒った眉、牙、ほおに絆創膏）。viewBox は 140×124
const BOSS_SVG = `<svg viewBox="0 0 140 124" aria-hidden="true">
  <path d="M52 32 L70 0 L88 32 Z" fill="#cfd6e4"/>
  <path d="M55 26 L84 20 M59 18 L80 13 M63 11 L75 8" stroke="#7b849a" stroke-width="3" stroke-linecap="round"/>
  <path d="M16 128 C16 62 38 32 70 32 C102 32 124 62 124 128 Z" fill="#4a2f1a"/>
  <path d="M40 128 C40 96 54 84 70 84 C86 84 100 96 100 128 Z" fill="#5d3c22"/>
  <path d="M34 50 C36 27 104 27 106 50 Z" fill="#d6332a"/>
  <rect x="28" y="47" width="84" height="7" rx="3.5" fill="#9e1f18"/>
  <circle cx="70" cy="40" r="6" fill="#ffd34d" stroke="#9e1f18" stroke-width="2"/>
  <path d="M40 61 L60 68 M100 61 L80 68" stroke="#140a04" stroke-width="5" stroke-linecap="round"/>
  <ellipse cx="54" cy="74" rx="6.8" ry="5.6" fill="#fff4e0"/><circle cx="55.5" cy="74.5" r="3.3" fill="#e5202a"/>
  <ellipse cx="86" cy="74" rx="6.8" ry="5.6" fill="#fff4e0"/><circle cx="84.5" cy="74.5" r="3.3" fill="#e5202a"/>
  <ellipse cx="70" cy="92" rx="21" ry="14" fill="#a8774d"/>
  <ellipse cx="70" cy="84" rx="8.5" ry="6" fill="#26120a"/>
  <path d="M54 96 Q70 108 86 96" stroke="#26120a" stroke-width="3" fill="none" stroke-linecap="round"/>
  <path d="M60 99.5 l3 6 l3 -4.5 Z M74 101 l3 4.5 l3 -6 Z" fill="#fff"/>
  <path d="M95 86 l12 7 M103 83 l-6 12" stroke="#f3e2c0" stroke-width="4" stroke-linecap="round"/>
  <ellipse cx="26" cy="114" rx="18" ry="12" fill="#d9a07a"/><ellipse cx="114" cy="114" rx="18" ry="12" fill="#d9a07a"/>
  <path d="M13 108 l-4 -9 M20 105 l-2 -10 M28 104 l0 -10 M112 104 l0 -10 M120 105 l2 -10 M127 108 l4 -9" stroke="#fff4e6" stroke-width="3.2" stroke-linecap="round"/>
</svg>`

// 叩かれたボスの顔（BOSS_SVG に重ねる）
const BOSS_DAZE = `<svg class="fxq-bdaze" viewBox="0 0 140 124" aria-hidden="true">
  <ellipse cx="54" cy="73" rx="9" ry="8" fill="#4a2f1a"/><ellipse cx="86" cy="73" rx="9" ry="8" fill="#4a2f1a"/>
  <path d="M48 67l12 12M60 67l-12 12M80 67l12 12M92 67l-12 12" stroke="#140a04" stroke-width="3.6" stroke-linecap="round"/>
  <ellipse cx="70" cy="101" rx="13" ry="5" fill="#a8774d"/>
  <path d="M58 101 q4 -4 8 0 t8 0 t8 0" stroke="#26120a" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <ellipse cx="84" cy="30" rx="9" ry="7" fill="#ff8fab" stroke="#e0607f" stroke-width="2"/>
</svg>`

// ピコピコハンマー。打つ面（ヘッドの下の面の中央）は (16, 44)、支点（柄の端）は (76, 20)。viewBox は 80×50
const HAMMER_SVG = `<svg viewBox="0 0 80 50" aria-hidden="true">
  <path d="M27 20 H76" stroke="#d9a520" stroke-width="8" stroke-linecap="round"/>
  <path d="M27 18 H75" stroke="#ffe08a" stroke-width="2.5" stroke-linecap="round"/>
  <rect x="4" y="6" width="24" height="32" rx="6" fill="#ff4f6d"/>
  <rect x="2" y="0" width="28" height="9" rx="4.5" fill="#ffd34d"/>
  <rect x="2" y="35" width="28" height="9" rx="4.5" fill="#ffd34d"/>
  <rect x="8" y="10" width="6" height="24" rx="3" fill="#fff" opacity=".45"/>
</svg>`

// ボスが掘り進むひび（マスの中の 0〜100 の座標）。[形, 描き始める進み具合, 描き終わる進み具合]
const CRACKS: readonly (readonly [string, number, number])[] = [
  ['M50 60 L41 48 L45 37 L35 25 L39 11', 0, 0.55],
  ['M50 60 L62 52 L70 56 L83 45', 0.2, 0.75],
  ['M50 60 L46 72 L56 81 L51 94', 0.4, 0.9],
  ['M50 60 L36 65 L25 60 L12 69', 0.6, 1],
]

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k
const rnd = (a: number, b: number): number => a + Math.random() * (b - a)
const pickOne = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]
const fmt = (n: number): string => Math.round(n).toLocaleString('ja-JP')

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

export class MoleQuest {
  readonly el: HTMLElement
  private tl: Timeline
  private speed: number
  private readonly sound: 'personal' | 'all'
  private gen = 0 // play / cancel ごとに増やす（古い演出の続きが、新しい回を書き換えないように）
  private dead = false
  private phase: Phase = 'idle'
  private still = false
  private card: CardView | null = null
  private cell: number | null = null
  private target = false
  private label = ''
  private introMs = 0
  private playMs = 0
  private n = 5 // カードの一辺のマス数
  private parts: Parts | null = null
  private px: Particles | null = null
  private holes: Hole[] = []
  private boss: Boss | null = null
  private armed = false // ボスの影・ひび・照準を出した
  // 時計: play からの演出上の ms。速度を切り替えたら、そこまでの分を確定してから数え直す
  private e0 = 0
  private t0 = 0
  private nextAt = 0 // 次のモグラを出す時刻（演出上）
  private overAt = 0 // 叩く時間が終わった時刻（実時間）
  private score = 0
  private combo = 0
  private best = 0
  private lastHit = -1e9
  private serial = 0
  private secShown = -1
  private hyped = 0 // 出したあおりの段（0〜2）
  private dangerShown = -1
  private bannerGen = 0
  private washed = false // 全面の光は 1 回の演出につき 1 回まで
  private raf = 0
  private onScore: ((score: number) => void) | null = null
  private readonly gates = new Map<string, number>()

  constructor(host: HTMLElement, o: { speed?: number; sound?: 'personal' | 'all' } = {}) {
    this.el = el('div', 'fxq')
    host.append(this.el)
    this.speed = o.speed && o.speed > 0 ? o.speed : 1
    this.sound = o.sound ?? 'personal'
    this.tl = new Timeline(this.speed)
    this.applyLoops()
    this.el.addEventListener('pointerdown', this.onDown)
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

  // くり返す動きの長さ。速度を上げても、脈動は 1 秒に約 1 回まで、照準の回転は 10 秒に 1 周までに抑える
  private applyLoops(): void {
    const s = this.speed
    const set = (name: string, ms: number, min: number) => this.el.style.setProperty(name, `${Math.round(Math.max(min, ms / s))}ms`)
    set('--fxq-pulse-ms', 1100, 800)
    set('--fxq-spin-ms', 12000, 10000)
    set('--fxq-drift-ms', 2400, 1200)
    set('--fxq-dots-ms', 1500, 1000)
  }

  // play からの演出上の ms
  private now(): number {
    return this.e0 + (performance.now() - this.t0) * this.speed
  }

  // 実時間の長さ（演出上の ms を今の速度で縮め、min より短くしない）
  private real(ms: number, min: number): number {
    return Math.max(min, ms / this.speed)
  }

  async play(card: CardView, o: MoleQuestStart): Promise<number> {
    if (this.dead) return 0
    this.reset()
    const gen = this.gen
    const tl = this.tl
    this.card = card
    this.introMs = Math.max(0, o.introMs)
    this.playMs = Math.max(0, o.playMs)
    this.still = prefersReducedMotion()
    const m = this.measure(card)
    const cell = o.cell
    this.cell = o.target && cell !== null && Number.isInteger(cell) && cell >= 0 && cell < m.boxes.length ? cell : null
    this.target = o.target
    this.label = o.target ? o.label : ''
    const done = new Promise<number>((resolve) => (this.onScore = resolve))
    this.parts = this.build(m)
    this.e0 = 0
    this.t0 = performance.now()
    this.phase = 'intro'
    this.el.dataset.phase = 'intro'
    this.el.classList.add('is-live')
    this.intro(tl, gen)
    this.raf = requestAnimationFrame(this.frame)
    void this.watch(tl, gen)
    return done
  }

  async result(r: MoleQuestResult): Promise<void> {
    if (this.dead || this.phase === 'result') return
    if (this.phase === 'idle') this.bare()
    if (this.phase === 'intro' || this.phase === 'play') this.finish() // 叩く時間の途中で結果が来たら、そこで終える
    this.phase = 'result'
    this.el.dataset.phase = 'result'
    const gen = this.gen
    const tl = this.tl
    const alive = () => !tl.cancelled && gen === this.gen
    // 「そこまで！」を見せきってから
    await this.until(this.overAt + this.real(650, 260))
    if (!alive()) return
    const p = this.parts
    if (p) void play(p.hud, [{ opacity: 1 }, { opacity: 0 }], 260, tl, { fill: 'forwards' })
    if (r.lost) await this.lostFlow(tl, r, alive)
    else if (this.target) await this.defendFlow(tl, r, alive)
    else await this.plainFlow(tl, r, alive)
    if (!alive()) return
    await play(this.el, [{ opacity: 1 }, { opacity: 0 }], 360, tl, { fill: 'forwards' })
    if (gen === this.gen) this.reset()
  }

  // 途中でも片付ける（待っている play は、その時点の数で解決する）
  cancel(): void {
    this.reset()
  }

  destroy(): void {
    this.reset()
    this.dead = true
    this.el.removeEventListener('pointerdown', this.onDown)
    this.el.remove()
  }

  // ---- 組み立て -------------------------------------------------------------

  // マスの位置（この層の座標）。カードが見えていない（大きさが取れない）ときは、いつものカードの位置に仮のマスを並べる
  private measure(card: CardView): { boxes: Box[]; card: Box | null } {
    const nodes = [...card.el.querySelectorAll<HTMLElement>('.fxc-cell[data-i]')].sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i))
    const boxes = nodes.map((node) => boxIn(node, this.el))
    if (boxes.length && boxes.every((b) => b.w > 4 && b.h > 4)) {
      this.n = Math.round(Math.sqrt(boxes.length)) || 5
      return { boxes, card: boxIn(card.el, this.el) }
    }
    const n = nodes.length === 9 ? 3 : 5
    const size = n === 5 ? 63 : 86
    const gap = n === 5 ? 6 : 9
    const span = n * size + (n - 1) * gap
    const x0 = ((this.el.clientWidth || 390) - span) / 2
    const y0 = 338 - span / 2
    this.n = n
    return {
      boxes: Array.from({ length: n * n }, (_, i) => ({ x: x0 + (i % n) * (size + gap), y: y0 + Math.floor(i / n) * (size + gap), w: size, h: size })),
      card: null,
    }
  }

  private build(m: { boxes: Box[]; card: Box | null }): Parts {
    this.el.className = 'fxq'
    this.el.classList.toggle('is-still', this.still)
    this.el.dataset.mode = this.target ? 'target' : 'free'
    this.el.innerHTML = `
      <i class="fxq-shade"></i>
      <i class="fxq-edge"></i>
      <div class="fxq-field"></div>
      <div class="fxq-hud">
        <div class="fxq-hud-row">
          <span class="fxq-badge"><b>⚠</b>緊急クエスト</span>
          <span class="fxq-title">モグラ撃退</span>
          <span class="fxq-sec"><b>${Math.ceil(this.playMs / 1000)}</b><small>秒</small></span>
        </div>
        <div class="fxq-bar"><i class="fxq-fill"></i></div>
      </div>
      <div class="fxq-hype"></div>
      <i class="fxq-floor"></i>
      <div class="fxq-panel">
        <div class="fxq-row">
          <div class="fxq-score"><small>撃退</small><b class="fxq-num">0</b><small>匹</small></div>
          <div class="fxq-combo"></div>
        </div>
        <div class="fxq-mission"></div>
      </div>
      <div class="fxq-resbox"></div>
      <canvas class="fxq-px"></canvas>
      <div class="fxq-fx"></div>
      <div class="fxq-banner"></div>
      <i class="fxq-wash"></i>`
    const $ = <T extends Element = HTMLElement>(s: string): T => this.el.querySelector<T>(s)!
    const shade = $('.fxq-shade')
    // 暗くするのはカードの外だけ（カードが戦場）
    if (m.card) shade.style.cssText = `left:${m.card.x - 6}px;top:${m.card.y - 6}px;width:${m.card.w + 12}px;height:${m.card.h + 12}px`
    else shade.classList.add('is-full')
    const cy = m.card ? m.card.y + m.card.h / 2 : 318
    this.el.style.setProperty('--fxq-cy', `${Math.round(cy)}px`)
    this.el.style.setProperty('--fxq-panel', `${Math.round(clamp(m.card ? m.card.y + m.card.h + 12 : 540, 420, 660))}px`)
    const canvas = $<HTMLCanvasElement>('.fxq-px')
    canvas.width = this.el.clientWidth || 390
    canvas.height = this.el.clientHeight || 844
    this.px = new Particles(canvas, 600)
    this.px.speed = this.speed
    const field = $('.fxq-field')
    this.holes = []
    m.boxes.forEach((b, i) => {
      if (i === this.cell) return // 狙われたマスにはボスがいる（小さなモグラは出さない）
      const node = el(
        'div',
        'fxq-hole',
        `<i class="fxq-pit"></i><div class="fxq-clip"><div class="fxq-mole">${MOLE_SVG}${DAZE_SVG}</div></div>`,
      )
      node.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`
      node.dataset.i = String(i)
      field.append(node)
      this.holes.push({
        i,
        box: b,
        node,
        pit: node.querySelector<HTMLElement>('.fxq-pit')!,
        mole: node.querySelector<HTMLElement>('.fxq-mole')!,
        state: 'idle',
        downAt: 0,
        hitUntil: 0,
        endAt: 0,
        fall: 0,
        freeAt: 0,
        serial: 0,
        a: null,
        pa: null,
      })
    })
    this.boss = this.cell !== null ? this.buildBoss(field, m.boxes[this.cell]) : null
    return {
      shade,
      edge: $('.fxq-edge'),
      field,
      hud: $('.fxq-hud'),
      sec: $('.fxq-sec b'),
      fill: $('.fxq-fill'),
      hype: $('.fxq-hype'),
      floor: $('.fxq-floor'),
      panel: $('.fxq-panel'),
      num: $('.fxq-num'),
      combo: $('.fxq-combo'),
      mission: $('.fxq-mission'),
      res: $('.fxq-resbox'),
      banner: $('.fxq-banner'),
      fx: $('.fxq-fx'),
      wash: $('.fxq-wash'),
    }
  }

  private buildBoss(field: HTMLElement, b: Box): Boss {
    const node = el(
      'div',
      'fxq-boss',
      `<div class="fxq-marks">
        <div class="fxq-shadow"><div class="fxq-flinch"><i class="fxq-blob"></i><i class="fxq-eyes"><i></i><i></i></i></div></div>
        <svg class="fxq-crack" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${CRACKS.map(([d]) => `<path pathLength="1" d="${d}"/>`).join('')}</svg>
        <i class="fxq-reticle"></i>
      </div>
      <i class="fxq-bpit"></i>
      <div class="fxq-bclip"><div class="fxq-bbody">${BOSS_SVG}${BOSS_DAZE}</div></div>`,
    )
    node.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`
    field.append(node)
    const $ = <T extends Element = HTMLElement>(s: string): T => node.querySelector<T>(s)!
    return {
      box: b,
      node,
      marks: $('.fxq-marks'),
      flinch: $('.fxq-flinch'),
      cracks: [...node.querySelectorAll<SVGPathElement>('.fxq-crack path')],
      pit: $('.fxq-bpit'),
      clip: $('.fxq-bclip'),
      body: $('.fxq-bbody'),
    }
  }

  // play なしで result が呼ばれたとき（途中から入った端末など）: 結果を見せるだけの層を作る
  private bare(): void {
    this.still = prefersReducedMotion()
    this.parts = this.build({ boxes: [], card: null })
    this.phase = 'over'
    this.overAt = performance.now() - 10000
    void play(this.parts.shade, [{ opacity: 0 }, { opacity: 1 }], 240, this.tl, { fill: 'forwards' })
    this.reveal(this.parts.floor, 0)
  }

  // ---- 時間の進め方 -----------------------------------------------------------

  private readonly frame = (): void => {
    this.raf = 0
    if (this.phase === 'idle') return
    this.pump()
    // 叩く時間が終わって、モグラが全部引っ込んで穴が閉じたら止める（電池のため。結果がすぐ来ても、穴は閉じきる）
    if ((this.phase === 'over' || this.phase === 'result') && this.holes.every((h) => h.state === 'idle')) return
    this.raf = requestAnimationFrame(this.frame)
  }

  // 画面が裏にあって requestAnimationFrame が止まっても、時間どおりに始めて終わるように見張る
  private async watch(tl: Timeline, gen: number): Promise<void> {
    while (!tl.cancelled && gen === this.gen && (this.phase === 'intro' || this.phase === 'play')) {
      await tl.wait(150 * this.speed)
      if (tl.cancelled || gen !== this.gen) return
      this.pump()
    }
  }

  private pump(): void {
    const real = performance.now()
    if (this.phase === 'intro' && this.now() >= this.introMs) this.go()
    if (this.phase === 'play') {
      const t = this.now()
      const k = this.playMs > 0 ? clamp((t - this.introMs) / this.playMs, 0, 1) : 1
      this.spawnUntil(t, real)
      this.drawTimer(t, k)
      if (this.boss) this.drawDanger(k)
      if (k >= 1) this.finish()
    }
    this.retire(real)
  }

  // 実時間で at になるまで待つ
  private until(at: number): Promise<void> {
    return this.tl.wait(Math.max(0, at - performance.now()) * this.speed)
  }

  // ---- 警報 -------------------------------------------------------------------

  private intro(tl: Timeline, gen: number): void {
    const p = this.parts!
    const I = this.introMs
    const ok = () => gen === this.gen && this.phase === 'intro'
    this.cue(() => sfx.questAlarm())
    this.el.classList.add('is-alarm') // 縁の光がゆっくり脈打つ
    void play(p.shade, [{ opacity: 0 }, { opacity: 1 }], 280, tl, { fill: 'forwards' })
    void play(p.edge, [{ opacity: 0 }, { opacity: 1 }], 420, tl, { fill: 'forwards' })
    const alarm = `<div class="fxq-ban is-alarm"><i class="fxq-tape"></i><div class="fxq-ban-body">
      <svg class="fxq-warn" viewBox="0 0 64 56" aria-hidden="true"><path d="M32 5 L60 51 L4 51 Z" fill="#ffc21a" stroke="#1a1405" stroke-width="4" stroke-linejoin="round"/><rect x="29" y="18" width="6" height="19" rx="3" fill="#1a1405"/><circle cx="32" cy="44" r="3.6" fill="#1a1405"/></svg>
      <div class="fxq-ban-main">${txt('緊急クエスト発生！')}</div><div class="fxq-ban-sub">${txt('モグラ撃退')}</div>
    </div><i class="fxq-tape"></i></div>`
    if (I < 1200) {
      // 警報が短いときは、文字だけ見せてすぐ始める
      void this.showBanner(alarm, Math.max(100, I - 560))
      this.setMission('intro')
      this.reveal(p.floor, 0)
      this.reveal(p.panel, 0)
      this.reveal(p.hud, 0)
      if (this.boss) this.arm(0)
      return
    }
    void this.showBanner(alarm, I * 0.4 - 500)
    tl.at(I * 0.3, () => {
      if (!ok()) return
      this.setMission('intro')
      this.reveal(p.floor, 0)
      this.reveal(p.panel, 26)
    })
    // ボスが出てきて、狙うマスに潜る（狙われていない人には、モグラの群れがちらっと顔を出す）
    tl.at(I * 0.36, () => {
      if (!ok()) return
      if (this.boss) this.bossIntro(tl, I * 0.4)
      else this.teaser(I * 0.3)
    })
    tl.at(I * 0.78, () => ok() && this.reveal(p.hud, -24))
    tl.at(I * 0.84, () => ok() && void this.showBanner(`<div class="fxq-ban is-ready">${txt('よーい…')}</div>`, -1))
  }

  // ボスが狙うマスから出てきて、ひと言いってから潜る（until は潜り始めるまでの演出上の ms）。潜ったあとは影・ひび・照準が残る。
  // bossAppear は「ゴゴゴ…」のあと、呼んでから実時間 0.42 秒で「ドバッ！」と飛び出す音なので、飛び出す絵をそこに合わせる
  // （速度を上げて間に合わないときだけ、潜るまでに収まるよう詰める）
  private bossIntro(tl: Timeline, until: number): void {
    const gen = this.gen
    sfx.bossAppear()
    const burst = Math.max(0, Math.min(BURST * this.speed, until - 300))
    this.rumble(tl, burst)
    tl.at(burst, () => {
      void this.bossRise(tl, 280)
      tl.at(160, () => this.bubble(this.label ? `${this.label} は いただく！` : 'このマス、いただく！', Math.max(560, until - burst)))
    })
    tl.at(Math.max(until, burst + 300), () => {
      void this.bossDive(tl, 240).then(() => {
        if (gen === this.gen && (this.phase === 'intro' || this.phase === 'play')) this.arm(320)
      })
    })
  }

  // 「ゴゴゴ…」: 地面がもり上がって穴が開きかけ、土がこぼれる（lead のあとに飛び出す）
  private rumble(tl: Timeline, lead: number): void {
    const b = this.boss
    if (!b || lead <= 0) return
    const cx = b.box.x + b.box.w / 2
    this.onoma('ゴゴゴ…', cx, b.box.y + b.box.h * 0.12, b.box.w * 0.85, 'is-boss')
    void play(b.pit, this.still ? [{ opacity: 0 }, { opacity: 0.6 }] : [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(0.55)', opacity: 0.85 }], lead, tl, {
      easing: 'ease-in',
      fill: 'forwards',
    })
    if (this.still) return
    for (const f of [0.25, 0.65]) {
      tl.at(lead * f, () => this.px?.burst(cx, b.box.y + b.box.h * 0.8, { count: 6, colors: SOIL, speed: 2.4, gravity: 0.3, life: 24, size: 4, shape: 'rect' }))
    }
  }

  // 狙われていない人: モグラの群れがちらっと顔を出す（まだ叩けない）
  private teaser(stay: number): void {
    const list: Hole[] = []
    for (const h of [...this.holes].sort(() => Math.random() - 0.5)) {
      if (list.length >= 5) break
      if (!list.some((o) => this.near(o, h))) list.push(h)
    }
    list.forEach((h, j) =>
      this.tl.at(j * 70, () => {
        if (this.phase !== 'intro' || h.state !== 'idle') return
        this.pitTo(h, true, 120)
        this.moleUp(h, 160)
        if (this.gate('pop', 70)) sfx.molePop()
        this.tl.at(stay, () => {
          if (this.phase !== 'intro' || h.state !== 'idle') return
          this.moleDown(h, 160)
          this.tl.at(170, () => h.state === 'idle' && this.pitTo(h, false, 120))
        })
      }),
    )
  }

  // ---- 叩く時間 ---------------------------------------------------------------

  private go(): void {
    this.phase = 'play'
    this.el.dataset.phase = 'play'
    this.el.classList.remove('is-alarm')
    this.nextAt = this.introMs + FIRST
    this.cue(() => sfx.questGo())
    const p = this.parts
    if (!p) return
    this.setMission('play')
    this.reveal(p.floor, 0)
    this.reveal(p.panel, 0)
    this.reveal(p.hud, 0)
    if (this.boss && !this.armed) this.arm(200)
    void this.showBanner(`<div class="fxq-ban is-go">${txt('叩け！')}</div>`, 220)
  }

  // 叩く時間の終わり。叩いた数で play を解決し、タップを下へ通す
  private finish(): void {
    if (this.phase !== 'intro' && this.phase !== 'play') return
    const real = performance.now()
    this.phase = 'over'
    this.el.dataset.phase = 'over'
    this.el.classList.remove('is-live', 'is-alarm')
    this.overAt = real
    for (const h of this.holes) if (h.state === 'up') this.lower(h, real, true)
    const p = this.parts
    if (p) {
      p.fill.style.transform = 'scaleX(0)'
      p.sec.textContent = '0'
      void this.showBanner(`<div class="fxq-ban is-end">${txt('そこまで！')}</div>`, 520)
      this.setMission('wait')
    }
    this.cue(() => sfx.questEnd())
    const done = this.onScore
    this.onScore = null
    done?.(this.score)
  }

  private spawnUntil(t: number, real: number): void {
    const end = this.introMs + this.playMs - TAIL
    if (t - this.nextAt > 400) this.nextAt = t // 画面が裏にあった間の分は、まとめて出さない
    while (this.nextAt <= t && this.nextAt < end) {
      const k = clamp((this.nextAt - this.introMs) / Math.max(1, this.playMs), 0, 1)
      let n = 1
      if (k > PAIR.from && Math.random() < PAIR.p) n++
      if (k > TRIO.from && Math.random() < TRIO.p) n++
      // 3×3 のカードでは、穴の数に合わせて同時の上限を下げる
      const cap = Math.min(Math.round(lerp(CAP[0], CAP[1], k)), Math.max(1, Math.floor(this.holes.length * 0.6)))
      for (let j = 0; j < n && this.alive() < cap; j++) if (!this.spawn(k, real)) break
      this.nextAt += lerp(GAP[0], GAP[1], k) * rnd(0.75, 1.25)
    }
  }

  private alive(): number {
    let c = 0
    for (const h of this.holes) if (h.state === 'up') c++
    return c
  }

  private near(a: Hole, b: Hole): boolean {
    const n = this.n
    return Math.abs((a.i % n) - (b.i % n)) <= 1 && Math.abs(Math.floor(a.i / n) - Math.floor(b.i / n)) <= 1
  }

  private spawn(k: number, real: number): boolean {
    const free = this.holes.filter((h) => h.state === 'idle' && h.freeAt <= real)
    if (!free.length) return false
    // 出ているモグラのすぐ隣は避ける（1 回だけ引き直す）
    let h = pickOne(free)
    if (this.holes.some((o) => o.state === 'up' && this.near(o, h))) h = pickOne(free)
    const rise = this.real(RISE, 70)
    const up = Math.max(MIN_UP, (lerp(UP[0], UP[1], k) * rnd(0.9, 1.1)) / this.speed)
    h.state = 'up'
    h.fall = this.real(FALL, 90)
    h.downAt = real + rise + up
    h.hitUntil = h.downAt + h.fall * 0.6
    h.endAt = h.downAt + h.fall
    h.serial = ++this.serial
    h.node.dataset.n = String(h.serial)
    h.node.classList.remove('is-bonk')
    h.node.classList.add('is-up')
    this.pitTo(h, true, 120)
    this.moleUp(h, RISE)
    if (this.gate('pop', 70)) sfx.molePop()
    return true
  }

  // 時間が来たモグラを引っ込め、引っ込みきった穴を閉じる
  private retire(real: number): void {
    for (const h of this.holes) {
      if (h.state === 'up' && real >= h.downAt) this.lower(h, real)
      else if ((h.state === 'down' || h.state === 'hit') && real >= h.endAt) {
        h.state = 'idle'
        h.freeAt = real + this.real(COOL, 60)
        this.pitTo(h, false, 140)
      }
    }
  }

  private lower(h: Hole, real: number, quick = false): void {
    h.state = 'down'
    h.node.classList.remove('is-up')
    if (quick) {
      h.fall = this.real(120, 80)
      h.hitUntil = real
    }
    h.endAt = real + h.fall
    this.moleDown(h, quick ? 120 : FALL)
  }

  // ---- モグラの動き -------------------------------------------------------------

  private anim(node: Element, frames: Keyframe[], ms: number, o: { min?: number; delay?: number; easing?: string; fill?: FillMode } = {}): Animation {
    return node.animate(frames, {
      duration: Math.max(o.min ?? 1, this.tl.ms(ms)),
      delay: o.delay ? this.tl.ms(o.delay) : 0,
      easing: o.easing ?? 'ease-out',
      fill: o.fill ?? 'none',
    })
  }

  private pitTo(h: Hole, open: boolean, ms: number): void {
    h.pa?.cancel()
    const a = open ? 0 : 1
    const z = open ? 1 : 0
    h.pa = this.anim(
      h.pit,
      this.still ? [{ opacity: a }, { opacity: z }] : [{ transform: `scale(${a})`, opacity: a }, { transform: `scale(${z})`, opacity: z }],
      ms,
      { min: 60, fill: 'forwards' },
    )
  }

  private moleUp(h: Hole, ms: number): void {
    h.a?.cancel()
    h.a = this.still
      ? this.anim(h.mole, [{ opacity: 0 }, { opacity: 1 }], ms, { min: 70, fill: 'forwards' })
      : this.anim(
          h.mole,
          [
            { transform: 'translateY(105%)' },
            { transform: 'translateY(-7%) scale(0.96, 1.05)', offset: 0.7 },
            { transform: 'translateY(0%) scale(1, 1)' },
          ],
          ms,
          { min: 70, fill: 'forwards', easing: 'cubic-bezier(.2,.9,.3,1.1)' },
        )
  }

  private moleDown(h: Hole, ms: number): void {
    h.a?.cancel()
    h.a = this.still
      ? this.anim(h.mole, [{ opacity: 1 }, { opacity: 0 }], ms, { min: 80, fill: 'forwards' })
      : this.anim(h.mole, [{ transform: 'translateY(0%)' }, { transform: 'translateY(-5%)', offset: 0.2 }, { transform: 'translateY(105%)' }], ms, {
          min: 80,
          fill: 'forwards',
          easing: 'ease-in',
        })
  }

  // ---- タップ -----------------------------------------------------------------

  private readonly onDown = (e: PointerEvent): void => {
    if (this.phase !== 'intro' && this.phase !== 'play') return
    // 長押しのメニューや文字の選択を出さない（伝播は止めない。音のロック解除は document の pointerdown で受けている）
    if (e.cancelable) e.preventDefault()
    if (e.button > 0) return // 右クリックなどは数えない
    const pt = this.local(e)
    this.pump() // 押した瞬間の状態にそろえる（時間切れなら、ここで終わる）
    if (this.phase === 'intro') {
      if (this.gate('early', 300)) ring(this.parts!.fx, pt.x, pt.y, 40, 'rgba(255,255,255,0.5)', this.tl, 320)
      return
    }
    if (this.phase !== 'play') return
    const real = performance.now()
    const h = this.holeAt(pt, real)
    if (h) this.whack(h, pt, real)
    else this.miss(pt)
  }

  // 指の位置（画面側で縮小表示されていても、390×844 の座標に直す）
  private local(e: PointerEvent): Pt {
    const r = this.el.getBoundingClientRect()
    const k = r.width / (this.el.offsetWidth || r.width || 1) || 1
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k }
  }

  // 押した場所のモグラ。マスより少し広く取り（頭はマスの上にはみ出す）、重なったら近いほう
  private holeAt(pt: Pt, real: number): Hole | null {
    let best: Hole | null = null
    let bestD = Infinity
    for (const h of this.holes) {
      if (h.state !== 'up' && !(h.state === 'down' && real < h.hitUntil)) continue
      const { x, y, w, h: hh } = h.box
      if (pt.x < x - w * 0.12 || pt.x > x + w * 1.12 || pt.y < y - hh * 0.3 || pt.y > y + hh * 1.08) continue
      const d = Math.hypot(pt.x - (x + w / 2), pt.y - (y + hh * 0.42))
      if (d < bestD) {
        best = h
        bestD = d
      }
    }
    return best
  }

  // 叩いた: ハンマーが振り下ろされ、モグラがつぶれて目を回し、火花と「ポカッ」
  private whack(h: Hole, pt: Pt, real: number): void {
    const p = this.parts!
    const tl = this.tl
    this.score++
    this.combo = real - this.lastHit <= COMBO_GAP ? this.combo + 1 : 1
    this.lastHit = real
    this.best = Math.max(this.best, this.combo)
    const dur = this.real(430, 260)
    h.state = 'hit'
    h.endAt = real + dur
    h.node.classList.remove('is-up')
    h.node.classList.add('is-bonk')
    h.a?.cancel()
    h.a = this.still
      ? this.anim(h.mole, [{ opacity: 1 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], 430, { min: 260, fill: 'forwards' })
      : this.anim(
          h.mole,
          [
            { transform: 'translateY(0%) scale(1, 1)' },
            { transform: 'translateY(6%) scale(1.2, 0.7)', offset: 0.14 },
            { transform: 'translateY(2%) scale(0.94, 1.06)', offset: 0.3 },
            { transform: 'translateY(4%) scale(1, 1)', offset: 0.52, easing: 'cubic-bezier(.5,0,.9,.5)' },
            { transform: 'translateY(105%) scale(1, 1)' },
          ],
          430,
          { min: 260, fill: 'forwards', easing: 'linear' },
        )
    sfx.whack(this.combo) // 速く叩くほど 1 打が小さくなる音なので、間引かない
    if (this.gate('vibrate', 60)) vibrate(10)
    const cx = h.box.x + h.box.w / 2
    const hy = h.box.y + h.box.h * 0.3
    this.onoma(pickOne(ONOMA), cx + rnd(-10, 10), h.box.y - h.box.h * 0.08, h.box.w)
    if (!this.still) {
      this.hammer(pt, true)
      ring(p.fx, cx, hy, h.box.w * 1.05, '#fff4cc', tl, 360)
      this.px?.burst(cx, hy, { count: 10 + Math.min(12, this.combo), colors: SPARK, speed: 5, gravity: 0.2, life: 24, size: 4, shape: 'spark' })
      this.stars(cx, hy - h.box.h * 0.12, h.box.w)
    }
    this.drawScore()
    this.drawCombo()
    if (this.boss) this.flinch()
  }

  // 空振り: 小さなハンマーと土ぼこりだけ（控えめに）。コンボは切れる
  private miss(pt: Pt): void {
    if (this.combo) {
      this.combo = 0
      this.drawCombo()
    }
    if (this.gate('miss', 200)) sfx.whackMiss()
    if (this.still) return
    this.hammer(pt, false)
    if (this.gate('dust', 150)) ring(this.parts!.fx, pt.x, pt.y, 30, 'rgba(210,190,160,0.7)', this.tl, 300)
  }

  // ピコピコハンマー。打つ面を指の位置に合わせ、柄の端を支点に振り下ろす（画面の右側では左右を逆にする）
  private hammer(pt: Pt, hit: boolean): void {
    const fx = this.parts?.fx
    if (!fx) return
    const flip = pt.x > (this.el.clientWidth || 390) * 0.66
    const s = hit ? 0.95 : 0.7
    const node = el('i', flip ? 'fxq-hammer is-flip' : 'fxq-hammer', HAMMER_SVG)
    const ax = (flip ? 64 : 16) * s
    node.style.cssText = `left:${pt.x - ax}px;top:${pt.y - 44 * s}px;width:${80 * s}px;height:${50 * s}px;transform-origin:${(flip ? 4 : 76) * s}px ${20 * s}px`
    fx.append(node)
    const up = flip ? -48 : 48
    const o = hit ? 1 : 0.55
    this.anim(
      node,
      [
        { transform: `rotate(${up}deg)`, opacity: o },
        { transform: `rotate(${-up * 0.08}deg)`, opacity: o, offset: 0.3 },
        { transform: 'rotate(0deg)', opacity: o, offset: 0.48 },
        { transform: `rotate(${up * 0.45}deg)`, opacity: 0 },
      ],
      300,
      { min: 200, easing: 'cubic-bezier(.3,0,.3,1)' },
    ).finished.then(
      () => node.remove(),
      () => node.remove(),
    )
  }

  // 「ポカッ」などの文字が弾んで浮く（画面の端からはみ出さないように寄せる）
  private onoma(word: string, x: number, y: number, w: number, cls = ''): void {
    const fx = this.parts?.fx
    if (!fx) return
    const size = Math.round(clamp(w * 0.32, 16, 28))
    const half = (size * word.length) / 2 + 6
    const W = this.el.clientWidth || 390
    const node = el('i', cls ? `fxq-onoma ${cls}` : 'fxq-onoma', escapeHtml(word))
    node.style.cssText = `left:${clamp(x, half, Math.max(half, W - half))}px;top:${y}px;font-size:${size}px`
    fx.append(node)
    const r = rnd(-14, 14)
    const frames = this.still
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }]
      : [
          { transform: `translate(-50%, -50%) rotate(${r}deg) scale(0.4)`, opacity: 0 },
          { transform: `translate(-50%, -50%) rotate(${r}deg) scale(1.15)`, opacity: 1, offset: 0.22 },
          { transform: `translate(-50%, -60%) rotate(${r}deg) scale(1)`, opacity: 1, offset: 0.6 },
          { transform: `translate(-50%, -110%) rotate(${r}deg) scale(0.95)`, opacity: 0 },
        ]
    this.anim(node, frames, 560, { min: 360 }).finished.then(
      () => node.remove(),
      () => node.remove(),
    )
  }

  // 目を回した頭の上を、星がひと回りする
  private stars(x: number, y: number, w: number): void {
    const fx = this.parts?.fx
    if (!fx) return
    const r = w * 0.36
    const node = el('div', 'fxq-stars', [0, 1, 2].map((k) => `<i style="left:${Math.cos((k * 2 * Math.PI) / 3) * r}px;top:${Math.sin((k * 2 * Math.PI) / 3) * r * 0.45}px">${k === 1 ? '✦' : '★'}</i>`).join(''))
    node.style.cssText = `left:${x}px;top:${y}px`
    fx.append(node)
    this.anim(
      node,
      [
        { transform: 'rotate(0deg) scale(0.6)', opacity: 0 },
        { transform: 'rotate(80deg) scale(1)', opacity: 1, offset: 0.25 },
        { transform: 'rotate(240deg) scale(1)', opacity: 1, offset: 0.75 },
        { transform: 'rotate(300deg) scale(0.8)', opacity: 0 },
      ],
      620,
      { min: 360, easing: 'linear' },
    ).finished.then(
      () => node.remove(),
      () => node.remove(),
    )
  }

  private drawScore(): void {
    const p = this.parts
    if (!p) return
    p.num.textContent = String(this.score)
    if (!this.still) this.anim(p.num, [{ transform: 'scale(1.32)' }, { transform: 'scale(1)' }], 200, { min: 130, easing: 'cubic-bezier(.2,1.4,.4,1)' })
  }

  private drawCombo(): void {
    const p = this.parts
    if (!p) return
    const c = this.combo
    p.combo.classList.toggle('on', c >= 2)
    if (c < 2) return
    p.combo.dataset.lv = c >= 20 ? '3' : c >= 10 ? '2' : c >= 5 ? '1' : '0'
    p.combo.innerHTML = `<b>${c}</b><small>COMBO</small>`
    if (!this.still) this.anim(p.combo, [{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], 220, { min: 140, easing: 'cubic-bezier(.2,1.4,.4,1)' })
    const word = COMBO_WORD[c]
    if (!word) return
    this.hypeText(`${c} COMBO ${word}`)
    if (!this.still) {
      const b = boxIn(p.combo, this.el)
      this.px?.burst(b.x + b.w / 2, b.y + b.h / 2, { count: 24, colors: c >= 10 ? GOLD : SPARK, speed: 6, gravity: 0.15, life: 34, size: 5, shape: 'spark' })
    }
  }

  // ---- 時計とあおり -------------------------------------------------------------

  private drawTimer(t: number, k: number): void {
    const p = this.parts
    if (!p) return
    p.fill.style.transform = `scaleX(${(1 - k).toFixed(4)})`
    const left = Math.max(0, Math.ceil((this.introMs + this.playMs - t) / 1000))
    if (left !== this.secShown) {
      this.secShown = left
      p.sec.textContent = String(left)
      this.el.classList.toggle('is-half', k >= 0.5)
      this.el.classList.toggle('is-hurry', left <= 3)
      if (left >= 1 && left <= 3) {
        this.cue(() => sfx.questTick(left))
        if (!this.still) this.anim(p.sec, [{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], 260, { min: 160, easing: 'cubic-bezier(.2,1.4,.4,1)' })
      }
    }
    if (this.hyped < 1 && k >= 0.35) {
      this.hyped = 1
      this.hypeText('どんどん出てくる！')
    } else if (this.hyped < 2 && k >= 0.7) {
      this.hyped = 2
      this.hypeText('ラストスパート！')
    }
  }

  // 時計の下に、ひと言を弾ませる
  private hypeText(text: string): void {
    const node = this.parts?.hype
    if (!node) return
    node.textContent = text
    node.getAnimations().forEach((a) => a.cancel())
    const frames = this.still
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
      : [
          { opacity: 0, transform: 'translateY(8px) scale(0.7)' },
          { opacity: 1, transform: 'translateY(0px) scale(1.08)', offset: 0.14 },
          { opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.24 },
          { opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.8 },
          { opacity: 0, transform: 'translateY(-6px) scale(1)' },
        ]
    this.anim(node, frames, 1200, { min: 700, fill: 'forwards' })
  }

  // ---- ボス ---------------------------------------------------------------------

  // 影・ひび・照準を出す（叩く時間の間ずっと）
  private arm(ms: number): void {
    const b = this.boss
    if (!b || this.armed) return
    this.armed = true
    if (ms > 0) void play(b.marks, [{ opacity: 0 }, { opacity: 1 }], ms, this.tl, { fill: 'forwards' })
    else b.marks.style.opacity = '1'
  }

  // 時間とともに、ボスが近づいてくる（影が大きく、目がはっきりし、ひびが伸びる）。結果とは関係なく、時間だけで進む
  private drawDanger(k: number): void {
    const b = this.boss
    const q = Math.round(k * 100)
    if (!b || q === this.dangerShown) return
    this.dangerShown = q
    b.node.style.setProperty('--k', (q / 100).toFixed(2))
    b.cracks.forEach((path, i) => {
      const [, a, z] = CRACKS[i]
      path.style.strokeDashoffset = String(1 - clamp((k - a) / (z - a), 0, 1))
    })
  }

  // 叩くたびに、ボスがひるむ
  private flinch(): void {
    const b = this.boss
    if (!b || this.still || !this.gate('flinch', 220)) return
    this.anim(b.flinch, [{ transform: 'scale(1)' }, { transform: 'scale(0.82)', offset: 0.3 }, { transform: 'scale(1)' }], 320, { min: 180 })
    if (this.gate('flinch-word', 2600)) this.onoma('ひるんだ！', b.box.x + b.box.w / 2, b.box.y + b.box.h * 0.1, b.box.w, 'is-boss')
  }

  // 飛び出す（穴は「ゴゴゴ…」で開きかけていれば、そこから一気に開く）
  private bossRise(tl: Timeline, ms: number): Promise<void> {
    const b = this.boss
    if (!b) return Promise.resolve()
    void play(b.pit, this.still ? [{ opacity: 0.6 }, { opacity: 1 }] : [{ transform: 'scale(0.55)', opacity: 0.85 }, { transform: 'scale(1)', opacity: 1 }], 160, tl, {
      fill: 'forwards',
    })
    if (this.still) return play(b.body, [{ opacity: 0 }, { opacity: 1 }], 200, tl, { fill: 'forwards' })
    const cx = b.box.x + b.box.w / 2
    this.px?.burst(cx, b.box.y + b.box.h * 0.8, { count: 26, colors: SOIL, speed: 6, gravity: 0.32, life: 40, size: 7, shape: 'rect' })
    return play(
      b.body,
      [
        { transform: 'translateY(105%)' },
        { transform: 'translateY(-8%) scale(0.97, 1.04)', offset: 0.7 },
        { transform: 'translateY(0%) scale(1, 1)' },
      ],
      ms,
      tl,
      { easing: 'cubic-bezier(.2,.9,.3,1.1)', fill: 'forwards' },
    )
  }

  private bossDive(tl: Timeline, ms: number): Promise<void> {
    const b = this.boss
    if (!b) return Promise.resolve()
    void play(b.pit, this.still ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0)', opacity: 0 }], 200, tl, {
      delay: ms * 0.7,
      fill: 'forwards',
    })
    if (this.still) return play(b.body, [{ opacity: 1 }, { opacity: 0 }], 200, tl, { fill: 'forwards' })
    return play(b.body, [{ transform: 'translateY(0%)' }, { transform: 'translateY(-6%)', offset: 0.25 }, { transform: 'translateY(105%)' }], ms, tl, {
      easing: 'ease-in',
      fill: 'forwards',
    })
  }

  // ボスのふきだし（頭の上。画面の端からはみ出さないように寄せる）
  private bubble(text: string, ms: number): void {
    const p = this.parts
    const b = this.boss
    if (!p || !b) return
    const node = el('div', 'fxq-say', escapeHtml(text))
    p.fx.append(node)
    const W = this.el.clientWidth || 390
    const w = node.offsetWidth || 140
    const h = node.offsetHeight || 32
    const cx = b.box.x + b.box.w / 2
    const x = clamp(cx - w / 2, 8, W - 8 - w)
    node.style.left = `${x}px`
    node.style.top = `${Math.max(40, b.box.y + b.box.h * 0.8 - b.box.w * 1.42 - h - 8)}px`
    node.style.setProperty('--tail', `${clamp(cx - x, 16, w - 16)}px`)
    const frames = this.still
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
      : [
          { opacity: 0, transform: 'translateY(10px) scale(0.5)' },
          { opacity: 1, transform: 'translateY(0px) scale(1.08)', offset: 0.14 },
          { opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.24 },
          { opacity: 1, transform: 'translateY(0px) scale(1)', offset: 0.85 },
          { opacity: 0, transform: 'translateY(-6px) scale(0.96)' },
        ]
    void play(node, frames, ms, this.tl).then(() => node.remove())
  }

  // ---- 結果 ---------------------------------------------------------------------

  // 結果の前半（狙われた人）: 「ゴゴゴ…」でボスが出てこようとし、bossAppear の「ドバッ！」（実時間 0.42 秒）で飛び出す
  private async bossBurst(tl: Timeline, alive: () => boolean): Promise<boolean> {
    const b = this.boss
    if (!b) return alive()
    sfx.bossAppear()
    this.drawDanger(1)
    this.rumble(tl, BURST * this.speed)
    await tl.wait(BURST * this.speed)
    if (!alive()) return false
    void play(b.marks, [{ opacity: 1 }, { opacity: 0 }], 160, tl, { fill: 'forwards' })
    // 「ドバッ」はボスの顔にかからないよう、画面の内側の横に出す
    const cx = b.box.x + b.box.w / 2
    const side = cx < (this.el.clientWidth || 390) / 2 ? 1 : -1
    this.onoma('ドバッ', cx + side * b.box.w * 0.95, b.box.y + b.box.h * 0.15, b.box.w * 1.3, 'is-boss')
    void this.bossRise(tl, 280)
    return alive()
  }

  // 守りきれなかった: ボスがマスから飛び出して笑い、潜ってマスを埋める。悔しいが、重くしすぎない
  private async lostFlow(tl: Timeline, r: MoleQuestResult, alive: () => boolean): Promise<void> {
    const b = this.boss
    if (b) {
      if (!(await this.bossBurst(tl, alive))) return
      tl.at(160, () => this.bubble('いただき！', 1100))
      await tl.wait(480)
      if (!alive()) return
    }
    // questFail（約 1.3 秒）には土の音がない。このあとの card.moleFill の「ドスッ」と重ならないように先に鳴らす
    sfx.questFail()
    this.showResult(this.resultHtml('lost', r))
    await tl.wait(b ? 700 : 400)
    if (!alive()) return
    if (b) {
      await this.bossDive(tl, 240)
      if (!alive()) return
    }
    if (this.card && this.cell !== null) await this.card.moleFill(this.cell)
    if (!alive()) return
    await tl.wait(1200)
  }

  // 守りきった: 飛び出したボスに最後の一撃。目を回して吹っ飛び、「防衛成功！」
  private async defendFlow(tl: Timeline, r: MoleQuestResult, alive: () => boolean): Promise<void> {
    const p = this.parts
    const b = this.boss
    if (b) {
      if (!(await this.bossBurst(tl, alive))) return
      await tl.wait(300)
      if (!alive()) return
      // 最後の一撃
      const cx = b.box.x + b.box.w / 2
      const hy = b.box.y + b.box.h * 0.8 - b.box.w * 1.0
      b.node.classList.add('is-bonk')
      sfx.questDefend()
      this.onoma('ドカーン！', cx, hy - b.box.w * 0.25, b.box.w * 1.5, 'is-big')
      if (!this.still) {
        this.hammer({ x: cx, y: hy }, true)
        ring(p!.fx, cx, hy, b.box.w * 1.8, '#fff4cc', tl, 520)
        this.px?.burst(cx, hy, { count: 40, colors: GOLD, speed: 8, gravity: 0.2, life: 40, size: 6, shape: 'spark' })
        this.px?.burst(b.box.x + b.box.w / 2, b.box.y + b.box.h / 2, { count: 18, colors: EMBER, speed: 5, gravity: 0.25, life: 30, size: 4, shape: 'spark' })
        void play(
          b.body,
          [{ transform: 'translateY(0%) scale(1, 1)' }, { transform: 'translateY(6%) scale(1.14, 0.8)', offset: 0.35 }, { transform: 'translateY(0%) scale(1, 1)' }],
          240,
          tl,
          { fill: 'forwards' },
        )
      }
      this.washOnce()
      await tl.wait(260)
      if (!alive()) return
      // 吹っ飛んで退散（捨てぜりふを読ませてから「防衛成功！」）
      this.bubble('おぼえてろ〜！', 950)
      void play(b.pit, this.still ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0)', opacity: 0 }], 260, tl, {
        delay: 120,
        fill: 'forwards',
      })
      if (this.still) void play(b.body, [{ opacity: 1 }, { opacity: 0 }], 300, tl, { fill: 'forwards' })
      else {
        b.clip.classList.add('is-free')
        const dir = cx < (this.el.clientWidth || 390) / 2 ? -1 : 1
        void play(
          b.body,
          [
            { transform: 'translate(0%, 0%) rotate(0deg) scale(1)', opacity: 1 },
            { transform: `translate(${dir * 60}%, -120%) rotate(${dir * 200}deg) scale(0.8)`, opacity: 1, offset: 0.45 },
            { transform: `translate(${dir * 140}%, -230%) rotate(${dir * 420}deg) scale(0.35)`, opacity: 0 },
          ],
          820,
          tl,
          { easing: 'cubic-bezier(.25,.6,.4,1)', fill: 'forwards' },
        )
      }
      this.guard()
      await tl.wait(720)
      if (!alive()) return
    } else {
      sfx.questDefend()
      this.washOnce()
    }
    const lbl = this.label ? `${escapeHtml(this.label)} を守りきった！` : 'リーチを守りきった！'
    void this.showBanner(`<div class="fxq-ban is-win"><div class="fxq-ban-main">${txt('防衛成功！')}</div><div class="fxq-ban-note">${lbl}</div></div>`, 900)
    await tl.wait(1150)
    if (!alive()) return
    this.showResult(this.resultHtml('win', r))
    if (r.rank >= 1 && r.rank <= 3) this.kingBurst()
    await tl.wait(2000)
  }

  // 狙われていなかった人: 自分の撃退数を数え上げ、会場での順位と合計を見せる
  private async plainFlow(tl: Timeline, r: MoleQuestResult, alive: () => boolean): Promise<void> {
    void this.showBanner(`<div class="fxq-ban is-done"><div class="fxq-ban-main">${txt('クエスト終了！')}</div><div class="fxq-ban-note">おつかれさま！</div></div>`, 700)
    await tl.wait(900)
    if (!alive()) return
    const node = this.showResult(this.resultHtml('free', r))
    const count = node.querySelector<HTMLElement>('.fxq-count')
    if (count) this.countUp(count, r.score, 600)
    if (r.rank >= 1 && r.rank <= 3) {
      sfx.questDefend()
      tl.at(600, () => this.kingBurst())
    }
    await tl.wait(2300)
  }

  private resultHtml(kind: 'lost' | 'win' | 'free', r: MoleQuestResult): string {
    const rank = `<span>会場 <b>${fmt(r.rank)}</b> 位 / ${fmt(r.players)} 人</span>`
    const combo = this.best >= 5 ? `<span>最大 <b>${this.best}</b> COMBO</span>` : ''
    const king = r.rank >= 1 && r.rank <= 3 ? `<div class="fxq-king">★ 撃退王 第${r.rank}位！</div>` : ''
    const chip = this.label ? `<b class="fxq-chip">${escapeHtml(this.label)}</b>` : 'リーチ'
    if (kind === 'lost') {
      const main = r.need >= 1 ? `あと <b>${fmt(r.need)}</b> 匹 叩けば守れた！` : 'あと一歩で守れた！'
      return `<div class="fxq-res is-lost"><div class="fxq-res-head"><i>▼</i>守りきれなかった…</div><div class="fxq-res-main">${main}</div>
        <div class="fxq-res-sub"><span>ナイスファイト！</span><span>撃退 <b>${fmt(r.score)}</b> 匹</span>${rank}${combo}</div>${king}</div>`
    }
    if (kind === 'win') {
      return `<div class="fxq-res is-win"><div class="fxq-res-head"><i>★</i>防衛成功</div><div class="fxq-res-main">${chip} を守りきった！</div>
        <div class="fxq-res-sub"><span>撃退 <b>${fmt(r.score)}</b> 匹</span>${rank}${combo}</div>${king}</div>`
    }
    return `<div class="fxq-res is-free"><div class="fxq-res-head"><i>✦</i>あなたの結果</div><div class="fxq-res-main">撃退 <b class="fxq-count">${this.still ? fmt(r.score) : '0'}</b> 匹</div>
      <div class="fxq-res-sub">${rank}<span>会場の合計 <b>${fmt(r.total)}</b> 匹</span>${combo}</div>${king}</div>`
  }

  // 下の点数の代わりに、結果の札を出す
  private showResult(html: string): HTMLElement {
    const p = this.parts!
    const tl = this.tl
    void play(p.panel, [{ opacity: 1 }, { opacity: 0 }], 200, tl, { fill: 'forwards' })
    p.res.innerHTML = html
    const node = p.res.firstElementChild as HTMLElement
    void play(
      node,
      this.still
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: 'translateY(26px) scale(0.96)' },
            { opacity: 1, transform: 'translateY(-3px) scale(1.01)', offset: 0.7 },
            { opacity: 1, transform: 'translateY(0px) scale(1)' },
          ],
      340,
      tl,
      { easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' },
    )
    return node
  }

  private countUp(node: HTMLElement, to: number, ms: number): void {
    if (this.still || to <= 0) {
      node.textContent = fmt(to)
      return
    }
    const steps = Math.min(to, 20)
    for (let i = 1; i <= steps; i++) this.tl.at((ms * i) / steps, () => (node.textContent = fmt((to * i) / steps)))
    this.tl.at(ms, () => {
      if (!this.still) this.anim(node, [{ transform: 'scale(1.3)' }, { transform: 'scale(1)' }], 260, { min: 160, easing: 'cubic-bezier(.2,1.4,.4,1)' })
    })
  }

  // 撃退王（上位 3 人）に入った: 金の粒が弾ける
  private kingBurst(): void {
    const node = this.parts?.res.querySelector<HTMLElement>('.fxq-king')
    if (!node || this.still) return
    const b = boxIn(node, this.el)
    this.px?.burst(b.x + b.w / 2, b.y + b.h / 2, { count: 40, colors: GOLD, speed: 7, gravity: 0.18, life: 44, size: 6, shape: 'spark' })
    this.anim(node, [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1.12)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], 360, {
      min: 200,
      easing: 'cubic-bezier(.2,.8,.3,1)',
    })
  }

  // 守ったマスに、金の「✓」の盾
  private guard(): void {
    const p = this.parts
    const b = this.boss
    if (!p || !b) return
    const s = b.box.w * 0.92
    const g = el('div', 'fxq-guard', '<b>✓</b><small>守った</small>')
    g.style.cssText = `left:${b.box.x + b.box.w / 2 - s / 2}px;top:${b.box.y + b.box.h / 2 - s / 2}px;width:${s}px;height:${s}px`
    p.fx.append(g)
    const frames = this.still
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
      : [
          { transform: 'scale(0.3)', opacity: 0 },
          { transform: 'scale(1.15)', opacity: 1, offset: 0.14 },
          { transform: 'scale(1)', opacity: 1, offset: 0.24 },
          { transform: 'scale(1)', opacity: 1, offset: 0.85 },
          { transform: 'scale(1.08)', opacity: 0 },
        ]
    void play(g, frames, 2000, this.tl, { delay: 200, fill: 'backwards' }).then(() => g.remove())
  }

  // 全面の淡い金の光（1 回の演出につき 1 回まで。明るさの変化は 20% 以下、立ち上がりは 120ms 以上）
  private washOnce(): void {
    const p = this.parts
    if (!p || this.washed) return
    this.washed = true
    void play(p.wash, [{ opacity: 0 }, { opacity: 0.18, offset: 0.3 }, { opacity: 0 }], 900, this.tl, { min: 420 })
  }

  // ---- 文字 ---------------------------------------------------------------------

  // カードの真ん中に文字を叩きつけ、hold のあいだ見せて消す（hold < 0 なら、次の文字が来るまで残す）
  private async showBanner(html: string, hold: number): Promise<void> {
    const p = this.parts
    if (!p) return
    const tl = this.tl
    const token = ++this.bannerGen
    p.banner.innerHTML = html
    const inner = p.banner.firstElementChild as HTMLElement
    await play(
      inner,
      this.still
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transform: 'scale(1.7)', opacity: 0 },
            { transform: 'scale(0.94)', opacity: 1, offset: 0.65 },
            { transform: 'scale(1)', opacity: 1 },
          ],
      280,
      tl,
      { easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'forwards' },
    )
    if (hold < 0 || token !== this.bannerGen) return
    await tl.wait(hold)
    if (token !== this.bannerGen) return
    await play(inner, [{ opacity: 1 }, { opacity: 0 }], 220, tl, { fill: 'forwards' })
    if (token === this.bannerGen) p.banner.replaceChildren()
  }

  private setMission(kind: 'intro' | 'play' | 'wait'): void {
    const node = this.parts?.mission
    if (!node) return
    const chip = this.label ? `<b class="fxq-chip">${escapeHtml(this.label)}</b>` : ''
    const dots = '<em class="fxq-dots"><i>.</i><i>.</i><i>.</i></em>'
    const sub = this.target ? '叩いた数が 会場の下位だと やられる' : '叩いた数は 会場の合計と撃退王に入る'
    let head: string
    if (kind === 'wait') head = `<i>…</i><span>${this.target ? '判定中' : '集計中'}${dots}`
    else if (this.target) head = kind === 'intro' ? `<i>▲</i><span>ボスモグラが ${chip || 'あなたのリーチ'} を狙っている！` : `<i>▲</i><span>${chip || 'リーチ'} を守れ！`
    else head = kind === 'intro' ? '<i>✦</i><span>あなたは狙われていない' : '<i>✦</i><span>失うものはなし！ どんどん叩け'
    node.innerHTML = `${head}<small>${sub}</small></span>`
  }

  // 下から（上から）すっと出す。1 回だけ
  private reveal(node: HTMLElement, dy: number): void {
    if (node.dataset.on) return
    node.dataset.on = '1'
    void play(
      node,
      this.still || !dy ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'translateY(0px)' }],
      320,
      this.tl,
      { fill: 'forwards', easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
  }

  // ---- 小物 ---------------------------------------------------------------------

  // 警報や合図（大画面と同じ音）は、sound が 'all' のときだけ鳴らす。デモでは大画面が同じ PC で鳴らしている
  private cue(fn: () => void): void {
    if (this.sound === 'all') fn()
  }

  // 同じ光や音が、実時間で ms より短い間隔で続かないようにする
  private gate(key: string, ms: number): boolean {
    const now = performance.now()
    if (now - (this.gates.get(key) ?? -1e9) < ms) return false
    this.gates.set(key, now)
    return true
  }

  // 何もしていない状態に戻す（待っている play は、その時点の数で解決する）
  private reset(): void {
    this.gen++
    this.tl.cancel()
    this.tl = new Timeline(this.speed)
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    const done = this.onScore
    const score = this.score
    this.onScore = null
    this.px?.clear()
    this.px = null
    this.el.getAnimations().forEach((a) => a.cancel())
    this.el.replaceChildren()
    this.el.className = 'fxq'
    delete this.el.dataset.phase
    delete this.el.dataset.mode
    this.parts = null
    this.holes = []
    this.boss = null
    this.armed = false
    this.card = null
    this.cell = null
    this.target = false
    this.label = ''
    this.phase = 'idle'
    this.nextAt = 0
    this.overAt = 0
    this.score = 0
    this.combo = 0
    this.best = 0
    this.lastHit = -1e9
    this.secShown = -1
    this.hyped = 0
    this.dangerShown = -1
    this.washed = false
    this.gates.clear()
    done?.(score)
  }
}
