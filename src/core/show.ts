import type { Impact } from './game'
import type { Rng } from './rng'

// 演出の方針。「結果が先、演出はあと」: 次の番号の影響（事実）から段階を抽選し、
// 段階から予告の組み合わせと時刻を決める。結果について嘘はつかない（虹は確定のときだけ）。

// 段階: 0 青 / 1 緑 / 2 赤 / 3 金 / 4 虹
export type Tier = 0 | 1 | 2 | 3 | 4
export const TIER_NAME = ['青', '緑', '赤', '金', '虹'] as const
export const TIER_WORD = ['', 'CHANCE', '激アツ', 'BINGO CHANCE', '確定'] as const
export const TIER_SHAPE = ['●', '▲', '◆', '★', '✦'] as const

export type FactClass = 'QUIET' | 'WARM' | 'HOT' | 'BINGO' | 'PREM'

// 大画面の段階の抽選表（％）。会場全体の熱を表す 4 段階で、ガセは溜めの間だけ。
// 虹は「虹が出た画面の持ち主は必ず当たる」ので、大画面では全員確定のイベントにだけ使う
export const TIER_TABLE: Readonly<Record<FactClass, readonly number[]>> = {
  QUIET: [86, 11, 3, 0, 0],
  WARM: [45, 40, 15, 0, 0],
  HOT: [10, 40, 42, 8, 0],
  // 1000 人規模だと中盤以降はほぼ毎回ビンゴが出るので、金（PUSH 待ち）が続きすぎないように抑える
  BINGO: [6, 22, 42, 30, 0],
  PREM: [0, 0, 20, 80, 0],
}

export type PersonalOutcome = 'none' | 'hit' | 'reach' | 'bingo'

// 手元（スマホ）の段階の抽選表（％）。次の番号が自分のカードにとって何を意味するかで決める。
// 当たらない人にも緑・赤のあおりを少し出し（失敗演出で終わる）、虹は自分がビンゴになるときだけ
export const PERSONAL_TABLE: Readonly<Record<PersonalOutcome, readonly number[]>> = {
  none: [90, 8, 2, 0, 0],
  hit: [30, 55, 15, 0, 0],
  reach: [5, 35, 50, 10, 0],
  bingo: [0, 5, 25, 40, 30],
}

export function personalTier(outcome: PersonalOutcome, rng: Rng): Tier {
  return rng.weighted(PERSONAL_TABLE[outcome]) as Tier
}

export interface Context {
  size: number
  winners: number // 公開前までに上がった人数
  prizeCount: number
}

export function classify(imp: Impact, all: readonly Impact[], ctx: Context): FactClass {
  const b = imp.newBingo
  if (b >= 1) {
    const first = ctx.winners === 0
    const lastPrize = ctx.winners + b >= ctx.prizeCount
    const mass = b >= Math.max(5, Math.ceil(0.02 * ctx.size))
    return first || lastPrize || mass ? 'PREM' : 'BINGO'
  }
  if (imp.newReach < 1) return 'QUIET'
  // ビンゴが出ない候補の中で、新規リーチ数が上位何％か（人数によらず頻度が安定する）
  const pool = all.filter((i) => i.newBingo === 0)
  const above = pool.filter((i) => i.newReach > imp.newReach).length
  const share = above / Math.max(1, pool.length)
  if (share < 0.15) return 'HOT'
  if (share < 0.5) return 'WARM'
  return 'QUIET'
}

export function allowedTiers(cls: FactClass): Tier[] {
  return TIER_TABLE[cls].flatMap((p, t) => (p > 0 ? [t as Tier] : []))
}

export function pickTier(cls: FactClass, rng: Rng): Tier {
  return rng.weighted(TIER_TABLE[cls]) as Tier
}

// 1 回の抽選の時間割（ms、「次へ」から）。番号は各自のスマホで先に開け、大画面はあとから答え合わせをする:
//   0 〜 charge         手元のスロットを回して溜める（連打しても、これより早くは STOP できない）
//   charge 〜 deadline  STOP の受付（押さなかった人は deadline で自動で止まる）
//   reveal              大画面の答え合わせ（金・虹は、ここから MC の PUSH を待つ）
//   total               結果を見せ終わる
export interface Timing {
  charge: number
  deadline: number
  reveal: number
  total: number
  push: boolean
}

const CHARGE = [3500, 4500, 5500, 6500, 7500]
const STOP_WINDOW = 3500
const RESULT = [3200, 3600, 4000, 4400, 5000]
const RAINBOW_REVEAL = 8500 // 虹（全員確定の流れ）の拍の基準

export function timing(tier: Tier, size: number): Timing {
  // 少人数は抽選回数が多くなるので、尺を少し縮める
  const k = size <= 100 ? 0.85 : 1
  const charge = CHARGE[tier] * k
  const deadline = charge + STOP_WINDOW
  const reveal = deadline + 400
  return { charge, deadline, reveal, total: reveal + RESULT[tier] * k, push: tier >= 3 }
}

export interface Plan {
  tier: Tier
  steps: number // ステップアップの段数（0〜5）
  stepTiers: Tier[]
  pseudo: number // 疑似連の回数（0〜3）
  cutin: Tier | null
  telop: string | null
  group: boolean // 群予告
  upgrade: boolean // 金の流れから虹に昇格する版
}

const BUDGET: readonly (readonly [number, number])[] = [[0, 1], [2, 3], [4, 6], [7, 10], [7, 10]]
const PSEUDO_COST = [0, 1, 2, 4]
const CUTIN_COST = [0, 1, 2, 4]
const TELOPS = [
  ['次の 1 球に注目', '何かが起きそうな予感…'],
  ['会場がざわついている…', 'リーチの人、準備はいい？'],
  ['これは来るか…!?', '全員、画面に注目！'],
]

// 予告ポイント制: 段階ごとの予算の中で、予告の部品をランダムに組み合わせる。
// 部品が多いほど熱い、という読み筋を観客が覚えられるようにする
export function makePlan(tier: Tier, rng: Rng): Plan {
  const plan: Plan = {
    tier,
    steps: 0,
    stepTiers: [],
    pseudo: 0,
    cutin: null,
    telop: null,
    group: false,
    upgrade: tier === 4 && rng.chance(0.3),
  }
  if (tier === 4 && !plan.upgrade) return plan
  const shown = (plan.upgrade ? 3 : tier) as Tier
  const [lo, hi] = BUDGET[shown]
  let left = lo + rng.int(hi - lo + 1)
  for (const part of rng.shuffle(['steps', 'pseudo', 'cutin', 'telop', 'group'])) {
    if (left <= 0) break
    if (part === 'steps') {
      const max = shown >= 3 ? 5 : shown + 2
      const steps = Math.min(max, 1 + Math.min(left, 1 + rng.int(4)))
      if (steps >= 2) {
        plan.steps = steps
        left -= steps - 1
      }
    } else if (part === 'pseudo') {
      const options = [1, 2, 3].filter((k) => PSEUDO_COST[k] <= left && (k < 3 || shown >= 2))
      if (options.length) {
        plan.pseudo = rng.pick(options)
        left -= PSEUDO_COST[plan.pseudo]
      }
    } else if (part === 'cutin') {
      const options = ([1, 2, 3] as Tier[]).filter((t) => t <= shown && CUTIN_COST[t] <= left)
      if (options.length) {
        const t = rng.pick(options)
        plan.cutin = t
        left -= CUTIN_COST[t]
      }
    } else if (part === 'telop') {
      const cost = Math.min(left, 1 + rng.int(3))
      plan.telop = rng.pick(TELOPS[cost - 1])
      left -= cost
    } else if (left >= 2) {
      plan.group = true
      left -= 2
    }
  }
  plan.stepTiers = Array.from(
    { length: plan.steps },
    (_, i) => Math.round((i / Math.max(1, plan.steps - 1)) * shown) as Tier,
  )
  return plan
}

export type BeatKind =
  | 'appear'
  | 'spin'
  | 'holdChange'
  | 'step'
  | 'group'
  | 'pseudo'
  | 'cutin'
  | 'telop'
  | 'decel'
  | 'riser'
  | 'sea'
  | 'heartbeat'
  | 'ma'
  | 'goldEdge'
  | 'freeze'
  | 'crack'
  | 'kakutei'
  | 'rainbowPhones'
  | 'push'
  | 'reveal'

export interface Beat {
  at: number // 「次へ」からの経過 ms
  kind: BeatKind
  heat: Tier // この拍のあとの色
  tier?: Tier
  index?: number
  dur?: number
  text?: string
}

// 演出計画を「時刻つきの拍の列」にする。大画面もスマホも同じ列を見て動くので、色や鼓動がそろう
export function schedule(plan: Plan, t: Timing): Beat[] {
  const beats: Beat[] = []
  let heat: Tier = 0
  const add = (at: number, kind: BeatKind, extra: Partial<Beat> = {}) => {
    beats.push({ at: Math.round(at), kind, heat, ...extra })
  }
  const r = t.reveal

  if (plan.tier === 4 && !plan.upgrade) {
    // 虹: すべてを止める → ヒビ → 確定ロゴ → 全台が虹色 → PUSH 待ち
    const k = r / RAINBOW_REVEAL
    heat = 4
    add(0, 'freeze')
    add(1500 * k, 'crack')
    add(3000 * k, 'kakutei')
    add(5000 * k, 'rainbowPhones')
    add(r, 'push')
    return beats
  }

  const shown = (plan.upgrade ? 3 : plan.tier) as Tier
  add(0, 'appear')
  add(300, 'spin')
  if (plan.telop) add(450, 'telop', { text: plan.telop })

  // 前半: 予告の部品を順に並べる。入りきらなければ詰める
  const tail = plan.upgrade ? 4300 : [600, 1200, 3000, 3200][shown]
  const room = Math.max(600, r - tail - 400)
  const items: { kind: BeatKind; dur: number; extra: Partial<Beat> }[] = []
  for (let i = 0; i < plan.steps; i++) {
    items.push({ kind: 'step', dur: 600, extra: { index: i, tier: plan.stepTiers[i] } })
  }
  if (plan.group) items.push({ kind: 'group', dur: 800, extra: {} })
  for (let i = 0; i < plan.pseudo; i++) items.push({ kind: 'pseudo', dur: 900, extra: { index: i } })
  if (plan.cutin !== null) items.push({ kind: 'cutin', dur: 900, extra: { tier: plan.cutin } })
  const need = items.reduce((s, it) => s + it.dur, 0)
  const k = need > room ? room / need : 1
  if (plan.steps === 0 && shown > 0) {
    heat = shown
    add(380, 'holdChange', { tier: shown })
  }
  let at = 400
  for (const it of items) {
    if (it.extra.tier !== undefined) heat = Math.max(heat, it.extra.tier) as Tier
    add(at, it.kind, it.extra)
    at += it.dur * k
  }
  heat = Math.max(heat, shown) as Tier

  // 後半: 減速・ライザー・鼓動・間（ま）。段階が上がるほど長く溜める
  if (plan.upgrade) {
    add(r - 4300, 'goldEdge')
    add(r - 3600, 'riser', { dur: 1200 })
    heat = 4
    add(r - 2400, 'freeze')
    add(r - 1800, 'crack')
    add(r - 1200, 'kakutei')
    add(r - 900, 'rainbowPhones')
    add(r, 'push')
  } else if (shown === 0) {
    add(r - 600, 'decel')
    add(r, 'reveal')
  } else if (shown === 1) {
    add(r - 1200, 'riser', { dur: 1200 })
    add(r, 'reveal')
  } else if (shown === 2) {
    add(r - 3000, 'sea')
    add(r - 2200, 'heartbeat', { dur: 1400 })
    add(r - 800, 'ma', { dur: 800 })
    add(r, 'reveal')
  } else {
    add(r - 3200, 'goldEdge')
    add(r - 3000, 'sea')
    add(r - 2400, 'riser', { dur: 1800 })
    add(r - 600, 'ma', { dur: 600 })
    add(r, 'push')
  }
  return beats.sort((a, b) => a.at - b.at)
}

