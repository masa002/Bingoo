import { registerGallery, type GalleryItem } from '../gallery'
import type { Timeline } from '../runtime'
import type { Tier } from '../theme'
import { playBingo, playReach, type AoriOutcome } from './aori'
import { CardView, boxIn } from './card'
import { HandSpin } from './spin'

// 手元のスロットのギャラリー。見本の画面は ui/phone.ts と同じ並び（ステータス・名前・リーチの札・カード・最新の番号・履歴）にして、
// カードを上に置いたまま回す。
//   連打あり: 自動で連打をまねる（1 秒に 6〜10 回、ときどき息つぎ。STOP が光ったら、少し間をおいて押す）
//   連打なし: 何もしなければ時間切れで自動で止まる（見ている人が自分でタップして遊んでもよい）
// 止まったあとは、組み込み側の呼び方の見本として、最新の番号と履歴を書き換え、resolve → スタンプ → リーチ・ビンゴの演出と続ける

const G = 'スマホ: 手元のスロット'
const CARD5 = [3, 22, 38, 51, 67, 12, 17, 44, 59, 70, 7, 28, 0, 48, 62, 15, 19, 33, 56, 74, 1, 25, 41, 53, 65]
// 溜めの最短（×1）。組み込みの目安は 3.5〜7.5 秒で、時間切れはそこから +3.5 秒
const MIN_CHARGE: Readonly<Record<Tier, number>> = { 0: 3500, 1: 4500, 2: 5500, 3: 6500, 4: 7500 }
const GRACE = 3500
const HISTORY = [20, 3, 17, 56, 22, 74] // 見本の履歴（新しい順）
const bits = (...cells: number[]): number => cells.reduce((m, i) => m | (1 << i), 0)
const DIAG4 = bits(0, 6, 12, 18) // 斜めがあと 1 つ（O65）
const QUIET = bits(1, 12, 19) // リーチなし
const label = (n: number): string => `${'BINGO'[Math.floor((n - 1) / 15)]}${n}`

// 5×5 のライン（横・縦・斜め）
const LINES: readonly (readonly number[])[] = [
  ...[0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) => r * 5 + c)),
  ...[0, 1, 2, 3, 4].map((c) => [0, 1, 2, 3, 4].map((r) => r * 5 + c)),
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
]
const openOf = (line: readonly number[], mask: number): number[] => line.filter((i) => !(mask & (1 << i)))
const reachLines = (mask: number): number => LINES.filter((line) => openOf(line, mask).length === 1).length
// リーチのラインの、あと 1 つのマス
const waitingOf = (mask: number): number[] => [...new Set(LINES.flatMap((line) => (openOf(line, mask).length === 1 ? openOf(line, mask) : [])))]

interface Mock {
  card: CardView
  chip: HTMLElement
  latest: HTMLElement
  history: HTMLElement
}

interface Spec {
  id: string
  label: string
  tier: Tier
  mash: boolean // 自動で連打をまねる
  mask: number // 回す前のカード
  waiting: number[] // あと 1 つのマス
  n: number // 出る番号
  outcome: AoriOutcome
  openAt?: number // start から番号が届くまで（既定 300ms）
  forceAt?: number // start から forceStop を呼ぶまで
  rank?: number
}

// ---- 見本の画面 ----------------------------------------------------------------

function mockPhone(host: HTMLElement, tl: Timeline, mask: number, waiting: readonly number[]): Mock {
  host.insertAdjacentHTML(
    'beforeend',
    `<div style="position:absolute;inset:0;background:radial-gradient(120% 60% at 50% 0%,#16204a,#0a0f24 60%,#070b1a);color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif;font-size:15px">
      <div style="display:flex;justify-content:space-between;padding:12px 26px 4px;font-size:13px;font-weight:700"><span>9:41</span><span>●●● 100%</span></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 16px 4px"><div><b style="font-size:18px">あなた</b><small style="margin-left:8px;color:#8a93b8">No.00042</small></div><div style="color:#8a93b8;font-size:13px">参加 1,000人</div></div>
      <div style="min-height:38px;margin:0 14px"><div data-k="chip"></div></div>
      <div data-k="card" style="position:relative;margin-top:6px"></div>
      <div style="position:relative;margin-top:8px;text-align:center"><small style="display:block;color:#8a93b8">最新の番号</small><b data-k="latest" style="font-size:40px;font-weight:900">I20</b></div>
      <div data-k="history" style="display:flex;flex-wrap:wrap;gap:5px;justify-content:center;padding:0 14px;margin-top:6px"></div>
    </div>`,
  )
  const root = host.lastElementChild as HTMLElement
  const $ = (k: string): HTMLElement => root.querySelector<HTMLElement>(`[data-k="${k}"]`)!
  const card = new CardView($('card'), { size: 5, speed: tl.speed })
  card.setCells(CARD5)
  card.setMarks(mask, { waiting })
  const m: Mock = { card, chip: $('chip'), latest: $('latest'), history: $('history') }
  setChip(m, waiting.length ? `リーチ　あと ${waiting.map((c) => label(CARD5[c])).join('・')}` : '')
  renderHistory(m, HISTORY)
  return m
}

function setChip(m: Mock, text: string, rainbow = false): void {
  m.chip.textContent = text
  m.chip.style.cssText = text
    ? `border-radius:10px;padding:6px 10px;font-weight:900;font-size:15px;color:${rainbow ? '#1a1400' : '#fff'};background:${
        rainbow ? 'linear-gradient(90deg,#ff5a5a,#ffb84d,#fff15a,#5aff8c,#5ad2ff,#a85aff)' : 'linear-gradient(90deg,#ff7a3d,#ef4444)'
      }`
    : ''
}

function renderHistory(m: Mock, nums: readonly number[]): void {
  m.history.innerHTML = nums
    .map((n) => {
      const mine = CARD5.includes(n)
      return `<span style="font-size:12px;padding:2px 7px;border-radius:999px;background:${mine ? 'rgba(255,92,122,0.35)' : '#18204a'};color:${mine ? '#fff' : '#8a93b8'}">${label(n)}</span>`
    })
    .join('')
}

// リールに流す候補（カードで開いている番号を除いた、まだ出ていない番号の代わり）
function poolOf(mask: number): number[] {
  const open = new Set(CARD5.filter((_, i) => mask & (1 << i)))
  return Array.from({ length: 75 }, (_, i) => i + 1).filter((x) => !open.has(x))
}

// ギャラリーで別の演出に切り替えたら（host が外れたら）止める
function watch(host: HTMLElement, tl: Timeline, ...parts: { destroy(): void }[]): void {
  const check = () => {
    if (!host.isConnected || tl.cancelled) parts.forEach((p) => p.destroy())
    else requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

async function hold(tl: Timeline, ms: number): Promise<boolean> {
  await tl.wait(ms)
  return !tl.cancelled
}

// ---- 連打をまねる ----------------------------------------------------------------

// 画面の (x, y)（390×844 の座標）を指でタップしたことにする
function tapAt(spin: HandSpin, x: number, y: number): void {
  const root = spin.el
  const r = root.getBoundingClientRect()
  const k = r.width / (root.offsetWidth || 390) || 1
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: r.left + x * k,
    clientY: r.top + y * k,
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
  }
  root.dispatchEvent(new PointerEvent('pointerdown', init))
  root.dispatchEvent(new PointerEvent('pointerup', init))
}

// 大きなボタンのあたりを押す（spread は親指のぶれ）
function pressButton(spin: HandSpin, spread: number): void {
  const btn = spin.el.querySelector('.fxs-btn')
  if (!btn) return
  const b = boxIn(btn, spin.el)
  tapAt(spin, b.x + b.w / 2 + (Math.random() - 0.5) * spread * 2, b.y + b.h / 2 + (Math.random() - 0.5) * spread)
}

// 1 秒に 6〜10 回、ときどき息つぎをする。STOP が光ったら、少し間をおいて押す
async function mash(spin: HandSpin, tl: Timeline): Promise<void> {
  for (let k = 1; !tl.cancelled && spin.el.isConnected; k++) {
    const phase = spin.el.dataset.phase
    if (phase === 'ready') {
      if (await hold(tl, 700 + Math.random() * 400)) pressButton(spin, 0)
      return
    }
    if (phase !== 'charge') return
    pressButton(spin, 40)
    await tl.wait(k % 19 === 0 ? 450 : 100 + Math.random() * 65)
  }
}

// ---- 通し ------------------------------------------------------------------------

async function run(host: HTMLElement, tl: Timeline, s: Spec): Promise<void> {
  const m = mockPhone(host, tl, s.mask, s.waiting)
  const spin = new HandSpin(host, { speed: tl.speed })
  watch(host, tl, m.card, spin)
  if (!(await hold(tl, 600))) return
  const min = MIN_CHARGE[s.tier]
  spin.start({
    tier: s.tier,
    waiting: s.waiting.map((c) => label(CARD5[c])),
    pool: poolOf(s.mask),
    minChargeMs: min,
    deadlineMs: min + GRACE,
  })
  tl.at(s.openAt ?? 300, () => spin.open(s.n))
  if (s.forceAt !== undefined) tl.at(s.forceAt, () => spin.forceStop())
  if (s.mash) void mash(spin, tl)
  await spin.stopped()
  if (tl.cancelled) return
  // 組み込み側: 止めた番号を、最新の番号と履歴に出しておく（本体が引っ込むと見える）
  m.latest.textContent = label(s.n)
  renderHistory(m, [s.n, ...HISTORY.slice(0, 5)])
  await spin.resolve({ outcome: s.outcome, label: label(s.n) })
  if (!tl.cancelled) await follow(m, host, tl, s)
}

// 組み込み側が続けて呼ぶ演出の見本（スタンプ → ライン・リーチ・ビンゴ）
async function follow(m: Mock, host: HTMLElement, tl: Timeline, s: Spec): Promise<void> {
  const cell = CARD5.indexOf(s.n)
  if (s.outcome === 'none' || cell < 0) return
  const mask = s.mask | (1 << cell)
  await m.card.stamp(cell)
  if (tl.cancelled) return
  if (s.outcome === 'bingo') {
    const line = LINES.filter((l) => openOf(l, mask).length === 0).flat()
    m.card.setMarks(mask, { line })
    setChip(m, `BINGO！ 第 ${s.rank ?? 1} 位`, true)
    await m.card.celebrateLine(line)
    if (!tl.cancelled) await playBingo(host, { rank: s.rank ?? 1, speed: tl.speed })
    return
  }
  const waiting = waitingOf(mask)
  const labels = waiting.map((c) => label(CARD5[c]))
  m.card.setMarks(mask, { waiting })
  setChip(m, labels.length ? `${labels.length >= 2 ? 'ダブルリーチ' : 'リーチ'}　あと ${labels.join('・')}` : '')
  if (s.outcome === 'reach' || s.outcome === 'double') await playReach(host, { lines: reachLines(mask), waiting: labels, speed: tl.speed })
}

const item = (s: Spec): GalleryItem => ({
  id: `phone-spin-${s.id}`,
  group: G,
  label: s.label,
  screen: 'phone',
  play: (host, tl) => run(host, tl, s),
})

const SPECS: Spec[] = [
  { id: '0-mash', label: '青 ● 連打あり → ハズレ（静かに引っ込む）', tier: 0, mash: true, mask: QUIET, waiting: [], n: 36, outcome: 'none' },
  { id: '0-auto', label: '青 ● 連打なし（時間切れで自動 STOP）→ ヒット', tier: 0, mash: false, mask: QUIET, waiting: [], n: 25, outcome: 'hit' },
  { id: '1-mash', label: '緑 ▲ 連打あり → ヒット', tier: 1, mash: true, mask: QUIET, waiting: [], n: 28, outcome: 'hit' },
  { id: '1-auto', label: '緑 ▲ 連打なし（時間切れ）→ 失敗（ざんねん…）', tier: 1, mash: false, mask: DIAG4, waiting: [24], n: 36, outcome: 'none' },
  { id: '2-mash', label: '赤 ◆ 連打あり → リーチ', tier: 2, mash: true, mask: bits(2, 7, 12), waiting: [], n: 33, outcome: 'reach' },
  { id: '2-auto', label: '赤 ◆ 連打なし（時間切れ）→ 失敗（惜しい！）', tier: 2, mash: false, mask: DIAG4, waiting: [24], n: 36, outcome: 'none' },
  { id: '3-mash', label: '金 ★ 連打あり → ビンゴ', tier: 3, mash: true, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 3 },
  { id: '3-auto', label: '金 ★ 連打なし（時間切れ）→ 失敗', tier: 3, mash: false, mask: DIAG4, waiting: [24], n: 36, outcome: 'none' },
  { id: '4-mash', label: '虹 ✦ 連打あり → ビンゴ確定', tier: 4, mash: true, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 1 },
  { id: '4-auto', label: '虹 ✦ 連打なし（時間切れ）→ ビンゴ確定', tier: 4, mash: false, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 2 },
  {
    id: '2-double',
    label: '赤 ◆ 連打あり → ダブルリーチ（あと 1 つのマスが光る）',
    tier: 2,
    mash: true,
    mask: DIAG4 | bits(10, 11),
    waiting: [24],
    n: 48,
    outcome: 'double',
  },
  {
    id: 'late',
    label: '番号が遅れて届く（時間切れのあとで open → すぐ止まる）',
    tier: 1,
    mash: false,
    mask: DIAG4,
    waiting: [24],
    n: 62,
    outcome: 'hit',
    openAt: MIN_CHARGE[1] + GRACE + 1200,
  },
  {
    id: 'force',
    label: '溜めの途中で forceStop（まだの予告を早送りして止まる）',
    tier: 3,
    mash: false,
    mask: DIAG4,
    waiting: [24],
    n: 65,
    outcome: 'bingo',
    forceAt: 2600,
    rank: 4,
  },
]

// 自分で遊ぶ: 段階と結果は毎回ランダム（連打はまねない）
function randomSpec(): Spec {
  const r = Math.random()
  const tier = (r < 0.2 ? 0 : r < 0.45 ? 1 : r < 0.7 ? 2 : r < 0.88 ? 3 : 4) as Tier
  const win = tier === 4 || Math.random() < 0.5
  const base = { id: 'play', label: '', tier, mash: false, mask: DIAG4, waiting: [24] }
  if (!win) return { ...base, n: 36, outcome: 'none' }
  if (tier <= 1) return { ...base, n: tier === 0 ? 25 : 62, outcome: 'hit' }
  if (tier === 2) return { ...base, mask: DIAG4 | bits(10, 11), n: 48, outcome: 'double' }
  return { ...base, n: 65, outcome: 'bingo', rank: tier === 4 ? 1 : 5 }
}

registerGallery(...SPECS.map(item), {
  id: 'phone-spin-play',
  group: G,
  label: '自分で遊ぶ（段階と結果はランダム。連打して STOP）',
  screen: 'phone',
  play: (host, tl) => run(host, tl, randomSpec()),
})
