import { Rng } from '../../core/rng'
import { makePlan, schedule, timing, type Beat } from '../../core/show'
import { registerGallery, type GalleryItem } from '../gallery'
import type { Timeline } from '../runtime'
import { TIER_SHAPE, TIER_WORD, type Tier } from '../theme'
import { playBingo, playReach, type AoriOutcome } from './aori'
import { CardView } from './card'
import { HandSpin } from './spin'

// 手元の抽選演出のギャラリー。見本の画面は ui/phone.ts と同じ並び（ステータス・名前・リーチの札・カード・最新の番号・履歴）にして、
// カードを上に置いたまま流す。拍の列は権威と同じく、大画面の段階から makePlan → schedule で毎回作る（timing は reveal・push だけを使う）。
// 呼ぶ順番も組み込みと同じ: start → （金・虹は reveal の時刻に awaitPush → MC の PUSH を待つ）→ reveal → resolve → スタンプなど。
// ステータスの行の真ん中に、大画面の拍（STEP・カットイン・PUSH 待ちなど）を小さく出す（見本だけ。そろい方を確かめるため）

const G = 'スマホ: 手元の抽選（大画面と同じ流れ）'
const CARD5 = [3, 22, 38, 51, 67, 12, 17, 44, 59, 70, 7, 28, 0, 48, 62, 15, 19, 33, 56, 74, 1, 25, 41, 53, 65]
const HISTORY = [20, 3, 17, 56, 22, 74] // 見本の履歴（新しい順）
const PUSH_WAIT = 2200 // 見本で MC が PUSH を押すまで
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
  venue: HTMLElement
}

interface Spec {
  id: string
  label: string
  venue: Tier // 大画面の段階
  tier: Tier // 自分のカードにとっての段階
  mask: number // 公開の前のカード
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
        <span data-k="venue" style="position:absolute;left:84px;right:96px;top:12px;text-align:center;font-size:11px;font-weight:700;color:#8a93b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span></div>
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
  const m: Mock = { card, chip: $('chip'), latest: $('latest'), history: $('history'), venue: $('venue') }
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

// 大画面の拍の名前（見本の帯に出す）
function describe(b: Beat): string {
  const t = (b.tier ?? b.heat) as Tier
  switch (b.kind) {
    case 'appear':
      return '登場'
    case 'spin':
      return '回転'
    case 'holdChange':
      return `保留変化 ${TIER_SHAPE[t]}`
    case 'step':
      return `STEP ${(b.index ?? 0) + 1} ${TIER_SHAPE[t]}`
    case 'group':
      return '群予告'
    case 'pseudo':
      return `疑似連 ×${(b.index ?? 0) + 2}`
    case 'cutin':
      return `カットイン ${TIER_SHAPE[t]}${TIER_WORD[t]}`
    case 'telop':
      return `テロップ「${b.text ?? ''}」`
    case 'decel':
      return '減速'
    case 'riser':
      return 'ライザー'
    case 'heartbeat':
      return '鼓動'
    case 'ma':
      return '間（ま）'
    case 'goldEdge':
      return '金の縁（裏返る）'
    case 'freeze':
      return 'フリーズ'
    case 'crack':
      return 'ヒビ'
    case 'kakutei':
      return '確定'
    case 'rainbowPhones':
      return '全台が虹'
    case 'push':
      return 'PUSH 待ち'
    case 'reveal':
      return '公開の予定'
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
  const spin = new HandSpin(host, { speed: tl.speed })
  watch(host, tl, m.card, spin)
  if (!(await hold(tl, 500))) return
  // 権威と同じ作り方: 大画面の段階から、演出計画と拍の列を作る
  const t = timing(s.venue, 1000)
  const beats = schedule(makePlan(s.venue, new Rng(`${s.id}-${Math.random()}`)), t)
  spin.start({
    tier: s.tier,
    waiting: s.waiting.map((c) => label(CARD5[c])),
    pool: poolOf(s.mask),
    beats,
    revealAt: t.reveal,
    venueTier: s.venue,
  })
  for (const b of beats) {
    const text = describe(b)
    if (text) tl.at(b.at, () => (m.venue.textContent = `会場: ${text}`))
  }
  if (!(await hold(tl, t.reveal))) return
  if (t.push) {
    // 金・虹は、大画面が MC の PUSH を待つ
    spin.awaitPush()
    m.venue.textContent = '会場: MC の PUSH 待ち…'
    if (!(await hold(tl, PUSH_WAIT))) return
  }
  m.venue.textContent = `会場: 公開 ${label(s.n)}`
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

const SPECS: Spec[] = [
  { id: 'v0-p0', label: '会場 青 × 自分 青 → ハズレ（静かなまま）', venue: 0, tier: 0, mask: QUIET, waiting: [], n: 36, outcome: 'none' },
  { id: 'v2-p0', label: '会場 赤 × 自分 青 → ハズレ（会場は激アツ、手元は上がらない）', venue: 2, tier: 0, mask: QUIET, waiting: [], n: 36, outcome: 'none' },
  { id: 'v1-p1', label: '会場 緑 × 自分 緑 → ヒット', venue: 1, tier: 1, mask: QUIET, waiting: [], n: 28, outcome: 'hit' },
  { id: 'v3-p1', label: '会場 金 × 自分 緑 → 失敗（手元は緑で止まる・PUSH 待ち）', venue: 3, tier: 1, mask: DIAG4, waiting: [24], n: 36, outcome: 'none' },
  { id: 'v0-p2', label: '会場 青 × 自分 赤 → リーチ（手元のほうが熱い）', venue: 0, tier: 2, mask: bits(2, 7, 12), waiting: [], n: 33, outcome: 'reach' },
  { id: 'v2-p2', label: '会場 赤 × 自分 赤 → 失敗（惜しい！）', venue: 2, tier: 2, mask: DIAG4, waiting: [24], n: 36, outcome: 'none' },
  { id: 'v2-p2-double', label: '会場 赤 × 自分 赤 → ダブルリーチ', venue: 2, tier: 2, mask: DIAG4 | bits(10, 11), waiting: [24], n: 48, outcome: 'double' },
  { id: 'v1-p3', label: '会場 緑 × 自分 金 → 失敗（手元だけ金）', venue: 1, tier: 3, mask: DIAG4, waiting: [24], n: 36, outcome: 'none' },
  { id: 'v3-p3', label: '会場 金 × 自分 金 → ビンゴ（PUSH 待ち）', venue: 3, tier: 3, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 3 },
  { id: 'v3-p4', label: '会場 金 × 自分 虹 → ビンゴ確定（PUSH 待ち）', venue: 3, tier: 4, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 1 },
  { id: 'v0-p4', label: '会場 青 × 自分 虹 → ビンゴ確定（静かな会場で、手元だけ確定）', venue: 0, tier: 4, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 2 },
  { id: 'v2-p4', label: '会場 赤 × 自分 虹 → ビンゴ確定', venue: 2, tier: 4, mask: DIAG4, waiting: [24], n: 65, outcome: 'bingo', rank: 4 },
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
