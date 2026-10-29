import type { Edge, Glow, Rarity } from '../core/prizes'
import type { Beat, FactClass, Notice, Plan, Tier, Timing } from '../core/show'

// 権威（本番はサーバー、デモはブラウザ内）から画面へ流れるメッセージ。
// 全員宛てに配るのは共通の事実だけで、個人のカードの状態は各端末が手元で計算する

export interface Totals {
  size: number
  reachHolders: number
  winners: number
  prizeCount: number
  prizesLeft: number
  remaining: number // 残りの番号の数
  hitsLeft: number // 残りの番号のうち、出せば誰かがビンゴになる番号の数（オリパの「当たり残数」）
  drawCount: number
  tampered: boolean // デモの操作で抽選順を変えた
}

export interface PrizeEntry {
  idx: number
  name: string
  isMe: boolean
  rarity: Rarity | null // null はダブルチャンス券（ラストワン争奪で外れ）
  prize: string | null
  glow: Glow
  edge: Edge
  upgrade: boolean // UR の縁が金から虹に昇格する
  lastOne: boolean
  code: string // 受け取りコード
}

export type Msg =
  | {
      type: 'snapshot'
      seed: string
      size: number
      prizeCount: number
      me: { idx: number; cardNo: number; name: string }
      drawn: number[]
      deckHash: string
      totals: Totals
      phase: 'reception' | 'playing' | 'over'
    }
  | { type: 'joined'; count: number }
  // notice は本人宛ての予告。本番では全員宛てとは別に、本人にだけ送る
  | { type: 'drawScheduled'; drawNo: number; tier: Tier; plan: Plan; timing: Timing; beats: Beat[]; notice: Notice }
  | { type: 'awaitPush'; drawNo: number; ms: number }
  | {
      type: 'numberRevealed'
      drawNo: number
      n: number
      label: string
      tier: Tier
      cls: FactClass
      hits: number
      newReach: number
      moreReach: number
      newBingo: number
      names: { name: string; isMe: boolean }[] // 大画面に出すのは 12 人まで
      totals: Totals
      resultMs: number
    }
  | { type: 'bulkDrawn'; numbers: number[]; totals: Totals }
  | { type: 'prizeTime'; entries: PrizeEntry[]; overflow: boolean; left: number }
  | { type: 'packOpened'; idx: number }
  | { type: 'prizeSpotlight'; entries: PrizeEntry[] }
  | { type: 'prizeEnd' }
  | { type: 'idle'; totals: Totals }
  | { type: 'gameOver'; totals: Totals }
  | { type: 'notice'; text: string }

export type MsgOf<T extends Msg['type']> = Extract<Msg, { type: T }>
