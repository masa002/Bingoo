import './quest.css'
import { bgm, sfx } from '../../audio'
import { GOLD, Particles } from '../particles'
import { Timeline, el, escapeHtml, prefersReducedMotion, replay } from '../runtime'
import { STAGE_H, STAGE_W } from '../theme'

// 緊急クエスト「モグラ撃退」の大画面（1920×1080 全体に重ねる。イベントの層 z-index 40、粒子の canvas は 60）。
//   brief:  警報「緊急クエスト発生！」のあと、説明の画面（何が起きるか・何をすればいいかの 3 つの手順）を出して、start を待つ。
//           司会が口頭で説明する時間なので、待っている間は動きを控えた落ち着いた画面にする（何十秒置いてもよい）
//   start:  「3・2・1」のカウントダウン（introMs。スマホと同時）→ 叩く時間（playMs）。
//           会場全員がスマホでモグラを叩いている様子と、叩いた数の合計（setTotal で 0.5 秒ごとに届く）を見せる。
//           叩く時間が終わったら「終了！」で止め、result() を待つ（待つ間は「集計中」）。brief なしで呼んでも動く
//   result: 結果（守った人・やられた人・リーチが消えた人、撃退数の合計、撃退王）を見せ、片付けてから解決する（約 6 秒）
// スマホでは全員にボスモグラを見せるが、マスを埋められるのはリーチの人だけ。やられる割合は先に決まっていて、
// 叩いた数が会場全体の下位に入った人がやられる。
//
//   const q = new MoleQuestStage(stageRoot, { speed })
//   q.brief({ playMs: 10000, targets: 312, players: 1000, autoMs: null }) // 司会の「スタート」まで出しておく
//   q.start({ introMs: 3600, playMs: 10000, targets: 312, players: 1000 })
//   q.setTotal(5321)
//   await q.result({ total: 18234, targets: 312, defended: 204, lost: 108, lostReach: 97, top: [...] })
//   q.destroy()
//
// 時間の使い方（演出上の ms。speed で縮む）:
//   brief()           0 で暗転と帯と警報の音、0.12 秒で「緊急クエスト発生！」、警報の「ウォン」3 回（0.42・0.92・1.42 秒）に合わせて脈打つ。
//                     0.92 秒で見出しが上へ退き、ボスモグラがせり上がる → 1.42 秒「モグラ襲来！」→ 2.1 秒で説明の画面に落ち着く
//                     （左に「カードを守れ！」と大ピンチのリーチの人数、右に手順 ①②③ が 2.3 秒から順に出る）→ 3.2 秒「まもなくスタート」。
//                     autoMs が数字なら、brief() から autoMs でいっぱいになるバーを出す。あとは start() が来るまで動かない
//   start()           説明を片付けて「3・2・1」。数字は叩き始めの 3・2・1 秒前に替わる（introMs が 3600 なら 0.6・1.6・2.6 秒）
//   introMs           「スタート！」。残り時間・会場の合計・モグラの畑に切り替わる
//   終わりの 3/2/1 秒  画面の真ん中に大きな 3・2・1
//   introMs+playMs    「終了！」。0.9 秒たっても result() が来なければ「集計中…」
//   result()          見出しと守った人・やられた人 → 1.3 秒で questTally を鳴らして撃退数を数え上げ（1.5 秒の「ドゥルルル…」に合わせて回し、
//                     2.8 秒の「ジャッ」で止める）→ 2.96 秒の「ジャーン！」で数字が決まり、撃退王が並ぶ → 3.51 秒の「キラリーン」で冠 →
//                     5.35 秒で消え始め、5.9 秒で片付けて解決する（叩く時間の途中で呼ばれたら、その場で「終了！」にして 0.7 秒後から始める）
// 区切り（叩き始め・3/2/1・終了）は Timeline で決める。終了の時刻は叩き始めの時点の速度で決まるので、
// 叩いている途中で速度を変えても、カウントダウンの表示と「終了！」はずれない（スマホと権威も同じ決め方をする）。
// モグラの畑と数字の回転は requestAnimationFrame で描く（畑は速度 ×2 までに抑え、穴ごとの動きを 1 秒に 3 回以下に保つ）。
// 説明の画面で待っている間は、毎フレームの処理を回さない（CSS のゆっくりした動きだけ）。
// 音は警報（brief）・カウントダウンの 3/2/1・叩き始め・残り 3/2/1・終了・結果の数え上げだけを鳴らす（モグラと叩く音はスマホが鳴らす）。
// 警報の赤は点滅させない（赤は動かない背景とふちにだけ使い、脈打つ光は琥珀色にする）。
// 色の決まり（スマホの側とそろえる）: 残り時間は金 #f5c542（残り 3 秒から橙 #ff9f1a）、守りきったは緑 #22c55e と ◆、
// やられたは灰青 #94a3b8 と ▼、「あなた」は水色の札（地 #5ad2ff・文字 #06223a）、見出しは金のグラデーションに濃い茶 #2a1a05 の縁。
// 狙われたリーチが 0 人のときは、「大ピンチのリーチ 0 人」とは出さず、「会場みんなで モグラを追い返せ！」にする
// （結果も、守った人・やられた人を出さずに、撃退数の合計と撃退王を主役にする）

export interface MoleQuestStageStart {
  introMs: number // 「3・2・1」のカウントダウンの長さ（スマホとそろえる）
  playMs: number // 叩ける時間
  targets: number // 本当に狙われた人数（リーチの人。スマホでは全員にボスモグラを見せる）
  players: number // 参加人数
}

export interface MoleQuestStageBrief {
  playMs: number // 叩ける時間（説明に「10 秒間」と出す）
  targets: number // 本当に狙われた人数（リーチの人）
  players: number // 参加人数
  autoMs: number | null // 自動で始まるまでの時間（司会の「スタート」を待つときは null）
}

export interface MoleQuestStageResult {
  total: number // 会場で叩いた数の合計
  targets: number
  defended: number // 守りきった人
  lost: number // やられた人
  lostReach: number // それでリーチが消えた人
  top: { name: string; score: number; isMe: boolean }[] // 撃退王（上位 3 人）
}

// ---- 共通の部品 ------------------------------------------------------------------

// 取り消されたときに、演出の途中から抜けるための印
const CANCELLED = Symbol('cancelled')

const FONT = "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', system-ui, sans-serif"
const AMBER = ['#ffc53d', '#ffe08a', '#fff4cc', '#ff9f1a'] as const
const SOIL = ['#7a4a2e', '#a8714a', '#5a3a22', '#c9a27e'] as const

const fmt = (n: number): string => n.toLocaleString('ja-JP')
const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0)
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const easeOut = (k: number): number => 1 - Math.pow(1 - clamp(k, 0, 1), 3)
const easeIn = (k: number): number => Math.pow(clamp(k, 0, 1), 2)
// 少し行き過ぎてから戻る（モグラが飛び出すとき）
const backOut = (k: number): number => {
  const x = clamp(k, 0, 1) - 1
  return 1 + 2.4 * x * x * x + 1.4 * x * x
}

// 付けたクラスの transition が必ず効くように、いったん配置を確定させてから付ける
function on(node: Element | null | undefined, cls = 'on'): void {
  if (!node) return
  void node.getBoundingClientRect()
  node.classList.add(cls)
}

// 決まった種から作る乱数（畑の飾りと穴の並びを、毎回同じ形にする）
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 演出の台本。始まりから t ms の時刻まで待ち、取り消されたら（host が外されたときも）CANCELLED を投げて抜ける
class Seq {
  private now = 0

  constructor(
    readonly tl: Timeline,
    private readonly alive: () => boolean,
  ) {}

  async until(t: number): Promise<void> {
    if (t > this.now) {
      await this.tl.wait(t - this.now)
      this.now = t
    }
    if (!this.alive()) this.tl.cancel()
    if (this.tl.cancelled) throw CANCELLED
  }

  // 始まりから t ms の時刻に fn を呼ぶ（待たない）
  at(t: number, fn: () => void): void {
    this.tl.at(t - this.now, fn)
  }
}

// ---- 絵 ----------------------------------------------------------------------------

// 小さなモグラ（スマホのカードのモグラと同じ絵）。canvas に描くので、表情ごとに 1 枚ずつ絵にしておく
const MOLE_BODY =
  '<path d="M14 92 C14 38 30 18 50 18 C70 18 86 38 86 92 Z" fill="#6b4a2f"/>' +
  '<path d="M24 30 C26 6 74 6 76 30 Z" fill="#f5c542"/>' +
  '<path d="M31 24 C33 18 38 15 44 14" stroke="#fff4cc" stroke-width="2.6" fill="none" stroke-linecap="round" opacity=".8"/>' +
  '<rect x="19" y="27" width="62" height="5" rx="2.5" fill="#d9a520"/>' +
  '<circle cx="50" cy="15" r="5" fill="#fff4cc" stroke="#d9a520" stroke-width="2"/>' +
  '<ellipse cx="50" cy="61" rx="17" ry="12" fill="#c99a6e"/>' +
  '<ellipse cx="50" cy="54" rx="7" ry="5" fill="#ff8fab"/>' +
  '<ellipse cx="30" cy="57" rx="5" ry="3.5" fill="#ff8fab" opacity=".5"/><ellipse cx="70" cy="57" rx="5" ry="3.5" fill="#ff8fab" opacity=".5"/>' +
  '<ellipse cx="22" cy="80" rx="13" ry="9" fill="#e9b48f"/><ellipse cx="78" cy="80" rx="13" ry="9" fill="#e9b48f"/>' +
  '<path d="M14 76v6M19 74v7M24 74v7M76 74v7M81 74v7M86 76v6" stroke="#fff4e6" stroke-width="2" stroke-linecap="round"/>'

// 表情（ふつう: 怒り眉 ／ 叩かれた: > < ／ にやり: ^ ^ と舌）
const MOLE_FACE = {
  n:
    '<path d="M33 37 L42 39.5 M67 37 L58 39.5" stroke="#2a1a0c" stroke-width="2.4" stroke-linecap="round"/>' +
    '<circle cx="38" cy="45" r="3.6" fill="#140c06"/><circle cx="62" cy="45" r="3.6" fill="#140c06"/>' +
    '<circle cx="39.2" cy="43.8" r="1.2" fill="#fff"/><circle cx="63.2" cy="43.8" r="1.2" fill="#fff"/>' +
    '<path d="M43 63 Q50 70 57 63" stroke="#5a3a20" stroke-width="2" fill="none" stroke-linecap="round"/>',
  bonk:
    '<path d="M34 40.5 L41.5 45 L34 49.5 M66 40.5 L58.5 45 L66 49.5" stroke="#140c06" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<ellipse cx="50" cy="66" rx="4.6" ry="4.2" fill="#5a3a20"/>',
  smug:
    '<path d="M33.5 46.5 Q38 40.5 42.5 46.5 M57.5 46.5 Q62 40.5 66.5 46.5" stroke="#140c06" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
    '<path d="M43 63 Q50 70 57 63" stroke="#5a3a20" stroke-width="2" fill="none" stroke-linecap="round"/>' +
    '<path d="M48.5 66.5 Q51 73 53.5 66.5 Z" fill="#ff6f91"/>',
} as const

const moleSvg = (face: keyof typeof MOLE_FACE): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 90" width="240" height="216">${MOLE_BODY}${MOLE_FACE[face]}</svg>`

// ピコピコハンマー（横向き。右端が持ち手、左端の頭は縦の筒で、下の面で叩く）
const HAMMER_INNER =
  '<rect x="64" y="46" width="132" height="18" rx="9" fill="#ffd23f" stroke="#a87a10" stroke-width="3"/>' +
  '<path d="M76 51 H186" stroke="#fff6c8" stroke-width="4" stroke-linecap="round" opacity=".8"/>' +
  '<rect x="8" y="10" width="58" height="90" rx="14" fill="#ff5f7e" stroke="#9e2440" stroke-width="3"/>' +
  '<path d="M9 34 H65 M9 55 H65 M9 76 H65" stroke="#d93a5c" stroke-width="3"/>' +
  '<rect x="4" y="2" width="66" height="16" rx="8" fill="#ffd23f" stroke="#a87a10" stroke-width="3"/>' +
  '<rect x="4" y="92" width="66" height="16" rx="8" fill="#ffd23f" stroke="#a87a10" stroke-width="3"/>' +
  '<path d="M20 24 V86" stroke="#ffd0da" stroke-width="5" stroke-linecap="round" opacity=".7"/>'
const HAMMER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" width="400" height="220">${HAMMER_INNER}</svg>`
const HAMMER_ICON = `<svg class="fxqs-ham" viewBox="0 0 200 110" aria-hidden="true">${HAMMER_INNER}</svg>`

// ボスモグラ（ヘルメットに BOSS の札、ほおにばんそうこう、金歯）。表情は data-face で切り替える
// （grin 悪だくみ ／ smug してやったり ／ bonk 叩かれてふらふら ／ cry 完敗で泣く）
const BOSS_SVG = `<svg class="fxqs-boss-svg" viewBox="0 0 200 180" aria-hidden="true">
  <path d="M22 196 C20 86 54 36 100 36 C146 36 180 86 178 196 Z" fill="#6b4a2f"/>
  <path d="M60 196 C60 140 78 116 100 116 C122 116 140 140 140 196 Z" fill="#8a6142" opacity=".6"/>
  <path d="M40 66 C42 8 158 8 160 66 Z" fill="#f5c542"/>
  <path d="M60 46 C64 32 74 24 86 20" stroke="#fff4cc" stroke-width="6" fill="none" stroke-linecap="round" opacity=".75"/>
  <rect x="30" y="60" width="140" height="12" rx="6" fill="#d9a520"/>
  <rect x="79" y="40" width="42" height="15" rx="4" fill="#3b2412"/>
  <text x="100" y="51.6" text-anchor="middle" font-size="11" font-weight="900" fill="#ffd84a" letter-spacing="1" font-family="system-ui, sans-serif">BOSS</text>
  <circle cx="100" cy="24" r="11" fill="#fff4cc" stroke="#d9a520" stroke-width="4"/>
  <ellipse cx="100" cy="124" rx="36" ry="25" fill="#c99a6e"/>
  <ellipse cx="100" cy="109" rx="15" ry="10.5" fill="#ff8fab"/>
  <ellipse cx="95" cy="105" rx="5" ry="3" fill="#ffd3e1"/>
  <ellipse cx="56" cy="116" rx="11" ry="7" fill="#ff8fab" opacity=".5"/>
  <ellipse cx="144" cy="116" rx="11" ry="7" fill="#ff8fab" opacity=".5"/>
  <path d="M68 118 L38 112 M68 126 L38 131 M132 118 L162 112 M132 126 L162 131" stroke="#f6e6d4" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>
  <g transform="rotate(-24 150 96)"><rect x="136" y="90" width="30" height="12" rx="5" fill="#f3d3b0" stroke="#c9a27e" stroke-width="1.6"/><path d="M147 92v8M155 92v8" stroke="#c9a27e" stroke-width="1.6"/></g>
  <g class="fxqs-f fxqs-f-grin">
    <path d="M58 76 L86 85 M142 76 L114 85" stroke="#2a1a0c" stroke-width="6.5" stroke-linecap="round"/>
    <ellipse cx="75" cy="94" rx="8" ry="8.5" fill="#140c06"/><ellipse cx="125" cy="94" rx="8" ry="8.5" fill="#140c06"/>
    <circle cx="77.5" cy="91" r="2.6" fill="#fff"/><circle cx="127.5" cy="91" r="2.6" fill="#fff"/>
    <path d="M80 130 Q100 150 122 126 Q102 138 80 130 Z" fill="#3b1d0e"/>
    <rect x="102" y="131" width="9" height="8" rx="2" fill="#ffd84a" stroke="#a87a10" stroke-width="1.2"/>
  </g>
  <g class="fxqs-f fxqs-f-smug">
    <path d="M64 96 Q75 84 86 96 M114 96 Q125 84 136 96" stroke="#140c06" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M78 128 Q100 158 124 128 Z" fill="#3b1d0e"/>
    <ellipse cx="103" cy="143" rx="10" ry="6.5" fill="#ff6f91"/>
    <rect x="94" y="128" width="12" height="7" rx="2" fill="#ffd84a"/>
  </g>
  <g class="fxqs-f fxqs-f-bonk">
    <path d="M64 86 L82 94 L64 102 M136 86 L118 94 L136 102" stroke="#140c06" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M82 136 Q88 129 94 136 Q100 143 106 136 Q112 129 118 136" stroke="#5a3a20" stroke-width="4.5" fill="none" stroke-linecap="round"/>
    <path d="M62 30 L70 40 L64 47 L72 58" stroke="#8a5a00" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <g class="fxqs-f fxqs-f-cry">
    <path d="M64 92 Q75 100 86 92 M114 92 Q125 100 136 92" stroke="#140c06" stroke-width="6" fill="none" stroke-linecap="round"/>
    <path d="M70 100 Q64 122 70 146 M130 100 Q136 122 130 146" stroke="#8fd3ff" stroke-width="8" fill="none" stroke-linecap="round" opacity=".9"/>
    <path d="M84 140 Q100 128 116 140" stroke="#5a3a20" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  </g>
  <g class="fxqs-paw l"><ellipse cx="38" cy="162" rx="26" ry="18" fill="#e9b48f"/><path d="M20 156v9M28 152v12M36 151v12M44 152v11" stroke="#fff4e6" stroke-width="3.4" stroke-linecap="round"/></g>
  <g class="fxqs-paw r"><ellipse cx="162" cy="162" rx="26" ry="18" fill="#e9b48f"/><path d="M180 156v9M172 152v12M164 151v12M156 152v11" stroke="#fff4e6" stroke-width="3.4" stroke-linecap="round"/></g>
</svg>`

// 照準（狙われたリーチの印）
const RETICLE =
  '<svg class="fxqs-reticle" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" stroke-width="4"/>' +
  '<circle cx="20" cy="20" r="4" fill="currentColor"/><path d="M20 1v10M20 29v10M1 20h10M29 20h10" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>'

// 警報の三角（!）
const WARN = '<span class="fxqs-warn"><b>!</b></span>'

// 撃退王の冠
const CROWN_SVG = `<svg viewBox="0 0 110 76" aria-hidden="true">
  <path d="M8 66 L4 20 L30 40 L55 6 L80 40 L106 20 L102 66 Z" fill="#ffd84a" stroke="#a87a10" stroke-width="5" stroke-linejoin="round"/>
  <rect x="8" y="58" width="94" height="13" rx="3" fill="#f0a500" stroke="#a87a10" stroke-width="4"/>
  <circle cx="55" cy="42" r="7" fill="#ff5ad2" stroke="#fff4cc" stroke-width="2"/>
  <circle cx="30" cy="50" r="5" fill="#5ad2ff"/><circle cx="80" cy="50" r="5" fill="#5aff8c"/>
</svg>`

// 叩かれてふらふらのボスの頭の上を回る星
const DIZZY = '<span class="fxqs-dz" style="--k:0">★</span><span class="fxqs-dz" style="--k:1">★</span><span class="fxqs-dz" style="--k:2">★</span>'

// 残り時間の輪（半径 136。12 の目盛り）
const RING_C = 2 * Math.PI * 136
function ringSvg(): string {
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    const p = (r: number): string => `${(160 + Math.sin(a) * r).toFixed(1)}" y${r > 154 ? 2 : 1}="${(160 - Math.cos(a) * r).toFixed(1)}`
    return `<line x1="${p(150)}" x2="${p(158)}"/>`
  }).join('')
  return (
    '<svg class="fxqs-ring" viewBox="0 0 320 320" aria-hidden="true">' +
    '<circle class="fxqs-ring-trk" cx="160" cy="160" r="136"/>' +
    `<circle class="fxqs-ring-arc" cx="160" cy="160" r="136" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="0" transform="rotate(-90 160 160)"/>` +
    `<g class="fxqs-ring-tk">${ticks}</g></svg>`
  )
}

// SVG を canvas の絵にする（読み込みは非同期。読めたら done を呼ぶ）
function sprite(svg: string, w: number, h: number, done: () => void): HTMLCanvasElement {
  const c = el('canvas')
  c.width = w
  c.height = h
  const img = new Image()
  img.onload = () => {
    c.getContext('2d')?.drawImage(img, 0, 0, w, h)
    done()
  }
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  return c
}

// 楕円の放射グラデーションで塗る（hi は明るい中心を上にずらす量。rx に対する比）
function blob(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, stops: readonly (readonly [number, string])[], hi = 0): void {
  g.save()
  g.translate(x, y)
  g.scale(1, ry / rx)
  const gr = g.createRadialGradient(0, -hi * rx, rx * 0.05, 0, 0, rx)
  for (const [o, c] of stops) gr.addColorStop(o, c)
  g.fillStyle = gr
  g.beginPath()
  g.arc(0, 0, rx, 0, Math.PI * 2)
  g.fill()
  g.restore()
}

let starPath: Path2D | null = null
const star = (): Path2D =>
  (starPath ??= new Path2D('M0 -1 L0.29 -0.4 L0.95 -0.31 L0.48 0.15 L0.59 0.81 L0 0.5 L-0.59 0.81 L-0.48 0.15 L-0.95 -0.31 L-0.29 -0.4 Z'))

// ---- 回る数字（オドメーター） ------------------------------------------------------

const STRIP = Array.from({ length: 11 }, (_, i) => `<i>${i % 10}</i>`).join('')
const ROW = 1.1 // 数字 1 コマの高さ（em）
const BLUR = [0, 6, 16, 40] as const // ぶれの段階が上がる速さ（その桁が 1 秒に何コマ進むか）

// 桁ごとに縦に回る数字。速く回る桁ほど上下にぶれて見せ（残像）、止まる桁はくっきり見せる
class Odometer {
  readonly el: HTMLElement
  private wins: HTMLElement[] = [] // 1 の位から
  private strips: HTMLElement[] = []
  private levels: number[] = []
  private n = 0
  private rate = 0 // 1 の位が 1 秒に進むコマ数（ならした値）
  private lastV = -1
  private lastT = 0

  constructor(
    private readonly maxWidth: number,
    private readonly fontPx: number,
  ) {
    this.el = el('span', 'fxqs-odo')
  }

  // still なら、ぶれなしで整数の位置に止める
  render(value: number, now: number, still = false): void {
    let v = Math.max(0, Number.isFinite(value) ? value : 0)
    const n = String(Math.floor(v)).length
    if (n !== this.n) this.build(n)
    if (this.lastV >= 0 && now > this.lastT) {
      const inst = Math.abs(v - this.lastV) / ((now - this.lastT) / 1000)
      this.rate += (inst - this.rate) * Math.min(1, (now - this.lastT) / 140)
    }
    this.lastV = v
    this.lastT = now
    if (still) {
      v = Math.round(v)
      this.rate = 0
    }
    let unit = 1
    for (let i = 0; i < this.n; i++) {
      const digit = Math.floor(v / unit) % 10
      // 上の桁は、下の桁が 9 → 0 に回る最後の 1 コマのあいだだけ一緒に回る
      const pos = still ? digit : i === 0 ? v % 10 : digit + clamp((v % unit) - (unit - 1), 0, 1)
      this.strips[i].style.transform = `translate3d(0, ${(-pos * ROW).toFixed(3)}em, 0)`
      const r = this.rate / unit
      let lv = this.levels[i]
      while (lv < 3 && r > BLUR[lv + 1] * 1.15) lv++
      while (lv > 0 && r < BLUR[lv] * 0.85) lv--
      if (lv !== this.levels[i]) {
        this.wins[i].classList.remove(`b${this.levels[i]}`)
        if (lv) this.wins[i].classList.add(`b${lv}`)
        this.levels[i] = lv
      }
      unit *= 10
    }
  }

  private build(n: number): void {
    const grew = n > this.n && this.n > 0
    this.n = n
    const parts: string[] = []
    for (let i = n - 1; i >= 0; i--) {
      parts.push(`<span class="fxqs-odo-w${grew && i === n - 1 ? ' new' : ''}"><span class="fxqs-odo-s">${STRIP}</span></span>`)
      if (i > 0 && i % 3 === 0) parts.push('<span class="fxqs-odo-c">,</span>')
    }
    this.el.innerHTML = parts.join('')
    this.wins = [...this.el.querySelectorAll<HTMLElement>('.fxqs-odo-w')].reverse()
    this.strips = this.wins.map((w) => w.firstElementChild as HTMLElement)
    this.levels = this.wins.map(() => 0)
    // 枠に収まる大きさにする（桁 0.64em、カンマ 0.28em）
    const em = n * 0.64 + Math.floor((n - 1) / 3) * 0.28
    this.el.style.fontSize = `${Math.min(this.fontPx, this.maxWidth / em).toFixed(1)}px`
  }
}

// ---- モグラの畑（canvas） ----------------------------------------------------------

type MoleState = 'idle' | 'rise' | 'up' | 'hit' | 'sink'

interface Hole {
  x: number
  y: number // 穴の中心（canvas の座標）
  s: number // 大きさ（奥ほど小さい）
  state: MoleState
  t: number // 今の状態になってからの時間（ms。負なら出番待ち）
  hold: number // 顔を出してからハンマーが当たるまで
  miss: boolean // 空振り（モグラがよける）
  calm: boolean // 誰も叩きに来ない（にやりとして引っ込むだけ）
  face: number // 0 ふつう / 1 叩かれた / 2 にやり
  dir: 1 | -1 // ハンマーが来る側
  cool: number // 次に顔を出せるまで
  from: number // 沈み始めたときの高さ
}

interface Bit {
  kind: 'star' | 'ring' | 'word' | 'dust'
  x: number
  y: number
  vx: number
  vy: number
  t: number
  life: number
  s: number
  r: number
  vr: number
  text: string
  miss: boolean
}

const FIELD_H = 700 // 畑の canvas の高さ（大画面の y 380〜1080 に置く）
// 穴の列（奥から手前へ。y は canvas の座標、s は大きさ、n は穴の数）
const ROWS = [
  { y: 160, s: 0.5, n: 13 },
  { y: 270, s: 0.63, n: 11 },
  { y: 405, s: 0.79, n: 9 },
  { y: 565, s: 0.97, n: 7 },
] as const
const MOLE_W = 150
const MOLE_H = 135
const PIT_RX = 76
const PIT_RY = 21
const RISE = 150 // 飛び出す
const SWING = 120 // ハンマーを振り下ろす
const HIT = 260 // 叩かれてつぶれる
const DODGE = 140 // よけて引っ込む
const SINK = 180 // 沈む
const HAM_REACH = 128 // ハンマーの柄の長さ（大きさ 1 のとき）
const WORDS = ['ポカッ', 'ポコッ', 'ペシッ', 'ボコッ', 'ピコッ', 'バシッ'] as const

// 会場のあちこちでモグラが顔を出しては叩かれる畑。数は rate（1 秒あたり）で決まる。
// 時間は呼び出し側が update(dt) で進める（速度はそこで掛ける）
class MoleField {
  rate = 8
  whack = 1 // 叩かれる割合（0 なら会場の誰も叩いていない。ハンマーは来ず、モグラは好き放題に顔を出す）
  private readonly ctx: CanvasRenderingContext2D
  private readonly bg: HTMLCanvasElement
  private readonly sprites: HTMLCanvasElement[]
  private readonly hammer: HTMLCanvasElement
  private readonly rows: Hole[][] = []
  private readonly holes: Hole[] = []
  private bits: Bit[] = []
  private acc = 0
  private spawning = false
  private still = false

  constructor(box: HTMLElement) {
    const canvas = el('canvas')
    canvas.width = STAGE_W
    canvas.height = FIELD_H
    box.append(canvas)
    this.ctx = canvas.getContext('2d')!
    // 絵が読めたら、止まった絵（動きを減らす設定）を描き直す
    const redraw = (): void => {
      if (this.still) this.draw()
    }
    this.sprites = (['n', 'bonk', 'smug'] as const).map((f) => sprite(moleSvg(f), 240, 216, redraw))
    this.hammer = sprite(HAMMER_SVG, 400, 220, redraw)
    const r = rng(7)
    ROWS.forEach((row, ri) => {
      const margin = 40 + 110 * row.s
      const step = (STAGE_W - margin * 2) / row.n
      const list: Hole[] = []
      for (let i = 0; i < row.n; i++) {
        list.push({
          x: margin + step * (i + 0.5) + (ri % 2 ? 1 : -1) * step * 0.18 + (r() - 0.5) * 24 * row.s,
          y: row.y + (r() - 0.5) * 14 * row.s,
          s: row.s,
          state: 'idle',
          t: 0,
          hold: 0,
          miss: false,
          calm: false,
          face: 0,
          dir: 1,
          cool: r() * 500,
          from: 0,
        })
      }
      this.rows.push(list)
      this.holes.push(...list)
    })
    this.bg = el('canvas')
    this.bg.width = STAGE_W
    this.bg.height = FIELD_H
    this.paint()
    this.draw()
  }

  // 叩く時間の始まり。最初はまとめて飛び出す
  start(): void {
    this.spawning = true
    for (let i = 0; i < 9; i++) this.spawn(i * 45)
  }

  // 叩く時間の終わり。出ているモグラは、にやりとして引っ込む
  stop(): void {
    this.spawning = false
    for (const h of this.holes) {
      if (h.state !== 'rise' && h.state !== 'up') continue
      h.from = this.lift(h)
      h.face = 2
      h.state = 'sink'
      h.t = 0
    }
  }

  // 動きを減らす設定: 何匹か顔を出した、止まった絵にする
  showStill(): void {
    this.still = true
    this.spawning = false
    const up = new Set([2, 6, 10, 15, 19, 23, 28, 31, 35, 38])
    this.holes.forEach((h, i) => {
      h.state = up.has(i) ? 'up' : 'idle'
      h.t = 0
      h.hold = Infinity
      h.face = i % 4 === 3 ? 1 : 0
    })
    this.bits = []
    this.draw()
  }

  update(dt: number): void {
    if (this.still) return
    if (this.spawning) {
      this.acc = Math.min(4, this.acc + (dt / 1000) * this.rate)
      while (this.acc >= 1) {
        this.acc -= 1
        this.spawn(0)
      }
    }
    for (const h of this.holes) this.step(h, dt)
    const f = dt / 16.7
    for (const b of this.bits) {
      b.t += dt
      b.x += b.vx * f
      b.y += b.vy * f
      if (b.kind === 'star') b.vy += 0.5 * f * b.s
      b.r += b.vr * f
    }
    this.bits = this.bits.filter((b) => b.t < b.life)
  }

  draw(): void {
    const c = this.ctx
    c.clearRect(0, 0, STAGE_W, FIELD_H)
    c.drawImage(this.bg, 0, 0)
    // 奥の列から順に、モグラ → ハンマー（手前の列のモグラが、奥のハンマーより前に来る）
    for (const row of this.rows) {
      for (const h of row) if (h.state !== 'idle') this.drawMole(c, h)
      for (const h of row) if (h.state === 'up' || h.state === 'hit') this.drawHammer(c, h)
    }
    for (const b of this.bits) this.drawBit(c, b)
  }

  private spawn(delay: number): void {
    const free = this.holes.filter((h) => h.state === 'idle' && h.cool <= 0)
    if (!free.length) return
    const h = free[Math.floor(Math.random() * free.length)]
    h.state = 'rise'
    h.t = -delay
    h.calm = Math.random() >= this.whack
    h.hold = h.calm ? 500 + Math.random() * 600 : SWING + 120 + Math.random() * 420
    h.miss = !h.calm && Math.random() < 0.08
    h.face = 0
    h.dir = Math.random() < 0.5 ? 1 : -1
  }

  private step(h: Hole, dt: number): void {
    const before = h.t
    h.t += dt
    switch (h.state) {
      case 'idle':
        h.cool -= dt
        return
      case 'rise':
        // 顔を出した瞬間に、土が少しはねる
        if (before < 0 && h.t >= 0) this.dust(h.x, h.y - 4 * h.s, h.s * 0.7)
        if (h.t >= RISE) this.go(h, 'up')
        return
      case 'up':
        if (h.t >= h.hold) this.strike(h)
        return
      case 'hit':
        if (h.t >= (h.miss ? DODGE : HIT)) {
          h.from = h.miss ? 0 : 0.86
          this.go(h, 'sink')
        }
        return
      case 'sink':
        if (h.t >= SINK) {
          this.go(h, 'idle')
          // 同じ穴は 1 秒に 1 回くらいまで（光り方が 1 秒に 3 回を超えないように）
          h.cool = 420 + Math.random() * 700
        }
    }
  }

  private go(h: Hole, state: MoleState): void {
    h.state = state
    h.t = 0
  }

  // ハンマーが振り下ろされた瞬間
  private strike(h: Hole): void {
    this.go(h, 'hit')
    const s = h.s
    if (h.calm) {
      // 誰も叩きに来ないので、にやりとして引っ込む
      h.miss = true
      h.face = 2
      return
    }
    if (h.miss) {
      h.face = 2
      this.dust(h.x, h.y - 6 * s, s)
      this.word('スカッ', h.x + h.dir * 30 * s, h.y - 70 * s, s, true)
      return
    }
    h.face = 1
    const top = h.y - MOLE_H * s * 0.9
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.55 + (Math.random() - 0.5) * 0.3
      const v = (5 + Math.random() * 3) * s
      this.bits.push({ kind: 'star', x: h.x, y: top, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 460, s, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, text: '', miss: false })
    }
    this.bits.push({ kind: 'ring', x: h.x, y: top + 8 * s, vx: 0, vy: 0, t: 0, life: 280, s, r: 0, vr: 0, text: '', miss: false })
    this.word(WORDS[Math.floor(Math.random() * WORDS.length)], h.x - h.dir * 40 * s, top - 34 * s, s, false)
  }

  private word(text: string, x: number, y: number, s: number, miss: boolean): void {
    this.bits.push({ kind: 'word', x, y, vx: 0, vy: 0, t: 0, life: 620, s, r: (Math.random() - 0.5) * 0.4, vr: 0, text, miss })
  }

  private dust(x: number, y: number, s: number): void {
    for (const side of [-1, 1]) {
      this.bits.push({ kind: 'dust', x: x + side * 40 * s, y, vx: side * 0.8 * s, vy: 0, t: 0, life: 420, s, r: 0, vr: 0, text: '', miss: false })
    }
  }

  // 穴から出ている高さ（0〜1）
  private lift(h: Hole): number {
    switch (h.state) {
      case 'rise':
        return h.t <= 0 ? 0 : backOut(h.t / RISE)
      case 'up':
        return 1
      case 'hit':
        return h.miss ? 1 - easeIn(h.t / DODGE) : 1 - 0.14 * easeOut(h.t / 60)
      case 'sink':
        return h.from * (1 - easeIn(h.t / SINK))
      default:
        return 0
    }
  }

  // 横と縦の伸び縮み（飛び出すときは縦に伸び、叩かれたらつぶれる）
  private squash(h: Hole): [number, number] {
    if (h.state === 'rise') {
      const k = clamp(h.t / RISE, 0, 1)
      return [1 - 0.08 * (1 - k), 1 + 0.12 * (1 - k)]
    }
    if (h.state === 'hit' && !h.miss) {
      const sy = 0.72 + 0.2 * easeOut(h.t / HIT)
      return [1 + (1 - sy) * 0.7, sy]
    }
    if (h.state === 'sink' && h.face === 1) return [1.05, 0.92]
    return [1, 1]
  }

  private drawMole(c: CanvasRenderingContext2D, h: Hole): void {
    const lift = this.lift(h)
    if (lift <= 0.002) return
    const s = h.s
    const w = MOLE_W * s
    const hh = MOLE_H * s
    const [sx, sy] = this.squash(h)
    c.save()
    // 見えるのは穴の線より上と、穴の口の中だけ
    c.beginPath()
    c.rect(h.x - w, h.y - hh * 1.6, w * 2, hh * 1.6)
    c.ellipse(h.x, h.y, PIT_RX * s, PIT_RY * s, 0, 0, Math.PI)
    c.clip()
    c.save()
    c.translate(h.x, h.y + hh * (1 - lift))
    if (h.state === 'up') c.rotate(0.05 * Math.sin((h.t + h.x) / 120))
    c.scale(sx, sy)
    c.drawImage(this.sprites[h.face], -w / 2, -hh, w, hh)
    c.restore()
    // 穴の中は暗く
    const gr = c.createLinearGradient(0, h.y - 8 * s, 0, h.y + PIT_RY * s)
    gr.addColorStop(0, 'rgba(8, 4, 2, 0)')
    gr.addColorStop(1, 'rgba(8, 4, 2, 0.92)')
    c.fillStyle = gr
    c.fillRect(h.x - w * 0.6, h.y - 8 * s, w * 1.2, (PIT_RY + 10) * s)
    c.restore()
    this.lip(c, h)
  }

  private drawHammer(c: CanvasRenderingContext2D, h: Hole): void {
    if (h.calm) return
    let ang: number
    let alpha: number
    if (h.state === 'up') {
      const from = h.hold - SWING
      if (h.t < from) return
      const p = clamp((h.t - from) / SWING, 0, 1)
      ang = 78 * (1 - p * p)
      alpha = Math.min(1, p * 4)
    } else if (h.t < 80) {
      ang = -5 * Math.sin((Math.PI * h.t) / 80)
      alpha = 1
    } else {
      const q = clamp((h.t - 80) / 160, 0, 1)
      ang = 46 * easeOut(q)
      alpha = 1 - q
    }
    if (alpha <= 0) return
    const s = h.s
    const k = (HAM_REACH * s) / 157 // 絵の 1 単位の大きさ（持ち手の端から頭の中心まで 157）
    const top = h.miss ? h.y - 8 * s : h.y - MOLE_H * s * 0.9
    c.save()
    c.globalAlpha = alpha
    if (h.dir < 0) {
      c.translate(h.x * 2, 0)
      c.scale(-1, 1)
    }
    // 持ち手の端を軸に回す。角度 0 で、頭の下の面がモグラの頭に当たる
    c.translate(h.x + 157 * k, top - 50 * k)
    c.rotate((ang * Math.PI) / 180)
    c.drawImage(this.hammer, -194 * k, -55 * k, 200 * k, 110 * k)
    c.restore()
  }

  private drawBit(c: CanvasRenderingContext2D, b: Bit): void {
    const k = b.t / b.life
    c.save()
    if (b.kind === 'star') {
      c.globalAlpha = 1 - easeIn(k)
      c.translate(b.x, b.y)
      c.rotate(b.r)
      c.scale(13 * b.s, 13 * b.s)
      c.fillStyle = '#ffe066'
      c.fill(star())
      c.lineWidth = 0.14
      c.strokeStyle = '#a86a00'
      c.stroke(star())
    } else if (b.kind === 'ring') {
      const e = easeOut(k)
      c.globalAlpha = 0.85 * (1 - k)
      c.strokeStyle = '#fff1b8'
      c.lineWidth = 7 * b.s * (1 - e) + 1
      c.beginPath()
      c.ellipse(b.x, b.y, (24 + 70 * e) * b.s, (11 + 28 * e) * b.s, 0, 0, Math.PI * 2)
      c.stroke()
    } else if (b.kind === 'word') {
      const pop = k < 0.12 ? 1.35 - (k / 0.12) * 0.35 : 1
      c.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1
      c.translate(b.x, b.y - 34 * b.s * easeOut(k))
      c.rotate(b.r)
      c.scale(pop, pop)
      c.font = `900 ${Math.round(46 * b.s)}px ${FONT}`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.lineJoin = 'round'
      c.lineWidth = 9 * b.s
      c.strokeStyle = b.miss ? '#262a40' : '#3b2412'
      c.strokeText(b.text, 0, 0)
      c.fillStyle = b.miss ? '#cfd6ee' : '#fff4cc'
      c.fillText(b.text, 0, 0)
    } else {
      const e = easeOut(k)
      c.globalAlpha = 0.5 * (1 - k)
      c.fillStyle = '#c9a27e'
      c.beginPath()
      c.ellipse(b.x, b.y - 22 * e * b.s, (18 + 36 * e) * b.s, (10 + 20 * e) * b.s, 0, 0, Math.PI * 2)
      c.fill()
    }
    c.restore()
  }

  // 穴の手前のふち（モグラの体の前に描き直す）
  private lip(g: CanvasRenderingContext2D, h: Hole): void {
    g.strokeStyle = 'rgba(214, 160, 104, 0.85)'
    g.lineWidth = 3.4 * h.s
    g.lineCap = 'round'
    g.beginPath()
    g.ellipse(h.x, h.y + 0.5 * h.s, PIT_RX * h.s, PIT_RY * h.s, 0, 0.14 * Math.PI, 0.86 * Math.PI)
    g.stroke()
  }

  // 動かない背景（地面・小石・草・穴）を一度だけ描いておく
  private paint(): void {
    const g = this.bg.getContext('2d')!
    const W = STAGE_W
    const H = FIELD_H
    g.beginPath()
    g.moveTo(-10, 122)
    g.bezierCurveTo(520, 64, 1400, 64, W + 10, 122)
    g.lineTo(W + 10, H)
    g.lineTo(-10, H)
    g.closePath()
    const soil = g.createLinearGradient(0, 64, 0, H)
    soil.addColorStop(0, '#4d2f1a')
    soil.addColorStop(0.35, '#3b2314')
    soil.addColorStop(1, '#22140b')
    g.fillStyle = soil
    g.fill()
    const r = rng(11)
    for (let i = 0; i < 240; i++) {
      const d = r()
      const y = 110 + d * (H - 120)
      const s = 0.45 + d * 0.8
      g.fillStyle = r() < 0.5 ? 'rgba(150, 104, 66, 0.32)' : 'rgba(12, 6, 2, 0.38)'
      g.beginPath()
      g.ellipse(r() * W, y, (3 + r() * 7) * s, (1.6 + r() * 3) * s, 0, 0, Math.PI * 2)
      g.fill()
    }
    g.strokeStyle = 'rgba(96, 120, 52, 0.55)'
    g.lineCap = 'round'
    for (let i = 0; i < 70; i++) {
      const d = r()
      const y = 120 + d * (H - 130)
      const s = 0.5 + d * 0.8
      const x = r() * W
      g.lineWidth = 2.2 * s
      g.beginPath()
      for (const a of [-0.5, -0.1, 0.35]) {
        g.moveTo(x, y)
        g.lineTo(x + Math.sin(a) * 14 * s, y - Math.cos(a) * 16 * s)
      }
      g.stroke()
    }
    // 上の端は闇に溶かす
    g.globalCompositeOperation = 'destination-out'
    const fade = g.createLinearGradient(0, 56, 0, 150)
    fade.addColorStop(0, 'rgba(0, 0, 0, 1)')
    fade.addColorStop(1, 'rgba(0, 0, 0, 0)')
    g.fillStyle = fade
    g.fillRect(0, 0, W, 150)
    g.globalCompositeOperation = 'source-over'
    for (const h of this.holes) {
      const s = h.s
      blob(g, h.x, h.y + 16 * s, 116 * s, 34 * s, [
        [0, 'rgba(0, 0, 0, 0.45)'],
        [1, 'rgba(0, 0, 0, 0)'],
      ])
      blob(
        g,
        h.x,
        h.y + 4 * s,
        106 * s,
        36 * s,
        [
          [0, '#ab7a4b'],
          [0.6, '#7a5030'],
          [1, '#4f311b'],
        ],
        0.3,
      )
      blob(g, h.x, h.y, PIT_RX * s, PIT_RY * s, [
        [0, '#030201'],
        [0.72, '#120904'],
        [1, '#2c180b'],
      ])
      this.lip(g, h)
    }
  }
}

// ---- 本体 ------------------------------------------------------------------------

type Phase = 'idle' | 'alarm' | 'brief' | 'count' | 'play' | 'end' | 'result' | 'done'
type Mood = 'perfect' | 'clear' | 'bad' | 'free'

interface Entry {
  name: string
  score: number
  isMe: boolean
}

// 結果の言い方（守った人のほうが多ければ防衛成功。やられた人が多くても、笑える BAD にする）
const MOOD: Readonly<Record<Mood, { kick: string; head: string; bubble: string; face: string }>> = {
  perfect: { kick: 'PERFECT DEFENSE', head: '全員 守りきった！', bubble: 'ぐぬぬ…まいったモグ…', face: 'cry' },
  clear: { kick: 'QUEST CLEAR', head: '防衛成功！', bubble: 'おぼえてろモグ〜！', face: 'bonk' },
  bad: { kick: 'QUEST RESULT', head: 'モグラにやられた…！', bubble: 'リーチ いただいたモグ♪', face: 'smug' },
  // 狙われたリーチがいなかった（誰もやられない）
  free: { kick: 'QUEST CLEAR', head: 'モグラを追い返した！', bubble: 'おぼえてろモグ〜！', face: 'bonk' },
}

interface Refs {
  body: HTMLElement
  glow: HTMLElement
  banner: HTMLElement
  kicker: HTMLElement
  title: HTMLElement
  raid: HTMLElement
  brief: HTMLElement
  briefNum: HTMLElement | null
  steps: HTMLElement[]
  hold: HTMLElement
  holdBar: HTMLElement
  pre: HTMLElement
  preNum: HTMLElement
  boss: HTMLElement
  bossBubble: HTMLElement
  field: HTMLElement
  hud: HTMLElement
  timeNum: HTMLElement
  arc: SVGCircleElement
  totalN: HTMLElement
  paceNum: HTMLElement
  meter: HTMLElement[]
  plus: HTMLElement
  cd: HTMLElement
  cdText: HTMLElement
  end: HTMLElement
  wait: HTMLElement
  go: HTMLElement
  res: HTMLElement
  bands: HTMLElement[]
  beams: HTMLElement[]
}

export class MoleQuestStage {
  readonly el: HTMLElement
  private readonly host: HTMLElement
  private readonly attached: boolean
  private readonly rm = prefersReducedMotion()
  private speed: number
  private flow: Timeline // いま進んでいる台本（start の警報〜終了、または result）
  private phase: Phase = 'idle'
  private gen = 0 // start と result のたびに増やす（古い result の片付けが、あとの start を消さないように）
  private inResult = false
  private dead = false
  private ducked = false
  private glowed = false
  private raf = 0
  private lastFrame = 0
  private r: Refs | null = null

  // start で受け取った値と、叩く時間
  private targets = 0
  private players = 0
  private playMs = 10000
  private playFrom = 0 // 叩く時間の始まりと終わり（performance.now の時刻）
  private playTo = 0
  private secShown = -1
  private hurry = false
  private woAt = 0

  // 会場の合計（0.5 秒ごとに届く値のあいだを、なめらかにつなぐ）
  private goal = 0
  private from = 0
  private shown = 0
  private segAt = 0
  private segDur = 500
  private lastSetAt = 0
  private lastSet = 0
  private pace = -1 // 1 秒あたりに叩いた数（演出上の秒）。まだ分からなければ -1
  private paceShown = -2
  private paceAt = 0
  private plusQueue = 0
  private plusAt = 0

  private field: MoleField | null = null
  private fieldLive = false
  private odo: Odometer | null = null
  private fx: Particles | null = null
  private canvas: HTMLCanvasElement | null = null

  constructor(host: HTMLElement, o: { speed?: number } = {}) {
    this.host = host
    this.attached = host.isConnected
    this.speed = typeof o.speed === 'number' && Number.isFinite(o.speed) && o.speed > 0 ? o.speed : 1
    this.flow = new Timeline(this.speed)
    this.el = el('div', 'fxqs')
    host.append(this.el)
    this.timeVars()
  }

  setSpeed(speed: number): void {
    if (!(speed > 0) || !Number.isFinite(speed)) return
    this.speed = speed
    this.flow.speed = speed
    if (this.fx) this.fx.speed = speed
    this.timeVars()
  }

  // 説明の画面: 警報のあと、何が起きるか・何をすればいいかを出して、start が呼ばれるまで待つ。
  // autoMs が数字なら、その時間で始まることが分かるバーを出す（null なら司会の合図を待つ）
  brief(o: MoleQuestStageBrief): void {
    if (this.dead) return
    this.gen++
    this.inResult = false
    this.reset()
    this.playMs = Math.max(0, Number.isFinite(o.playMs) ? o.playMs : 10000)
    this.targets = count(o.targets)
    this.players = count(o.players)
    this.build()
    this.phase = 'alarm'
    const autoMs = typeof o.autoMs === 'number' && Number.isFinite(o.autoMs) && o.autoMs > 0 ? o.autoMs : null
    void this.runBrief(new Seq(this.flow, this.alive), autoMs)
  }

  // 「3・2・1」→ 叩く時間。説明の画面（brief）が出ていれば、そこから切り替える。出ていなければ、ここで組み立てる
  start(o: MoleQuestStageStart): void {
    if (this.dead) return
    this.gen++
    this.inResult = false
    const introMs = Math.max(0, Number.isFinite(o.introMs) ? o.introMs : 3600)
    const fromBrief = this.r !== null && (this.phase === 'alarm' || this.phase === 'brief')
    if (fromBrief) {
      this.flow.cancel()
      this.flow = new Timeline(this.speed)
    } else this.reset()
    this.playMs = Math.max(0, Number.isFinite(o.playMs) ? o.playMs : 10000)
    this.targets = count(o.targets)
    this.players = count(o.players)
    if (fromBrief) this.r!.timeNum.textContent = String(Math.ceil(this.playMs / 1000))
    else this.build()
    this.phase = 'count'
    this.loop()
    void this.runStart(new Seq(this.flow, this.alive), introMs)
  }

  // 会場で叩いた数の合計（0.5 秒ごとに届く）。届いた間隔で次の値までなめらかに回す
  setTotal(total: number): void {
    if (this.dead || this.phase === 'result' || this.phase === 'done') return
    const v = count(total)
    const now = performance.now()
    if (this.lastSetAt > 0) {
      const gap = now - this.lastSetAt
      this.segDur = clamp(gap, 120, 1500)
      const sec = (gap * this.speed) / 1000
      if (sec > 0.05) this.feedPace(Math.max(0, v - this.lastSet) / sec)
    } else {
      this.segDur = clamp(500 / this.speed, 120, 1500)
      const sec = ((now - this.playFrom) * this.speed) / 1000
      if (this.phase === 'play' && sec > 0.2) this.feedPace(v / sec)
    }
    if (this.phase === 'play') this.plusQueue += Math.max(0, v - this.lastSet)
    this.lastSetAt = now
    this.lastSet = v
    // 減ることはないはずだが、減ったらその値にそろえる
    if (v < this.goal) this.shown = v
    this.from = this.shown
    this.goal = v
    this.segAt = now
  }

  async result(raw: MoleQuestStageResult): Promise<void> {
    if (this.dead || this.inResult) return
    this.inResult = true
    const gen = ++this.gen
    const live = this.phase === 'alarm' || this.phase === 'brief' || this.phase === 'count' || this.phase === 'play'
    this.flow.cancel()
    this.flow = new Timeline(this.speed)
    if (!this.r || this.phase === 'done') {
      // start を呼ばずに結果だけ出す
      this.reset()
      this.targets = count(raw?.targets)
      this.build()
      this.loop()
    }
    try {
      if (live) {
        // 叩く時間の途中で結果が来たら、その場で「終了！」にしてから
        this.end()
        await new Seq(this.flow, this.alive).until(700)
      }
      await this.runResult(new Seq(this.flow, this.alive), raw)
    } catch (err) {
      if (err !== CANCELLED) throw err
    } finally {
      // 途中で start がやり直されていたら、新しい方を消さない
      if (gen === this.gen) {
        this.inResult = false
        this.finish()
      }
    }
  }

  destroy(): void {
    if (this.dead) return
    this.dead = true
    this.flow.cancel()
    this.stopLoop()
    this.fx?.clear()
    this.canvas?.remove()
    this.el.remove()
    this.duck(false)
  }

  // ---- 警報 → 説明の画面 ---------------------------------------------------------

  private async runBrief(s: Seq, autoMs: number | null): Promise<void> {
    const r = this.r!
    try {
      const fx = this.particles()

      // 1. 暗転・赤い縁・警告の帯（「ドドン！」）
      this.el.dataset.phase = 'alarm'
      sfx.questAlarm()
      this.duck(true)
      for (const b of r.bands) on(b)
      for (const b of r.beams) on(b)
      // 2. 「緊急クエスト発生！」の帯が開き、文字がたたきつけられる（0.12 秒の「ジャン！」）
      await s.until(60)
      on(r.banner)
      await s.until(120)
      on(r.title)
      s.at(250, () => fx?.burst(960, 480, { count: 120, colors: AMBER, speed: 13, shape: 'spark', gravity: 0.05, life: 46 }))
      // 警報の「ウォン」3 回に合わせて、EMERGENCY QUEST が琥珀色に脈打つ（脈はこの 3 回だけ）
      for (const t of [420, 920, 1420]) s.at(t, () => this.wo())
      // 3. 見出しが上へ退き、ボスモグラがせり上がる →「モグラ襲来！」
      await s.until(920)
      r.banner.classList.add('up')
      await s.until(1100)
      on(r.boss)
      fx?.burst(960, 1010, { count: 50, colors: SOIL, speed: 9, gravity: 0.45, life: 45, shape: 'rect', size: 10 })
      await s.until(1420)
      on(r.raid)
      await s.until(1520)
      on(r.bossBubble)

      // 4. 説明の画面に落ち着く（警報の音が終わるころ）。ボスは左へ下がり、手順が ①②③ の順に出る
      await s.until(2100)
      this.phase = 'brief'
      this.el.dataset.phase = 'brief'
      this.duck(false)
      on(r.brief)
      this.countUp(r.briefNum, this.targets, 600)
      for (const [i, step] of r.steps.entries()) {
        await s.until(2300 + i * 280)
        on(step)
      }
      // 5. 「まもなくスタート」。自動で始まるときは、brief() から autoMs でいっぱいになるバーを出す。あとは start() を待つだけ
      await s.until(3200)
      if (autoMs !== null) {
        r.hold.classList.add('auto')
        r.holdBar.style.transitionDuration = `${this.flow.ms(Math.max(0, autoMs - 3200))}ms`
      }
      on(r.hold)
    } catch (err) {
      if (err !== CANCELLED) throw err
    }
  }

  // ---- 3・2・1 → 叩く時間 → 終了 ---------------------------------------------------

  private async runStart(s: Seq, introMs: number): Promise<void> {
    const r = this.r!
    try {
      // 説明を片付けて、画面の真ん中に大きなカウントダウン（数字は叩き始めの 3・2・1 秒前に替わる。スマホと同じ時刻）
      this.el.dataset.phase = 'count'
      this.duck(true)
      for (const b of r.bands) on(b)
      for (const b of r.beams) on(b)
      r.boss.classList.add('dive')
      on(r.pre)
      for (const n of [3, 2, 1]) if (introMs >= n * 1000) s.at(introMs - n * 1000, () => this.preCount(n))

      // 叩き始め
      await s.until(introMs)
      this.go()
      const end = introMs + this.playMs
      for (const n of [3, 2, 1]) if (this.playMs >= n * 1000) s.at(end - n * 1000, () => this.countdown(n))
      s.at(introMs + 1100, () => r.go.classList.add('off'))
      await s.until(end)
      this.end()
    } catch (err) {
      if (err !== CANCELLED) throw err
    }
  }

  // 叩き始めまでの 3・2・1（消さずに数字だけを替えるので、速度を上げても点滅にならない）
  private preCount(n: number): void {
    const r = this.r
    if (!r || this.phase !== 'count') return
    sfx.questTick(n)
    r.preNum.dataset.text = String(n)
    r.preNum.firstElementChild!.textContent = String(n)
    on(r.preNum)
    replay(r.preNum, 'punch')
  }

  // 「スタート！」: カウントダウンを片付けて、残り時間・会場の合計・モグラの畑に切り替える
  private go(): void {
    const r = this.r!
    this.phase = 'play'
    this.el.dataset.phase = 'play'
    sfx.questGo()
    this.duck(false)
    this.glow()
    // 終わりの時刻は、ここでの速度で決める（このあと速度が変わっても、表示と「終了！」はずれない）
    this.playFrom = performance.now()
    this.playTo = this.playFrom + this.flow.ms(this.playMs)
    this.secShown = -1
    on(r.go)
    r.boss.classList.add('dive')
    on(r.hud)
    on(r.field)
    if (this.field) {
      if (this.rm) this.field.showStill()
      else {
        this.field.start()
        this.fieldLive = true
      }
    }
    this.particles()?.burst(960, 560, { count: 150, colors: AMBER, speed: 14, shape: 'spark', gravity: 0.06, life: 50 })
  }

  // 「ウォン」の脈。速度を上げても、実時間で 350ms より詰めない（光るのは 1 秒に 3 回まで）
  private wo(): void {
    const now = performance.now()
    if (!this.r || now - this.woAt < 350) return
    this.woAt = now
    replay(this.r.kicker, 'wo')
  }

  // 残り 3・2・1 秒（画面の真ん中に大きく。消さずに数字だけを替えるので、速度を上げても点滅にならない）
  private countdown(n: number): void {
    const r = this.r
    if (!r || this.phase !== 'play') return
    sfx.questTick(n)
    if (!this.hurry) {
      this.hurry = true
      this.el.classList.add('hurry')
      on(r.cd)
    }
    r.cdText.dataset.text = String(n)
    r.cdText.firstElementChild!.textContent = String(n)
    replay(r.cdText, 'punch')
  }

  // 「終了！」（試合終了のゴングの 3 打目に合わせて文字が着地する）。0.9 秒たっても結果が来なければ「集計中…」
  private end(): void {
    const r = this.r
    if (!r || this.phase === 'idle' || this.phase === 'end' || this.phase === 'result' || this.phase === 'done') return
    this.phase = 'end'
    this.el.dataset.phase = 'end'
    this.el.classList.remove('hurry')
    this.hurry = false
    sfx.questEnd()
    this.duck(false)
    this.field?.stop()
    this.secShown = 0
    r.timeNum.textContent = '0'
    r.arc.setAttribute('stroke-dashoffset', RING_C.toFixed(1))
    on(r.end)
    this.flow.at(900, () => on(r.wait))
  }

  // ---- 結果 -------------------------------------------------------------------

  private async runResult(s: Seq, raw: MoleQuestStageResult): Promise<void> {
    const r = this.r!
    const total = count(raw?.total)
    const targets = count(raw?.targets)
    const defended = count(raw?.defended)
    const lost = count(raw?.lost)
    const lostReach = count(raw?.lostReach)
    const top: Entry[] = (Array.isArray(raw?.top) ? raw.top : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({ name: String(e.name ?? '').trim() || '？', score: count(e.score), isMe: e.isMe === true }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    const mood: Mood = targets === 0 && lost === 0 ? 'free' : lost === 0 ? 'perfect' : defended >= lost ? 'clear' : 'bad'
    const meRank = top.findIndex((e) => e.isMe) + 1

    this.phase = 'result'
    this.el.dataset.phase = 'result'
    this.el.classList.remove('hurry')
    this.duck(true)
    r.res.dataset.mood = mood
    r.res.classList.toggle('free', mood === 'free')
    r.res.innerHTML = resultHtml(mood, targets, defended, lost, lostReach, top, meRank)
    const $ = (sel: string): HTMLElement | null => r.res.querySelector<HTMLElement>(sel)
    const odo = new Odometer(640, 150)
    $('.fxqs-res-n')?.prepend(odo.el)
    odo.render(0, performance.now(), true)
    const fx = this.particles()

    // 1. 見出し・ボスの反応・守った人とやられた人
    await s.until(80)
    this.fieldLive = false
    on($('.fxqs-res-h'))
    await s.until(280)
    on($('.fxqs-res-boss'))
    on($('.fxqs-res-r'))
    s.at(720, () => on($('.fxqs-res-boss .fxqs-bubble')))
    await s.until(420)
    on($('.fxqs-card.def'))
    on($('.fxqs-res-note'))
    this.countUp($('.fxqs-card.def .fxqs-card-n b'), defended, 700)
    await s.until(580)
    on($('.fxqs-card.lost'))
    this.countUp($('.fxqs-card.lost .fxqs-card-n b'), lost, 700)
    this.countUp($('.fxqs-card.lost .fxqs-card-s b'), lostReach, 700)
    await s.until(780)
    on($('.fxqs-ratio'))

    // 2. 撃退数の合計を数え上げる（questTally の「ドゥルルル…」1.5 秒に合わせて回し、「ジャッ」で止める）
    await s.until(1300)
    sfx.questTally()
    const panel = $('.fxqs-res-total')
    on(panel)
    this.tween(1500, (k) => odo.render(k < 1 ? total * (1 - (1 - k) * (1 - k)) : total, performance.now(), k >= 1))
    // 「ジャッ」で数字が止まり、「ジャーン！」で決まる（金に光って火花）
    await s.until(2800)
    if (panel) replay(panel, 'land')
    await s.until(2960)
    if (panel) {
      panel.classList.add('done')
      const [x, y] = this.stagePos(panel)
      fx?.burst(x, y + 20, { count: 110, colors: AMBER, speed: 12, shape: 'spark', gravity: 0.1, life: 48 })
    }

    // 3. 「ジャーン！」で撃退王が 3 位から並び、「キラリーン」で冠がのる
    const pods = [3, 2, 1].map((rank) => $(`.fxqs-pod.r${rank}`))
    pods.forEach((pod, i) =>
      s.at(2960 + i * 80, () => {
        if (!pod) return
        on(pod)
        this.countUp(pod.querySelector('.fxqs-pod-score b'), top[2 - i]?.score ?? 0, 500)
      }),
    )
    await s.until(3510)
    const king = pods[2]
    if (king) {
      on(king.querySelector('.fxqs-crown'))
      this.shake(6, 260)
      const [x, y] = this.stagePos(king)
      fx?.burst(x, y - 60, { count: 180, colors: GOLD, speed: 13, shape: 'spark', gravity: 0.12, life: 60 })
    }
    if (meRank) s.at(3800, () => on($('.fxqs-king-me')))
    await s.until(3900)
    if (mood !== 'bad' || meRank === 1) fx?.rain(200, GOLD)

    // 4. 片付け（消えきるまで待つ。速度を上げても、消える長さは実時間で 400ms 以上）
    await s.until(5350)
    this.el.classList.add('fxqs-out')
    this.canvas?.classList.add('fxqs-out')
    await s.until(5350 + Math.max(550, s.tl.speed * 450))
  }

  // ---- 毎フレーム -------------------------------------------------------------

  private loop(): void {
    if (this.raf || this.dead) return
    this.lastFrame = 0
    this.raf = requestAnimationFrame(this.frame)
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private readonly frame = (now: number): void => {
    this.raf = 0
    if (!this.alive() || !this.r) return
    const dt = this.lastFrame ? Math.min(80, now - this.lastFrame) : 16
    this.lastFrame = now
    if (this.phase === 'play') this.drawClock(now)
    if (this.phase !== 'result') this.drawTotal(now)
    if (this.field && this.fieldLive) {
      this.field.rate = this.moleRate()
      // 合計が届いていて、ほとんど増えていなければ、誰も叩いていない畑にする
      this.field.whack = this.pace >= 0 && this.pace < 1 ? 0 : 1
      // 畑は速度 ×2 までに抑える（穴ごとの動きが速くなりすぎないように）
      this.field.update(dt * Math.min(2, this.speed))
      this.field.draw()
    }
    this.drawPlus(now)
    this.raf = requestAnimationFrame(this.frame)
  }

  // 残り時間（叩き始めに決めた終わりの時刻から、演出上の残り ms を出す）
  private drawClock(now: number): void {
    const r = this.r!
    const span = Math.max(1, this.playTo - this.playFrom)
    const left = this.playMs * clamp((this.playTo - now) / span, 0, 1)
    const sec = Math.ceil(left / 1000 - 0.001)
    if (sec !== this.secShown) {
      this.secShown = sec
      r.timeNum.textContent = String(sec)
    }
    // 動きを減らす設定では、輪も 1 秒ごとに減らす
    const frac = this.playMs > 0 ? (this.rm ? (sec * 1000) / this.playMs : left / this.playMs) : 0
    r.arc.setAttribute('stroke-dashoffset', (RING_C * (1 - clamp(frac, 0, 1))).toFixed(1))
  }

  private drawTotal(now: number): void {
    const r = this.r!
    if (this.odo) {
      const k = clamp((now - this.segAt) / Math.max(1, this.segDur), 0, 1)
      this.shown = this.from + (this.goal - this.from) * k
      if (this.rm) this.odo.render(this.goal, now, true)
      else this.odo.render(this.shown, now)
    }
    if (now - this.paceAt < 250) return
    const p = this.pace < 0 ? -1 : Math.round(this.pace / 10) * 10
    if (p === this.paceShown) return
    this.paceShown = p
    this.paceAt = now
    r.paceNum.textContent = p < 0 ? '―' : fmt(p)
    const lit = p <= 0 ? 0 : Math.max(1, Math.round(this.intensity() * r.meter.length))
    r.meter.forEach((m, i) => m.classList.toggle('on', i < lit))
  }

  // 届いた合計の増えた分を「+1,234」で浮かべる（1 秒に 2 回まで。まとめて出す）
  private drawPlus(now: number): void {
    if (this.rm || this.phase !== 'play' || this.plusQueue <= 0 || now - this.plusAt < 450) return
    const r = this.r!
    const p = el('span', 'fxqs-plus-i', `+${fmt(this.plusQueue)}`)
    this.plusQueue = 0
    this.plusAt = now
    p.style.left = `${1180 + Math.random() * 70}px`
    p.style.top = `${100 + Math.random() * 34}px`
    p.addEventListener('animationend', () => p.remove())
    r.plus.append(p)
    while (r.plus.childElementCount > 5) r.plus.firstElementChild?.remove()
  }

  private feedPace(x: number): void {
    this.pace = this.pace < 0 ? x : this.pace + (x - this.pace) * 0.5
  }

  // 会場の熱気（0.1〜1）。参加者 1 人が 1 秒に 3 回叩くと最大
  private intensity(): number {
    if (this.pace < 0) return 0.5
    const full = (this.players > 0 ? this.players : 1000) * 3
    return clamp(this.pace / full, 0.1, 1)
  }

  // 畑に 1 秒あたり何匹出すか（熱気と会場の大きさで決める。終盤は少し増やす）
  private moleRate(): number {
    const size = clamp(0.55 + Math.log10(Math.max(1, this.players)) * 0.15, 0.6, 1)
    return (3 + 19 * this.intensity()) * size * (this.hurry ? 1.2 : 1)
  }

  // ---- 組み立てと片付け ----------------------------------------------------------

  private reset(): void {
    this.flow.cancel()
    this.flow = new Timeline(this.speed)
    this.fx?.clear()
    this.canvas?.classList.remove('fxqs-out')
    this.goal = this.from = this.shown = 0
    this.segAt = this.lastSetAt = this.lastSet = 0
    this.segDur = 500
    this.pace = -1
    this.paceShown = -2
    this.paceAt = 0
    this.plusQueue = 0
    this.plusAt = 0
    this.secShown = -1
    this.hurry = false
    this.glowed = false
    this.field = null
    this.fieldLive = false
    this.odo = null
  }

  private build(): void {
    this.el.className = `fxqs${this.rm ? ' fxqs-rm' : ''}`
    this.el.dataset.phase = 'idle'
    const players = fmt(this.players)
    const targets = fmt(this.targets)
    const secs = Math.max(1, Math.round(this.playMs / 1000))
    // 狙われたリーチが 0 人のときは、「0 人がピンチ！」とは出さない
    const some = this.targets > 0
    const top = `▲ EMERGENCY QUEST ▲　緊急クエスト「モグラ撃退」　◆ スマホでモグラをたたいて ${some ? 'カードを守れ！' : '追い返せ！'} ◆　`.repeat(3)
    const bot = (some ? `◆ リーチの ${targets} 人がピンチ！ ◆　みんなでたたいて守れ！　▲ WARNING ▲　` : '◆ みんなで モグラを追い返せ！ ◆　▲ WARNING ▲　').repeat(4)
    // 狙われた人数は桁が多いほど小さく
    const tgtSize = targets.length <= 3 ? 110 : targets.length <= 5 ? 86 : 66
    this.el.innerHTML = `
      <div class="fxqs-dim"></div>
      <div class="fxqs-vig"></div>
      <div class="fxqs-body">
        <div class="fxqs-beam l"></div><div class="fxqs-beam r"></div>
        <div class="fxqs-field"></div>
        <div class="fxqs-boss fxqs-bossy" data-face="grin">${BOSS_SVG}<div class="fxqs-bubble">リーチ いただくモグ♪</div></div>
        <div class="fxqs-banner">
          <i class="fxqs-hz t"></i><i class="fxqs-hz b"></i>
          <div class="fxqs-chev l"><i></i><i></i><i></i></div><div class="fxqs-chev r"><i></i><i></i><i></i></div>
          <div class="fxqs-kicker">${WARN}<span>EMERGENCY QUEST</span>${WARN}</div>
          <div class="fxqs-title fxqs-ol" data-text="緊急クエスト発生！"><b>緊急クエスト発生！</b></div>
        </div>
        <div class="fxqs-raid"><div class="fxqs-raid-in"><div class="fxqs-ol" data-text="モグラが出た！"><b>モグラが出た！</b></div><small>ドドドド…</small></div></div>
        ${
          some
            ? `<div class="fxqs-brief">
          <p class="fxqs-brief-a">スマホでモグラをたたいて</p>
          <div class="fxqs-brief-b fxqs-ol" data-text="カードを守れ！"><b>カードを守れ！</b></div>
          <div class="fxqs-brief-t"><span>${RETICLE}リーチの</span><b>0</b><small>人がピンチ！</small></div>
          <p class="fxqs-brief-p">参加 ${players} 人</p>
        </div>`
            : `<div class="fxqs-brief free">
          <p class="fxqs-brief-a">みんなで</p>
          <div class="fxqs-brief-b fxqs-ol" data-text="モグラを追い返せ！"><b>モグラを追い返せ！</b></div>
          <p class="fxqs-brief-p">${players} 人でチャレンジ！</p>
        </div>`
        }
        <ol class="fxqs-steps">
          <li class="fxqs-step"><i>1</i><div><b>スマホを見て！</b><span>ボスモグラが あなたのカードをねらってる！</span></div></li>
          <li class="fxqs-step"><i>2</i><div><b>出てきたモグラを 指でタップ！<em>${secs} 秒間</em></b><span>何回でも OK。どんどんたたこう！</span></div></li>
          <li class="fxqs-step"><i>3</i><div>${
            some
              ? '<b>たくさんたたいて カードを守ろう！</b><span>たたいた数が少ないと、リーチの人は マスを埋められる！</span>'
              : '<b>たくさんたたいて 追い返そう！</b><span>いちばん多くたたいた人が 撃退王！</span>'
          }</div></li>
        </ol>
        <div class="fxqs-hold">
          <div class="fxqs-hold-a"><b>まもなくスタート</b><i>・</i><i>・</i><i>・</i></div>
          <p class="fxqs-hold-b"><span class="m">司会の合図でスタート！</span>スマホを持って 待っててね</p>
          <div class="fxqs-hold-bar"><b></b></div>
        </div>
        <div class="fxqs-hud">
          <div class="fxqs-p fxqs-time">${ringSvg()}<div class="fxqs-time-in"><small>残り</small><b>${Math.ceil(this.playMs / 1000)}</b><small>秒</small></div></div>
          <div class="fxqs-p fxqs-total">
            <div class="fxqs-total-h">${HAMMER_ICON}<span>会場の撃退数</span></div>
            <div class="fxqs-total-n"><small>匹</small></div>
            <div class="fxqs-pace"><span>いま 1 秒に</span><b>―</b><small>匹</small><span class="fxqs-meter">${'<i></i>'.repeat(16)}</span></div>
          </div>
          <div class="fxqs-p fxqs-tgt">
            ${
              some
                ? `<div class="fxqs-tgt-h">${RETICLE}<span>リーチの</span></div>
            <div class="fxqs-tgt-n" style="--fs:${tgtSize}px"><b>${targets}</b><small>人が</small></div>
            <div class="fxqs-tgt-s">ピンチ！</div>
            <p class="fxqs-tgt-p">参加 ${players} 人</p>`
                : `<div class="fxqs-tgt-h"><span>参加</span></div>
            <div class="fxqs-tgt-n" style="--fs:${players.length <= 3 ? 110 : players.length <= 5 ? 86 : 66}px"><b>${players}</b><small>人</small></div>
            <div class="fxqs-tgt-s">みんなでたたけ！</div>`
            }
          </div>
        </div>
        <div class="fxqs-plus"></div>
        <div class="fxqs-cd"><div class="fxqs-ol" data-text="3"><b>3</b></div></div>
        <div class="fxqs-end"><small>TIME UP</small><div class="fxqs-ol" data-text="そこまで！"><b>そこまで！</b></div><p class="fxqs-wait">数えています<i>・</i><i>・</i><i>・</i></p></div>
        <div class="fxqs-pre"><small>スマホを見て！</small><div class="fxqs-ol" data-text="3"><b>3</b></div><p>出てきたモグラを タップ！</p></div>
        <div class="fxqs-go"><small>モグラをたたけ！</small><div class="fxqs-ol" data-text="スタート！"><b>スタート！</b></div></div>
        <div class="fxqs-res"></div>
        <div class="fxqs-band top"><div class="fxqs-band-in"><div class="fxqs-marq"><span>${top}</span><span>${top}</span></div></div></div>
        <div class="fxqs-band bot"><div class="fxqs-band-in"><div class="fxqs-marq rev"><span>${bot}</span><span>${bot}</span></div></div></div>
      </div>
      <div class="fxqs-glow"></div>`
    const $ = <T extends Element = HTMLElement>(sel: string): T => this.el.querySelector<T>(sel)!
    const r: Refs = {
      body: $('.fxqs-body'),
      glow: $('.fxqs-glow'),
      banner: $('.fxqs-banner'),
      kicker: $('.fxqs-kicker'),
      title: $('.fxqs-title'),
      raid: $('.fxqs-raid'),
      brief: $('.fxqs-brief'),
      briefNum: this.el.querySelector<HTMLElement>('.fxqs-brief-t b'),
      steps: [...this.el.querySelectorAll<HTMLElement>('.fxqs-step')],
      hold: $('.fxqs-hold'),
      holdBar: $('.fxqs-hold-bar b'),
      pre: $('.fxqs-pre'),
      preNum: $('.fxqs-pre .fxqs-ol'),
      boss: $('.fxqs-boss'),
      bossBubble: $('.fxqs-boss .fxqs-bubble'),
      field: $('.fxqs-field'),
      hud: $('.fxqs-hud'),
      timeNum: $('.fxqs-time-in b'),
      arc: $<SVGCircleElement>('.fxqs-ring-arc'),
      totalN: $('.fxqs-total-n'),
      paceNum: $('.fxqs-pace b'),
      meter: [...this.el.querySelectorAll<HTMLElement>('.fxqs-meter i')],
      plus: $('.fxqs-plus'),
      cd: $('.fxqs-cd'),
      cdText: $('.fxqs-cd .fxqs-ol'),
      end: $('.fxqs-end'),
      wait: $('.fxqs-wait'),
      go: $('.fxqs-go'),
      res: $('.fxqs-res'),
      bands: [...this.el.querySelectorAll<HTMLElement>('.fxqs-band')],
      beams: [...this.el.querySelectorAll<HTMLElement>('.fxqs-beam')],
    }
    this.r = r
    this.odo = new Odometer(800, 190)
    r.totalN.prepend(this.odo.el)
    this.odo.render(0, performance.now(), true)
    this.field = new MoleField(r.field)
  }

  // result のあと: 全部片付けて、空の層だけを残す（destroy で取り外す）
  private finish(): void {
    if (this.phase === 'done') return
    this.phase = 'done'
    this.flow.cancel()
    this.stopLoop()
    this.field = null
    this.fieldLive = false
    this.odo = null
    this.r = null
    this.fx?.clear()
    this.canvas?.remove()
    this.fx = null
    this.canvas = null
    this.el.replaceChildren()
    this.el.className = 'fxqs'
    delete this.el.dataset.phase
    this.duck(false)
  }

  // host が画面から外されたら、その場で片付ける
  private readonly alive = (): boolean => {
    if (this.dead) return false
    if (this.attached && !this.host.isConnected) {
      this.destroy()
      return false
    }
    return true
  }

  // ---- 小さな部品 --------------------------------------------------------------

  // CSS の時間の単位。画面全体の明るさの変化・繰り返す光・流れる文字は、速度を上げても安全な長さにとどめる
  private timeVars(): void {
    const ms = (x: number): number => x / this.speed
    const st = this.el.style
    st.setProperty('--u', `${ms(1000)}ms`)
    st.setProperty('--fade', `${Math.max(240, ms(350))}ms`)
    st.setProperty('--pulse', `${Math.max(700, ms(1000))}ms`)
    st.setProperty('--sweep', `${Math.max(1600, ms(2600))}ms`)
    st.setProperty('--marq', `${Math.max(12000, ms(24000))}ms`)
    st.setProperty('--plus', `${Math.max(700, ms(1000))}ms`)
    st.setProperty('--punch', `${Math.max(220, ms(380))}ms`)
    st.setProperty('--dots', `${Math.max(900, ms(1200))}ms`)
    // 説明の画面で待つ間の、ボスのゆっくりしたゆれ
    st.setProperty('--calm', `${Math.max(2400, ms(2400))}ms`)
    // 最後に消えるとき（暗転が明けて画面全体が明るくなるので、急にしない）
    st.setProperty('--out', `${Math.max(400, ms(500))}ms`)
    this.canvas?.style.setProperty('--out', st.getPropertyValue('--out'))
  }

  private duck(on: boolean): void {
    if (this.ducked === on) return
    this.ducked = on
    bgm.duck(on)
  }

  // 粒子の canvas（z-index 60）。動きを減らす設定のときは出さない
  private particles(): Particles | null {
    if (this.rm || this.dead) return null
    if (!this.fx) {
      const c = el('canvas', 'fxqs-canvas')
      c.width = STAGE_W
      c.height = STAGE_H
      c.style.setProperty('--out', this.el.style.getPropertyValue('--out'))
      this.host.append(c)
      this.canvas = c
      this.fx = new Particles(c, 1400)
      this.fx.speed = this.speed
    }
    return this.fx
  }

  // 全面の光。1 回のクエストで 1 回だけ、明るさの変化は 16%、立ち上がりは 150ms 以上
  private glow(): void {
    if (this.rm || this.glowed || !this.r) return
    this.glowed = true
    const duration = Math.max(600, this.flow.ms(900))
    this.r.glow.animate([{ opacity: 0 }, { opacity: 0.16, offset: 0.25 }, { opacity: 0 }], { duration, easing: 'ease-out' })
  }

  // 揺れ（撃退王の金の冠のときだけ。8px 以内、300ms 以内）
  private shake(px: number, ms: number): void {
    if (this.rm || !this.r) return
    const a = Math.min(8, px)
    const frames = [0, a, -a * 0.8, a * 0.55, -a * 0.3, 0].map((x, i) => ({ transform: `translate(${x}px, ${(i % 2 ? -0.4 : 0.3) * x}px)` }))
    this.r.body.animate(frames, { duration: Math.min(300, this.flow.ms(ms)), easing: 'linear' })
  }

  // requestAnimationFrame で k = 0→1 を回す（長さは演出上の ms）。描画が止まっていても、最後は必ず k = 1 を呼ぶ
  private tween(ms: number, fn: (k: number) => void): void {
    const tl = this.flow
    const dur = tl.ms(ms)
    if (this.rm || dur <= 0) return fn(1)
    const t0 = performance.now()
    const step = (now: number): void => {
      if (this.dead || tl.cancelled) return
      const k = Math.min(1, (now - t0) / dur)
      fn(k)
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
    tl.at(ms, () => fn(1))
  }

  private countUp(node: Element | null | undefined, to: number, ms: number): void {
    if (!node) return
    this.tween(ms, (k) => (node.textContent = fmt(Math.round(to * easeOut(k)))))
  }

  // 要素の中心の、大画面での座標（粒子を出す位置）
  private stagePos(node: HTMLElement): [number, number] {
    let x = node.offsetWidth / 2
    let y = node.offsetHeight / 2
    let n: HTMLElement | null = node
    while (n && n !== this.el) {
      x += n.offsetLeft
      y += n.offsetTop
      n = n.offsetParent as HTMLElement | null
    }
    return [x, y]
  }
}

// 結果の盤（左: 撃退数の合計・守った人・やられた人、右: 撃退王、右上: ボスの反応）
function resultHtml(mood: Mood, targets: number, defended: number, lost: number, lostReach: number, top: readonly Entry[], meRank: number): string {
  const m = MOOD[mood]
  const sum = defended + lost
  const defPct = sum > 0 ? (defended / sum) * 100 : 0
  // 人数は桁が多いほど小さく（カードの幅に収める）
  const fs = (n: number): number => (fmt(n).length <= 3 ? 120 : fmt(n).length <= 5 ? 96 : 76)
  const slot = (rank: number): string => {
    const e = top[rank - 1]
    if (!e) return ''
    return `<div class="fxqs-pod r${rank}${e.isMe ? ' me' : ''}">
      <div class="fxqs-pod-who">
        ${rank === 1 ? `<i class="fxqs-crown">${CROWN_SVG}</i>` : ''}
        ${e.isMe ? '<span class="fxqs-pod-me">あなた</span>' : ''}
        <b class="fxqs-pod-name">${escapeHtml(e.name)}</b>
        <span class="fxqs-pod-score"><b>0</b><small>匹</small></span>
      </div>
      <div class="fxqs-pod-base"><span class="fxqs-medal">${rank}</span><small>位</small></div>
    </div>`
  }
  const podium = top.length
    ? `<div class="fxqs-podium">${slot(2)}${slot(1)}${slot(3)}</div>`
    : '<p class="fxqs-king-none">今回は 撃退王なし…</p>'
  // 守りきった（緑 ◆）とやられた（灰青 ▼）。「リーチが消えた」は、やられた人数と違うときだけ出す（同じ数字を 2 回出さない）。
  // 狙われたリーチがいなかったときは、この欄を出さない
  const stats =
    mood === 'free'
      ? '<p class="fxqs-res-note">やられた人は いない！</p>'
      : `<div class="fxqs-res-cards">
        <div class="fxqs-card def">
          <div class="fxqs-card-h"><i>◆</i>守りきった</div>
          <div class="fxqs-card-n" style="--fs:${fs(defended)}px"><b>0</b><small>人</small></div>
          <div class="fxqs-card-s">リーチの ${fmt(targets)} 人のうち</div>
        </div>
        <div class="fxqs-card lost">
          <div class="fxqs-card-h"><i>▼</i>やられた</div>
          <div class="fxqs-card-n" style="--fs:${fs(lost)}px"><b>0</b><small>人</small></div>
          ${lostReach !== lost ? '<div class="fxqs-card-s"><i>▲</i>リーチが消えた <b>0</b> 人</div>' : ''}
        </div>
      </div>
      <div class="fxqs-ratio" style="--def:${defPct.toFixed(1)}%; --lost:${sum > 0 ? (100 - defPct).toFixed(1) : 0}%"><i class="def"></i><i class="lost"></i></div>`
  const me = meRank === 1 ? 'あなたが撃退王！' : meRank ? `あなたは ${meRank} 位！` : ''
  return `
    <header class="fxqs-res-h">
      <div class="fxqs-res-k">${m.kick}</div>
      <div class="fxqs-res-t fxqs-ol" data-text="${m.head}"><b>${m.head}</b></div>
    </header>
    <div class="fxqs-res-boss fxqs-bossy" data-face="${m.face}">${BOSS_SVG}${m.face === 'bonk' ? DIZZY : ''}<div class="fxqs-bubble">${m.bubble}</div></div>
    <section class="fxqs-res-l">
      <div class="fxqs-p fxqs-res-total">
        <div class="fxqs-res-lb">${HAMMER_ICON}<span>会場の撃退数</span></div>
        <div class="fxqs-res-n"><small>匹</small></div>
      </div>
      ${stats}
    </section>
    <section class="fxqs-res-r">
      <div class="fxqs-king-h"><span>★</span>撃退王<span>★</span></div>
      ${podium}
      ${me ? `<div class="fxqs-king-me">${me}</div>` : ''}
    </section>`
}
