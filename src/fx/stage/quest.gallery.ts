import { registerGallery } from '../gallery'
import type { Timeline } from '../runtime'
import { MoleQuestStage, type MoleQuestStageResult } from './quest'

// 緊急クエスト「モグラ撃退」の大画面のギャラリー。叩いた数の合計（setTotal）は本番と同じく 0.5 秒ごとに届け、
// 結果（result）は叩く時間が終わった 0.8 秒後に呼ぶ。
// 「説明の画面」の項目は brief から始めて、司会の「スタート」の代わりに数秒待ってから start へ進む
// （ほかの項目は brief なしで start から。3・2・1 のカウントダウンから始まる）。
// 後ろに大画面の配置（HUD・抽選機・結果・会場・番号の盤）を薄く描いて、重ねたときの見え方も確かめられるようにする

const G = '大画面: 緊急クエスト'
const INTRO = 3600 // 「3・2・1」のカウントダウン
const PLAY = 10000

function backdrop(host: HTMLElement): HTMLElement {
  const boxes: readonly (readonly [string, number, number, number, number])[] = [
    ['HUD', 0, 0, 1920, 90],
    ['抽選機', 40, 90, 1200, 700],
    ['結果パネル', 1270, 110, 610, 390],
    ['会場ビュー', 1270, 520, 610, 260],
    ['番号の盤', 40, 800, 1840, 260],
  ]
  for (const [label, x, y, w, h] of boxes) {
    const box = document.createElement('div')
    box.textContent = label
    box.style.cssText =
      `position:absolute; left:${x}px; top:${y}px; width:${w}px; height:${h}px; box-sizing:border-box; padding:12px 18px;` +
      'border:2px solid rgba(138,147,184,.28); border-radius:18px; background:rgba(22,32,74,.35);' +
      'color:rgba(200,210,255,.45); font:800 28px system-ui, sans-serif'
    host.append(box)
  }
  return host
}

type Top = MoleQuestStageResult['top']

interface Case {
  id: string
  label: string
  players: number
  targets: number
  total: number
  defended: number
  lost: number
  lostReach: number
  top: Top
  speeds?: readonly (readonly [at: number, times: number])[] // 叩き始めからの ms と、そこからの速度の倍率
  resultAt?: number // start から result を呼ぶまでの ms（既定は叩く時間の終わりの 0.8 秒後）
  // 説明の画面から始める。autoMs は自動で始まるまでの時間（司会を待つなら null）、
  // waitMs は start を呼ぶまでの時間（null なら呼ばずに、説明の画面のまま置いておく）
  brief?: { autoMs: number | null; waitMs: number | null }
}

const p = (name: string, score: number, isMe = false): Top[number] => ({ name, score, isMe })

// 0.5 秒ごとの会場の合計（叩き始めは少しずつ、なかほどで波があり、終盤は追い込みで増える）。
// 最後の値は final の 98% にしておく（遅れて届いた分が、結果の合計に入る）
function totals(final: number, steps: number): number[] {
  const w = Array.from({ length: steps }, (_, i) => {
    const t = (i + 0.5) / steps
    const ramp = Math.min(1, t / 0.15)
    const wave = 1 + 0.2 * Math.sin(t * 11)
    const spurt = t > 0.7 ? 1.3 : 1
    return ramp * wave * spurt
  })
  const sum = w.reduce((a, b) => a + b, 0)
  let acc = 0
  return w.map((x) => Math.round(((acc += x) / sum) * final * 0.98))
}

async function run(host: HTMLElement, tl: Timeline, c: Case): Promise<void> {
  const q = new MoleQuestStage(backdrop(host), { speed: tl.speed })
  if (c.brief) {
    q.brief({ playMs: PLAY, targets: c.targets, players: c.players, autoMs: c.brief.autoMs })
    // waitMs が null なら、ほかの項目を選ぶまで説明の画面のまま（長く置いても崩れないことを確かめる）
    await tl.wait(c.brief.waitMs ?? 3600000)
    if (tl.cancelled || c.brief.waitMs === null) return q.destroy()
  }
  q.start({ introMs: INTRO, playMs: PLAY, targets: c.targets, players: c.players })
  totals(c.total, PLAY / 500).forEach((v, i) => tl.at(INTRO + (i + 1) * 500, () => q.setTotal(v)))
  for (const [at, times] of c.speeds ?? []) tl.at(INTRO + at, () => q.setSpeed(tl.speed * times))
  await tl.wait(c.resultAt ?? INTRO + PLAY + 800)
  if (!tl.cancelled) {
    await q.result({ total: c.total, targets: c.targets, defended: c.defended, lost: c.lost, lostReach: c.lostReach, top: c.top })
  }
  q.destroy()
}

const NORMAL: Omit<Case, 'id' | 'label'> = {
  players: 1000,
  targets: 312,
  total: 18234,
  defended: 204,
  lost: 108,
  lostReach: 97,
  top: [p('きつね208', 168), p('しろくま042', 159), p('ぱんだ579', 151)],
}

const CASES: readonly Case[] = [
  { id: 'brief', label: '説明 → 司会がスタート（7 秒後）→ 3・2・1 → 結果まで', ...NORMAL, brief: { autoMs: null, waitMs: 7000 } },
  { id: 'brief-auto', label: '説明（自動。8 秒でバーがいっぱいになってスタート）', ...NORMAL, brief: { autoMs: 8000, waitMs: 8000 } },
  { id: 'brief-hold', label: '説明のまま置く（スタートを押さない）', ...NORMAL, brief: { autoMs: null, waitMs: null } },
  { id: 'brief-early', label: '警報の途中でスタート（1.5 秒後）', ...NORMAL, brief: { autoMs: null, waitMs: 1500 } },
  {
    id: 'no-target',
    label: 'リーチの人が 0 人（説明 → 結果まで。撃退数と撃退王が主役）',
    players: 1000,
    targets: 0,
    total: 15420,
    defended: 0,
    lost: 0,
    lostReach: 0,
    top: [p('きつね208', 171), p('ねこ123', 164, true), p('ぱんだ579', 150)],
    brief: { autoMs: null, waitMs: 5000 },
  },
  { id: 'reach-differs', label: '結果: リーチが消えた人が、やられた人より少ない', ...NORMAL, lost: 108, lostReach: 97 },
  { id: 'reach-same', label: '結果: リーチが消えた人が、やられた人と同じ（下の行なし）', ...NORMAL, lost: 108, lostReach: 108 },
  { id: 'normal', label: 'ふつう（1,000 人・リーチの 312 人がピンチ）', ...NORMAL },
  {
    id: 'almost',
    label: 'ほぼ全員 守りきった',
    players: 1000,
    targets: 286,
    total: 27650,
    defended: 279,
    lost: 7,
    lostReach: 5,
    top: [p('らっこ311', 182), p('こあら777', 176), p('いるか150', 170)],
  },
  {
    id: 'perfect',
    label: '全員 守りきった（やられた人 0）',
    players: 1000,
    targets: 240,
    total: 31020,
    defended: 240,
    lost: 0,
    lostReach: 0,
    top: [p('ぺんぎん009', 190), p('かわうそ612', 183), p('たぬき333', 179)],
  },
  {
    id: 'many-lost',
    label: 'やられた人が多い（モグラにやられた…！）',
    players: 1000,
    targets: 342,
    total: 9410,
    defended: 98,
    lost: 244,
    lostReach: 226,
    top: [p('はりねずみ520', 121), p('あるぱか064', 117), p('うさぎ816', 109)],
  },
  {
    id: 'me-king',
    label: 'あなたが撃退王',
    players: 1000,
    targets: 298,
    total: 20480,
    defended: 211,
    lost: 87,
    lostReach: 80,
    top: [p('ねこ123', 196, true), p('ふくろう404', 171), p('しろくま042', 165)],
  },
  {
    id: 'me-3rd',
    label: 'あなたが 3 位',
    ...NORMAL,
    top: [p('きつね208', 168), p('しろくま042', 159), p('ねこ123', 151, true)],
  },
  {
    id: 'small',
    label: '少人数（30 人・リーチの 7 人がピンチ）',
    players: 30,
    targets: 7,
    total: 1480,
    defended: 4,
    lost: 3,
    lostReach: 3,
    top: [p('いるか150', 98), p('ねこ123', 91, true), p('こあら777', 84)],
  },
  {
    id: 'huge',
    label: '1 万人（合計が 6 桁）',
    players: 10000,
    targets: 3120,
    total: 412345,
    defended: 2048,
    lost: 1072,
    lostReach: 975,
    top: [p('ぺんぎん009', 214), p('らっこ311', 209), p('かわうそ612', 205)],
  },
  {
    id: 'two',
    label: '撃退王が 2 人だけ・長い名前',
    players: 12,
    targets: 3,
    total: 380,
    defended: 2,
    lost: 1,
    lostReach: 1,
    top: [p('ながいなまえのはりねずみさん', 64), p('あるぱか', 58)],
  },
  {
    id: 'none',
    label: '誰もたたかなかった（撃退王なし）',
    players: 40,
    targets: 9,
    total: 0,
    defended: 0,
    lost: 9,
    lostReach: 9,
    top: [],
  },
  { id: 'speed', label: 'たたく途中で速度を変える（×3 → ×0.5 → ×1）', ...NORMAL, speeds: [[1500, 3], [4000, 0.5], [7000, 1]] },
  { id: 'early', label: 'たたく途中で結果が来る（その場で「そこまで！」にする）', ...NORMAL, resultAt: INTRO + 5000 },
]

registerGallery(
  ...CASES.map((c) => ({
    id: `stage-quest-${c.id}`,
    group: G,
    label: c.label,
    screen: 'stage' as const,
    play: (host: HTMLElement, tl: Timeline) => run(host, tl, c),
  })),
)
