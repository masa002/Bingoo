import { registerGallery, type GalleryItem } from '../gallery'
import type { Timeline } from '../runtime'
import type { Tier } from '../theme'
import { Aori, playBingo, playMoleResult, playReach, playWildResult, type AoriOutcome } from './aori'
import { CardView } from './card'

// スマホのカード・手元のあおり・単発の演出のギャラリー。
// 見本の画面は ui/phone.ts と同じ並び（ステータス・名前・リーチの札・カード・最新の番号）にして、重なり方も確かめられるようにする

const CARD5 = [3, 22, 38, 51, 67, 12, 17, 44, 59, 70, 7, 28, 0, 48, 62, 15, 19, 33, 56, 74, 1, 25, 41, 53, 65]
const CARD3 = [9, 34, 61, 27, 0, 52, 14, 70, 45]
const REVEAL = [2600, 4000, 5600, 6800, 8500] // 段階ごとの公開までの ms（core/show.ts と同じ）
const bits = (...cells: number[]): number => cells.reduce((m, i) => m | (1 << i), 0)
const DIAG4 = bits(0, 6, 12, 18) // 斜めがあと 1 つ（O65）

const G_CARD = 'スマホ: カード'
const G_AORI = 'スマホ: あおり'
const G_SHOT = 'スマホ: 単発の演出'
const G_FLOW = 'スマホ: 通し（組み込みの見本）'

// ギャラリーで別の演出に切り替えたら（host が外れたら）止める
function watch(host: HTMLElement, tl: Timeline, ...parts: { destroy(): void }[]): void {
  const check = () => {
    if (!host.isConnected || tl.cancelled) parts.forEach((p) => p.destroy())
    else requestAnimationFrame(check)
  }
  requestAnimationFrame(check)
}

// 待って、まだ続けてよいか
async function hold(tl: Timeline, ms: number): Promise<boolean> {
  await tl.wait(ms)
  return !tl.cancelled
}

// 見本のスマホ画面を作り、カードを置いて返す
function mockPhone(host: HTMLElement, tl: Timeline, o: { size?: 5 | 3; chip?: string; width?: string } = {}): CardView {
  const size = o.size ?? 5
  host.insertAdjacentHTML(
    'beforeend',
    `<div style="position:absolute;inset:0;background:radial-gradient(120% 60% at 50% 0%,#16204a,#0a0f24 60%,#070b1a);color:#e8ecff;font-family:'Hiragino Sans','Yu Gothic UI','Meiryo',system-ui,sans-serif">
      <div style="display:flex;justify-content:space-between;padding:12px 26px 4px;font-size:13px;font-weight:700"><span>9:41</span><span>●●● 100%</span></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 16px 4px"><b style="font-size:18px">あなた<small style="margin-left:8px;color:#8a93b8;font-weight:400">No.00042</small></b><small style="color:#8a93b8">参加 1,000人</small></div>
      <div style="min-height:38px;margin:0 14px">${
        o.chip ? `<div style="border-radius:10px;padding:6px 10px;font-weight:900;background:linear-gradient(90deg,#ff7a3d,#ef4444)">${o.chip}</div>` : ''
      }</div>
      <div class="fxc-gal-slot" style="position:relative;margin-top:6px"></div>
      <div style="margin-top:8px;text-align:center"><small style="display:block;color:#8a93b8">最新の番号</small><b style="font-size:40px;font-weight:900">I20</b></div>
    </div>`,
  )
  const card = new CardView(host.querySelector<HTMLElement>('.fxc-gal-slot')!, { size, speed: tl.speed })
  if (o.width) card.el.style.setProperty('--fxc-w', o.width)
  card.setCells(size === 5 ? CARD5 : CARD3)
  card.setMarks(size === 5 ? bits(12) : bits(4))
  return card
}

// ---- カード ------------------------------------------------------------------

function cardItem(id: string, label: string, run: (card: CardView, tl: Timeline, host: HTMLElement) => Promise<void> | void, size: 5 | 3 = 5): GalleryItem {
  return {
    id: `phone-card-${id}`,
    group: G_CARD,
    label,
    screen: 'phone',
    async play(host, tl) {
      const card = mockPhone(host, tl, { size })
      watch(host, tl, card)
      await run(card, tl, host)
    },
  }
}

registerGallery(
  cardItem('deal5', '5×5: 配る（1 マスずつめくれる）', (card) => card.deal()),
  cardItem('stamp', '5×5: スタンプ（インクで穴が開いて弾む）', async (card, tl) => {
    let mask = bits(12)
    for (const c of [6, 18, 0]) {
      if (!(await hold(tl, 300))) return
      await card.stamp(c)
      mask |= 1 << c
      card.setMarks(mask)
    }
    card.setMarks(mask, { waiting: [24] })
  }),
  cardItem('wait', '5×5: リーチ（あと 1 つが金の照準で脈動）', (card) => {
    card.setMarks(DIAG4 | bits(10, 11, 13), { waiting: [24, 14] })
  }),
  cardItem('line', '5×5: ラインがそろう（光が走る）', async (card, tl) => {
    card.setMarks(DIAG4, { waiting: [24] })
    if (!(await hold(tl, 600))) return
    await card.stamp(24)
    const line = [0, 6, 12, 18, 24]
    card.setMarks(DIAG4 | bits(24), { line })
    await card.celebrateLine(line)
  }),
  cardItem('line2', '5×5: 2 本同時にそろう', async (card, tl) => {
    card.setMarks(DIAG4 | bits(10, 11, 13, 14), { waiting: [24] })
    if (!(await hold(tl, 600))) return
    await card.stamp(24)
    const cells = [0, 6, 10, 11, 12, 13, 14, 18, 24]
    card.setMarks(DIAG4 | bits(10, 11, 13, 14, 24), { line: cells })
    await card.celebrateLine(cells)
  }),
  cardItem('wild', '5×5: 虹玉で開く（虹の光が落ちてくる）', async (card, tl) => {
    card.setMarks(bits(0, 6, 12))
    if (!(await hold(tl, 500))) return
    await card.wildOpen(18)
    card.setMarks(DIAG4, { wild: [18], waiting: [24] })
  }),
  cardItem('mole', '5×5: モグラが穴を埋める', async (card, tl) => {
    card.setMarks(DIAG4, { waiting: [24] })
    if (!(await hold(tl, 600))) return
    await card.moleFill(18)
    card.setMarks(bits(0, 6, 12), { filled: [18] })
  }),
  cardItem('states', '5×5: 状態の見本（開いた・あと 1 つ・ライン・埋められた・虹）', (card) => {
    card.setMarks(bits(0, 2, 7, 12, 20, 21, 22, 23, 24), { line: [20, 21, 22, 23, 24], filled: [8], wild: [7], waiting: [17] })
  }),
  cardItem('deal3', '3×3 チャレンジ: 配る（金のカード）', (card) => card.deal(), 3),
  cardItem(
    'ch-line',
    '3×3 チャレンジ: スタンプ → ライン',
    async (card, tl) => {
      card.setMarks(bits(3, 4), { waiting: [5] })
      if (!(await hold(tl, 600))) return
      await card.stamp(5)
      card.setMarks(bits(3, 4, 5), { line: [3, 4, 5] })
      await card.celebrateLine([3, 4, 5])
    },
    3,
  ),
  {
    id: 'phone-card-ch-small',
    group: G_CARD,
    label: '3×3 チャレンジ: 幅 220px の枠に置く（--fxc-w）',
    screen: 'phone',
    async play(host, tl) {
      const card = mockPhone(host, tl, { size: 3, width: '220px' })
      watch(host, tl, card)
      await card.deal()
    },
  },
)

// ---- あおり ------------------------------------------------------------------

interface Scene {
  id: string
  label: string
  tier: Tier
  outcome: AoriOutcome
  drawn: string // 大画面に出た番号
  mask?: number // あおりの前のカード（既定は斜めがあと 1 つ = O65 待ち）
  waiting?: number[]
  rank?: number
  after?: (card: CardView, host: HTMLElement, tl: Timeline) => Promise<void> // 組み込み側が続けて呼ぶ演出の見本
}

const stampAnd = (cell: number, mask: number, waiting: number[] = []) => async (card: CardView) => {
  await card.stamp(cell)
  card.setMarks(mask, { waiting })
}

const bingoAfter = (rank: number) => async (card: CardView, host: HTMLElement, tl: Timeline) => {
  await card.stamp(24)
  const line = [0, 6, 12, 18, 24]
  card.setMarks(DIAG4 | bits(24), { line })
  await card.celebrateLine(line)
  await playBingo(host, { rank, speed: tl.speed })
}

const SCENES: Scene[] = [
  { id: '0-none', label: '青 → 外れ（静かに消える）', tier: 0, outcome: 'none', drawn: 'N36' },
  { id: '0-hit', label: '青 → ヒット', tier: 0, outcome: 'hit', drawn: 'I25', after: stampAnd(21, DIAG4 | bits(21), [24]) },
  { id: '1-fail', label: '緑 CHANCE → 失敗', tier: 1, outcome: 'none', drawn: 'N36' },
  {
    id: '1-reach',
    label: '緑 CHANCE → リーチ',
    tier: 1,
    outcome: 'reach',
    drawn: 'N33',
    mask: bits(2, 7, 12),
    waiting: [],
    after: async (card, host, tl) => {
      await stampAnd(17, bits(2, 7, 12, 17), [22])(card)
      await playReach(host, { lines: 1, waiting: ['N41'], speed: tl.speed })
    },
  },
  { id: '2-fail', label: '赤 激アツ → 失敗（惜しい！）', tier: 2, outcome: 'none', drawn: 'N36' },
  {
    id: '2-double',
    label: '赤 激アツ → ダブルリーチ',
    tier: 2,
    outcome: 'double',
    drawn: 'G48',
    mask: DIAG4 | bits(10, 11),
    after: async (card, host, tl) => {
      await stampAnd(13, DIAG4 | bits(10, 11, 13), [24, 14])(card)
      await playReach(host, { lines: 2, waiting: ['O65', 'O62'], speed: tl.speed })
    },
  },
  { id: '3-fail', label: '金 BINGO CHANCE → 失敗（PUSH 待ちのあと）', tier: 3, outcome: 'none', drawn: 'N36' },
  { id: '3-bingo', label: '金 BINGO CHANCE → ビンゴ', tier: 3, outcome: 'bingo', drawn: 'O65', rank: 3, after: bingoAfter(3) },
  { id: '4-bingo', label: '虹 確定 → ビンゴ', tier: 4, outcome: 'bingo', drawn: 'O65', rank: 1, after: bingoAfter(1) },
]

const label = (n: number): string => 'BINGO'[Math.floor((n - 1) / 15)] + n

registerGallery(
  ...SCENES.map(
    (sc): GalleryItem => ({
      id: `phone-aori-${sc.id}`,
      group: G_AORI,
      label: sc.label,
      screen: 'phone',
      async play(host, tl) {
        const waiting = sc.waiting ?? [24]
        const labels = waiting.map((c) => label(CARD5[c]))
        const card = mockPhone(host, tl, { chip: labels.length ? `リーチ　あと ${labels.join('・')}` : undefined })
        card.setMarks(sc.mask ?? DIAG4, { waiting })
        const aori = new Aori(host, { speed: tl.speed })
        watch(host, tl, card, aori)
        if (!(await hold(tl, 400))) return
        const R = REVEAL[sc.tier]
        aori.start({ tier: sc.tier, revealIn: R, waiting: labels })
        if (!(await hold(tl, R))) return
        // 金・虹は、大画面が MC の PUSH を待つ
        if (sc.tier >= 3) {
          aori.awaitPush()
          if (!(await hold(tl, 1800))) return
        }
        await aori.resolve({ outcome: sc.outcome, label: sc.drawn, rank: sc.rank })
        if (!tl.cancelled && sc.after) await sc.after(card, host, tl)
      },
    }),
  ),
)

// ---- 単発の演出 --------------------------------------------------------------

function shotItem(id: string, label: string, run: (host: HTMLElement, speed: number) => Promise<void>): GalleryItem {
  return {
    id: `phone-shot-${id}`,
    group: G_SHOT,
    label,
    screen: 'phone',
    async play(host, tl) {
      const card = mockPhone(host, tl)
      card.setMarks(DIAG4, { waiting: [24] })
      watch(host, tl, card)
      await run(host, tl.speed)
    },
  }
}

registerGallery(
  shotItem('reach', 'リーチ！', (host, speed) => playReach(host, { lines: 1, waiting: ['O65'], speed })),
  shotItem('double', 'ダブルリーチ！', (host, speed) => playReach(host, { lines: 2, waiting: ['O65', 'O62'], speed })),
  shotItem('triple', 'リーチ 3 本（ダブルリーチ＋ライン数）', (host, speed) => playReach(host, { lines: 3, waiting: ['O65', 'O62', 'N41'], speed })),
  shotItem('bingo', 'ビンゴ（第 3 位）', (host, speed) => playBingo(host, { rank: 3, speed })),
  shotItem('mole-hit', 'モグラ: 穴を埋められた', (host, speed) => playMoleResult(host, { hit: true, lostReach: false, label: 'I17', speed })),
  shotItem('mole-lost', 'モグラ: リーチが消えた', (host, speed) => playMoleResult(host, { hit: true, lostReach: true, label: 'G56', speed })),
  shotItem('mole-safe', 'モグラ: セーフ', (host, speed) => playMoleResult(host, { hit: false, lostReach: false, speed })),
  shotItem('wild', '虹玉: マスが開いた', (host, speed) => playWildResult(host, { label: 'N44', newReach: false, speed })),
  shotItem('wild-reach', '虹玉: 開いてリーチ', (host, speed) => playWildResult(host, { label: 'N44', newReach: true, speed })),
)

// ---- 通し（組み込み側の呼び方の見本） ------------------------------------------

registerGallery(
  {
    id: 'phone-flow-mole',
    group: G_FLOW,
    label: 'モグラ: マスが埋まる → リーチが消えた',
    screen: 'phone',
    async play(host, tl) {
      const card = mockPhone(host, tl, { chip: 'リーチ　あと O65' })
      card.setMarks(DIAG4, { waiting: [24] })
      watch(host, tl, card)
      if (!(await hold(tl, 500))) return
      await card.moleFill(18)
      card.setMarks(bits(0, 6, 12), { filled: [18] })
      await playMoleResult(host, { hit: true, lostReach: true, label: 'G56', speed: tl.speed })
    },
  },
  {
    id: 'phone-flow-wild',
    group: G_FLOW,
    label: '虹玉: マスが開く → リーチ',
    screen: 'phone',
    async play(host, tl) {
      const card = mockPhone(host, tl)
      card.setMarks(bits(0, 6, 12))
      watch(host, tl, card)
      if (!(await hold(tl, 500))) return
      await card.wildOpen(18)
      card.setMarks(DIAG4, { wild: [18], waiting: [24] })
      await playWildResult(host, { label: 'G56', newReach: true, speed: tl.speed })
    },
  },
)
