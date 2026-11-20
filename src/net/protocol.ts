import type { BallColor, Glow, Rarity } from '../core/prizes'
import type { Beat, MachineStyle, Tier } from '../core/show'
import type { LiveSettings } from './wire'

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

// 名前の一覧の 1 人。本番では idx（参加者の番号）を付けて配り、受け取った端末が isMe（自分かどうか）を決める
export interface Who {
  name: string
  isMe: boolean
  idx?: number
}

// 本番で、途中から入った（つなぎ直した）端末に渡す、いまの状態。デモでは付かない
export interface LiveState {
  count: number // 参加人数
  mask: number // 自分のカードの開いたマス
  filled: number // モグラに埋められたマス
  wild: number // 虹玉で開いたマス
  rank: number // ビンゴした順位（まだなら 0）
  prize: { name: string; rarity: Rarity | null } | null // 受け取った（または選んでいる途中の）景品
  challenge: { cells: number[]; mask: number; target: Rarity } | null
  dcEntered: boolean // ダブルチャンスにエントリー済み
  dcLeftMs: number // ダブルチャンスの受付の残り時間（受付中でなければ 0）
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
      live?: LiveState // 本人宛て（大画面・主催には count と phase だけが意味を持つ）
    }
  // 主催の端末だけに送る、進行の状態（本番）。デモの主催コンソールは、権威を直接見ている
  | {
      type: 'host'
      phase: Phase
      busy: boolean // 抽選やイベントの最中（「次へ」は効かない）
      hold: string | null // 説明の画面などで主催の合図を待っているときの、ボタンの名前
      step: string // 進行の位置（phase と段階を合わせた文字列）。「次へ」に from として付けて送り返す
      auto: boolean
      players: number // 参加した人数（仮想の参加者を含む）
      bots: number // そのうち、リハーサル用の仮想の参加者
      connected: number // いまつながっている端末の数
      drawCount: number
      deckHash: string
      event: 'wild' | 'mole' | null // 次の「次へ」で起きる、手で指定したイベント
      settings: LiveSettings // いまの景品の数と名前（やり直しの窓に出す）
    }
  | { type: 'joined'; count: number; meJoined: boolean } // meJoined は本人宛て
  // 全員確定（虹玉）。durationMs が大画面の演出の長さ、resultAt に各自の結果を見せる
  | {
      type: 'eventPlay'
      durationMs: number
      resultAt: number
      total: number
      newReach: number
      newDouble: number
      me: MyCellChange // 本人宛て
      totals: Totals
    }
  | { type: 'finalBall'; prizesLeft: number; durationMs: number }
  | {
      type: 'drawScheduled'
      drawNo: number
      style: MachineStyle // 抽選機の回し方の型（大画面とスマホで着地をそろえる）
      revealAt: number // 番号が出る時刻（ms）。どの回も同じ長さ
      beats: Beat[] // 大画面の抽選機の拍（期待度の予告は入らない。スマホは、番号が見える瞬間を合わせるのに使う）
      // 本人宛て: 自分のカードにとっての段階（期待度はスマホだけに出す）と、その段階で作った拍
      personal: { tier: Tier; waiting: string[]; beats: Beat[] }
    }
  | {
      type: 'numberRevealed'
      drawNo: number
      n: number
      label: string
      hits: number
      newReach: number
      moreReach: number
      newBingo: number
      names: Who[] // 大画面に出すのは 12 人まで
      challengeWins: Who[]
      totals: Totals
      resultMs: number
    }
  // lastOne は、上のランクまで景品が尽きて同じ回に上がった人で争うとき。争う人がそれぞれスマホでガラポンを回し、
  // dropAt で全員の玉が出るのと同時に大画面が当たりを発表する
  | { type: 'prizeTime'; entries: PrizeEntry[]; lastOne: { dropAt: number; durationMs: number } | null; final: boolean }
  | { type: 'choices'; challengers: Who[]; totals: Totals }
  | { type: 'challengeDeal'; idx: number; cells: number[]; target: Rarity } // 本人宛て
  | { type: 'challengeEnd'; idx: number } // 決着しないままゲームが終わった（本人宛て）
  // 参加者の操作が要るイベントは、いきなり始めない。先に説明の画面（何が起きるか・何をすればいいか）を出して、
  // 司会の「スタート」を待つ。autoMs は、自動進行のときに説明を出しておく時間（手動のときは null）
  | {
      type: 'questBrief'
      kind: 'mole'
      playMs: number
      targets: number
      players: number
      autoMs: number | null
      me: { target: boolean; cell: number | null; label: string } // 本人宛て
    }
  | { type: 'lastOneBrief'; prizes: number; entrants: Who[]; meIn: boolean; autoMs: number | null }
  // 緊急クエスト「モグラ撃退」。狙われるのはリーチの人。やられる割合は先に決まっていて、
  // 叩いた数が会場全体の下位（その割合）に入った人がやられる（持っているものを失うのは、自分が挑んだ結果としてだけにする）
  | {
      type: 'questStart'
      kind: 'mole'
      introMs: number // 「3・2・1」のカウントダウン（大画面とスマホで同時。説明は questBrief で済んでいる）
      playMs: number // 叩く時間
      targets: number // 狙われたリーチの人数
      players: number
      me: { target: boolean; cell: number | null; label: string } // 本人宛て（ボスモグラが狙う自分のマス）
    }
  | { type: 'questProgress'; total: number } // 会場で叩いた数の合計（叩く時間の間、0.5 秒ごと。大画面とスマホの両方）
  | {
      type: 'questResult'
      kind: 'mole'
      total: number
      targets: number
      defended: number
      lost: number
      lostReach: number
      top: (Who & { score: number })[] // 撃退王（上位 3 人）
      // 本人宛て。need は、やられたときに、あと何匹叩けば守れたか（守れる数との差）
      me: { score: number; target: boolean; lost: boolean; cell: number | null; need: number; rank: number; reachBefore: number; reachAfter: number }
      totals: Totals
      resultMs: number
    }
  | { type: 'bulkDrawn'; numbers: number[]; totals: Totals }
  | { type: 'idle'; totals: Totals }
  | { type: 'gameOver'; totals: Totals; leftoverUpper: number }
  | { type: 'dcEntry'; seconds: number; eligible: number; meEligible: boolean }
  | { type: 'dcEntrants'; count: number }
  | {
      type: 'dcSpin'
      balls: { color: BallColor; prize?: string }[] // 本人宛て（エントリーしていなければ空）
      winners: (Who & { color: BallColor; prize: string })[]
      entrants: number
    }
  | { type: 'dcEnd' }
  | { type: 'notice'; text: string }

export type MsgOf<T extends Msg['type']> = Extract<Msg, { type: T }>

// 端末（スマホ）から権威へのコマンド
export type PhoneCommand =
  | { type: 'join' }
  | { type: 'questScore'; score: number } // 叩き終わったときに 1 回だけ送る
  // 叩いている途中の数（本番だけ。2 秒おきくらい）。大画面の「会場で叩いた数」に足すだけで、結果には使わない
  | { type: 'questProgress'; score: number }
  | { type: 'choice'; kind: 'receive' | 'challenge' }
  // 景品の発表（prizeTime）に自分が入っていたら、受け取ってすぐ 1 回送る（スマホが起きていることをサーバーに知らせる）。
  // サーバーは、これを送ってこなかった人（眠っている・つながっていないスマホ）の選択は待たずに「受け取る」扱いにする
  | { type: 'prizeSeen' }
  | { type: 'entry' }
