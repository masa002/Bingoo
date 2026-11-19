import { Rng } from '../../core/rng'
import { drawTiming, venueBeats, type MachineStyle } from '../../core/show'
import { registerGallery, type GalleryItem } from '../gallery'
import { MACHINE_STYLES } from '../landing'
import type { Timeline } from '../runtime'
import { DrawMachine } from './draw'

// 大画面の抽選機の見本（URL に ?gallery を付けて開く）。
// 抽選機は、どの回も同じ調子で「回る → ゆっくりになる → 番号が出る → 結果の言葉」。
// 変わるのは、回し方の型（3 つ）と、着地のあとの強さ（結果で決まる 3 つ）だけなので、その組み合わせを並べる

const GROUP = '大画面: 抽選機'
const VARIANT_NAME: Readonly<Record<MachineStyle, string>> = {
  reel: 'スロットリール型',
  stack: 'カードめくり型',
  flap: 'パタパタ型',
}

type Power = 0 | 1 | 2
const POWERS: readonly Power[] = [0, 1, 2]
const POWER_NAME = ['何もなし', 'リーチが増えた', 'ビンゴが出た（金）'] as const
// 着地のあとにカードの帯へ出す結果の言葉の見本（組み込みでは、ui 側がその回の結果から作って渡す）
const RESULT = ['ビンゴなし', 'リーチ +12 人', 'ビンゴ 3 人！'] as const

// 見本の番号の候補（すでに 12 個出た体で）
function poolOf(rng: Rng): number[] {
  return rng.shuffle(Array.from({ length: 75 }, (_, i) => i + 1)).slice(12)
}

const seedRng = (name: string): Rng => new Rng(`draw-gallery/${name}/${Math.random()}`)

// 見本が終わっても最後の画面を残し、ギャラリーで次を選んだ（tl が取り消された）ときに片付ける
async function linger(tl: Timeline, m: DrawMachine): Promise<void> {
  await tl.wait(10 * 60 * 1000)
  m.destroy()
}

// 1 回の抽選を、回り出しから着地まで通す。reveal は番号が出る時刻（省略すると本番と同じ長さ）。取り消されたら false
async function drawOnce(tl: Timeline, m: DrawMachine, power: Power, rng: Rng, o: { reveal?: number; result?: string } = {}): Promise<boolean> {
  const reveal = o.reveal ?? drawTiming(1000, power === 2).reveal
  const pool = poolOf(rng)
  m.reset()
  m.setPool(pool)
  m.start(venueBeats(reveal))
  await tl.wait(reveal)
  if (tl.cancelled) return false
  await m.reveal(rng.pick(pool), { result: o.result ?? RESULT[power], power })
  return !tl.cancelled
}

function item(id: string, label: string, play: (host: HTMLElement, tl: Timeline) => Promise<void>): GalleryItem {
  return { id: `stage-draw-${id}`, group: GROUP, label, screen: 'stage', play }
}

registerGallery(
  // ---- 型 × 着地の強さ（本番と同じ長さで、最初から最後まで） ----
  ...MACHINE_STYLES.flatMap((variant) =>
    POWERS.map((power) =>
      item(`${variant}-${power}`, `${VARIANT_NAME[variant]}: ${POWER_NAME[power]}「${RESULT[power]}」`, async (host, tl) => {
        const m = new DrawMachine(host, { speed: tl.speed, variant })
        await drawOnce(tl, m, power, seedRng(`${variant}-${power}`))
        await linger(tl, m)
      }),
    ),
  ),

  // ---- 着地だけを見比べる・続けて回す・崩れないことの確認 ----
  item('lands', '着地の強さ 3 つを続けて（何もなし → リーチが増えた → ビンゴが出た。短く回す）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed })
    const rng = seedRng('lands')
    for (const power of POWERS) {
      if (!(await drawOnce(tl, m, power, rng, { reveal: 1700 }))) break
      await tl.wait(2600)
      if (tl.cancelled) break
    }
    await linger(tl, m)
  }),
  item('repeat', '続けて 8 回（型と入り方が毎回変わる。結果はまちまち）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed })
    const rng = seedRng('repeat')
    for (let i = 0; i < 8; i++) {
      const power = rng.weighted([55, 33, 12]) as Power
      const t = drawTiming(100, power === 2)
      if (!(await drawOnce(tl, m, power, rng, { reveal: t.reveal }))) break
      await tl.wait(t.result)
      if (tl.cancelled) break
    }
    await linger(tl, m)
  }),
  item('long', '長い結果の言葉（「リーチ +1280 人」。帯に収まるまで文字を小さくする）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed })
    await drawOnce(tl, m, 1, seedRng('long'), { reveal: 1700, result: 'リーチ +1280 人' })
    await linger(tl, m)
  }),
  item('speed', '速さの切り替え（×1 → ×3 → ×0.5 → ×1、ビンゴが出た回）', async (host, tl) => {
    const base = tl.speed
    const m = new DrawMachine(host, { speed: base })
    tl.at(1200, () => m.setSpeed(base * 3))
    tl.at(2600, () => m.setSpeed(base * 0.5))
    tl.at(4600, () => m.setSpeed(base))
    await drawOnce(tl, m, 2, seedRng('speed'))
    await linger(tl, m)
  }),
  item('interrupt', '途中で発表（回っている最中に発表しても崩れない）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed })
    const rng = seedRng('interrupt')
    const pool = poolOf(rng)
    m.setPool(pool)
    m.start(venueBeats(drawTiming(1000, false).reveal))
    await tl.wait(1500)
    if (!tl.cancelled) await m.reveal(rng.pick(pool), { result: RESULT[1], power: 1 })
    await linger(tl, m)
  }),
  item('reduced', '動きを減らす設定（色と文字だけ。ビンゴが出た回）', async (host, tl) => {
    const m = new DrawMachine(host, { speed: tl.speed, reducedMotion: true })
    await drawOnce(tl, m, 2, seedRng('reduced'))
    await linger(tl, m)
  }),
)
