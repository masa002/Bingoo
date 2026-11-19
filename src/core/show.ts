import type { Rng } from './rng'

// 演出の方針。「結果が先、演出はあと」: 次の番号が自分のカードにとって何を意味するか（事実）から段階を抽選し、
// 段階から予告の組み合わせと時刻を決める。結果について嘘はつかない（虹は確定のときだけ）。
//
// 期待度（色）を出すのはスマホだけ。大画面（会場）には出さない。
//   - 会場と自分の 2 本を出すと、同じ回に色が食い違う（会場は金なのに自分は青、など）。
//   - 会場の盛り上がりは、イベント（緊急クエストなど）で作る。
// 大画面の抽選機は、どの回も同じ調子で回して番号を出し、結果（ビンゴ N 人など）だけを伝える。

// 段階: 0 青 / 1 緑 / 2 赤 / 3 金 / 4 虹
export type Tier = 0 | 1 | 2 | 3 | 4
export const TIER_NAME = ['青', '緑', '赤', '金', '虹'] as const
// 段階の言葉は「自分のカードに、何が起きそうか」をそのまま言う（パチンコの「CHANCE」「激アツ」「STEP」は、知らない人に伝わらなかった）。
// オリパと同じで、色がそのまま結果の言葉になる。言葉は、会場で口に出して自然なものにする（説明の書き言葉をそのまま置かない）
export const MY_TIER_WORD = ['', 'あるかも？', 'リーチのチャンス！', 'ビンゴのチャンス！', 'ビンゴ確定！'] as const
// いちばん下の段階（青）の呼び名
export const TIER_QUIET = 'まだまだ'
// 期待度の目盛りの見出し（何の目盛りかを必ず添える）
export const HEAT_LABEL = 'あなたの期待度'
export const TIER_SHAPE = ['●', '▲', '◆', '★', '✦'] as const

export type PersonalOutcome = 'none' | 'hit' | 'reach' | 'bingo'

// 段階の抽選表（％）。次の番号が自分のカードにとって何を意味するかで決める。
//   - 当たらない回にも緑・赤を少し出す（「なかった…」で終わる）
//   - ビンゴになる回にも青・緑を少し残す（青だから外れ、と先に分からないようにする。「なかった…？ → あった！」で覆る）
//   - 虹は、自分がビンゴになるときだけ
export const PERSONAL_TABLE: Readonly<Record<PersonalOutcome, readonly number[]>> = {
  none: [84, 13, 3, 0, 0],
  hit: [30, 55, 15, 0, 0],
  reach: [8, 37, 55, 0, 0],
  bingo: [5, 12, 23, 30, 30],
}
// リーチの人には、ビンゴにならない回にも金を少し出す（金が出たら必ずビンゴ、にはしない。必ずなのは虹だけ）
const TEASE_GOLD = 3

// いまのカードで、次の 1 個で起こりうること。カードは本人に見えているので、起こりえない言葉は出さない
// （リーチでない人に「ビンゴのチャンス！」、もうビンゴした人に「あるかも？」を出さない）
export interface Possible {
  hit: boolean // 残りの番号のどれかが、自分のカードにある
  reach: boolean // 残りの番号のどれかで、リーチが増える
  bingo: boolean // 残りの番号のどれかで、ビンゴになる（リーチ中）
}

export function allowedPersonal(can: Possible): Tier[] {
  const out: Tier[] = [0]
  if (can.hit || can.reach || can.bingo) out.push(1)
  if (can.reach) out.push(2)
  if (can.bingo) out.push(3, 4)
  return out
}

export function personalTier(outcome: PersonalOutcome, can: Possible, rng: Rng): Tier {
  // 実際に起きることは、起こりうることに必ず含める
  const able: Possible = {
    hit: can.hit || outcome !== 'none',
    reach: can.reach || outcome === 'reach',
    bingo: can.bingo || outcome === 'bingo',
  }
  const w = [...PERSONAL_TABLE[outcome]]
  if (able.bingo && outcome !== 'bingo') {
    w[3] += TEASE_GOLD
    w[0] = Math.max(0, w[0] - TEASE_GOLD)
  }
  const ok = new Set(allowedPersonal(able))
  return rng.weighted(w.map((p, t) => (ok.has(t as Tier) ? p : 0))) as Tier
}

// 1 回の抽選の時間（ms、「次へ」から）。番号が出るまでの長さは、どの回も同じ（大画面も全員のスマホも、同時に番号が出る）。
// 結果を見せる長さは、ビンゴが出た回だけ長くする
const REVEAL = 7400
const RESULT = 3400
const RESULT_WIN = 4600

export function drawTiming(size: number, win: boolean): { reveal: number; result: number } {
  // 少人数は抽選回数が多くなるので、尺を少し縮める
  const k = size <= 100 ? 0.85 : 1
  return { reveal: REVEAL * k, result: (win ? RESULT_WIN : RESULT) * k }
}

// 抽選機の回し方の型（リール・カードめくり・パタパタ）。型ごとに着地の時間が少し違うので、
// 権威が決めて大画面とスマホの両方に配り、番号が見える瞬間をそろえる
export type MachineStyle = 'reel' | 'stack' | 'flap'
const STYLES: readonly MachineStyle[] = ['reel', 'stack', 'flap']

// 型は毎回くじで決める（期待度とは関係ない。見た目に変化をつけるだけ）。同じ型は 3 回続けない。
// rand は 0 以上 1 未満の乱数（権威は種つきの乱数、ギャラリーは Math.random を渡す）
export function pickStyle(recent: readonly MachineStyle[], rand: () => number): MachineStyle {
  const last = recent.slice(-2)
  const pool = last.length === 2 && last[0] === last[1] ? STYLES.filter((k) => k !== last[0]) : STYLES
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
}

// スマホの予告の計画（自分のカードにとっての段階から作る）
export interface Plan {
  tier: Tier // 予告で見せる段階（0 青〜3 金。虹の「確定」は、スマホが発表の少し前に自分で出す）
  steps: number // ステップアップの段数（0〜5）
  stepTiers: Tier[]
  pseudo: number // 疑似連の回数（0〜3）
  cutin: Tier | null
  telop: string | null
  group: boolean // 群予告
}

const BUDGET: readonly (readonly [number, number])[] = [[0, 1], [2, 3], [4, 6], [7, 10]]
const PSEUDO_COST = [0, 1, 2, 4]
const CUTIN_COST = [0, 1, 2, 4]
// テロップは、その回の段階に合った言葉にする（熱い回に弱気な言葉が出ると、降格に見える）。どれも自分のカードの話
const TELOPS = [
  ['カードにあるかな？', 'さあ、何が出る？'],
  ['あるかも…？', 'そろそろ来るか…？'],
  ['これは来るか…!?', 'チャンスかも…！'],
  ['ビンゴ、来い！', 'これは大チャンス…！'],
]

// 予告ポイント制: 段階ごとの予算の中で、予告の部品をランダムに組み合わせる。
// 部品が多いほど熱い、という読み筋を覚えられるようにする
export function makePlan(tier: Tier, rng: Rng): Plan {
  const shown = Math.min(3, tier) as Tier
  const plan: Plan = { tier: shown, steps: 0, stepTiers: [], pseudo: 0, cutin: null, telop: null, group: false }
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
      // カットインは、その回の段階の言葉だけ（金の回に緑の言葉が出ると、合図が食い違う）
      if (shown >= 1 && CUTIN_COST[shown] <= left) {
        plan.cutin = shown
        left -= CUTIN_COST[shown]
      }
    } else if (part === 'telop') {
      const cost = Math.min(left, 1 + rng.int(3))
      plan.telop = rng.pick(TELOPS[shown])
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

// 計画を「時刻つきの拍の列」にする。reveal は番号が出る時刻（ms）
export function schedule(plan: Plan, reveal: number): Beat[] {
  const beats: Beat[] = []
  let heat: Tier = 0
  const add = (at: number, kind: BeatKind, extra: Partial<Beat> = {}) => {
    beats.push({ at: Math.round(at), kind, heat, ...extra })
  }
  const r = reveal
  const shown = plan.tier
  add(0, 'appear')
  add(300, 'spin')
  if (plan.telop) add(450, 'telop', { text: plan.telop })

  // 前半: 予告の部品を順に並べる。入りきらなければ詰める
  const tail = [600, 1200, 3000, 3200][shown]
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
  if (shown === 0) {
    add(r - 600, 'decel')
  } else if (shown === 1) {
    add(r - 1200, 'riser', { dur: 1200 })
  } else if (shown === 2) {
    add(r - 3000, 'sea')
    add(r - 2200, 'heartbeat', { dur: 1400 })
    add(r - 800, 'ma', { dur: 800 })
  } else {
    add(r - 3200, 'goldEdge')
    add(r - 3000, 'sea')
    add(r - 2400, 'riser', { dur: 1800 })
    add(r - 600, 'ma', { dur: 600 })
  }
  add(r, 'reveal')
  return beats.sort((a, b) => a.at - b.at)
}

// 大画面の抽選機の拍: 回り出して、ゆっくりになって、番号が出る。どの回も同じ（期待度の予告は入れない）
export function venueBeats(reveal: number): Beat[] {
  return schedule({ tier: 0, steps: 0, stepTiers: [], pseudo: 0, cutin: null, telop: null, group: false }, reveal)
}

// スマホの拍: 自分のカードにとっての段階から作る。虹（自分のビンゴ確定）は、確定の前にどこまで上げておくかを毎回変える
// （青のまま突然・緑・赤・金から。確定そのものは、スマホが発表の少し前に出す）
export function personalBeats(tier: Tier, reveal: number, rng: Rng): Beat[] {
  const shown = tier === 4 ? rng.pick<Tier>([0, 1, 2, 3, 3]) : tier
  return schedule(makePlan(shown, rng), reveal)
}
