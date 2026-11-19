import { Rng } from '../../core/rng'
import { drawTiming, personalBeats, pickStyle, venueBeats, type Beat } from '../../core/show'
import { registerGallery, type GalleryItem } from '../gallery'
import type { Timeline } from '../runtime'
import { MY_TIER_WORD, TIER_QUIET, TIER_SHAPE, type Tier } from '../theme'
import { playBingo, playReach, type AoriOutcome } from './aori'
import { CardView } from './card'
import { HandSpin } from './spin'

// 手元の抽選演出のギャラリー。見本の画面は ui/phone.ts と同じ並び（ステータス・名前・リーチの札・カード・最新の番号・履歴）にして、
// カードを上に置いたまま流す。見本は「自分の段階 × 結果」の組み合わせ（期待度はスマホだけに出る）。
// 拍は権威と同じ作り方で、毎回作る: 自分の拍は personalBeats、大画面の抽選機の拍は venueBeats、型は pickStyle、長さは drawTiming。
// 呼ぶ順番も組み込みと同じ: start → 番号が出る時刻に reveal → resolve → スタンプなど。
// 段階とカードは、権威と同じく食い違わないようにしてある（金・虹はリーチの人だけ、赤はリーチが増えうる人だけ）。
// オリパの合図の見本もここにある: 昇格（途中で色が上がる）、復活（青・緑のままリーチ・ビンゴになった回。「なかった…？」→ 暗転 →「あった！」）。
// ステータスの行の真ん中に、いまの拍を小さく出す（見本だけ。拍のなぞり方を確かめるため）

const G = 'スマホ: 手元の抽選（あなたの期待度）'
const CARD5 = [3, 22, 38, 51, 67, 12, 17, 44, 59, 70, 7, 28, 0, 48, 62, 15, 19, 33, 56, 74, 1, 25, 41, 53, 65]
const HISTORY = [20, 3, 17, 56, 22, 74] // 見本の履歴（新しい順）
const bits = (...cells: number[]): number => cells.reduce((m, i) => m | (1 << i), 0)
const DIAG4 = bits(0, 6, 12, 18) // 斜めがあと 1 つ（O65）。ほかにリーチは増えない
const DIAG4_ROW3 = DIAG4 | bits(10, 11) // 斜めがあと 1 つ（O65）で、横もあと 2 つ（G48 でリーチが増える）
const COL3 = bits(2, 7, 12) // リーチなし。縦があと 2 つ（N33 でリーチになる）
const QUIET = bits(1, 12, 19) // リーチなし。1 つあいても、リーチにならない
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
  note: HTMLElement
}

interface Spec {
  id: string
  label: string
  tier: Tier // 自分のカードにとっての段階
  flow?: Tier // 虹のとき、確定の前に届く流れ（青〜金）。省略すると、権威と同じくじで決まる
  mask: number // 番号が出る前のカード
  waiting: number[] // あと 1 つのマス
  n: number // 出る番号
  outcome: AoriOutcome
  rank?: number
}

// ---- 見本の画面 ----------------------------------------------------------------

function mockPhone(host: HTMLElement, tl: Timeline, mask: number, waiting: readonly number[]): Mock {
  host.insertAdjacentHTML(
    'beforeend',
    `<div style="position:absolute;inset:0;background:radial-gradient(120% 60% at 50% 0%,#16204a,#0a0f24 60%,#070b1a);color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif;font-size:15px">
      <div style="position:relative;display:flex;justify-content:space-between;padding:12px 26px 4px;font-size:13px;font-weight:700"><span>9:41</span><span>●●● 100%</span>
        <span data-k="note" style="position:absolute;left:84px;right:96px;top:12px;text-align:center;font-size:11px;font-weight:700;color:#8a93b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span></div>
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
  const m: Mock = { card, chip: $('chip'), latest: $('latest'), history: $('history'), note: $('note') }
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

// 拍の名前（見本のステータスの行に出す）
function describe(b: Beat): string {
  const t = (b.tier ?? b.heat) as Tier
  switch (b.kind) {
    case 'spin':
      return '回る'
    case 'holdChange':
      return `色が変わる ${TIER_SHAPE[t]}`
    case 'step':
      return `期待が高まる ${TIER_SHAPE[t]}`
    case 'group':
      return 'カードの群れが飛ぶ'
    case 'pseudo':
      return `まだ止まらない！ ${(b.index ?? 0) + 2} 回目`
    case 'cutin':
      return `カットイン「${TIER_SHAPE[t]}${MY_TIER_WORD[t]}」`
    case 'telop':
      return `テロップ「${b.text ?? ''}」`
    case 'decel':
      return 'ゆっくりになる'
    case 'riser':
      return '音が上がっていく'
    case 'heartbeat':
      return 'ドキドキ'
    case 'ma':
      return '間（ま）'
    case 'goldEdge':
      return '金の箔が下りる'
    case 'reveal':
      return '発表の時刻'
    default:
      return ''
  }
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

// ---- 通し（組み込みと同じ呼び方） ----------------------------------------------------

async function run(host: HTMLElement, tl: Timeline, s: Spec): Promise<void> {
  const m = mockPhone(host, tl, s.mask, s.waiting)
  // 見本には大画面がないので、回り出しと着地の音も手元で鳴らす（本番のスマホと同じ）
  const spin = new HandSpin(host, { speed: tl.speed, sound: 'all' })
  watch(host, tl, m.card, spin)
  if (!(await hold(tl, 500))) return
  // 権威と同じ作り方: 自分の段階から自分の拍を作る。大画面の抽選機の拍と型は、番号が見える瞬間を合わせるためだけに渡す
  const reveal = drawTiming(1000, false).reveal
  const beats = personalBeats(s.flow ?? s.tier, reveal, new Rng(`${s.id}-${Math.random()}`))
  spin.start({
    tier: s.tier,
    waiting: s.waiting.map((c) => label(CARD5[c])),
    pool: poolOf(s.mask),
    beats,
    revealAt: reveal,
    venueBeats: venueBeats(reveal),
    venueVariant: pickStyle([], Math.random),
  })
  for (const b of beats) {
    const text = describe(b)
    if (text) tl.at(b.at, () => (m.note.textContent = `拍: ${text}`))
  }
  if (!(await hold(tl, reveal))) return
  m.note.textContent = `発表 ${label(s.n)}`
  await spin.reveal(s.n)
  if (tl.cancelled) return
  // 組み込み側: 出た番号を、最新の番号と履歴に出しておく（本体が引っ込むと見える）
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
    setChip(m, `ビンゴ！ 第 ${s.rank ?? 1} 位`, true)
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

const SPECS: Spec[] = [
  { id: 't0-none', label: `青 → なかった…（${TIER_QUIET}のまま）`, tier: 0, mask: QUIET, waiting: [], n: 36, outcome: 'none' },
  { id: 't0-hit', label: '青 → あった！', tier: 0, mask: QUIET, waiting: [], n: 28, outcome: 'hit' },
  { id: 't1-none', label: '緑「あるかも？」→ なかった…', tier: 1, mask: QUIET, waiting: [], n: 36, outcome: 'none' },
  { id: 't1-hit', label: '緑「あるかも？」→ あった！', tier: 1, mask: QUIET, waiting: [], n: 28, outcome: 'hit' },
  { id: 't2-none', label: '赤「リーチのチャンス！」→ なかった…', tier: 2, mask: COL3, waiting: [], n: 36, outcome: 'none' },
  { id: 't2-reach', label: '赤「リーチのチャンス！」→ リーチ！', tier: 2, mask: COL3, waiting: [], n: 33, outcome: 'reach' },
  { id: 't2-double', label: '赤「リーチのチャンス！」→ ダブルリーチ！', tier: 2, mask: DIAG4_ROW3, waiting: [24], n: 48, outcome: 'double' },
  { id: 't2-bingo', label: '赤「リーチのチャンス！」→ ビンゴ！', tier: 2, mask: DIAG4_ROW3, waiting: [24], n: 65, outcome: 'bingo', rank: 6 },
  { id: 't3-none', label: '金「ビンゴのチャンス！」→ なかった…（金でも、必ずではない）', tier: 3, mask: DIAG4, waiting: [24], n: 36, outcome: 'none' },
  { id: 't3-bingo', label: '金「ビンゴのチャンス！」→ ビンゴ！', tier: 3, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 3 },
  // ---- 虹（自分のビンゴ確定）。確定は、発表の少し前に出る ----
  { id: 't4-from0', label: '虹: 青のまま → 突然「ビンゴ確定！」→ ビンゴ！', tier: 4, flow: 0, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 2 },
  { id: 't4-from2', label: '虹: 赤まで上がる →「ビンゴ確定！」→ ビンゴ！', tier: 4, flow: 2, mask: DIAG4_ROW3, waiting: [24], n: 65, outcome: 'bingo', rank: 4 },
  { id: 't4-from3', label: '虹: 金まで上がる →「ビンゴ確定！」→ ビンゴ！', tier: 4, flow: 3, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 1 },
  { id: 't4-any', label: '虹: 流れはくじ（権威と同じ）→「ビンゴ確定！」→ ビンゴ！', tier: 4, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 1 },
  // ---- オリパの合図 ----
  { id: 'revive-reach', label: 'どんでん返し: 青のまま → なかった…？ → 暗くなる → あった！ → リーチ！', tier: 0, mask: COL3, waiting: [], n: 33, outcome: 'reach' },
  { id: 'revive-bingo', label: 'どんでん返し: 緑のまま → なかった…？ → 暗くなる → あった！ → ビンゴ！', tier: 1, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 5 },
]

registerGallery(
  ...SPECS.map(
    (s): GalleryItem => ({
      id: `phone-spin-${s.id}`,
      group: G,
      label: s.label,
      screen: 'phone',
      play: (host, tl) => run(host, tl, s),
    }),
  ),
)
