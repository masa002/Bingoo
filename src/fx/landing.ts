import type { Beat, BeatKind } from '../core/show'
import type { MachineStyle, Tier } from './theme'

// 抽選機のリールの動きと、着地の時刻のモデル。大画面の抽選機（stage/draw.ts）とスマホの手元の演出（phone/spin.ts）の
// 両方がここの数字を使う。番号が見える瞬間を 2 つの画面でそろえるため、動きの数字はここ 1 か所にだけ書く
// （draw.ts の動きを変えたいときは、ここを変える。そうすればスマホの着地も一緒に変わる）。
// 時間はすべて演出上の ms（速度で縮む）、速さはコマ / 演出上の ms

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

export const MACHINE_STYLES: readonly MachineStyle[] = ['reel', 'stack', 'flap']

export interface MachineSpec {
  rate: number // 全速
  minStop: number // 止めるときに最低限進めるコマ数（止める先のコマが、まだ見えていない距離）
  lock: number // 止まってから「着地」に見えるまで（カードめくり型: 弾いた札がどく。パタパタ型: 最後の 1 枚が落ちきる）
}

export const MACHINE: Readonly<Record<MachineStyle, MachineSpec>> = {
  reel: { rate: 0.018, minStop: 1.5, lock: 0 },
  stack: { rate: 0.011, minStop: 1, lock: 110 },
  flap: { rate: 0.0135, minStop: 1, lock: 240 },
}

// ---- 拍 ----------------------------------------------------------------------

// 次の拍までの持ち時間を測るときに数えない拍（重ねて出すもの・会場ビュー用）
export const PASSIVE: ReadonlySet<BeatKind> = new Set<BeatKind>(['telop', 'sea', 'holdChange'])

// i 番目の拍の持ち時間（次の、数える拍まで）。詰めて並んだ回でも、部品が次の拍にかぶらないように縮めるのに使う
export function slotOf(list: readonly Beat[], i: number): number {
  for (let j = i + 1; j < list.length; j++) if (!PASSIVE.has(list[j].kind)) return list[j].at - list[i].at
  return 1200
}

// ---- 拍ごとのリールの動かし方 ---------------------------------------------------

// 一定の速さ v に向かう（ease は追いつくまでの時定数）
export interface ReelRun {
  v: number
  ease: number
}

export const reelRun = {
  spin: (style: MachineStyle): ReelRun => ({ v: MACHINE[style].rate, ease: 150 }), // 回り出す
  decel: (slot: number): ReelRun => ({ v: 0.0034, ease: Math.max(60, slot / 2.6) }), // 公開に向けてゆっくりになる（青）
  riser: (style: MachineStyle, dur: number): ReelRun => ({ v: MACHINE[style].rate * 1.3, ease: dur / 2.5 }), // 音が上がる間、速まる
  heartbeat: (): ReelRun => ({ v: 0.0042, ease: 260 }), // 1 コマずつ見える速さまで落ちる（赤）
}

// 疑似連（止まりかけて、また回り出す）の時間割。stop で「？」に止め、pause だけ置いて合図を show の長さ出し、
// 合図を出してから rest たったら resume の速さで回り直す
export function pseudoPlan(style: MachineStyle, index: number, slot: number): { stop: number; pause: number; show: number; rest: number; resume: ReelRun } {
  const d = clamp(slot, 380, 1100)
  return { stop: d * 0.34, pause: d * 0.14, show: d * 0.52, rest: d * 0.18, resume: { v: MACHINE[style].rate * (1.1 + 0.1 * index), ease: 90 } }
}

// 間（ま）で「？」に止めるまでの長さ
export const maStopMs = (dur: number): number => clamp(dur * 0.4, 160, 320)

// パタパタ型の 1 枚がめくれる長さ。止まる瞬間（速さ 0）の最後の 1 枚が、いちばん長い（= MACHINE.flap.lock）
export const flapMs = (v: number): number => clamp(0.95 / Math.max(v, 1e-4), 70, MACHINE.flap.lock)

// ---- 着地 ----------------------------------------------------------------------

// 回っているリールを番号に止めるまでの長さ。速いほど長くかける。「？」で止まっているときは、次のコマへ送るだけ
export function stopMs(v: number): number {
  return v > 0.0015 ? clamp(260 + v * 14000, 300, 520) : 280
}

// 裏向き（待機中・金の箔）のカードをめくって番号を見せる。金は、ぐっと縮めて（squeeze）からめくる。
// visible は表が見え始める時刻（めくりの曲線が半分を越えるところ）、land は着地の衝撃の時刻
export const FLIP_EASING = 'cubic-bezier(.35,1.3,.55,1)'
const FLIP_HALF = 0.155 // FLIP_EASING の曲線が 0.5（真横）を越える、時間の割合

export function flipPlan(tier: Tier, reduced = false): { squeeze: number; ms: number; visible: number; land: number } {
  if (reduced) return { squeeze: 0, ms: 0, visible: 0, land: 0 }
  if (tier >= 3) return { squeeze: 120, ms: 420, visible: 120 + 420 * FLIP_HALF, land: 120 + 220 }
  return { squeeze: 0, ms: 340, visible: 340 * FLIP_HALF, land: 180 }
}

export interface MachineMotion {
  back: boolean // カードが裏（金の箔）を向いている
  v: number // リールの速さ
}

// 拍の列をなぞって、時刻 t（start からの ms）に抽選機がどう動いているかを求める。
// スマホは大画面の抽選機を見られないので、同じ拍の列からこれで求めて、着地の時刻を合わせる
export function motionAt(beats: readonly Beat[], t: number, style: MachineStyle): MachineMotion {
  let v = 0
  let goal = 0
  let ease = 200
  let at = 0
  let back = false
  // 時刻 to まで進める（時定数 ease で goal に追いつく）
  const go = (to: number): void => {
    if (to <= at) return
    v = goal + (v - goal) * Math.exp(-(to - at) / ease)
    at = to
  }
  const run = (r: ReelRun): void => {
    goal = r.v
    ease = Math.max(16, r.ease)
  }
  const halt = (): void => {
    v = 0
    goal = 0
  }
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]
    if (b.at > t) break
    go(b.at)
    if (back) continue // 裏返ったあとは、リールは動かさない
    const slot = slotOf(beats, i)
    switch (b.kind) {
      case 'spin':
        run(reelRun.spin(style))
        break
      case 'decel':
        run(reelRun.decel(slot))
        break
      case 'riser':
        run(reelRun.riser(style, b.dur ?? 1200))
        break
      case 'heartbeat':
        run(reelRun.heartbeat())
        break
      case 'pseudo': {
        const p = pseudoPlan(style, b.index ?? 0, slot)
        const resume = b.at + p.stop + p.pause + p.rest
        halt()
        if (t >= resume) {
          at = resume
          run(p.resume)
        }
        break
      }
      case 'ma':
        halt()
        break
      case 'goldEdge':
        back = true
        break
    }
  }
  go(t)
  return { back, v }
}

export interface Landing {
  flip: boolean // 裏向きからめくる（そうでなければ、リールを減速して止める）
  visible: number // 公開を呼んでから、番号が見え始めるまで
  land: number // 公開を呼んでから、着地の衝撃まで
}

// 公開を呼んだ時点の動きから、着地の時刻を求める（tier は大画面の段階）
export function landingOf(m: MachineMotion, style: MachineStyle, tier: Tier): Landing {
  if (m.back) {
    const f = flipPlan(tier)
    return { flip: true, visible: f.visible, land: f.land }
  }
  const T = stopMs(m.v) + MACHINE[style].lock
  return { flip: false, visible: T, land: T }
}
