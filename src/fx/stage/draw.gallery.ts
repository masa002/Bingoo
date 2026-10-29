import { Rng } from '../../core/rng'
import { makePlan, schedule, timing, type Beat, type BeatKind, type Plan, type Tier } from '../../core/show'
import { registerGallery, type GalleryItem } from '../gallery'
import type { Timeline } from '../runtime'
import { DRAW_VARIANTS, DrawMachine, type DrawVariant } from './draw'

// 大画面の抽選機の見本（URL に ?gallery を付けて開く）。
// 段階ごとの通し（core/show.ts の makePlan → schedule で毎回ちがう計画）と、要素ごとの見本を並べる

const GROUP = '大画面: 抽選機'
const VARIANT_NAME: Readonly<Record<DrawVariant, string>> = {
  reel: 'スロットリール型',
  stack: 'カードめくり型',
  flap: 'パタパタ型',
}

// 見本の番号の候補（すでに 12 個出た体で）
function poolOf(rng: Rng): number[] {
  return rng.shuffle(Array.from({ length: 75 }, (_, i) => i + 1)).slice(12)
}

const seedRng = (name: string): Rng => new Rng(`draw-gallery/${name}/${Math.random()}`)

const beat = (at: number, kind: BeatKind, heat: Tier, extra: Partial<Beat> = {}): Beat => ({ at, kind, heat, ...extra })

const planOf = (tier: Tier, o: Partial<Plan> = {}): Plan => ({
  tier,
  steps: 0,
  stepTiers: [],
  pseudo: 0,
  cutin: null,
  telop: null,
  group: false,
  upgrade: false,
  ...o,
})

// 見本が終わっても最後の画面を残し、ギャラリーで次を選んだ（tl が取り消された）ときに片付ける
async function linger(tl: Timeline, m: DrawMachine): Promise<void> {
  await tl.wait(10 * 60 * 1000)
  m.destroy()
}

// 計画を作って公開まで通す。金は PUSH 待ちに入ってから公開する。取り消されたら false
async function drawOnce(tl: Timeline, m: DrawMachine, tier: Tier, rng: Rng, o: { size?: number; pushWait?: number } = {}): Promise<boolean> {
  const plan = makePlan(tier, rng)
  const t = timing(tier, o.size ?? 1000)
  const pool = poolOf(rng)
  m.reset()
  m.setPool(pool)
  m.start(schedule(plan, t), plan)
  await tl.wait(t.reveal)
  if (tl.cancelled) return false
  if (t.push) {
    m.awaitPush()
    await tl.wait(o.pushWait ?? 1600)
    if (tl.cancelled) return false
  }
  await m.reveal(rng.pick(pool), tier)
  return !tl.cancelled
}

// 手で組んだ拍の列を流して、revealAt で公開する（push を渡すと、PUSH 待ちをその長さだけ見せてから公開）
async function custom(
  tl: Timeline,
  m: DrawMachine,
  beats: Beat[],
  plan: Plan,
  o: { revealAt: number; tier: Tier; push?: number },
): Promise<boolean> {
  const rng = seedRng('custom')
  const pool = poolOf(rng)
  m.reset()
  m.setPool(pool)
  m.start(beats, plan)
  await tl.wait(o.revealAt)
  if (tl.cancelled) return false
  if (o.push !== undefined) {
    m.awaitPush()
    await tl.wait(o.push)
    if (tl.cancelled) return false
  }
  await m.reveal(rng.pick(pool), o.tier)
  return !tl.cancelled
}

function item(id: string, label: string, play: (host: HTMLElement, tl: Timeline) => Promise<void>): GalleryItem {
  return { id: `stage-draw-${id}`, group: GROUP, label, screen: 'stage', play }
}

// 拍の列だけを差し替える見本
function sample(
  id: string,
  label: string,
  beats: Beat[],
  plan: Plan,
  o: { revealAt: number; tier: Tier; push?: number; variant?: DrawVariant },
): GalleryItem {
  return item(id, label, async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed, variant: o.variant })
    await custom(tl, m, beats, plan, o)
    await linger(tl, m)
  })
}

const TIER_LABEL = ['青（静か）', '緑（CHANCE）', '赤（激アツ）', '金（BINGO CHANCE・PUSH 待ちのあと公開）'] as const

registerGallery(
  // ---- 段階ごとの通し（毎回ちがう計画と型） ----
  ...([0, 1, 2, 3] as const).map((tier) =>
    item(`tier${tier}`, `通し: ${TIER_LABEL[tier]}`, async (host, tl) => {
      const m = new DrawMachine(host, { speed: tl.speed })
      await drawOnce(tl, m, tier, seedRng(`tier${tier}`))
      await linger(tl, m)
    }),
  ),

  // ---- 型ごと（赤の計画で、型を固定） ----
  ...DRAW_VARIANTS.map((variant) =>
    item(`variant-${variant}`, `型: ${VARIANT_NAME[variant]}（赤の計画）`, async (host, tl) => {
      const m = new DrawMachine(host, { speed: tl.speed, variant })
      await drawOnce(tl, m, 2, seedRng(variant))
      await linger(tl, m)
    }),
  ),

  // ---- 要素ごとの見本 ----
  sample(
    'steps',
    'ステップアップ 5 段（青 → 金）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(700, 'step', 0, { index: 0, tier: 0 }),
      beat(1300, 'step', 1, { index: 1, tier: 1 }),
      beat(1900, 'step', 2, { index: 2, tier: 2 }),
      beat(2500, 'step', 2, { index: 3, tier: 2 }),
      beat(3100, 'step', 3, { index: 4, tier: 3 }),
      beat(3900, 'riser', 3, { dur: 1200 }),
    ],
    planOf(3, { steps: 5, stepTiers: [0, 1, 2, 2, 3] }),
    { revealAt: 5100, tier: 3 },
  ),
  sample(
    'pseudo',
    '疑似連 3 回（止まりかけ → NEXT ×2・×3・×4）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(380, 'holdChange', 2, { tier: 2 }),
      beat(1000, 'pseudo', 2, { index: 0 }),
      beat(2000, 'pseudo', 2, { index: 1 }),
      beat(3000, 'pseudo', 2, { index: 2 }),
      beat(4100, 'heartbeat', 2, { dur: 1400 }),
      beat(5500, 'ma', 2, { dur: 800 }),
    ],
    planOf(2, { pseudo: 3 }),
    { revealAt: 6300, tier: 2 },
  ),
  sample(
    'pseudo-flap',
    '疑似連 3 回（パタパタ型）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(380, 'holdChange', 2, { tier: 2 }),
      beat(1000, 'pseudo', 2, { index: 0 }),
      beat(2000, 'pseudo', 2, { index: 1 }),
      beat(3000, 'pseudo', 2, { index: 2 }),
      beat(4200, 'decel', 2),
    ],
    planOf(2, { pseudo: 3 }),
    { revealAt: 4800, tier: 2, variant: 'flap' },
  ),
  sample(
    'cutin',
    'カットイン 3 色（緑 CHANCE・赤 激アツ・金 BINGO CHANCE）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(800, 'cutin', 1, { tier: 1 }),
      beat(2100, 'cutin', 2, { tier: 2 }),
      beat(3400, 'cutin', 3, { tier: 3 }),
      beat(4700, 'decel', 3),
    ],
    planOf(3, { cutin: 3 }),
    { revealAt: 5300, tier: 3 },
  ),
  sample(
    'group',
    '群予告（青の群れ → 赤の群れ）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(700, 'group', 0),
      beat(2100, 'holdChange', 2, { tier: 2 }),
      beat(2200, 'group', 2),
      beat(3600, 'decel', 2),
    ],
    planOf(2, { group: true }),
    { revealAt: 4200, tier: 2, variant: 'stack' },
  ),
  sample(
    'telop',
    'テロップ 3 種（控えめ → 強め）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(450, 'telop', 0, { text: '次の 1 球に注目' }),
      beat(2700, 'holdChange', 1, { tier: 1 }),
      beat(2800, 'telop', 1, { text: '会場がざわついている…' }),
      beat(5300, 'holdChange', 2, { tier: 2 }),
      beat(5400, 'telop', 2, { text: 'これは来るか…!?' }),
      beat(7400, 'decel', 2),
    ],
    planOf(2, { telop: 'これは来るか…!?' }),
    { revealAt: 8000, tier: 2 },
  ),
  sample(
    'decel',
    '減速 → 着地（青）',
    [beat(0, 'appear', 0), beat(300, 'spin', 0), beat(2000, 'decel', 0)],
    planOf(0),
    { revealAt: 2600, tier: 0 },
  ),
  sample(
    'riser',
    'ライザー → 着地（緑）',
    [beat(0, 'appear', 0), beat(300, 'spin', 0), beat(380, 'holdChange', 1, { tier: 1 }), beat(2800, 'riser', 1, { dur: 1200 })],
    planOf(1),
    { revealAt: 4000, tier: 1 },
  ),
  sample(
    'heartbeat',
    '鼓動 → 間（ま）→ 着地（赤）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(380, 'holdChange', 2, { tier: 2 }),
      beat(1600, 'heartbeat', 2, { dur: 1400 }),
      beat(3000, 'ma', 2, { dur: 800 }),
    ],
    planOf(2),
    { revealAt: 3800, tier: 2 },
  ),
  sample(
    'gold',
    '金の箔 → ライザー → 間 → PUSH 待ち → 着地',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(380, 'holdChange', 3, { tier: 3 }),
      beat(1400, 'goldEdge', 3),
      beat(2000, 'riser', 3, { dur: 1800 }),
      beat(3800, 'ma', 3, { dur: 600 }),
      beat(4400, 'push', 3),
    ],
    planOf(3),
    { revealAt: 4400, tier: 3, push: 2000 },
  ),
  sample(
    'push',
    'PUSH 待ち（5 秒。1 秒に 1 回の脈動）',
    [
      beat(0, 'appear', 0),
      beat(300, 'spin', 0),
      beat(800, 'goldEdge', 3),
      beat(1800, 'ma', 3, { dur: 600 }),
      beat(2400, 'push', 3),
    ],
    planOf(3),
    { revealAt: 2400, tier: 3, push: 5000 },
  ),
  item('lands', '着地 4 段階（青 → 緑 → 赤 → 金。reset して使い回す）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed })
    for (const t of [0, 1, 2, 3] as const) {
      const beats = [beat(0, 'appear', 0), beat(300, 'spin', 0), beat(1100, 'decel', t)]
      if (t > 0) beats.push(beat(380, 'holdChange', t, { tier: t }))
      if (!(await custom(tl, m, beats, planOf(t), { revealAt: 1700, tier: t }))) break
      await tl.wait(2600)
      if (tl.cancelled) break
    }
    await linger(tl, m)
  }),
  item('repeat', '連続 8 回（本番の出方の比率。型・入り方が毎回変わる）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed })
    const rng = seedRng('repeat')
    for (let i = 0; i < 8; i++) {
      const tier = rng.weighted([52, 26, 15, 7]) as Tier
      if (!(await drawOnce(tl, m, tier, rng, { size: 100, pushWait: 900 }))) break
      const t = timing(tier, 100)
      await tl.wait(t.total - t.reveal)
      if (tl.cancelled) break
    }
    await linger(tl, m)
  }),
  item('speed', '速度の切り替え（×1 → ×3 → ×0.5 → ×1、金の計画）', async (host, tl) => {
    const base = tl.speed
    const m = new DrawMachine(host, { speed: base })
    tl.at(1200, () => m.setSpeed(base * 3))
    tl.at(2600, () => m.setSpeed(base * 0.5))
    tl.at(4600, () => m.setSpeed(base))
    await drawOnce(tl, m, 3, seedRng('speed'))
    await linger(tl, m)
  }),
  item('interrupt', '途中で公開（溜めの最中に reveal が来ても崩れない）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed })
    const rng = seedRng('interrupt')
    const plan = makePlan(3, rng)
    const pool = poolOf(rng)
    m.setPool(pool)
    m.start(schedule(plan, timing(3, 1000)), plan)
    await tl.wait(1500)
    if (!tl.cancelled) await m.reveal(rng.pick(pool), 3)
    await linger(tl, m)
  }),
  item('reduced', '動きを減らす設定（色と文字だけで伝える。赤の計画）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed, reducedMotion: true })
    await drawOnce(tl, m, 2, seedRng('reduced'))
    await linger(tl, m)
  }),
)
