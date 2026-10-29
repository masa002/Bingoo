import type { Glow, Rarity } from '../core/prizes'
import type { Beat, FactClass, Plan, Tier, Timing } from '../core/show'
import type { BallColor } from '../fx/theme'

// 権威（本番はサーバー、デモはブラウザ内）から画面へ流れるメッセージ。
// 全員宛てに配るのは共通の事実だけで、個人のカードの状態は各端末が手元で計算する。
// 「本人宛て」と書いた項目は、本番では全員宛てとは別に、その人にだけ送る

export type Phase = 'reception' | 'playing' | 'over' | 'dc-entry' | 'dc-spin' | 'done'

export interface Totals {
  size: number
  reachHolders: number
  winners: number
  lowerTotal: number
  lowerLeft: number
  upperTotal: number
  upperLeft: number
  challengers: number
  remaining: number // 残りの番号の数
  hitsLeft: number // 残りの番号のうち、出せば誰かがビンゴになる番号の数（オリパの「当たり残数」）
  drawCount: number
  tampered: boolean // デモの操作で抽選順を変えた
  phase: Phase
}

export interface ChoiceOffer {
  allowed: boolean
  target: Rarity
  chance?: number
  reason?: string
}

export interface PrizeEntry {
  idx: number
  name: string
  isMe: boolean
  kind: 'normal' | 'challenge' // 通常のビンゴか、上位チャレンジの成功か
  rarity: Rarity | null // null は景品なし（ラストワン争奪で外れ）
  prize: string | null
  glow: Glow
  upgrade: boolean
  rankUp?: { from: Rarity; to: Rarity }
  choice?: ChoiceOffer // 受け取るか上位チャレンジかを選べるとき
}

export interface MyCellChange {
  cell: number | null // 自分のカードで変わったマス（対象外なら null）
  label: string
  reachBefore: number
  reachAfter: number
}

export type Msg =
  | {
      type: 'snapshot'
      seed: string
      size: number
      me: { idx: number; cardNo: number; name: string }
      drawn: number[]
      deckHash: string
      totals: Totals
    }
  | { type: 'joined'; count: number }
  // 全員確定（虹玉）とモグラ。durationMs が大画面の演出の長さ、resultAt に各自の結果を見せる
  | {
      type: 'eventPlay'
      kind: 'wild' | 'mole'
      durationMs: number
      resultAt: number
      total: number
      newReach: number
      newDouble: number
      hit: number
      lostReach: number
      me: MyCellChange // 本人宛て
      totals: Totals
    }
  | { type: 'finalBall'; prizesLeft: number; durationMs: number }
  | {
      type: 'drawScheduled'
      drawNo: number
      tier: Tier
      plan: Plan
      timing: Timing
      beats: Beat[]
      personal: { tier: Tier; waiting: string[] } // 本人宛て
    }
  // STOP の受付が始まった。n は本人宛て（本番では本人にだけ送る）で、大画面には答え合わせまで出さない
  | { type: 'drawOpen'; drawNo: number; n: number }
  | { type: 'stopCount'; drawNo: number; count: number; total: number }
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
      challengeWins: { name: string; isMe: boolean }[]
      totals: Totals
      resultMs: number
    }
  | { type: 'prizeTime'; entries: PrizeEntry[]; lastOne: boolean; final: boolean }
  | { type: 'choices'; challengers: { name: string; isMe: boolean }[]; totals: Totals }
  | { type: 'challengeDeal'; idx: number; cells: number[]; target: Rarity } // 本人宛て
  | { type: 'challengeEnd'; idx: number } // 決着しないままゲームが終わった（本人宛て）
  | { type: 'bulkDrawn'; numbers: number[]; totals: Totals }
  | { type: 'idle'; totals: Totals }
  | { type: 'gameOver'; totals: Totals; leftoverUpper: number }
  | { type: 'dcEntry'; seconds: number; eligible: number; meEligible: boolean }
  | { type: 'dcEntrants'; count: number }
  | {
      type: 'dcSpin'
      balls: { color: BallColor; prize?: string }[] // 本人宛て（エントリーしていなければ空）
      winners: { name: string; color: BallColor; prize: string; isMe: boolean }[]
      entrants: number
    }
  | { type: 'dcEnd' }
  | { type: 'notice'; text: string }

export type MsgOf<T extends Msg['type']> = Extract<Msg, { type: T }>

// 端末（スマホ）から権威へのコマンド
export type PhoneCommand =
  | { type: 'join' }
  | { type: 'stop'; drawNo: number }
  | { type: 'choice'; kind: 'receive' | 'challenge' }
  | { type: 'entry' }
